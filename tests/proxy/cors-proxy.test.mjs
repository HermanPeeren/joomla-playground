// Tests of the CORS proxy (proxy/cors-proxy.js) with a fake upstream: no network, no Cloudflare.
// Run: npm run test:proxy

import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import proxy, { isAllowedHost, isAllowedUrl } from '../../proxy/cors-proxy.js';

const realFetch = globalThis.fetch;

/**
 * Replaces fetch with a table of URL => Response factories; records the URLs asked for.
 */
function upstream(routes) {
  const asked = [];

  globalThis.fetch = async (url, init) => {
    asked.push({ url, init });

    const route = routes[url];

    return route ? route() : new Response('not found', { status: 404 });
  };

  return asked;
}

function get(url, { origin = 'https://joomla-projects.github.io', method = 'GET' } = {}) {
  return new Request(`https://proxy.example/?url=${encodeURIComponent(url)}`, { method, headers: { origin } });
}

describe('CORS proxy', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('downloads an allowed file and adds CORS headers', async () => {
    upstream({
      'https://downloads.joomla.org/language/nl-NL.zip': () =>
        new Response('PK zip', { headers: { 'content-type': 'application/zip', 'content-length': '6', 'set-cookie': 'a=b' } }),
    });

    const response = await proxy.fetch(get('https://downloads.joomla.org/language/nl-NL.zip'));

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'PK zip');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('content-type'), 'application/zip');
    assert.equal(response.headers.get('set-cookie'), null);
  });

  test("takes the URL appended to the path, as @php-wasm's tcpOverFetch sends it", async () => {
    const asked = upstream({
      'https://update.joomla.org/language/details6/nl-NL_details.xml?a=1&b=2': () => new Response('<xml/>', { headers: { 'content-type': 'text/xml' } }),
    });

    const response = await proxy.fetch(
      new Request('https://proxy.example/https://update.joomla.org/language/details6/nl-NL_details.xml?a=1&b=2', { headers: { origin: 'https://joomla-projects.github.io' } })
    );

    assert.equal(response.status, 200);
    assert.equal(asked[0].url, 'https://update.joomla.org/language/details6/nl-NL_details.xml?a=1&b=2');
    assert.equal(response.headers.get('x-playground-cors-proxy'), 'true');
    assert.match(response.headers.get('access-control-expose-headers'), /x-playground-cors-proxy/);
    assert.match(response.headers.get('access-control-expose-headers'), /content-disposition/);

    const refused = await proxy.fetch(new Request('https://proxy.example/https://evil.example/x'));

    assert.equal(refused.status, 403);
    assert.equal(refused.headers.get('x-playground-cors-proxy'), 'true');
  });

  test('follows redirects, checking every host', async () => {
    const asked = upstream({
      'https://github.com/owner/repo/releases/download/1.0/ext.zip': () =>
        new Response(null, { status: 302, headers: { location: 'https://objects.githubusercontent.com/file?sig=1' } }),
      'https://objects.githubusercontent.com/file?sig=1': () => new Response('zip'),
      'https://github.com/owner/repo/releases/download/1.0/evil.zip': () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example/file' } }),
    });

    const response = await proxy.fetch(get('https://github.com/owner/repo/releases/download/1.0/ext.zip'));

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'zip');
    assert.equal(asked.length, 2);
    assert.equal(asked[0].init.redirect, 'manual');

    const evil = await proxy.fetch(get('https://github.com/owner/repo/releases/download/1.0/evil.zip'));

    assert.equal(evil.status, 403);
    assert.ok(!asked.some(({ url }) => url.startsWith('https://evil.example')));
  });

  test('refuses other hosts, plain http, other methods and bad URLs', async () => {
    const asked = upstream({});

    assert.equal((await proxy.fetch(get('https://example.org/file.zip'))).status, 403);
    assert.equal((await proxy.fetch(get('http://downloads.joomla.org/file.zip'))).status, 403);
    assert.equal((await proxy.fetch(new Request('https://proxy.example/?url=x', { method: 'POST', body: 'x' }))).status, 405);
    assert.equal((await proxy.fetch(new Request('https://proxy.example/'))).status, 400);
    assert.equal(asked.length, 0);
  });

  test('limits origins when ALLOWED_ORIGINS is set', async () => {
    upstream({ 'https://update.joomla.org/core/list.xml': () => new Response('<xml/>') });

    const env = { ALLOWED_ORIGINS: 'https://joomla-projects.github.io' };
    const allowed = await proxy.fetch(get('https://update.joomla.org/core/list.xml'), env);
    const other = await proxy.fetch(get('https://update.joomla.org/core/list.xml', { origin: 'https://other.example' }), env);
    const preflight = await proxy.fetch(new Request('https://proxy.example/', { method: 'OPTIONS', headers: { origin: 'https://joomla-projects.github.io' } }), env);

    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://joomla-projects.github.io');
    assert.equal(other.status, 403);
    assert.equal(preflight.status, 204);
  });

  test('refuses files that are too large', async () => {
    upstream({ 'https://downloads.joomla.org/big.zip': () => new Response('x'.repeat(20), { headers: { 'content-length': '20' } }) });

    assert.equal((await proxy.fetch(get('https://downloads.joomla.org/big.zip'), { MAX_BYTES: '10' })).status, 413);
  });

  test('applies the rate limiter', async () => {
    upstream({ 'https://downloads.joomla.org/a.zip': () => new Response('a') });

    const env = { RATE_LIMITER: { limit: async () => ({ success: false }) } };

    assert.equal((await proxy.fetch(get('https://downloads.joomla.org/a.zip'), env)).status, 429);
  });

  test('allows only a path of a shared host', () => {
    const entries = ['s3-us-west-2.amazonaws.com/joomla-official-downloads/'];

    assert.ok(isAllowedUrl(new URL('https://s3-us-west-2.amazonaws.com/joomla-official-downloads/x/nl-NL.zip?sig=1'), entries));
    assert.ok(!isAllowedUrl(new URL('https://s3-us-west-2.amazonaws.com/someone-else/file.zip'), entries));
    assert.ok(!isAllowedUrl(new URL('https://s3-us-west-2.amazonaws.com/joomla-official-downloads-evil/file.zip'), entries));
  });

  test('matches wildcard hosts', () => {
    assert.ok(isAllowedHost('cdn.example.org', ['*.example.org']));
    assert.ok(!isAllowedHost('example.org.evil', ['*.example.org']));
    assert.ok(!isAllowedHost('notexample.org', ['*.example.org']));
  });
});
