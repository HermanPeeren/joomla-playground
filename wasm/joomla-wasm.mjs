// Runs an installed Joomla site with PHP compiled to WebAssembly (@php-wasm/node), as step 2 towards the browser.
//
// The site folder is mounted into PHP's virtual filesystem at /var/www/html (NODEFS, so changes land on disk) and
// served over HTTP by @php-wasm's PHPRequestHandler behind a plain Node HTTP server.

import http from 'node:http';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PHP, PHPRequestHandler, ProcessIdAllocator } from '@php-wasm/universal';
import { createNodeFsMountHandler, loadNodeRuntime } from '@php-wasm/node';

export const DOCUMENT_ROOT = '/var/www/html';

const processIds = new ProcessIdAllocator();

/**
 * Runs PHP requests one after the other. With a single PHP instance, @php-wasm rejects a request that arrives
 * while another one runs (SinglePHPInstanceManager), and browsers send several requests at once.
 */
function createQueue() {
  let queue = Promise.resolve();

  return (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});

    return run;
  };
}

/**
 * Boots PHP with the site mounted.
 *
 * @param {object} options
 * @param {string} options.site        Joomla root on the host, installed with bin/install-sqlite-site.php
 * @param {string} [options.phpVersion] PHP version, e.g. '8.4'
 * @returns {Promise<PHP>}
 */
export async function bootPhp({ site, phpVersion = '8.4' }) {
  const php = new PHP(await loadNodeRuntime(phpVersion, { emscriptenOptions: { processId: processIds.claim() } }));

  await php.mount(DOCUMENT_ROOT, createNodeFsMountHandler(resolve(site)));
  php.chdir(DOCUMENT_ROOT);

  return php;
}

/**
 * Points configuration.php at the virtual filesystem and, when given, the URL the site is served at.
 */
export function prepareConfiguration(site, url = null) {
  const file = resolve(site, 'configuration.php');
  const values = {
    tmp_path: `${DOCUMENT_ROOT}/tmp`,
    log_path: `${DOCUMENT_ROOT}/administrator/logs`,
    ...(url ? { live_site: url } : {}),
  };
  let configuration = readFileSync(file, 'utf8');

  for (const [key, value] of Object.entries(values)) {
    configuration = configuration.replace(new RegExp(`public \\$${key} = '[^']*';`), `public $${key} = '${value}';`);
  }

  if (configuration !== readFileSync(file, 'utf8')) {
    // Saving the Global Configuration can make configuration.php read-only.
    chmodSync(file, 0o644);
    writeFileSync(file, configuration);
  }
}

/**
 * Serves the site over HTTP.
 *
 * @returns {Promise<{url: string, php: PHP, close: () => Promise<void>}>}
 */
export async function serve({ site, port = 8790, phpVersion = '8.4', log = () => {} }) {
  const url = `http://127.0.0.1:${port}`;

  prepareConfiguration(site, url);

  const php = await bootPhp({ site, phpVersion });
  const handler = new PHPRequestHandler({
    php,
    documentRoot: DOCUMENT_ROOT,
    absoluteUrl: url,
    // The browser keeps the cookies; PHP gets them from the request headers.
    cookieStore: false,
    // Joomla's .htaccess sends unknown site paths to index.php (SEF URLs).
    getFileNotFoundAction: (relativePath) =>
      relativePath.startsWith('/administrator') || relativePath.startsWith('/api')
        ? { type: '404' }
        : { type: 'internal-redirect', uri: '/index.php' },
  });

  const serialized = createQueue();

  const server = http.createServer(async (request, response) => {
    const started = performance.now();

    try {
      const chunks = [];

      for await (const chunk of request) {
        chunks.push(chunk);
      }

      const headers = Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value])
      );
      const body = Buffer.concat(chunks);
      const phpResponse = await serialized(() =>
        handler.request({
          url: request.url,
          method: request.method,
          headers,
          body: body.length ? new Uint8Array(body) : undefined,
        })
      );

      response.statusCode = phpResponse.httpStatusCode;

      for (const [name, value] of Object.entries(phpResponse.headers)) {
        response.setHeader(name, value);
      }

      response.end(Buffer.from(phpResponse.bytes));
      log(`${request.method} ${request.url} ${phpResponse.httpStatusCode} ${Math.round(performance.now() - started)} ms`);
    } catch (error) {
      response.statusCode = 500;
      response.end(String(error?.stack ?? error));
      log(`${request.method} ${request.url} 500 ${error?.message ?? error}`);
    }
  });

  await new Promise((done) => server.listen(port, '127.0.0.1', done));

  return {
    url,
    php,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

/**
 * Runs Joomla's CLI (cli/joomla.php) in WebAssembly.
 *
 * @returns {Promise<{exitCode: number, output: string}>}
 */
export async function runCli({ site, args, phpVersion = '8.4' }) {
  prepareConfiguration(site);

  const php = await bootPhp({ site, phpVersion });
  const response = await php.cli(['php', `${DOCUMENT_ROOT}/cli/joomla.php`, ...args]);
  const output = (await response.stdoutText) + (await response.stderrText);

  return { exitCode: await response.exitCode, output };
}
