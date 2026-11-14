import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(dir, '..', '..');
const { chromium } = await import(path.join(dir, '..', 'node_modules', 'playwright-core', 'index.mjs'));
const server = spawn('node', [path.join(repoRoot, 'dev', 'server.js')], { env: { ...process.env, PORT: '4454' }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1500 } });
const page = await ctx.newPage();
await page.route('**api.github.com**', (r) => r.abort());
await page.addInitScript({ path: path.join(dir, 'fake-firmware.mjs') });
await page.goto('http://localhost:4454/', { waitUntil: 'networkidle' });
await page.evaluate(() => document.getElementById('btnConnect')?.click());
await page.waitForFunction(() => document.getElementById('status').textContent === 'Connected', null, { timeout: 20000 });
await page.waitForTimeout(500);
await page.evaluate(() => document.querySelector('.circle-trigger[data-group="adjust"]')?.click());
await page.waitForTimeout(150);
await page.evaluate(() => document.querySelector('.section-tab[data-section="sec-sip"]')?.click());
await page.waitForTimeout(500);
const card = await page.$('#sec-sip');
// idle shot (no stream): pale zones, inline rows
await card.screenshot({ path: '/tmp/sip-idle2.png' });
// hold shot: Watch holds ON, catch a mid-hold frame
await page.evaluate(() => document.getElementById('btnWatchHolds')?.click());
await page.waitForTimeout(600);
// the fake cycles 2s holds / 2s gaps; poll for a mid-hold frame in the LONG window if possible
for (let i = 0; i < 20; i++) {
  const state = await page.evaluate(() => {
    const ladder = document.getElementById('winLadder');
    const zones = [0, 1, 2].map((k) => ladder.children[k]?.classList?.contains('filled') ?? false);
    return { zones, sweep: parseFloat(ladder.children[3]?.style?.width) || 0 };
  });
  if (state.zones[1] && state.sweep > 40 && state.sweep < 95) break;
  await page.waitForTimeout(150);
}
const card2 = await page.$('#sec-sip');
await card2.screenshot({ path: '/tmp/sip-hold.png' });
await browser.close();
server.kill();
console.log('shots saved');
