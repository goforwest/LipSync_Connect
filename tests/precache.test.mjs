// Verifies that every URL in app/service-worker.js's precache ASSETS list
// resolves to a real file on disk. Guards against asset moves/renames that
// leave the service worker pointing at 404s.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(dir, '..', 'app');

const sw = fs.readFileSync(path.join(appDir, 'service-worker.js'), 'utf8');
const cache = sw.match(/const CACHE = '([^']+)'/)?.[1];
const assetsBlock = sw.match(/const ASSETS = \[([\s\S]*?)\];/)?.[1];
if (!assetsBlock) throw new Error('Could not locate ASSETS list in service-worker.js');

const urls = [...assetsBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]);

let allOk = true;
console.log(`CACHE = ${cache}`);
for (const url of urls) {
  const target = url === './' ? path.join(appDir, 'index.html') : path.join(appDir, url.replace(/^\.\//, ''));
  const exists = fs.existsSync(target);
  console.log(`${exists ? 'PASS' : 'FAIL'}  ${url}${url === './' ? '  (= index.html)' : ''}`);
  if (!exists) allOk = false;
}

if (!allOk) {
  console.error('FAIL: one or more precache URLs do not resolve to a file on disk.');
  process.exit(1);
}
console.log(`PASS  all ${urls.length} precache URLs resolve to files on disk.`);
