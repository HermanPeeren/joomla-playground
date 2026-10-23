// Service worker of the Joomla Playground.
//
// Requests from the Joomla iframe go to a URL like <playground>/scope-<id>-6-2-0/administrator/: the tab's scope,
// which ends with the Joomla version of its bundle. This worker answers them: media/ files come from that static
// bundle (joomla/6.2.0/media/), everything else is sent over a BroadcastChannel to the PHP worker of the tab that
// owns the scope, which runs Joomla. Media files the bundle does not have, such as those of an extension installed
// in the playground, come from the site's own files, through the PHP worker too.

const channel = new BroadcastChannel('joomla-playground');
const pending = new Map();
const TIMEOUT_MS = 120000;

channel.onmessage = ({ data }) => {
  if (data?.type === 'response' && pending.has(data.id)) {
    pending.get(data.id)(data);
    pending.delete(data.id);
  }
};

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const base = new URL('./', self.registration.scope);

  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
    return;
  }

  const match = url.pathname.substring(base.pathname.length).match(/^(scope-[a-z0-9]+-(\d+)-(\d+)-(\d+))(\/.*)?$/);

  if (!match) {
    return;
  }

  const [, scope, major, minor, patch, path = '/'] = match;

  if (path.startsWith('/media/')) {
    event.respondWith(fromBundle(new URL(`joomla/${major}.${minor}.${patch}${path}${url.search}`, base), path).then((response) => response ?? runInPhp(event.request, scope)));

    return;
  }

  event.respondWith(runInPhp(event.request, scope));
});

/**
 * A media file of the static bundle, or null when the bundle does not have it. (A development server may answer a
 * missing file with its index page instead of a 404.)
 */
async function fromBundle(url, path) {
  const response = await fetch(url);
  const fallbackPage = response.headers.get('content-type')?.includes('text/html') && !/\.html?$/.test(path);

  return response.ok && !fallbackPage ? response : null;
}

async function runInPhp(request, scope) {
  const id = crypto.randomUUID();
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
  const headers = Object.fromEntries(request.headers.entries());

  const response = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, TIMEOUT_MS);

    pending.set(id, (data) => {
      clearTimeout(timer);
      resolve(data);
    });

    channel.postMessage({ type: 'request', id, scope, request: { url: request.url, method: request.method, headers, body } });
  });

  if (!response) {
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Playground stopped</title>'
        + '<p style="font-family:sans-serif">This Joomla Playground is not running any more. Reload the playground page to start a new one.</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  // Navigations do not accept a constructed 3xx response; Response.redirect() makes a real redirect.
  const location = response.headers.location?.[0];

  if ([301, 302, 303, 307, 308].includes(response.status) && location) {
    return Response.redirect(new URL(location, request.url).href, response.status);
  }

  const responseHeaders = new Headers();

  for (const [name, values] of Object.entries(response.headers)) {
    // The PHP worker keeps the cookies; a service worker response cannot set them anyway.
    if (name.toLowerCase() !== 'set-cookie') {
      for (const value of values) {
        responseHeaders.append(name, value);
      }
    }
  }

  const nullBody = [101, 204, 205, 304].includes(response.status);

  return new Response(nullBody ? null : response.body, { status: response.status, headers: responseHeaders });
}
