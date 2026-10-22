// Main page of the Joomla Playground: registers the service worker, starts the PHP worker, shows Joomla in an
// iframe and offers saving, exporting and importing playgrounds.
//
// ?site=<slug> opens a site saved in this browser; without it, a new temporary playground starts, set up by the
// blueprint in the URL if there is one (see blueprint.js).

import { deleteSite, freeSlug, isSiteOpen, listSites, renameSite } from './storage.js';
import { blueprintFromUrl } from './blueprint.js';
import { parseMail } from './mail.js';

const base = new URL('./', location.href);

// A CORS proxy for downloads of blueprints, set at build time: VITE_CORS_PROXY=https://proxy.example.org/?url=
const corsProxy = import.meta.env.VITE_CORS_PROXY || null;

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
  mail: document.querySelector('#mail'),
  mailCount: document.querySelector('#mail-count'),
  mailDialog: document.querySelector('#mail-dialog'),
  mailList: document.querySelector('#mail-list'),
  mailHeaders: document.querySelector('#mail-headers'),
  mailView: document.querySelector('#mail-view'),
};

let worker = null;
let playground = null;
const pending = new Map();
let nextId = 1;

/** The mails the running playground sent, newest first. */
let mails = [];
let selectedMail = null;

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', isError);
}

function setBusy(busy) {
  for (const button of [elements.site, elements.admin, elements.newSite, elements.save, elements.exportSite, elements.importSite, elements.mail]) {
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
  mails = [];
  selectedMail = null;
  renderMails();
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      setStatus(data.message);
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
  elements.frame.src = 'about:blank';
  startWorker();

  const scope = `scope-${Math.random().toString(36).slice(2, 10)}`;

  playground = await call('boot', { base: base.href, scope, corsProxy, ...options }, transfer);
  show(playground.landingPage ?? '/administrator/');

  if (playground.blueprintError) {
    setStatus(playground.blueprintError, true);
  }

  return playground;
}

function show(path = '/administrator/') {
  const seconds = (playground.timings.ready / 1000).toFixed(1);
  const where = playground.site ? `saved as "${playground.site}"` : 'temporary';

  setStatus(`Ready in ${seconds} s (${where})`);
  elements.credentials.textContent = `${playground.username} / ${playground.password}`;
  elements.info.textContent = `Joomla ${playground.manifest.joomla} · PHP ${playground.phpVersion} (WebAssembly) · ${playground.manifest.driver}`;
  elements.info.title = Object.entries(playground.timings).map(([step, ms]) => `${step}: ${ms} ms`).join('\n');
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

  await boot({ ...(site ? { site } : {}), php: blueprint?.preferredVersions?.php ?? null, blueprint });
}

start().catch((error) => {
  console.error(error);
  setStatus(error.message, true);
});
