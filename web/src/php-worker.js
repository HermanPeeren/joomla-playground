// PHP worker of the Joomla Playground: runs Joomla in PHP compiled to WebAssembly.
//
// It puts a Joomla site into PHP's in-memory filesystem, points it at this tab's scope URL, sets the Super User
// password, logs in, and answers the requests the service worker sends for that scope. The site comes from:
// - the pre-installed bundle (joomla/site.zip, see bin/build-browser-bundle.php): a temporary playground;
// - a saved site in the browser's private file system (OPFS): the zip it started from plus a snapshot of the files
//   that changed since, rewritten shortly after requests that change files (see storage.js);
// - an imported zip (an export of a playground).
//
// The page talks to it with messages { type, id, ... }; the worker answers { type: 'result', id, value | error }
// and sends { type: 'progress', message } while it works.

import { PHP, PHPRequestHandler } from '@php-wasm/universal';
import { loadWebRuntime } from '@php-wasm/web';
import { journalFSEvents } from '@php-wasm/fs-journal';
import { hasBase, readBase, readMeta, readSnapshot, siteLockName, writeBase, writeMeta, writeSnapshot } from './storage.js';

const DOCUMENT_ROOT = '/var/www/html';
const PHP_VERSION = '8.4';

/** Caches, logs and temporary files: left out of exports and snapshots (a PHP regular expression). */
const SKIP = '#^(tmp|cache|administrator/cache|administrator/logs)/(?!index\\.html$)#';

/**
 * After a form submission (any method but GET and HEAD) that changed files, a snapshot is written before the next
 * request runs. After other requests (sessions, caches) it is written this long after the last one that changed
 * files, and at most this long after the first.
 */
const SNAPSHOT_DELAY = 500;
const SNAPSHOT_MAX_DELAY = 5000;

const channel = new BroadcastChannel('joomla-playground');

/**
 * base:    the zip the site started from; its bytes are kept until the site is saved
 * changes: paths below the document root that changed since the site was unpacked from its base, and the folders
 *          that were renamed (moved with all their files)
 * dirty:   whether files changed since the last snapshot
 *
 * @type {{php: PHP, handler: PHPRequestHandler, manifest: object, password: string, site: string|null,
 *   base: {id: string|null, bytes: Uint8Array|null}, changes: {paths: Set<string>, trees: Set<string>}, dirty: boolean}}
 */
let state = null;

/**
 * Runs PHP requests one after the other. With a single PHP instance, @php-wasm rejects a request that arrives
 * while another one runs (SinglePHPInstanceManager), and pages fire several AJAX requests at once. Snapshots run
 * in this queue too, so no request changes files while one is taken.
 */
let queue = Promise.resolve();

function serialized(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});

  return run;
}

