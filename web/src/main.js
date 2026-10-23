// Main page of the Joomla Playground: registers the service worker, starts the PHP worker, shows Joomla in an
// iframe and offers saving, exporting and importing playgrounds.
//
// ?site=<slug> opens a site saved in this browser; without it, a new temporary playground starts, set up by the
// blueprint in the URL if there is one (see blueprint.js).

import { deleteSite, freeSlug, isSiteOpen, listSites, readMeta, renameSite } from './storage.js';
import { PHP_VERSIONS, blueprintFromUrl } from './blueprint.js';
import { parseMail } from './mail.js';

const base = new URL('./', location.href);

// A CORS proxy (proxy/cors-proxy.js) for downloads from hosts without CORS headers, by blueprints and by PHP itself;
// set at build time: VITE_CORS_PROXY=https://joomla-playground-cors-proxy.example.workers.dev/
const corsProxy = import.meta.env.VITE_CORS_PROXY || null;

const elements = {
  status: document.querySelector('#status'),
  loading: document.querySelector('#loading'),
  loadingStatus: document.querySelector('#loading-status'),
  frame: document.querySelector('#joomla'),
  site: document.querySelector('#open-site'),
  admin: document.querySelector('#open-admin'),
  newSite: document.querySelector('#new-site'),
  reset: document.querySelector('#reset-site'),
  php: document.querySelector('#php-version'),
  joomla: document.querySelector('#joomla-version'),
  save: document.querySelector('#save-site'),
  exportSite: document.querySelector('#export-site'),
  importSite: document.querySelector('#import-site'),
  importFile: document.querySelector('#import-file'),
  sitesMenu: document.querySelector('#sites-menu'),
  sitesList: document.querySelector('#sites-list'),
  credentials: document.querySelector('#credentials'),
  info: document.querySelector('#info'),
  mail: document.querySelector('#mail'),
  mailCount: document.querySelector('#mail-count'),
  mailDialog: document.querySelector('#mail-dialog'),
  mailList: document.querySelector('#mail-list'),
  mailHeaders: document.querySelector('#mail-headers'),
  mailView: document.querySelector('#mail-view'),
};

let worker = null;
let playground = null;
let readyStatus = '';
let backgroundStatus = null;

/** The Joomla bundles of this playground: { default: '6.2.0', versions: [manifest, ...] } (joomla/versions.json). */
let bundles = null;
const pending = new Map();
let nextId = 1;

/** The mails the running playground sent, newest first. */
let mails = [];
let selectedMail = null;

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', isError);

  // While the loader shows, it says the same.
  elements.loadingStatus.textContent = message;
  elements.loading.classList.toggle('error', isError);
}

/**
 * Joomla's loader over the Joomla frame while a playground starts, until its first page has loaded.
 */
function setLoading(loading) {
  elements.loading.hidden = !loading;
}

// The loader is Joomla's own web component, from the default bundle (copied there by bin/build-browser-bundles.php).
import(/* @vite-ignore */ new URL('joomla/joomla-core-loader.js', base).href).catch(() => {});

function setBusy(busy) {
  for (const button of [elements.site, elements.admin, elements.newSite, elements.save, elements.exportSite, elements.importSite, elements.mail, elements.php]) {
    button.disabled = busy;
  }

  // A saved site keeps the Joomla version it was made with.
  elements.joomla.disabled = busy || Boolean(playground?.site);

  // A saved site keeps its changes; starting over is for temporary playgrounds.
  elements.reset.disabled = busy || Boolean(playground?.site);

  elements.save.disabled = busy || Boolean(playground?.site);
}

/**
 * Sends an action to the PHP worker and waits for its result.
 */
function call(type, payload = {}, transfer = []) {
  const id = nextId++;

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type, id, ...payload }, transfer);
  });
}

function startWorker() {
  worker?.terminate();
  worker = new Worker(new URL('./php-worker.js', import.meta.url), { type: 'module' });
  mails = [];
  selectedMail = null;
  readyStatus = '';
  backgroundStatus = null;
  renderMails();
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      setStatus(data.message);
    } else if (data.type === 'background') {
      // A blueprint step that runs after the playground is ready (its first messages may come before show()).
      backgroundStatus = data.message;
      readyStatus && setStatus(backgroundStatus ? `${readyStatus} · ${backgroundStatus}` : readyStatus);
    } else if (data.type === 'mail') {
      mails.unshift({ ...parseMail(data.mail.raw), received: data.mail.received });
      renderMails();
    } else if (data.type === 'result' && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);

      pending.delete(data.id);
      data.error ? reject(new Error(data.error)) : resolve(data.value);
    }
  };
  worker.onerror = (event) => {
    for (const { reject } of pending.values()) {
      reject(new Error(event.message || 'The PHP worker failed'));
    }

    pending.clear();
  };
}

