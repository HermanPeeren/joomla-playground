// PHP worker of the Joomla Playground: runs Joomla in PHP compiled to WebAssembly.
//
// It puts a Joomla site into PHP's in-memory filesystem, points it at this tab's scope URL, sets the Super User
// password, logs in, and answers the requests the service worker sends for that scope. The site comes from:
// - the pre-installed bundle (joomla/site.zip, see bin/build-browser-bundle.php): a temporary playground;
// - a saved site in the browser's private file system (OPFS), kept in sync after every request;
// - an imported zip (an export of a playground).
//
// The page talks to it with messages { type, id, ... }; the worker answers { type: 'result', id, value | error }
// and sends { type: 'progress', message } while it works.

import { PHP, PHPRequestHandler } from '@php-wasm/universal';
import { createDirectoryHandleMountHandler, loadWebRuntime } from '@php-wasm/web';
import { filesDirectory, readMeta, siteLockName, writeMeta } from './storage.js';

const DOCUMENT_ROOT = '/var/www/html';
const PHP_VERSION = '8.4';

const channel = new BroadcastChannel('joomla-playground');

/** @type {{php: PHP, handler: PHPRequestHandler, manifest: object, password: string, site: string|null}} */
let state = null;

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

const actions = { boot, save, exportSite };

self.onmessage = async ({ data }) => {
  const action = actions[data?.type];

  if (!action) {
    return;
  }

  try {
    const { value, transfer = [] } = await action(data);
    self.postMessage({ type: 'result', id: data.id, value }, transfer);
  } catch (error) {
    self.postMessage({ type: 'result', id: data.id, error: String(error?.message ?? error) });
  }
};

function progress(message) {
  self.postMessage({ type: 'progress', message });
}

/**
 * @param {object} options
 * @param {string} options.base   URL of the playground (the folder of index.html)
 * @param {string} options.scope  This tab's scope, e.g. "scope-abc123"
 * @param {string} [options.site] Slug of a saved site to open, or to create from the bundle
 * @param {string} [options.title] Title for a new saved site
 * @param {ArrayBuffer} [options.zip] An exported playground to start from
 */
async function boot({ base, scope, site = null, title = null, zip = null }) {
  const started = performance.now();
  const timings = {};
  const lap = (name) => (timings[name] = Math.round(performance.now() - started));
  const siteUrl = new URL(`${scope}/`, base).href.replace(/\/$/, '');

  if (site) {
    await lockSite(site);
  }

  progress(`Loading PHP ${PHP_VERSION}`);
  const [php, manifest] = await Promise.all([
    loadWebRuntime(PHP_VERSION).then((runtime) => new PHP(runtime)),
    fetch(new URL('joomla/manifest.json', base)).then((response) => response.json()),
  ]);
  lap('php');

  const meta = site ? await readMeta(site) : null;
  let password;

  if (meta) {
    // A saved site: copy it from OPFS into memory; changes go back to OPFS after every request.
    progress('Opening the saved site');
    await php.mount(DOCUMENT_ROOT, createDirectoryHandleMountHandler(await filesDirectory(site), {
      initialSync: { direction: 'opfs-to-memfs' },
    }));
    password = meta.password;
    lap('restore');
  } else {
    const bytes = zip ? new Uint8Array(zip) : await download(new URL('joomla/site.zip', base));
    lap('download');

    progress('Unpacking Joomla');
    php.mkdir(DOCUMENT_ROOT);
    php.writeFile('/tmp/site.zip', bytes);
    await runPhp(php, `
      $zip = new ZipArchive();
      if ($zip->open('/tmp/site.zip') !== true || !$zip->extractTo('${DOCUMENT_ROOT}')) {
          throw new RuntimeException('Cannot unpack the site');
      }
      // An export says which Joomla version and driver it holds (see exportSite()).
      file_put_contents('/tmp/archive-comment.json', (string) $zip->getArchiveComment());
      $zip->close();
      unlink('/tmp/site.zip');
      if (!is_file('${DOCUMENT_ROOT}/configuration.php') || !is_file('${DOCUMENT_ROOT}/data/joomla.sqlite')) {
          throw new RuntimeException('This zip is not a Joomla Playground export');
      }
    `);
    password = randomPassword();
    lap('unpack');
  }

  progress('Configuring the site');
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
    chmod($file, 0644);
    file_put_contents($file, $configuration);

    // The Super User password of this playground. The tables are plain SQLite tables for either driver.
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

  state = { php, handler, manifest, password, site: null };

  if (site && !meta) {
    await persist(site, title ?? site);
  } else if (meta) {
    state.site = site;
    await writeMeta(site, { ...meta, opened: new Date().toISOString() });
  }

  progress('Logging in');
  await logIn(handler, siteUrl, password);
  lap('login');

  channel.onmessage = ({ data }) => {
    if (data?.type === 'request' && data.scope === scope) {
      answer(data);
    }
  };

  return {
    value: {
      siteUrl,
      username: 'admin',
      password,
      manifest,
      timings,
      phpVersion: PHP_VERSION,
      site: state.site,
      importedFrom: zip ? siteComment(php) : null,
    },
  };
}

