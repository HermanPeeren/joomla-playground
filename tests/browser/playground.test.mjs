// Browser tests of the Joomla Playground: the production build (web/dist) in headless Chrome.
//
// Needs: npm run bundle && npm run web:build, and Google Chrome (or CHROME_PATH).
// Run:   npm run test:browser (node --test with the file named: Node 22+ does not take a folder)

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../..', import.meta.url));
const port = Number(process.env.PLAYGROUND_TEST_PORT ?? 5402);
const appUrl = `http://localhost:${port}/`;

let server;
let browser;
let page;
let playground;

describe('Joomla Playground in the browser', () => {
  before(async () => {
    assert.ok(existsSync(`${root}/web/dist/joomla/site.zip`), 'Build first: npm run bundle && npm run web:build');

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
    assert.match(playground.siteUrl, /\/scope-[a-z0-9]+$/);
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

  test('lists the saved site under My sites', async () => {
    await page.click('#sites-menu summary');
    await page.waitForSelector('#sites-list a:has-text("Persistence test")', { timeout: 10000 });
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