/**
 * Starts a playground in a new PHP worker: from the bundle, a saved site or an imported zip.
 */
async function boot(options = {}, transfer = []) {
  setBusy(true);
  setLoading(true);
  elements.frame.src = 'about:blank';
  startWorker();

  // The scope ends with the Joomla version: the service worker serves media files from that bundle.
  const joomla = options.joomla ?? bundles.default;
  const scope = `scope-${Math.random().toString(36).slice(2, 10)}-${joomla.replaceAll('.', '-')}`;

  playground = await call('boot', { base: base.href, scope, corsProxy, ...options, joomla }, transfer);
  show(playground.landingPage ?? '/administrator/');

  if (playground.blueprintError) {
    setStatus(playground.blueprintError, true);
  }

  return playground;
}

function show(path = '/administrator/') {
  const seconds = (playground.timings.ready / 1000).toFixed(1);
  const where = playground.site ? `saved as "${playground.site}"` : playground.prebuilt ? 'temporary, prebuilt demo' : 'temporary';

  readyStatus = `Ready in ${seconds} s (${where})`;
  setStatus(backgroundStatus ? `${readyStatus} · ${backgroundStatus}` : readyStatus);
  elements.credentials.textContent = `${playground.username} / ${playground.password}`;
  elements.info.textContent = `Joomla ${playground.manifest.joomla} · ${playground.manifest.driver}`;
  elements.php.value = playground.phpVersion;
  elements.joomla.value = playground.manifest.joomla;
  elements.info.title = Object.entries(playground.timings).map(([step, ms]) => `${step}: ${ms} ms`).join('\n');
  elements.frame.addEventListener('load', () => setLoading(false), { once: true });
  elements.frame.src = `${playground.siteUrl}${path}`;
  setBusy(false);

  // For tests and debugging.
  window.joomlaPlayground = playground;
}

async function saveSite() {
  const title = prompt('Save this playground in your browser as:', 'My Joomla site');

  if (!title) {
    return;
  }

  setBusy(true);

  try {
    const site = await freeSlug(title);

    // Ask the browser not to evict the saved sites when storage runs low.
    await navigator.storage.persist?.();
    await call('save', { site, title });

    playground.site = site;
    history.replaceState(null, '', `?site=${encodeURIComponent(site)}`);
    show();
  } catch (error) {
    setStatus(error.message, true);
    setBusy(false);
  }
}

async function exportSite() {
  setBusy(true);
  setStatus('Exporting the site');

  try {
    const bytes = await call('exportSite');
    const name = `${playground.site ?? 'joomla-playground'}-${new Date().toISOString().slice(0, 10)}.zip`;
    const link = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([bytes], { type: 'application/zip' })),
      download: name,
    });

    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    show();
  } catch (error) {
    setStatus(error.message, true);
    setBusy(false);
  }
}

async function importSite(file) {
  const bytes = await file.arrayBuffer();

  // An imported site starts as a temporary playground; it can be saved from there.
  history.replaceState(null, '', base.pathname);

  try {
    // An export says which Joomla version it holds: use the bundle of that version, if there is one.
    const from = zipComment(bytes);
    const joomla = bundles.versions.some((bundle) => bundle.joomla === from?.joomla) ? from.joomla : bundles.default;
    const result = await boot({ zip: bytes, joomla }, [bytes]);

    if (from?.joomla && from.joomla !== result.manifest.joomla) {
      setStatus(`Imported a Joomla ${from.joomla} site into the Joomla ${result.manifest.joomla} playground: media files may not match`, true);
    }
  } catch (error) {
    setStatus(`Import failed: ${error.message}`, true);
    setBusy(false);
  }
}

async function renderSites() {
  const sites = await listSites();

  elements.sitesList.replaceChildren();

  if (sites.length === 0) {
    elements.sitesList.append(Object.assign(document.createElement('li'), { className: 'empty', textContent: 'No saved sites yet' }));

    return;
  }

  for (const site of sites) {
    const item = document.createElement('li');
    const open = Object.assign(document.createElement('a'), { href: `?site=${encodeURIComponent(site.slug)}`, textContent: site.title });
    const details = Object.assign(document.createElement('span'), {
      className: 'details',
      textContent: `Joomla ${site.joomla} · ${new Date(site.updated).toLocaleString()}`,
    });
    const actions = Object.assign(document.createElement('span'), { className: 'actions' });
    const rename = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Rename' });
    const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'delete', textContent: 'Delete' });

    rename.onclick = async () => {
      const title = prompt('New name for this site:', site.title)?.trim();

      if (title && title !== site.title) {
        await renameSite(site.slug, title);
        await renderSites();
      }
    };

    remove.onclick = async () => {
      if (await isSiteOpen(site.slug)) {
        alert(`"${site.title}" is open in a tab. Close it first (or start a new playground there).`);

        return;
      }

      if (confirm(`Delete "${site.title}" from this browser? This cannot be undone.`)) {
        await deleteSite(site.slug);
        await renderSites();
      }
    };

    actions.append(rename, remove);
    item.append(open, details, actions);
    elements.sitesList.append(item);
  }
}

