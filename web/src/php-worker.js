// PHP worker of the Joomla Playground: runs Joomla in PHP compiled to WebAssembly.
//
// It unpacks the pre-installed site (joomla/site.zip, see bin/build-browser-bundle.php) into PHP's in-memory
// filesystem, points the site at this tab's scope URL, sets a new Super User password, logs in, and answers the
// requests the service worker sends for that scope.

import { PHP, PHPRequestHandler } from '@php-wasm/universal';
import { loadWebRuntime } from '@php-wasm/web';

const DOCUMENT_ROOT = '/var/www/html';
const PHP_VERSION = '8.4';

const channel = new BroadcastChannel('joomla-playground');

/**
 * Runs PHP requests one after the other. With a single PHP instance, @php-wasm rejects a request that arrives
 * while another one runs (SinglePHPInstanceManager), and pages fire several AJAX requests at once.
 */
let queue = Promise.resolve();

function serialized(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});

  return run;
}

self.onmessage = async ({ data }) => {
  if (data?.type !== 'boot') {
    return;
  }

  try {
    const result = await boot(data);
    self.postMessage({ type: 'ready', ...result });
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error?.stack ?? error) });
  }
};

function progress(message) {
  self.postMessage({ type: 'progress', message });
}

async function boot({ base, scope }) {
  const started = performance.now();
  const timings = {};
  const lap = (name) => (timings[name] = Math.round(performance.now() - started));
  const siteUrl = new URL(`${scope}/`, base).href.replace(/\/$/, '');

  progress(`Loading PHP ${PHP_VERSION}`);
  const php = new PHP(await loadWebRuntime(PHP_VERSION));
  lap('php');

  progress('Downloading Joomla');
  const [manifest, zip] = await Promise.all([
    fetch(new URL('joomla/manifest.json', base)).then((response) => response.json()),
    download(new URL('joomla/site.zip', base)),
  ]);
  lap('download');

  progress('Unpacking Joomla');
  php.mkdir(DOCUMENT_ROOT);
  php.writeFile('/tmp/site.zip', zip);
  await runPhp(php, `
    $zip = new ZipArchive();
    if ($zip->open('/tmp/site.zip') !== true || !$zip->extractTo('${DOCUMENT_ROOT}')) {
        throw new RuntimeException('Cannot unpack the site');
    }
    $zip->close();
    unlink('/tmp/site.zip');
  `);
  lap('unpack');

  progress('Configuring the site');
  const password = randomPassword();
  php.writeFile('/tmp/playground.json', JSON.stringify({ siteUrl, password, root: DOCUMENT_ROOT }));
  await runPhp(php, `
    $settings = json_decode(file_get_contents('/tmp/playground.json'), true);
    unlink('/tmp/playground.json');

    // configuration.php: this tab's URL and the in-memory paths.
    $file   = $settings['root'] . '/configuration.php';
    $values = [
        'live_site' => $settings['siteUrl'],
        'tmp_path'  => $settings['root'] . '/tmp',
        'log_path'  => $settings['root'] . '/administrator/logs',
    ];
    $configuration = file_get_contents($file);
    foreach ($values as $key => $value) {
        $configuration = preg_replace('/public \\$' . $key . ' = [^;]*;/', 'public $' . $key . ' = ' . var_export($value, true) . ';', $configuration);
    }
    file_put_contents($file, $configuration);

    // A new Super User password for every playground. The tables are plain SQLite tables for either driver.
    $db = new PDO('sqlite:' . $settings['root'] . '/data/joomla.sqlite');
    $statement = $db->prepare("UPDATE jos_users SET password = ? WHERE username = 'admin'");
    $statement->execute([password_hash($settings['password'], PASSWORD_DEFAULT)]);
  `);
  lap('configure');

  const handler = new PHPRequestHandler({
    php,
    documentRoot: DOCUMENT_ROOT,
    absoluteUrl: siteUrl,
    // Joomla's .htaccess sends unknown site paths to index.php (SEF URLs).
    getFileNotFoundAction: (relativePath) =>
      relativePath.startsWith('/administrator') || relativePath.startsWith('/api')
        ? { type: '404' }
        : { type: 'internal-redirect', uri: '/index.php' },
  });

  progress('Logging in');
  await logIn(handler, siteUrl, password);
  lap('login');

  channel.onmessage = async ({ data }) => {
    if (data?.type !== 'request' || data.scope !== scope) {
      return;
    }

    const { id, request } = data;

    try {
      const started = performance.now();
      const response = await serialized(() =>
        handler.request({
          url: request.url,
          method: request.method,
          headers: request.headers,
          body: request.body ? new Uint8Array(request.body) : undefined,
        })
      );

      const duration = performance.now() - started;

      if (duration > 2000) {
        console.warn(`PHP took ${Math.round(duration)} ms (queue included) for ${request.method} ${request.url}`);
      }

      if (response.httpStatusCode >= 500) {
        console.warn(`PHP ${response.httpStatusCode} for ${request.method} ${request.url}`, response.errors, response.text.slice(0, 500));
      }

      channel.postMessage({
        type: 'response',
        id,
        status: response.httpStatusCode,
        headers: response.headers,
        body: response.bytes,
      });
    } catch (error) {
      channel.postMessage({
        type: 'response',
        id,
        status: 500,
        headers: { 'content-type': ['text/plain; charset=utf-8'] },
        body: new TextEncoder().encode(String(error?.stack ?? error)),
      });
    }
  };

  return { siteUrl, username: 'admin', password, manifest, timings, phpVersion: PHP_VERSION };
}

async function runPhp(php, code) {
  const response = await php.run({ code: `<?php ${code}` });

  if (response.exitCode !== 0 || response.errors) {
    throw new Error(`PHP failed: ${response.errors || response.text}`);
  }

  return response;
}

async function download(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Cannot download ${url}: HTTP ${response.status}`);
  }

  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    chunks.push(value);
    received += value.length;

    if (total) {
      progress(`Downloading Joomla: ${Math.round((received / total) * 100)}% of ${(total / 1048576).toFixed(1)} MB`);
    }
  }

  const bytes = new Uint8Array(received);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return bytes;
}

/**
 * Logs in to the administrator, so the cookie store of the request handler holds a Super User session.
 * The cookies stay in this worker: the browser never sees them.
 */
async function logIn(handler, siteUrl, password) {
  const form = await handler.request({ url: `${siteUrl}/administrator/index.php` });
  const token = form.text.match(/name="([a-f0-9]{32})" value="1"/)?.[1];

  if (!token) {
    const message = form.text.match(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/)?.[1] ?? form.text;
    const page = message.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);

    throw new Error(`No login form in the administrator (HTTP ${form.httpStatusCode}): ${page} ${form.errors}`);
  }

  const body = new URLSearchParams({
    username: 'admin',
    passwd: password,
    option: 'com_login',
    task: 'login',
    return: btoa('index.php'),
    [token]: '1',
  });

  await handler.request({
    url: `${siteUrl}/administrator/index.php`,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new TextEncoder().encode(body.toString()),
  });
}

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
