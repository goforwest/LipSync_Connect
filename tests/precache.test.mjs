// Verifies that every URL in app/service-worker.js's precache ASSETS list
// resolves to a real file on disk. Guards against asset moves/renames that
// leave the service worker pointing at 404s.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(dir, '..', 'app');

const sw = fs.readFileSync(path.join(appDir, 'service-worker.js'), 'utf8');
const cache = sw.match(/const CACHE = '([^']+)'/)?.[1];
const assetsBlock = sw.match(/const ASSETS = \[([\s\S]*?)\];/)?.[1];

const urls = [...(assetsBlock ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
const targetFor = (url) =>
  url === './' ? path.join(appDir, 'index.html') : path.join(appDir, url.replace(/^\.\//, ''));

test('service worker defines a CACHE constant and an ASSETS list', () => {
  assert.ok(cache, 'CACHE constant missing from service-worker.js');
  assert.ok(assetsBlock, 'ASSETS list missing from service-worker.js');
  console.log(`CACHE = ${cache}`);
});

test('every precache URL resolves to a file on disk', () => {
  assert.ok(urls.length > 0, 'ASSETS list is empty');
  for (const url of urls) {
    const exists = fs.existsSync(targetFor(url));
    console.log(`${exists ? 'PASS' : 'FAIL'}  ${url}${url === './' ? '  (= index.html)' : ''}`);
    assert.ok(exists, `precache URL does not resolve to a file on disk: ${url}`);
  }
  console.log(`PASS  all ${urls.length} precache URLs resolve to files on disk.`);
});
