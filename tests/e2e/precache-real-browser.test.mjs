// Offline end-to-end check, driven by the real browser: the deployed service
// worker caches every ESM transitively reachable from js/main.js, so a hard
// reload after `Offline` must produce zero network failures. The server here
// is the dev server's, not a fixture — this test exists because the static
// precache URL list in tests/precache.test.mjs can't prove the browser
// actually receives them from cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The E2E driver needs *a* Chromium.
// Prefer PLAYWRIGHT_CHROME_EXECUTABLE when the caller wants control (GitHub CI);
// otherwise ask playwright-core where it installed Chromium for this platform
// ($HOME/Library/Caches/ms-playwright on macOS, $HOME/.cache/ms-playwright on
// Linux — same registry naming across OSes, so the script is portable).
const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(dir, '..', '..');
const playwrightIdx = path.join(repoRoot, 'dev', 'node_modules', 'playwright-core', 'index.mjs');
const { chromium } = await import(playwrightIdx);
const chrome = process.env.PLAYWRIGHT_CHROME_EXECUTABLE ?? chromium.executablePath();

const PORT = 4443;
const ORIGIN = `http://localhost:${PORT}`;

test.before(async () => {
  const server = spawn('node', [path.join(repoRoot, 'dev', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Readiness must be gated on the child's own state, not on the port
  // answering: if the port is already taken (e.g. a developer's own dev
  // server), this child exits with EADDRINUSE and a plain fetch probe would
  // happily talk to the *other* server and validate stale files. We wait for
  // either the "listening" line on stdout (server.js prints it in the listen
  // callback) or the child's exit, and only then probe the port.
  let serverExited = false;
  let serverError = '';
  server.stderr.on('data', (chunk) => {
    serverError += chunk;
  });
  server.on('exit', (code) => {
    serverExited = true;
    server.exitCode = code;
  });
  let listening = false;
  server.stdout.on('data', (chunk) => {
    if (String(chunk).includes(`:${PORT}`)) listening = true;
  });
  const deadline = Date.now() + 5000;
  for (;;) {
    if (serverExited)
      throw new Error(
        `dev server exited (code ${server.exitCode}) before becoming ready — is port ${PORT} already in use?` +
          (serverError ? ` Server said: ${serverError.trim()}` : ''),
      );
    if (listening) break;
    if (Date.now() > deadline) {
      server.kill();
      throw new Error('dev server did not become ready');
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    await fetch(ORIGIN + '/');
  } catch {
    server.kill();
    throw new Error('dev server reported ready but did not answer');
  }
  test.server = server;
});

test.after(() => test.server?.kill());

// The browser drive happens offline because the service-worker registration
// has to persist across navigations — 'Online' at load time, then 'Offline',
// then reload, is the only sequence that proves the cached path works.
test('service worker serves every reachable module offline', async () => {
  const { chromium } = await import(playwrightIdx);
  const browser = await chromium.launch({ headless: true, executablePath: chrome });
  const context = await browser.newContext({
    bypassCSP: false,
    serviceWorkers: 'allow',
  });
  const page = await context.newPage();
  const failures = [];
  page.on('requestfailed', (req) => failures.push(req.url() + '  ' + (req.failure()?.errorText ?? '?')));
  await page.goto(ORIGIN + '/', { waitUntil: 'networkidle' });
  // Confirm the SW actually claimed the page (it has to be active before the
  // offline swap attests anything).
  const swOk = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration('/');
    return !!reg && !!reg.active;
  });
  assert.ok(swOk, 'service worker registered and active');
  // Walk the precache list offline; every fetch for a js/ module must
  // succeed from SW. (Precache.test.mjs checks the files exist; this check
  // proves the browser never has to hit the network to get them.)
  await context.setOffline(true);
  await page.reload({ waitUntil: 'networkidle' });
  assert.deepEqual(failures, [] /* any fetch failure would show here */);
  const appBooted = await page.evaluate(() => {
    const banner = document.getElementById('unsupported');
    return !banner || banner.hidden;
  });
  assert.ok(appBooted, 'app boots offline (unsupported banner stays hidden when modules load)');
  await browser.close();
});
