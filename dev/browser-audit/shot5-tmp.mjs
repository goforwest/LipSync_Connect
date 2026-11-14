import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(dir, '..', '..');
const { chromium } = await import(path.join(dir, '..', 'node_modules', 'playwright-core', 'index.mjs'));
const server = spawn('node', [path.join(repoRoot, 'dev', 'server.js')], { env: { ...process.env, PORT: '4457' }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1500 } });
const page = await ctx.newPage();
await page.route('**api.github.com**', (r) => r.abort());
await page.addInitScript({ path: path.join(dir, 'fake-firmware.mjs') });
await page.goto('http://localhost:4457/', { waitUntil: 'networkidle' });
await page.evaluate(() => document.getElementById('btnConnect')?.click());
await page.waitForFunction(() => document.getElementById('status').textContent === 'Connected', null, { timeout: 20000 });
await page.waitForTimeout(500);
await page.evaluate(() => document.querySelector('.circle-trigger[data-group="adjust"]')?.click());
await page.waitForTimeout(150);
await page.evaluate(() => document.querySelector('.section-tab[data-section="sec-sip"]')?.click());
await page.waitForTimeout(500);
await page.evaluate(() => document.getElementById('btnWatchHolds')?.click());
for (let i = 0; i < 30; i++) {
  const s = await page.evaluate(() => {
    const l = document.getElementById('winLadder');
    return { filled: l.children[0]?.classList?.contains('filled'), active: l.children[1]?.classList?.contains?.('active') };
  });
  if (s.filled && s.active) break;
  await page.waitForTimeout(120);
}
const card = await page.$('#sec-sip');
await card.screenshot({ path: '/tmp/sip-hold3.png' });
await browser.close();
server.kill();
console.log('shot saved');
