// Entry point for `npm run test:browser-audit`. Boots the dev server (same
// readiness contract as the offline e2e: the child's "listening" line, not a
// port probe), injects the firmware fake, and runs the connected-state +
// viewport audits. Exits non-zero when any check fails; every check prints
// its PASS/FAIL with the probed detail so a failure reads like a bug report.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(dir, '..', '..');
const playwrightIdx = path.join(repoRoot, 'dev', 'node_modules', 'playwright-core', 'index.mjs');
const { chromium } = await import(playwrightIdx);
const chrome = process.env.PLAYWRIGHT_CHROME_EXECUTABLE ?? chromium.executablePath();

const PORT = Number(process.env.BROWSER_AUDIT_PORT ?? 4444);
const ORIGIN = `http://localhost:${PORT}`;

const server = spawn('node', [path.join(repoRoot, 'dev', 'server.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
// Same gate as the e2e: wait for the child's own listening line (an
// EADDRINUSE exit must not be mistaken for a ready port).
let serverExited = false;
let serverError = '';
let listening = false;
server.stderr.on('data', (c) => (serverError += c));
server.on('exit', () => (serverExited = true));
server.stdout.on('data', (c) => {
  if (String(c).includes(`:${PORT}`)) listening = true;
});
const deadline = Date.now() + 5000;
for (;;) {
  if (serverExited) {
    server.kill();
    console.error(
      `dev server exited before becoming ready — is port ${PORT} already in use?` + (serverError ? ` Server said: ${serverError.trim()}` : ''),
    );
    process.exit(1);
  }
  if (listening) break;
  if (Date.now() > deadline) {
    server.kill();
    console.error('dev server did not become ready');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 50));
}
try {
  await fetch(ORIGIN + '/');
} catch {
  server.kill();
  console.error('dev server reported ready but did not answer');
  process.exit(1);
}

const { runConnectedAudit, runViewportAudit } = await import(path.join(dir, 'connected-audit.mjs'));
let failed = 0;
try {
  const opts = { origin: ORIGIN, chromium, executablePath: chrome };
  for (const [name, run] of [
    ['connected-state', runConnectedAudit],
    ['viewport-matrix', runViewportAudit],
  ]) {
    const findings = await run(opts);
    const fails = findings.filter((f) => !f.ok);
    failed += fails.length;
    console.log(`${name}: ${findings.length - fails.length}/${findings.length} checks passed`);
  }
} finally {
  server.kill();
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll browser-audit checks passed');
process.exit(failed ? 1 : 0);