/**
 * The Mail button shows how many mails were sent; its dialog lists them and shows the selected one.
 */
function renderMails() {
  elements.mailCount.textContent = mails.length ? String(mails.length) : '';

  if (!elements.mailDialog.open) {
    return;
  }

  elements.mailList.replaceChildren();

  if (mails.length === 0) {
    elements.mailList.append(Object.assign(document.createElement('li'), { className: 'empty', textContent: 'No mail yet. Mails the site sends show up here.' }));
  }

  for (const mail of mails) {
    const item = document.createElement('li');

    item.classList.toggle('selected', mail === selectedMail);
    item.append(
      Object.assign(document.createElement('div'), { className: 'subject', textContent: mail.subject }),
      Object.assign(document.createElement('div'), { className: 'meta', textContent: `To ${mail.to} · ${new Date(mail.received).toLocaleTimeString()}` })
    );
    item.onclick = () => {
      selectedMail = mail;
      renderMails();
    };
    elements.mailList.append(item);
  }

  const mail = selectedMail ?? mails[0];
  const headers = mail ? [['From', mail.from], ['To', mail.to], ['Subject', mail.subject], ['Date', mail.date]] : [];

  elements.mailHeaders.replaceChildren(
    ...headers.flatMap(([name, value]) => [
      Object.assign(document.createElement('dt'), { textContent: name }),
      Object.assign(document.createElement('dd'), { textContent: value }),
    ])
  );

  // An HTML mail is shown in a sandboxed frame without scripts; a text mail as text.
  const content = mail?.html
    ? Object.assign(document.createElement('iframe'), { id: 'mail-html', title: 'Mail', sandbox: '', srcdoc: mail.html })
    : Object.assign(document.createElement('pre'), { id: 'mail-text', textContent: mail?.text ?? '' });

  elements.mailView.replaceChildren(elements.mailHeaders, content);
}

/**
 * Another PHP version: a saved site reopens with it (and keeps it); a temporary playground starts again from the
 * same link with it.
 */
function switchPhp() {
  const version = elements.php.value;
  const url = new URL(location.href);

  if (!playground.site && !confirm(`Start a new playground with PHP ${version}? This one is not saved and will be lost.`)) {
    elements.php.value = playground.phpVersion;

    return;
  }

  url.searchParams.set('php', version);
  location.href = url.href;
}

function switchJoomla() {
  const version = elements.joomla.value;
  const url = new URL(location.href);

  if (!confirm(`Start a new playground with Joomla ${version}? This one is not saved and will be lost.`)) {
    elements.joomla.value = playground.manifest.joomla;

    return;
  }

  url.searchParams.set('joomla', version);
  location.href = url.href;
}

/**
 * The Joomla version to start: a saved site's own, the one a blueprint or ?joomla= asks for (a version or its
 * start, like "5" or "5.4"), or the default.
 */
async function chooseJoomla(site, blueprint) {
  const available = bundles.versions.map((bundle) => bundle.joomla);

  if (site) {
    const meta = await readMeta(site);

    if (!meta || available.includes(meta.joomla)) {
      return { joomla: meta?.joomla ?? bundles.default };
    }

    return { joomla: bundles.default, warning: `This site was made with Joomla ${meta.joomla}, which this playground no longer has: its media files come from Joomla ${bundles.default}` };
  }

  const wanted = blueprint?.preferredVersions?.joomla;

  if (!wanted) {
    return { joomla: bundles.default };
  }

  const joomla = available.find((version) => `${version}.`.startsWith(`${wanted}.`));

  if (!joomla) {
    throw new Error(`Joomla ${wanted} is not available; choose ${available.join(', ')}`);
  }

  return { joomla };
}

/**
 * The JSON comment of a zip (an export of a playground), or null.
 */
function zipComment(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // The end of central directory record: signature, ..., comment length at +20, comment at +22.
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 22 - 65535); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      try {
        return JSON.parse(new TextDecoder().decode(bytes.subarray(offset + 22, offset + 22 + view.getUint16(offset + 20, true))));
      } catch {
        return null;
      }
    }
  }

  return null;
}

/**
 * The newest service worker: after a new deploy, the previous one would not know the bundles' URLs.
 */