const actions = { boot, save, exportSite, flush };

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
  const meta = site ? await readMeta(site) : null;
  const [php, manifest, files] = await Promise.all([
    loadWebRuntime(PHP_VERSION).then((runtime) => (lap('php'), new PHP(runtime))),
    fetch(new URL('joomla/manifest.json', base)).then((response) => response.json()),
    siteFiles({ base, site, meta, zip }).then((files) => (lap(meta ? 'read' : 'download'), files)),
  ]);

  progress(meta ? 'Opening the saved site' : 'Unpacking Joomla');
  php.mkdir(DOCUMENT_ROOT);
  php.writeFile('/tmp/site.zip', files.bytes);
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
  lap('unpack');

  const changes = { paths: new Set(), trees: new Set() };

  if (files.snapshot) {
    for (const path of await restoreSnapshot(php, files.snapshot)) {
      changes.paths.add(path);
    }

    lap('restore');
  }

  // From here on, note every path below the document root that changes: those go into the snapshots.
  journalFSEvents(php, DOCUMENT_ROOT, (entry) => trackChange(changes, entry));

  const password = meta?.password ?? randomPassword();

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

  state = {
    php,
    handler,
    manifest,
    password,
    site: null,
    base: { id: meta?.base ?? null, bytes: meta ? null : files.bytes },
    changes,
    dirty: false,
  };

  if (site && !meta) {
    await persist(site, title ?? site);
  } else if (meta) {
    state.site = site;
    await writeMeta(site, { ...meta, opened: new Date().toISOString() });
  }

  progress('Logging in');
  await logIn(handler, siteUrl, password);
  lap('login');
  scheduleSnapshot();

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
 * The zip to start from (the bundle, an imported export, or a saved site's base), and a saved site's snapshot.
 */
async function siteFiles({ base, site, meta, zip }) {
  if (!meta) {
    return { bytes: zip ? new Uint8Array(zip) : await download(new URL('joomla/site.zip', base)), snapshot: null };
  }

  if (!meta.base) {
    throw new Error(`The site "${site}" was saved by an earlier version of the playground and cannot be opened`);
  }

  const [bytes, snapshot] = await Promise.all([readBase(meta.base), readSnapshot(site)]);

  if (!bytes) {
    throw new Error(`The files of the site "${site}" are missing in this browser`);
  }

  return { bytes, snapshot };
}

/**
 * Saves the running playground as a site in OPFS. From then on, a snapshot of its changes is written there shortly
 * after requests that change files.
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

/**
 * Writes the base (once per zip), a first snapshot and then meta.json: a site is listed only when it is complete.
 */
async function persist(site, title) {
  progress('Saving the site in this browser');

  const id = await sha256(state.base.bytes);

  if (!(await hasBase(id))) {
    await writeBase(id, state.base.bytes);
  }

  await snapshot(site);
  await writeMeta(site, {
    title,
    password: state.password,
    joomla: state.manifest.joomla,
    driver: state.manifest.driver,
    base: id,
    created: new Date().toISOString(),
  });
  state.base = { id, bytes: null };
  state.site = site;
}

/**
 * Notes a filesystem operation of PHP (see journalFSEvents()) as a changed path, relative to the document root.
 */
function trackChange(changes, { operation, path, toPath, nodeType }) {
  const relative = (absolute) => (absolute?.startsWith(`${DOCUMENT_ROOT}/`) ? absolute.slice(DOCUMENT_ROOT.length + 1) : null);
  const from = relative(path);
  const to = operation === 'RENAME' ? relative(toPath) : null;

  if (from) {
    changes.paths.add(from);
  }

  if (to) {
    changes.paths.add(to);

    if (nodeType === 'directory') {
      changes.trees.add(to);
    }
  }

  if (state && (from || to)) {
    state.dirty = true;
  }
}

let snapshotTimer = null;
let firstChange = 0;

/**
 * Writes a snapshot of a saved site: next in the request queue, or after a quiet moment but not later than
 * SNAPSHOT_MAX_DELAY after the first change, so a busy site is saved too.
 */
function scheduleSnapshot({ now: immediately = false } = {}) {
  if (!state?.site || !state.dirty) {
    return;
  }

  const now = performance.now();

  if (snapshotTimer) {
    clearTimeout(snapshotTimer);
  } else {
    firstChange = now;
  }

  if (immediately) {
    snapshotTimer = null;
    serialized(() => state.dirty && snapshot(state.site)).catch((error) => console.error('Cannot save the site:', error));

    return;
  }

  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    serialized(() => state.dirty && snapshot(state.site)).catch((error) => console.error('Cannot save the site:', error));
  }, Math.max(0, Math.min(SNAPSHOT_DELAY, firstChange + SNAPSHOT_MAX_DELAY - now)));
}

/**
 * The page is hidden or closing: write the pending snapshot now.
 */
async function flush() {
  if (state?.site) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
    await serialized(() => state.dirty && snapshot(state.site));
  }

  return { value: null };
}

/**
 * Zips the changed files (files/<path>) and the deleted paths (deleted.json), and writes the zip to OPFS.
 * Runs in the request queue: no request changes files meanwhile.
 */
