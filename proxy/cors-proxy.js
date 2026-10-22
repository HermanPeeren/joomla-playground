// CORS proxy of the Joomla Playground, as a Cloudflare Worker.
//
// The playground runs in the browser, which may only download from hosts that send CORS headers. Joomla's
// downloads (extensions, language packs, updates) and GitHub release assets do not. This worker fetches such a
// file and returns it with CORS headers:
//
//   GET https://<worker>/?url=https%3A%2F%2Fdownloads.joomla.org%2F...
//
// Only GET and HEAD, only https, only the hosts in ALLOWED_HOSTS (also after redirects), at most MAX_BYTES.
// Deploy: see docs/DEVELOPMENT.md. Settings (wrangler.toml [vars], all optional):
//   ALLOWED_ORIGINS  comma-separated origins that may use the proxy, e.g. "https://hermanpeeren.github.io";
//                    default "*" (any)
//   ALLOWED_HOSTS    comma-separated hosts to replace the default list; "*.example.org" includes subdomains
//   MAX_BYTES        largest download, default 50 MB
// A rate limiting binding named RATE_LIMITER (Cloudflare Workers Rate Limiting) limits requests per client IP.

export const DEFAULT_ALLOWED_HOSTS = [
  'downloads.joomla.org',
  'update.joomla.org',
  'extensions.joomla.org',
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'raw.githubusercontent.com',
];

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export default {
  async fetch(request, env = {}) {
    const origin = request.headers.get('origin');
    const allowedOrigin = corsOrigin(origin, env);
    const cors = allowedOrigin
      ? { 'access-control-allow-origin': allowedOrigin, 'access-control-expose-headers': 'content-length, content-type', vary: 'origin' }
      : {};

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: allowedOrigin ? 204 : 403,
        headers: { ...cors, 'access-control-allow-methods': 'GET, HEAD', 'access-control-max-age': '86400' },
      });
    }

    const fail = (status, message) => new Response(`${message}\n`, { status, headers: { ...cors, 'content-type': 'text/plain; charset=utf-8' } });

    if (!allowedOrigin) {
      return fail(403, 'This origin may not use the proxy');
    }

    if (!['GET', 'HEAD'].includes(request.method)) {
      return fail(405, 'Only GET and HEAD');
    }

    if (env.RATE_LIMITER) {
      const { success } = await env.RATE_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') ?? 'unknown' });

      if (!success) {
        return fail(429, 'Too many requests; try again in a minute');
      }
    }

    let target;

    try {
      target = new URL(new URL(request.url).searchParams.get('url') ?? '');
    } catch {
      return fail(400, 'Give the file to download as ?url=<encoded URL>');
    }

    const hosts = allowedHosts(env);

    // Follow redirects here, so every hop is checked against the allowed hosts.
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (target.protocol !== 'https:' || !isAllowedHost(target.hostname, hosts)) {
        return fail(403, `Not an allowed download: ${target.href}`);
      }

      const response = await fetch(target.href, {
        method: request.method,
        redirect: 'manual',
        headers: { 'user-agent': 'Joomla Playground CORS proxy' },
      });

      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get('location')) {
        target = new URL(response.headers.get('location'), target);
        continue;
      }

      const length = Number(response.headers.get('content-length') ?? 0);
      const maxBytes = Number(env.MAX_BYTES ?? DEFAULT_MAX_BYTES);

      if (length > maxBytes) {
        return fail(413, `The file is larger than ${Math.round(maxBytes / 1048576)} MB`);
      }

      const headers = new Headers(cors);

      for (const name of ['content-type', 'content-length', 'content-disposition', 'last-modified', 'etag']) {
        response.headers.has(name) && headers.set(name, response.headers.get(name));
      }

      headers.set('cache-control', response.ok ? 'public, max-age=3600' : 'no-store');

      return new Response(request.method === 'HEAD' ? null : limit(response.body, maxBytes), { status: response.status, headers });
    }

    return fail(508, 'Too many redirects');
  },
};

export function isAllowedHost(hostname, hosts) {
  hostname = hostname.toLowerCase();

  return hosts.some((host) => (host.startsWith('*.') ? hostname.endsWith(host.slice(1)) : hostname === host));
}

function allowedHosts(env) {
  return env.ALLOWED_HOSTS ? env.ALLOWED_HOSTS.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean) : DEFAULT_ALLOWED_HOSTS;
}

function corsOrigin(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS ?? '*').split(',').map((value) => value.trim()).filter(Boolean);

  if (allowed.includes('*')) {
    return '*';
  }

  return origin && allowed.includes(origin) ? origin : null;
}

/**
 * Passes a body through, but stops it after maxBytes (a server may not say how large a file is).
 */
function limit(body, maxBytes) {
  if (!body) {
    return null;
  }

  let seen = 0;

  return body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        seen += chunk.byteLength;

        if (seen > maxBytes) {
          controller.error(new Error('Download too large'));

          return;
        }

        controller.enqueue(chunk);
      },
    })
  );
}