async function newestServiceWorker(registration) {
  await registration.update().catch(() => {});

  const pending = registration.installing ?? registration.waiting;

  if (pending) {
    await new Promise((resolve) => {
      pending.addEventListener('statechange', () => ['activated', 'redundant'].includes(pending.state) && resolve());
    });
  }

  await navigator.serviceWorker.ready;
}

/**
 * The prebuilt export of one of the playground's own blueprints (web/dist/demos/, see scripts/build-demos.mjs), when
 * it was made from this version of the blueprint. Not with ?fresh, nor when the URL changes the blueprint.
 *
 * @returns {Promise<{bytes: ArrayBuffer, joomla: string}|null>}
 */
async function prebuiltDemo(blueprint, url) {
  const name = blueprint?.source?.name;
  const changed = ['fresh', 'php', 'joomla', 'url', 'login', 'extension', 'language'].some((key) => url.searchParams.has(key));

  if (!name || changed || url.hash.length > 1) {
    return null;
  }

  try {
    const response = await fetch(new URL(`demos/${name}.json`, base));
    const demo = response.ok ? await response.json() : null;

    if (demo?.blueprint !== blueprint.source.sha256) {
      return null;
    }

    setStatus('Downloading the prebuilt demo');

    const zip = await fetch(new URL(`demos/${name}.zip`, base));

    if (!zip.ok) {
      return null;
    }

    const joomla = bundles.versions.some((bundle) => bundle.joomla === demo.joomla) ? demo.joomla : bundles.default;

    return { bytes: await zip.arrayBuffer(), joomla };
  } catch {
    // No prebuilt demo (e.g. vite's fallback page instead of JSON): run the blueprint.
    return null;
  }
}

function startOver() {
  if (confirm('Throw this playground away and start again from the same link?')) {
    location.reload();
  }
}

async function start() {
  if (!('serviceWorker' in navigator)) {
    throw new Error('This browser does not support service workers (they need HTTPS or localhost).');
  }

  setStatus('Starting the service worker');
  await newestServiceWorker(await navigator.serviceWorker.register(new URL('sw.js', base), { scope: base.pathname }));

  bundles = await (await fetch(new URL('joomla/versions.json', base))).json();
  elements.joomla.replaceChildren(...bundles.versions.map((bundle) => new Option(bundle.joomla, bundle.joomla)));
  elements.joomla.onchange = switchJoomla;

  elements.site.onclick = () => (elements.frame.src = `${playground.siteUrl}/`);
  elements.admin.onclick = () => (elements.frame.src = `${playground.siteUrl}/administrator/`);
  elements.newSite.onclick = () => (location.href = base.pathname);
  elements.reset.onclick = startOver;
  elements.php.replaceChildren(...PHP_VERSIONS.map((version) => new Option(version, version)));
  elements.php.onchange = switchPhp;
  elements.save.onclick = saveSite;
  elements.exportSite.onclick = exportSite;
  elements.importSite.onclick = () => elements.importFile.click();
  elements.importFile.onchange = () => elements.importFile.files[0] && importSite(elements.importFile.files[0]);
  elements.sitesMenu.ontoggle = () => elements.sitesMenu.open && renderSites();
  elements.mail.onclick = () => {
    elements.mailDialog.showModal();
    renderMails();
  };

  // A saved site writes its changes shortly after requests; when the tab is hidden or closed, write them now.
  const flush = () => playground?.site && call('flush').catch(() => {});

  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
  addEventListener('pagehide', flush);

  const url = new URL(location.href);
  const site = url.searchParams.get('site');
  const blueprint = await blueprintFromUrl(url);
  const prebuilt = site ? null : await prebuiltDemo(blueprint, url);

  if (prebuilt) {
    // The site the blueprint makes, exported at build time: start from it, like an import, without the steps.
    await boot(
      { zip: prebuilt.bytes, joomla: prebuilt.joomla, php: blueprint.preferredVersions?.php ?? null, blueprint: { landingPage: blueprint.landingPage, login: blueprint.login, steps: [] } },
      [prebuilt.bytes]
    );
    playground.prebuilt = blueprint.source.name;
    show(playground.landingPage ?? '/administrator/');

    return;
  }

  const { joomla, warning } = await chooseJoomla(site, blueprint);

  await boot({ ...(site ? { site } : {}), joomla, php: blueprint?.preferredVersions?.php ?? null, blueprint });

  if (warning) {
    setStatus(warning, true);
  }

  // A saved site remembers its PHP version: its address needs no ?php any more.
  if (site && url.searchParams.has('php')) {
    history.replaceState(null, '', `?site=${encodeURIComponent(site)}`);
  }
}

start().catch((error) => {
  console.error(error);
  setStatus(error.message, true);
});
