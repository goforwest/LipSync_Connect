// Service-worker lifecycle behavior beyond the precache file list: activation
// must stay inside LipSync's cache namespace, and stale-while-revalidate must
// keep the worker alive until its background cache write finishes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'app', 'service-worker.js'), 'utf8');
const currentCache = source.match(/const CACHE = '([^']+)'/)?.[1];

function loadWorker({ keys = [], cached = null, network = null, putError = null } = {}) {
  const handlers = {};
  const deleted = [];
  const puts = [];
  let fetches = 0;
  const cache = {
    async addAll() {},
    async put(request, response) {
      if (putError) throw putError;
      puts.push({ request, response });
    },
  };
  const context = {
    URL,
    Promise,
    console,
    Response: { error: () => ({ kind: 'error' }) },
    caches: {
      async keys() {
        return keys;
      },
      async delete(key) {
        deleted.push(key);
        return true;
      },
      async open() {
        return cache;
      },
      async match() {
        return cached;
      },
    },
    async fetch() {
      fetches++;
      return network;
    },
    self: {
      location: { origin: 'https://connect.example' },
      clients: { async claim() {} },
      async skipWaiting() {},
      addEventListener(type, fn) {
        handlers[type] = fn;
      },
    },
  };
  vm.runInNewContext(source, context, { filename: 'service-worker.js' });
  return {
    handlers,
    deleted,
    puts,
    get fetches() {
      return fetches;
    },
  };
}

test('service-worker activation deletes only obsolete LipSync caches', async () => {
  assert.ok(currentCache);
  const worker = loadWorker({ keys: [currentCache, 'lipsync-connect-v1', 'another-app-v9'] });
  let lifetime;
  worker.handlers.activate({ waitUntil: (promise) => (lifetime = promise) });
  await lifetime;
  assert.deepEqual(worker.deleted, ['lipsync-connect-v1']);
});

test('cached asset refresh is tied to the fetch-event lifetime', async () => {
  const cached = { kind: 'cached' };
  const network = { ok: true, clone: () => ({ kind: 'network-clone' }) };
  const worker = loadWorker({ cached, network });
  let lifetime;
  let response;
  worker.handlers.fetch({
    request: { method: 'GET', mode: 'cors', url: 'https://connect.example/js/main.js' },
    waitUntil(promise) {
      lifetime = promise;
    },
    respondWith(promise) {
      response = promise;
    },
  });

  assert.ok(lifetime, 'fetch event received a lifetime extension synchronously');
  assert.equal(await response, cached, 'the cached response still wins immediately');
  await lifetime;
  assert.equal(worker.fetches, 1, 'one shared network refresh ran');
  assert.equal(worker.puts.length, 1, 'the refreshed response reached the cache before the event settled');
});

test('a cache-write failure never masks a valid online response', async () => {
  const network = { ok: true, clone: () => ({ kind: 'network-clone' }) };
  const worker = loadWorker({ network, putError: new Error('quota exceeded') });
  let lifetime;
  let response;
  worker.handlers.fetch({
    request: { method: 'GET', mode: 'cors', url: 'https://connect.example/styles.css' },
    waitUntil(promise) {
      lifetime = promise;
    },
    respondWith(promise) {
      response = promise;
    },
  });

  assert.equal(await response, network, 'the live network response remains usable');
  await lifetime;
  assert.equal(worker.fetches, 1);
  assert.equal(worker.puts.length, 0);
});
