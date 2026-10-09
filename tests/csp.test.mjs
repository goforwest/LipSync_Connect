// The CSP is defined in three places that must stay in sync: the Vercel
// header, the index.html meta tag (no frame-ancestors there — the directive
// is ignored in meta per spec), and the dev server header. The firmware
// update check added `connect-src` for the GitHub release API + CDN redirect
// hops; this test pins all three to the same host list so one file can never
// silently drift (a dev-only allowlist would hide a production fetch bug).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function extractConnectSrc(csp) {
  const m = csp.match(/connect-src ([^;]+)/);
  return m ? m[1].trim() : null;
}

function readCspDefinitions() {
  const vercel = JSON.parse(fs.readFileSync(path.join(root, 'app/vercel.json'), 'utf8'));
  const vercelCsp = vercel.headers.find((h) => h.source === '/(.*)').headers.find((h) => h.key === 'Content-Security-Policy').value;
  const html = fs.readFileSync(path.join(root, 'app/index.html'), 'utf8');
  const htmlCsp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)[1];
  const server = fs.readFileSync(path.join(root, 'dev/server.js'), 'utf8');
  const serverCsp = server.match(/'Content-Security-Policy':\s*\n?\s*"([^"]+)"/)[1];
  return { vercelCsp, htmlCsp, serverCsp };
}

test('all three CSP definitions carry the same connect-src host list', () => {
  const { vercelCsp, htmlCsp, serverCsp } = readCspDefinitions();
  const connectSrcs = [vercelCsp, htmlCsp, serverCsp].map(extractConnectSrc);
  assert.ok(connectSrcs.every(Boolean), 'every CSP definition must include connect-src');
  assert.deepEqual(connectSrcs[0], connectSrcs[1]);
  assert.deepEqual(connectSrcs[1], connectSrcs[2]);
});

test('connect-src allows self plus the GitHub API and release-CDN redirect hops', () => {
  const { vercelCsp } = readCspDefinitions();
  const hosts = extractConnectSrc(vercelCsp).split(/\s+/);
  assert.ok(hosts.includes("'self'"));
  assert.ok(hosts.includes('https://api.github.com'));
  assert.ok(hosts.includes('https://github.com'));
  assert.ok(hosts.includes('https://objects.githubusercontent.com'));
  assert.ok(hosts.includes('https://release-assets.githubusercontent.com'));
});

test('CSP stays otherwise locked down (default-src self, no widening)', () => {
  const { vercelCsp, htmlCsp, serverCsp } = readCspDefinitions();
  for (const csp of [vercelCsp, htmlCsp, serverCsp]) {
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(csp.includes('*'), false, 'no wildcards in any CSP definition');
  }
});

test('the meta-tag CSP omits frame-ancestors (ignored in meta) while headers keep it', () => {
  const { vercelCsp, htmlCsp, serverCsp } = readCspDefinitions();
  assert.match(vercelCsp, /frame-ancestors 'none'/);
  assert.match(serverCsp, /frame-ancestors 'none'/);
  assert.equal(/frame-ancestors/.test(htmlCsp), false);
});