async function snapshot(site) {
  const started = performance.now();

  state.dirty = false;

  try {
    state.php.writeFile('/tmp/changes.json', JSON.stringify({ paths: [...state.changes.paths], trees: [...state.changes.trees] }));
    await runPhp(state.php, `
      $root    = '${DOCUMENT_ROOT}';
      $changes = json_decode(file_get_contents('/tmp/changes.json'), true);
      unlink('/tmp/changes.json');
      $zip = new ZipArchive();
      $zip->open('/tmp/snapshot.zip', ZipArchive::CREATE | ZipArchive::OVERWRITE);
      $deleted = [];
      $add = function (string $relative) use ($root, $zip, &$deleted) {
          if (preg_match(${JSON.stringify(SKIP)}, $relative)) {
              return;
          }
          $path = $root . '/' . $relative;
          if (is_file($path)) {
              $zip->addFile($path, 'files/' . $relative);
          } elseif (is_dir($path)) {
              $zip->addEmptyDir('files/' . $relative);
          } else {
              $deleted[] = $relative;
          }
      };
      foreach ($changes['paths'] as $relative) {
          $add($relative);
      }
      foreach ($changes['trees'] as $tree) {
          if (is_dir($root . '/' . $tree)) {
              $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root . '/' . $tree, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::SELF_FIRST);
              foreach ($files as $file) {
                  $add(substr($file->getPathname(), strlen($root) + 1));
              }
          }
      }
      $zip->addFromString('deleted.json', json_encode($deleted));
      $zip->close();
    `);

    const bytes = state.php.readFileAsBuffer('/tmp/snapshot.zip');

    state.php.unlink('/tmp/snapshot.zip');
    await writeSnapshot(site, bytes);
    console.debug(`Snapshot of "${site}": ${bytes.length} bytes in ${Math.round(performance.now() - started)} ms`);
  } catch (error) {
    state.dirty = true;

    throw error;
  }
}

/**
 * Puts a snapshot on top of the unpacked base: removes the deleted paths, writes the changed files.
 *
 * @returns {Promise<string[]>} The paths in the snapshot: the changes of the site so far.
 */
async function restoreSnapshot(php, bytes) {
  php.writeFile('/tmp/snapshot.zip', bytes);

  const response = await runPhp(php, `
    $root = '${DOCUMENT_ROOT}';
    $zip  = new ZipArchive();
    if ($zip->open('/tmp/snapshot.zip') !== true) {
        throw new RuntimeException('Cannot open the snapshot of the site');
    }
    $remove = function (string $path) use (&$remove) {
        if (is_dir($path) && !is_link($path)) {
            foreach (array_diff(scandir($path), ['.', '..']) as $name) {
                $remove($path . '/' . $name);
            }
            rmdir($path);
        } elseif (file_exists($path) || is_link($path)) {
            unlink($path);
        }
    };
    $paths = json_decode((string) $zip->getFromName('deleted.json'), true) ?: [];
    foreach ($paths as $relative) {
        $remove($root . '/' . $relative);
    }
    for ($index = 0; $index < $zip->numFiles; $index++) {
        $name = $zip->getNameIndex($index);
        if (!str_starts_with($name, 'files/')) {
            continue;
        }
        $relative = rtrim(substr($name, 6), '/');
        $path     = $root . '/' . $relative;
        $paths[]  = $relative;
        if (str_ends_with($name, '/')) {
            is_dir($path) || mkdir($path, 0777, true);
            continue;
        }
        if (is_dir($path)) {
            $remove($path);
        }
        is_dir(dirname($path)) || mkdir(dirname($path), 0777, true);
        file_put_contents($path, $zip->getFromIndex($index));
    }
    $zip->close();
    unlink('/tmp/snapshot.zip');
    echo json_encode($paths);
  `);

  return JSON.parse(response.text);
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
      $skip = ${JSON.stringify(SKIP)};
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
  } finally {
    scheduleSnapshot({ now: !['GET', 'HEAD'].includes(String(request.method ?? 'GET').toUpperCase()) });
  }
}

async function runPhp(php, code) {
  const response = await php.run({ code: `<?php ${code}` });

  if (response.exitCode !== 0 || response.errors) {
    throw new Error(`PHP failed: ${response.errors || response.text}`);
  }

  return response;
}

async function sha256(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
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
