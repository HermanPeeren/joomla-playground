// Browser tests of the Joomla Playground: the production build (web/dist) in headless Chrome.
//
// Needs: npm run bundle && npm run web:build, and Google Chrome (or CHROME_PATH).
// Run:   npm run test:browser (node --test with the file named: Node 22+ does not take a folder)

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../..', import.meta.url));
// A free port unless PLAYGROUND_TEST_PORT says otherwise: a fixed port could reach the server of another checkout.
const port = Number(process.env.PLAYGROUND_TEST_PORT ?? (await freePort()));
const appUrl = `http://localhost:${port}/`;

let server;
let browser;
let page;
let playground;

describe('Joomla Playground in the browser', () => {
  before(async () => {
    assert.ok(existsSync(`${root}/web/dist/joomla/versions.json`), 'Build first: npm run bundle && npm run web:build');

    // An extension package for the blueprint test, served next to the playground.
    mkdirSync(`${root}/web/dist/test-fixtures`, { recursive: true });
    execFileSync('php', ['-r', `
      $zip = new ZipArchive();
      $zip->open($argv[2], ZipArchive::CREATE | ZipArchive::OVERWRITE);
      $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($argv[1], FilesystemIterator::SKIP_DOTS));
      foreach ($files as $file) {
          $zip->addFile($file->getPathname(), str_replace(DIRECTORY_SEPARATOR, '/', substr($file->getPathname(), strlen($argv[1]) + 1)));
      }
      $zip->close();
    `, `${root}/tests/fixtures/com_playgroundtest`, `${root}/web/dist/test-fixtures/com_playgroundtest.zip`]);

    server = spawn(process.execPath, [`${root}/node_modules/vite/bin/vite.js`, 'preview', '--config', 'web/vite.config.js', '--port', String(port), '--strictPort'], {
      cwd: root,
      stdio: 'ignore',
    });
    await waitForServer(appUrl);

    browser = await chromium.launch(
      process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }
    );
    // One browser context for all tabs: they share the service worker, storage (OPFS) and locks.
    page = await (await browser.newContext()).newPage();
    page.on('pageerror', (error) => console.log('[pageerror]', error.message));
    // The PHP worker logs every snapshot of a saved site (size and duration).
    page.on('console', (message) => message.text().startsWith('Snapshot of') && console.log(message.text()));

    await page.goto(appUrl);
    await page.waitForFunction(() => window.joomlaPlayground || document.querySelector('#status.error'), null, { timeout: 180000 });

    playground = await page.evaluate(() => window.joomlaPlayground);
    assert.ok(playground, await page.locator('#status').textContent());
  });

  after(async () => {
    await browser?.close();
    server?.kill();
  });

  test('boots, logs in and shows the administrator dashboard', async () => {
    const frame = await joomlaFrame();

    await frame.waitForFunction(() => document.title.includes('Home Dashboard'), null, { timeout: 60000 });

    // Joomla's welcome tour starts on its own and takes the frame back to the dashboard. Dismiss it, as a user
    // would, so the following tests can navigate.
    await frame.click('text=Hide Forever', { timeout: 30000 });
    await frame.waitForSelector('text=Hide Forever', { state: 'detached', timeout: 30000 });
    assert.match(playground.siteUrl, /\/scope-[a-z0-9]+-\d+-\d+-\d+$/);
    // A page's window.parent is the page itself, as in a tab of its own: reloading "the parent" (as the Patch Tester's
    // Fetch Data does when its modal closes) reloads Joomla's page, not the playground.
    assert.equal(await frame.evaluate(() => window.parent === window), true);
    assert.equal(playground.manifest.driver, 'mysqlonsqlite');
    console.log('boot timings (ms):', JSON.stringify(playground.timings));
  });

  test('serves media files directly, with the right content type', async () => {
    const stylesheet = await page.evaluate(async (siteUrl) => {
      const frame = document.querySelector('#joomla').contentDocument;
      const href = [...frame.querySelectorAll('link[rel="stylesheet"]')].map((link) => link.href).find((url) => url.includes('/media/'));
      const response = await fetch(href);

      return { href, status: response.status, type: response.headers.get('content-type'), siteUrl };
    }, playground.siteUrl);

    assert.ok(stylesheet.href.startsWith(`${playground.siteUrl}/media/`), stylesheet.href);
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.type, /text\/css/);
  });

  test('catches the mail Joomla sends and shows it under Mail', async () => {
    // Global Configuration's "Send Test Mail", as its button does it: JSON with the mail settings and the form token.
    const answer = await page.evaluate(async (siteUrl) => {
      const administrator = await (await fetch(`${siteUrl}/administrator/index.php?option=com_config`)).text();
      const token = administrator.match(/"csrf\.token":"([a-f0-9]{32})"/)[1];
      const response = await fetch(`${siteUrl}/administrator/index.php?option=com_config&task=application.sendtestmail&format=json&${token}=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({ mailonline: 1, mailer: 'sendmail', mailfrom: 'site@example.invalid', fromname: 'Joomla Playground', sendmail: '/usr/sbin/sendmail', smtpauth: 0, smtpuser: '', smtphost: 'localhost', smtpsecure: 'none', smtpport: 25 }),
      });

      return response.text();
    }, playground.siteUrl);

    assert.match(answer, /"data":true/, answer.slice(0, 500));

    await page.waitForFunction(() => document.querySelector('#mail-count').textContent === '1', null, { timeout: 10000 });
    await page.click('#mail');
    await page.waitForSelector('#mail-list li.selected, #mail-list li:not(.empty)');

    const headers = await page.locator('#mail-headers').textContent();

    assert.match(headers, /site@example\.invalid/);
    assert.match(headers, /Test mail|test mail/i);
    assert.ok((await page.locator('#mail-view').textContent()).length > 50 || (await page.locator('#mail-html').count()) === 1, 'The mail has a body');
    await page.click('#mail-dialog button[type="submit"]');
  });

  test('saves an article through the administrator form', async () => {
    const frame = await openInFrame('/administrator/index.php?option=com_content&task=article.add');

    await frame.fill('#jform_title', 'Written in the browser');
    await frame.click('button.button-save');

    try {
      await frame.waitForSelector('text=Article saved.', { timeout: 60000 });
    } catch (error) {
      await page.screenshot({ path: `${root}/build/browser-test-failure.png` });
      throw error;
    }

    assert.ok(await frame.isVisible('text=Written in the browser'));
  });

  test('shows the article on the site', async () => {
    const frame = await openInFrame('/index.php?option=com_content&view=category&id=2');

    await frame.waitForSelector('text=Written in the browser', { timeout: 60000 });

    assert.match(await frame.title(), /Uncategorised|Joomla Playground/);
  });

  test('opens the System dashboard and Install Languages without blocking the playground', async () => {
    let frame = await openInFrame('/administrator/index.php?option=com_cpanel&view=cpanel&dashboard=system');

    await frame.waitForFunction(() => document.title.includes('System Dashboard'), null, { timeout: 30000 });

    // The list of languages comes from update.joomla.org: PHP's request goes through fetch(). Without networking,
    // curl waited 300 s for a connection and every other request of the playground waited behind it.
    const started = Date.now();
    frame = await openInFrame('/administrator/index.php?option=com_installer&view=languages');
    await frame.waitForSelector('#installer-languages tbody tr .btn', { timeout: 30000 });
    console.log(`Install Languages took ${Date.now() - started} ms`);

    // With the language packs in the bundle (npm run bundle downloads them), installing one takes the playground's
    // copy. Without them, it fails at once (downloads.joomla.org allows no cross-origin requests) and the page says
    // so. Either way, Joomla's redirect back to the list stays in this playground's scope.
    const withPacks = playground.manifest.languages > 0;
    const install = frame.locator('#installer-languages tbody tr .btn[aria-label*="Dutch"]').first();

    assert.equal(await frame.locator('text=language packs cannot be installed from this list').count(), withPacks ? 0 : 1);
    await Promise.all([frame.waitForNavigation({ timeout: 60000 }), install.click()]);
    await frame.waitForSelector(withPacks ? 'text=Installation of the language pack was successful' : 'text=language packs cannot be installed from this list', { timeout: 60000 });
    assert.ok(frame.url().startsWith(`${playground.siteUrl}/administrator/`), frame.url());

    assert.equal(await page.evaluate(async (siteUrl) => (await fetch(`${siteUrl}/index.php`)).status, playground.siteUrl), 200);
  });

  test('installs the Blog Sample Data from the home dashboard', async () => {
    const frame = await openInFrame('/administrator/index.php');

    // Smart Search indexes the sample articles; it used to print a PHP warning into the JSON of step 1.
    const steps = [];
    let last;
    const collect = async (response) => {
      if (response.url().includes('group=sampledata')) {
        steps.push(await response.text().catch((error) => error.message));
      }
    };

    page.on('response', collect);
    page.once('dialog', (dialog) => dialog.accept());

    try {
      const lastStep = page.waitForResponse((response) => response.url().includes('plugin=SampledataApplyStep4'), { timeout: 120000 });
      await frame.click('.sampledata-blog .apply-sample-data', { timeout: 30000 });
      last = await (await lastStep).text();
    } finally {
      page.off('response', collect);
    }

    // Each step answers with plain JSON; the last one says it is done.
    for (const step of steps) {
      assert.doesNotThrow(() => JSON.parse(step), step.slice(0, 300));
    }
    assert.match(last, /Blog Sample Data has been installed!/);
  });

  test('a second tab gets its own site and database', async () => {
    // Same browser context: same service worker and storage, like a second tab.
    const second = await page.context().newPage();

    try {
      await second.goto(appUrl);
      await second.waitForFunction(() => window.joomlaPlayground, null, { timeout: 180000 });

      const other = await second.evaluate(() => window.joomlaPlayground);

      assert.notEqual(other.siteUrl, playground.siteUrl);

      const frame = await (await second.waitForSelector('#joomla')).contentFrame();

      await frame.goto(`${other.siteUrl}/index.php?option=com_content&view=category&id=2`);
      assert.equal(await frame.locator('text=Written in the browser').count(), 0, 'The article of the first playground is not here');

      // The first playground still answers.
      const status = await page.evaluate(async (siteUrl) => (await fetch(`${siteUrl}/index.php`)).status, playground.siteUrl);

      assert.equal(status, 200);
    } finally {
      await second.close();
    }
  });

  test('saves the playground in the browser and opens it again after a reload', async () => {
    page.once('dialog', (dialog) => dialog.accept('Persistence test'));
    const saveStarted = Date.now();
    await page.click('#save-site');
    await page.waitForFunction(
      () => location.search === '?site=persistence-test' && document.querySelector('#status').textContent.includes('saved as'),
      null,
      { timeout: 120000 }
    );
    console.log(`saving took ${Date.now() - saveStarted} ms`);

    await page.reload();
    playground = await waitForPlayground(page);
    console.log('reopen timings (ms):', JSON.stringify(playground.timings));

    assert.equal(playground.site, 'persistence-test');
    assert.ok(await siteShows(page, playground, 'Written in the browser'), 'The article survived the reload');
  });

  test('keeps changes made after saving', async () => {
    const frame = await openInFrame('/administrator/index.php?option=com_content&task=article.add');

    await frame.fill('#jform_title', 'Written after saving');
    await frame.click('button.button-save');
    await frame.waitForSelector('text=Article saved.', { timeout: 60000 });

    // Reload right away: the page asks the worker to write its pending snapshot when it is hidden.
    await page.reload();
    playground = await waitForPlayground(page);
    console.log('reopen timings after a change (ms):', JSON.stringify(playground.timings));

    assert.ok(await siteShows(page, playground, 'Written after saving'), 'The change after saving survived the reload');
  });

  test('lists the saved site under My sites, and renames it', async () => {
    await page.click('#sites-menu summary');
    await page.waitForSelector('#sites-list a:has-text("Persistence test")', { timeout: 10000 });

    page.once('dialog', (dialog) => dialog.accept('Renamed test'));
    await page.click('#sites-list li:has-text("Persistence test") button:has-text("Rename")');
    await page.waitForSelector('#sites-list a:has-text("Renamed test")', { timeout: 10000 });

    assert.equal(await page.getAttribute('#sites-list a:has-text("Renamed test")', 'href'), '?site=persistence-test');
    await page.click('#sites-menu summary');
  });

  test('opens a saved site in one tab only', async () => {
    const second = await page.context().newPage();

    try {
      await second.goto(`${appUrl}?site=persistence-test`);
      await second.waitForSelector('#status.error', { timeout: 120000 });

      assert.match(await second.locator('#status').textContent(), /open in another tab/);
    } finally {
      await second.close();
    }
  });

  test('exports the site as a zip and imports it into a new playground', async () => {
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#export-site')]);
    const file = `${root}/build/browser-export.zip`;

    await download.saveAs(file);
    assert.ok(statSync(file).size > 5_000_000, 'The export holds the whole site');
    console.log(`export: ${(statSync(file).size / 1048576).toFixed(1)} MB`);

    // Joomla's media files are real, not the bundle's placeholders: the export runs on a server as it is.
    const media = JSON.parse(execFileSync('php', ['-r', `
      $zip = new ZipArchive();
      $zip->open($argv[1]);
      $empty = 0;
      for ($index = 0; $index < $zip->numFiles; $index++) {
          $stat = $zip->statIndex($index);
          $empty += str_starts_with($stat['name'], 'media/') && $stat['size'] === 0;
      }
      echo json_encode(['fontawesome' => $zip->statName('media/system/css/joomla-fontawesome.min.css')['size'], 'empty' => $empty]);
    `, file]).toString());

    console.log(`export media: ${JSON.stringify(media)}`);
    assert.ok(media.fontawesome > 0, 'media/system/css/joomla-fontawesome.min.css has content');
    assert.ok(media.empty < 10, `${media.empty} empty files in media/`);

    // A new temporary playground does not have the article...
    await page.goto(appUrl);
    const fresh = await waitForPlayground(page);

    assert.equal(fresh.site, null);
    assert.equal(await siteShows(page, fresh, 'Written in the browser', 5000), false);

    // ...the imported one does.
    await page.setInputFiles('#import-file', file);
    playground = await waitForPlayground(page, fresh.siteUrl);
    console.log('import timings (ms):', JSON.stringify(playground.timings));

    assert.equal(playground.site, null);
    assert.ok(await siteShows(page, playground, 'Written in the browser'), 'The imported site has the article');

    // Saved, the imported site keeps placeholders for the media files: its base is not the export's size.
    page.once('dialog', (dialog) => dialog.accept('Imported site'));
    await page.click('#save-site');
    await page.waitForFunction(() => location.search === '?site=imported-site', null, { timeout: 120000 });

    const baseSize = await page.evaluate(async () => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('joomla-playground');
      const meta = await (await (await (await root.getDirectoryHandle('sites')).getDirectoryHandle('imported-site')).getFileHandle('meta.json')).getFile();
      const { base } = JSON.parse(await meta.text());

      return (await (await (await root.getDirectoryHandle('bases')).getFileHandle(`${base}.zip`)).getFile()).size;
    });

    console.log(`base of the imported site: ${(baseSize / 1048576).toFixed(1)} MB`);
    assert.ok(baseSize < statSync(file).size - 5_000_000, `The base (${baseSize} bytes) has no media files`);
  });

describe('Blueprints', () => {
  let context;

  before(async () => {
    context = await browser.newContext();
  });

  after(async () => {
    await context?.close();
  });

  test('sets up a new playground from a blueprint and query parameters', async () => {
    const blueprint = {
      landingPage: '/index.php',
      steps: [
        { step: 'installExtension', url: 'test-fixtures/com_playgroundtest.zip' },
        { step: 'setGlobalConfig', values: { sitename: 'Blueprint Site' } },
        { step: 'runSql', sql: "UPDATE #__playgroundtest_items SET title = 'Changed by a blueprint';" },
        { step: 'enableExtension', element: 'debug', type: 'plugin', folder: 'system' },
        { step: 'writeFile', path: 'images/blueprint.txt', data: 'Written by a blueprint' },
        { step: 'importSampleData' },
        {
          step: 'runPHP',
          code: `<?php
            require 'configuration.php';
            $db = new PDO('sqlite:data/joomla.sqlite');
            file_put_contents('images/check.json', json_encode([
                'php'      => PHP_VERSION,
                'sitename' => (new JConfig())->sitename,
                'lifetime' => (new JConfig())->lifetime,
                'item'     => $db->query('SELECT title FROM jos_playgroundtest_items')->fetchColumn(),
                'debug'    => $db->query("SELECT enabled FROM jos_extensions WHERE element = 'debug' AND folder = 'system'")->fetchColumn(),
                'articles' => $db->query('SELECT COUNT(*) FROM jos_content')->fetchColumn(),
                'joomlaCa' => (function () {
                    // As Joomla's own HTTP client does it (CurlTransport): with the CA bundle that comes with Joomla.
                    $curl = curl_init('https://update.joomla.org/language/translationlist_6.xml');
                    curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER => true, CURLOPT_NOBODY => true, CURLOPT_TIMEOUT => 30,
                        CURLOPT_CAINFO => 'libraries/vendor/composer/ca-bundle/res/cacert.pem']);
                    return curl_exec($curl) === false ? curl_error($curl) : curl_getinfo($curl, CURLINFO_HTTP_CODE);
                })(),
            ]));`,
        },
      ],
    };
    const tab = await context.newPage();

    tab.on('pageerror', (error) => console.log('[pageerror]', error.message));
    await tab.goto(`${appUrl}?php=8.3&login=no#${encodeURIComponent(JSON.stringify(blueprint))}`);

    const result = await waitForPlayground(tab);

    console.log('blueprint timings (ms):', JSON.stringify(result.timings));
    assert.equal(result.blueprintError, null);
    assert.equal(result.phpVersion, '8.3');

    const check = await tab.evaluate(async (siteUrl) => {
      const fetchText = async (path) => (await fetch(siteUrl + path)).text();

      return {
        check: JSON.parse(await fetchText('/images/check.json')),
        file: await fetchText('/images/blueprint.txt'),
        administrator: await fetchText('/administrator/index.php'),
        frame: document.querySelector('#joomla').src,
      };
    }, result.siteUrl);

    assert.match(check.check.php, /^8\.3\./);
    assert.equal(check.check.sitename, 'Blueprint Site');
    assert.equal(String(check.check.lifetime), '240', 'Sessions last 4 hours');
    assert.equal(check.check.item, 'Changed by a blueprint');
    assert.equal(String(check.check.debug), '1');
    assert.equal(String(check.check.joomlaCa), '200', "Joomla's CA bundle trusts the playground's certificates");
    assert.ok(Number(check.check.articles) > 5, `Sample data installed: ${check.check.articles} articles`);
    assert.equal(check.file, 'Written by a blueprint');
    assert.match(check.administrator, /mod-login-username|id="form-login"/, 'login=no: the administrator shows the login form');
    assert.ok(check.administrator.includes(result.password), 'The login form says which password to use');
    assert.equal(check.frame, `${result.siteUrl}/index.php`);
    await tab.close();
  });

  test('switches PHP versions and starts over', async () => {
    const tab = await context.newPage();

    tab.on('dialog', (dialog) => dialog.accept());
    await tab.goto(`${appUrl}?url=/index.php`);

    const first = await waitForPlayground(tab);

    assert.equal(first.phpVersion, '8.4');
    assert.equal(await tab.inputValue('#php-version'), '8.4');

    // PHP 8.5: a new playground from the same link.
    await tab.selectOption('#php-version', '8.5');

    const second = await waitForPlayground(tab, first.siteUrl);

    assert.equal(second.phpVersion, '8.5');
    assert.match(tab.url(), /php=8\.5/);
    const site = await tab.evaluate(async (siteUrl) => {
      const response = await fetch(`${siteUrl}/index.php`);

      return { status: response.status, html: await response.text() };
    }, second.siteUrl);

    assert.equal(site.status, 200, 'Joomla runs on PHP 8.5');
    assert.doesNotMatch(site.html, /Fatal error|Deprecated:|Warning:/);

    await tab.click('#reset-site');

    const third = await waitForPlayground(tab, second.siteUrl);

    assert.equal(third.phpVersion, '8.5');
    assert.notEqual(third.siteUrl, second.siteUrl);
    await tab.close();
  });

  test('starts another Joomla version, with its own media files', async () => {
    const versions = JSON.parse(readFileSync(`${root}/web/dist/joomla/versions.json`, 'utf8'));
    const other = versions.versions.find((bundle) => bundle.joomla !== versions.default);

    if (!other) {
      return;
    }

    const major = other.joomla.split('.').slice(0, 2).join('.');
    const tab = await context.newPage();

    await tab.goto(`${appUrl}?joomla=${major}`);

    const result = await waitForPlayground(tab);

    assert.equal(result.manifest.joomla, other.joomla);
    assert.equal(await tab.inputValue('#joomla-version'), other.joomla);
    assert.match(result.siteUrl, new RegExp(`-${other.joomla.replaceAll('.', '-')}$`));

    const frame = await (await tab.waitForSelector('#joomla')).contentFrame();

    await frame.waitForFunction(() => document.querySelector('link[rel="stylesheet"][href*="/media/"]'), null, { timeout: 60000 });

    const stylesheet = await frame.evaluate(async () => {
      const href = document.querySelector('link[rel="stylesheet"][href*="/media/"]').href;
      const response = await fetch(href);

      return { href, status: response.status, type: response.headers.get('content-type') };
    });

    assert.equal(stylesheet.status, 200, stylesheet.href);
    assert.match(stylesheet.type, /text\/css/);
    await tab.close();

    const missing = await context.newPage();

    await missing.goto(`${appUrl}?joomla=3`);
    await missing.waitForSelector('#status.error', { timeout: 60000 });
    assert.match(await missing.locator('#status').textContent(), /Joomla 3 is not available/);
    await missing.close();
  });

  test('?language= installs a language pack and makes it the default', async () => {
    const tab = await context.newPage();

    await tab.goto(`${appUrl}?language=nl-NL`);

    const result = await waitForPlayground(tab);

    if (!result.manifest.languages) {
      await tab.close();

      return;
    }

    assert.equal(result.blueprintError, null);

    const html = await tab.evaluate(async (siteUrl) => (await fetch(`${siteUrl}/administrator/index.php`)).text(), result.siteUrl);

    assert.match(html, /<html[^>]* lang="nl-nl"/, 'The administrator is in Dutch');
    await tab.close();
  });

  test('sets up the multilingual heritage demo (?blueprint=heritage-demo)', async () => {
    const tab = await context.newPage();

    await tab.goto(`${appUrl}?blueprint=heritage-demo&fresh=1`);

    const result = await waitForPlayground(tab);

    console.log('heritage demo timings (ms):', JSON.stringify(result.timings));
    assert.equal(result.blueprintError, null);

    const pages = await tab.evaluate(async (siteUrl) => {
      const found = {};

      for (const code of ['en', 'nl', 'de', 'fr', 'es']) {
        const html = await (await fetch(`${siteUrl}/index.php/${code}/`)).text();

        found[code] = {
          lang: html.match(/<html[^>]* lang="([^"]+)"/)?.[1],
          switcher: html.includes('mod-languages'),
          items: (html.match(/class="blog-item/g) ?? []).length,
        };
      }

      return found;
    }, result.siteUrl);

    for (const [code, lang] of Object.entries({ en: 'en-gb', nl: 'nl-nl', de: 'de-de', fr: 'fr-fr', es: 'es-es' })) {
      assert.equal(pages[code].lang, lang, `${code}: the page is in ${lang}`);
      assert.ok(pages[code].switcher, `${code}: the language switcher is there`);
      assert.ok(pages[code].items > 1, `${code}: the heritage articles are there (${pages[code].items})`);
    }

    // The Smart Search index is built in the background (a blueprint step with "background": true); the toolbar
    // shows its progress after "Ready in ...".
    await tab.waitForFunction(() => !document.querySelector('#status').textContent.includes('·'), null, { timeout: 300000 });
    assert.doesNotMatch(await tab.locator('#status').textContent(), /error|failed/i);

    const found = await tab.evaluate(
      async (siteUrl) => (await (await fetch(`${siteUrl}/index.php/en/?option=com_finder&view=search&q=Frogs`)).text()).includes('November: Frogs'),
      result.siteUrl
    );

    assert.ok(found, 'Smart Search finds a heritage article');

    // Export it, as scripts/build-demos.mjs does, as the prebuilt demo for the next test.
    const [download] = await Promise.all([tab.waitForEvent('download', { timeout: 300000 }), tab.evaluate(() => window.joomlaPlaygroundExport({ media: false }))]);
    const blueprint = readFileSync(`${root}/web/dist/blueprints/heritage-demo.json`);

    mkdirSync(`${root}/web/dist/demos`, { recursive: true });
    await download.saveAs(`${root}/web/dist/demos/heritage-demo.zip`);
    writeFileSync(
      `${root}/web/dist/demos/heritage-demo.json`,
      JSON.stringify({ blueprint: createHash('sha256').update(blueprint).digest('hex'), joomla: result.manifest.joomla, php: result.phpVersion })
    );
    await tab.close();
  });

  test('starts the heritage demo from its prebuilt export, in seconds', async () => {
    const tab = await context.newPage();

    try {
      await tab.goto(`${appUrl}?blueprint=heritage-demo`);

      const result = await waitForPlayground(tab);

      console.log('prebuilt heritage demo timings (ms):', JSON.stringify(result.timings));
      assert.match(await tab.locator('#status').textContent(), /prebuilt demo/);
      assert.ok(result.timings.ready < 30000, `Ready in ${result.timings.ready} ms`);

      const page = await tab.evaluate(async (siteUrl) => {
        const html = await (await fetch(`${siteUrl}/index.php/fr/`)).text();
        const search = await (await fetch(`${siteUrl}/index.php/en/?option=com_finder&view=search&q=Frogs`)).text();
        const administrator = await (await fetch(`${siteUrl}/administrator/index.php`)).text();

        return {
          lang: html.match(/<html[^>]* lang="([^"]+)"/)?.[1],
          items: (html.match(/class="blog-item/g) ?? []).length > 1,
          search: search.includes('November: Frogs'),
          // The administrator's menu (it disappeared when the Special view level got invalid rules).
          adminMenu: (administrator.match(/class="item item-level-1/g) ?? []).length > 0,
        };
      }, result.siteUrl);

      assert.deepEqual(page, { lang: 'fr-fr', items: true, search: true, adminMenu: true });

      // A media file of an installed extension, which the static bundle does not have: from the site's own files.
      const script = await tab.evaluate(async (siteUrl) => {
        const response = await fetch(`${siteUrl}/media/mod_demodata/js/demodata-process.js`);

        return { status: response.status, type: response.headers.get('content-type'), demodata: (await response.text()).includes('demodataAjax') };
      }, result.siteUrl);

      assert.equal(script.status, 200);
      assert.match(script.type, /javascript/);
      assert.ok(script.demodata, "The module's own script");

      // The language switcher on the row of the site name (user.css of the blueprint): every flag can be clicked.
      const frame = await (await tab.waitForSelector('#joomla')).contentFrame();

      await frame.goto(`${result.siteUrl}/index.php/de/`);

      const flags = await frame.evaluate(() =>
        [...document.querySelectorAll('.mod-languages a')].map((link) => {
          const box = link.getBoundingClientRect();

          return link.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        })
      );

      assert.deepEqual(flags, [true, true, true, true, true], 'Every flag of the language switcher can be clicked');
    } finally {
      await tab.close();
      // The next build makes its own (npm run demos).
      rmSync(`${root}/web/dist/demos`, { recursive: true, force: true });
    }
  });

  test('installs the Patch Tester (?blueprint=patchtester)', async () => {
    const tab = await context.newPage();

    try {
      await tab.goto(`${appUrl}?blueprint=patchtester`);

      const result = await waitForPlayground(tab);

      assert.equal(result.blueprintError, null);

      // Fetch Data needs GitHub (60 requests an hour without a token), so the test stops at the list.
      const frame = await (await tab.waitForSelector('#joomla')).contentFrame();

      await frame.waitForSelector('text=Fetch Data', { timeout: 60000 });
      assert.match(frame.url(), /option=com_patchtester&view=pulls/);
    } finally {
      await tab.close();
    }
  });

  test('reports a wrong blueprint', async () => {
    const tab = await context.newPage();

    await tab.goto(`${appUrl}#${encodeURIComponent(JSON.stringify({ steps: [{ step: 'installPlugin' }] }))}`);
    await tab.waitForSelector('#status.error', { timeout: 60000 });

    assert.match(await tab.locator('#status').textContent(), /unknown step "installPlugin"/);
    await tab.close();
  });
  });
});

/**
 * Waits until the page runs a playground (a new one, if the previous site URL is given).
 */
async function waitForPlayground(target, previousSiteUrl = null) {
  await target.waitForFunction(
    (previous) => document.querySelector('#status.error') || (window.joomlaPlayground && window.joomlaPlayground.siteUrl !== previous),
    previousSiteUrl,
    { timeout: 180000 }
  );

  const result = await target.evaluate(() => window.joomlaPlayground);

  assert.ok(result && result.siteUrl !== previousSiteUrl, await target.locator('#status').textContent());

  return result;
}

/**
 * Whether the site's category page of the given playground shows a text.
 */
async function siteShows(target, current, text, timeout = 60000) {
  const frame = await (await target.waitForSelector('#joomla')).contentFrame();

  await frame.goto(`${current.siteUrl}/index.php?option=com_content&view=category&id=2`, { timeout: 120000 });

  return frame.waitForSelector(`text=${text}`, { timeout }).then(() => true, () => false);
}

async function joomlaFrame() {
  const handle = await page.waitForSelector('#joomla');
  const frame = await handle.contentFrame();

  await frame.waitForLoadState('load');

  return frame;
}

/**
 * Navigates the Joomla iframe. Joomla's own scripts (the welcome tour, AJAX widgets) may still be busy or navigate
 * the frame themselves, which aborts a navigation; then wait and try again.
 */
async function openInFrame(path) {
  const frame = await joomlaFrame();

  for (let attempt = 1; ; attempt++) {
    await frame.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});

    try {
      await frame.goto(playground.siteUrl + path, { timeout: 120000 });

      return frame;
    } catch (error) {
      if (attempt === 3 || !String(error.message).includes('ERR_ABORTED')) {
        throw error;
      }
    }
  }
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) {
      throw new Error(`The preview server stopped (exit code ${server.exitCode}); is port ${port} in use?`);
    }

    try {
      const response = await fetch(url);

      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`${url} did not start`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();

    probe.once('error', reject);
    probe.listen(0, 'localhost', () => {
      const { port: free } = probe.address();

      probe.close(() => resolve(free));
    });
  });
}