/**
 * Saves the running playground as a site in OPFS. From then on, changes are written there after every request.
 */
async function save({ site, title }) {
  if (!state) {
    throw new Error('The playground is not running');
  }

  if (state.site) {
    throw new Error(`This playground is already saved as "${state.site}"`);
  }

  await lockSite(site);
  await serialized(() => persist(site, title));

  return { value: { site } };
}

async function persist(site, title) {
  progress('Saving the site in this browser');
  await state.php.mount(DOCUMENT_ROOT, createDirectoryHandleMountHandler(await filesDirectory(site), {
    initialSync: {
      direction: 'memfs-to-opfs',
      onProgress: ({ files, total }) => total && progress(`Saving the site in this browser: ${files} of ${total} files`),
    },
  }));
  await writeMeta(site, {
    title,
    password: state.password,
    joomla: state.manifest.joomla,
    driver: state.manifest.driver,
    created: new Date().toISOString(),
  });
  state.site = site;
}

/**
 * Zips the site (without caches, logs and temporary files) as a download.
 */
async function exportSite() {
  if (!state) {
    throw new Error('The playground is not running');
  }

  const comment = JSON.stringify({ joomlaPlayground: 1, joomla: state.manifest.joomla, driver: state.manifest.driver, exported: new Date().toISOString() });

  await serialized(() =>
    runPhp(state.php, `
      $root = '${DOCUMENT_ROOT}';
      $skip = '#^(tmp|cache|administrator/cache|administrator/logs)/(?!index\\.html$)#';
      $zip  = new ZipArchive();
      $zip->open('/tmp/export.zip', ZipArchive::CREATE | ZipArchive::OVERWRITE);
      $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS));
      foreach ($files as $file) {
          $relative = substr($file->getPathname(), strlen($root) + 1);
          if ($file->isFile() && !preg_match($skip, $relative)) {
              $zip->addFile($file->getPathname(), $relative);
          }
      }
      $zip->setArchiveComment(${JSON.stringify(comment)});
      $zip->close();
    `)
  );

  const bytes = state.php.readFileAsBuffer('/tmp/export.zip');
  state.php.unlink('/tmp/export.zip');

  return { value: bytes.buffer, transfer: [bytes.buffer] };
}

/**
 * The comment an export carries: Joomla version and driver of the site.
 */
function siteComment(php) {
  try {
    return JSON.parse(php.readFileAsText('/tmp/archive-comment.json'));
  } catch {
    return null;
  }
}

/**
 * One tab per saved site: two PHP workers writing the same files would overwrite each other's changes.
 * The lock is held until this worker ends. After a reload, the previous page's worker may still hold it for a
 * moment, so wait a few seconds before giving up.
 */
async function lockSite(site) {
  const acquired = await new Promise((resolve) => {
    navigator.locks
      .request(siteLockName(site), { signal: AbortSignal.timeout(5000) }, () => {
        resolve(true);

        return new Promise(() => {});
      })
      .catch(() => resolve(false));
  });

  if (!acquired) {
    throw new Error(`The site "${site}" is open in another tab. Close that tab first.`);
  }
}

async function answer({ id, request }) {
  try {
    const started = performance.now();
    const response = await serialized(() =>
      state.handler.request({
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

    channel.postMessage({ type: 'response', id, status: response.httpStatusCode, headers: response.headers, body: response.bytes });
  } catch (error) {
    channel.postMessage({
      type: 'response',
      id,
      status: 500,
      headers: { 'content-type': ['text/plain; charset=utf-8'] },
      body: new TextEncoder().encode(String(error?.stack ?? error)),
    });
  }
}

async function runPhp(php, code) {
  const response = await php.run({ code: `<?php ${code}` });

  if (response.exitCode !== 0 || response.errors) {
    throw new Error(`PHP failed: ${response.errors || response.text}`);
  }

  return response;
}

async function download(url) {
  progress('Downloading Joomla');

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
