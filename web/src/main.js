// Main page of the Joomla Playground: registers the service worker, starts the PHP worker and shows Joomla in
// an iframe once it is running.

const base = new URL('./', location.href);
const scope = `scope-${Math.random().toString(36).slice(2, 10)}`;
const siteUrl = new URL(`${scope}/`, base);

const elements = {
  status: document.querySelector('#status'),
  frame: document.querySelector('#joomla'),
  site: document.querySelector('#open-site'),
  admin: document.querySelector('#open-admin'),
  credentials: document.querySelector('#credentials'),
  info: document.querySelector('#info'),
};

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', isError);
}

async function start() {
  if (!('serviceWorker' in navigator)) {
    throw new Error('This browser does not support service workers (they need HTTPS or localhost).');
  }

  setStatus('Starting the service worker');
  await navigator.serviceWorker.register(new URL('sw.js', base), { scope: base.pathname });
  await navigator.serviceWorker.ready;

  const worker = new Worker(new URL('./php-worker.js', import.meta.url), { type: 'module' });

  const result = await new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        setStatus(data.message);
      } else if (data.type === 'ready') {
        resolve(data);
      } else if (data.type === 'error') {
        reject(new Error(data.message));
      }
    };
    worker.onerror = (event) => reject(new Error(event.message || 'The PHP worker failed to start'));
    worker.postMessage({ type: 'boot', base: base.href, scope });
  });

  const seconds = (result.timings.login / 1000).toFixed(1);

  setStatus(`Ready in ${seconds} s`);
  elements.credentials.textContent = `${result.username} / ${result.password}`;
  elements.info.textContent = `Joomla ${result.manifest.joomla} · PHP ${result.phpVersion} (WebAssembly) · ${result.manifest.driver}`;
  elements.info.title = Object.entries(result.timings).map(([step, ms]) => `${step}: ${ms} ms`).join('\n');

  elements.site.onclick = () => (elements.frame.src = siteUrl.href);
  elements.admin.onclick = () => (elements.frame.src = new URL('administrator/', siteUrl).href);
  elements.site.disabled = elements.admin.disabled = false;

  elements.frame.src = new URL('administrator/', siteUrl).href;

  // For tests and debugging.
  window.joomlaPlayground = { siteUrl: siteUrl.href, ...result };
}

start().catch((error) => {
  console.error(error);
  setStatus(error.message, true);
});
