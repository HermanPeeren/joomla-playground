// Main page of the Joomla Playground: registers the service worker, starts the PHP worker, shows Joomla in an
// iframe and offers saving, exporting and importing playgrounds.
//
// ?site=<slug> opens a site saved in this browser; without it, a new temporary playground starts.

import { deleteSite, freeSlug, isSiteOpen, listSites } from './storage.js';

const base = new URL('./', location.href);

const elements = {
  status: document.querySelector('#status'),
  frame: document.querySelector('#joomla'),
  site: document.querySelector('#open-site'),
  admin: document.querySelector('#open-admin'),
  newSite: document.querySelector('#new-site'),
  save: document.querySelector('#save-site'),
  exportSite: document.querySelector('#export-site'),
  importSite: document.querySelector('#import-site'),
  importFile: document.querySelector('#import-file'),
  sitesMenu: document.querySelector('#sites-menu'),
  sitesList: document.querySelector('#sites-list'),
  credentials: document.querySelector('#credentials'),
  info: document.querySelector('#info'),
};

let worker = null;
let playground = null;
const pending = new Map();
let nextId = 1;

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', isError);
}

function setBusy(busy) {
  for (const button of [elements.site, elements.admin, elements.newSite, elements.save, elements.exportSite, elements.importSite]) {
    button.disabled = busy;
  }

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
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      setStatus(data.message);
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
  elements.frame.src = 'about:blank';
  startWorker();

  const scope = `scope-${Math.random().toString(36).slice(2, 10)}`;

  playground = await call('boot', { base: base.href, scope, ...options }, transfer);
  show();

  return playground;
}

function show() {
  const seconds = (playground.timings.login / 1000).toFixed(1);
  const where = playground.site ? `saved as "${playground.site}"` : 'temporary';

  setStatus(`Ready in ${seconds} s (${where})`);
  elements.credentials.textContent = `${playground.username} / ${playground.password}`;
  elements.info.textContent = `Joomla ${playground.manifest.joomla} · PHP ${playground.phpVersion} (WebAssembly) · ${playground.manifest.driver}`;
  elements.info.title = Object.entries(playground.timings).map(([step, ms]) => `${step}: ${ms} ms`).join('\n');
  elements.frame.src = new URL('administrator/', `${playground.siteUrl}/`).href;
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
    const result = await boot({ zip: bytes }, [bytes]);
    const from = result.importedFrom;

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
    const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Delete' });

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

    item.append(open, details, remove);
    elements.sitesList.append(item);
  }
}

async function start() {
  if (!('serviceWorker' in navigator)) {
    throw new Error('This browser does not support service workers (they need HTTPS or localhost).');
  }

  setStatus('Starting the service worker');
  await navigator.serviceWorker.register(new URL('sw.js', base), { scope: base.pathname });
  await navigator.serviceWorker.ready;

  elements.site.onclick = () => (elements.frame.src = `${playground.siteUrl}/`);
  elements.admin.onclick = () => (elements.frame.src = `${playground.siteUrl}/administrator/`);
  elements.newSite.onclick = () => (location.href = base.pathname);
  elements.save.onclick = saveSite;
  elements.exportSite.onclick = exportSite;
  elements.importSite.onclick = () => elements.importFile.click();
  elements.importFile.onchange = () => elements.importFile.files[0] && importSite(elements.importFile.files[0]);
  elements.sitesMenu.ontoggle = () => elements.sitesMenu.open && renderSites();

  const site = new URLSearchParams(location.search).get('site');

  await boot(site ? { site } : {});
}

start().catch((error) => {
  console.error(error);
  setStatus(error.message, true);
});
