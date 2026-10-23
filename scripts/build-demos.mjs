// Prebuilt demos: runs each of the playground's own blueprints that asks for it ("meta": { "prebuild": true }) in
// headless Chrome, and exports the resulting site. ?blueprint=<name> then starts from that export, in seconds,
// instead of running the steps again.
//
// Needs the built playground: npm run bundle && npm run web:build && npm run demos
//
// Output (in web/dist/demos/):
//   <name>.zip    the export of the site (as the toolbar's Export makes it)
//   <name>.json   { blueprint: <SHA-256 of the blueprint file>, joomla, php, built, seconds }
// The page uses the export only while the blueprint file is unchanged (the same SHA-256).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = `${root}/web/dist`;
const only = process.argv[2] ?? null;

const blueprints = readdirSync(`${dist}/blueprints`)
  .filter((file) => file.endsWith('.json') && file !== 'assets.json')
  .map((file) => ({ name: file.slice(0, -5), text: readFileSync(`${dist}/blueprints/${file}`) }))
  .filter(({ name, text }) => (only ? name === only : JSON.parse(text).meta?.prebuild));

if (blueprints.length === 0) {
  console.log('No blueprints to prebuild');
  process.exit(0);
}

const port = await freePort();
const server = spawn(process.execPath, [`${root}/node_modules/vite/bin/vite.js`, 'preview', '--config', 'web/vite.config.js', '--port', String(port), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
});
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });

try {
  await waitForServer(`http://localhost:${port}/`);
  mkdirSync(`${dist}/demos`, { recursive: true });

  for (const { name, text } of blueprints) {
    const started = Date.now();
    const page = await (await browser.newContext({ acceptDownloads: true })).newPage();

    console.log(`== ${name}`);
    await page.goto(`http://localhost:${port}/?blueprint=${name}&fresh=1`);
    await page.waitForFunction(() => window.joomlaPlayground || document.querySelector('#status.error'), null, { timeout: 900000 });

    const playground = await page.evaluate(() => window.joomlaPlayground);

    if (!playground || playground.blueprintError) {
      throw new Error(`${name}: ${playground?.blueprintError ?? (await page.locator('#status').textContent())}`);
    }

    // Background steps (e.g. the Smart Search index) end when the status shows no progress any more.
    await page.waitForFunction(() => !document.querySelector('#status').textContent.includes('·'), null, { timeout: 900000 });

    const status = await page.locator('#status').textContent();

    if (/error|failed/i.test(status)) {
      throw new Error(`${name}: ${status}`);
    }

    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.click('#export-site')]);

    await download.saveAs(`${dist}/demos/${name}.zip`);

    const seconds = Math.round((Date.now() - started) / 1000);

    writeFileSync(
      `${dist}/demos/${name}.json`,
      JSON.stringify(
        {
          blueprint: createHash('sha256').update(text).digest('hex'),
          joomla: playground.manifest.joomla,
          php: playground.phpVersion,
          built: new Date().toISOString(),
          seconds,
        },
        null,
        2
      ) + '\n'
    );
    console.log(`  ${(statSync(`${dist}/demos/${name}.zip`).size / 1048576).toFixed(1)} MB, built in ${seconds} s`);
    await page.context().close();
  }
} finally {
  await browser.close();
  server.kill();
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) {
      throw new Error(`The preview server stopped (exit code ${server.exitCode})`);
    }

    try {
      if ((await fetch(url)).ok) {
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
