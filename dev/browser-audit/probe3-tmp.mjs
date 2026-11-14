import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(dir, '..', '..');
const { chromium } = await import(path.join(dir, '..', 'node_modules', 'playwright-core', 'index.mjs'));
const server = spawn('node', [path.join(repoRoot, 'dev', 'server.js')], { env: { ...process.env, PORT: '4455' }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await page.goto('http://localhost:4455/?nocache=' + Date.now(), { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const out = await page.evaluate(() => {
  const row = document.querySelector('.tuning-row--inline');
  if (!row) return { found: false, rowClasses: [...document.querySelectorAll('.tuning-row')].map((r) => r.className) };
  const stepper = row.querySelector('.tuning-stepper');
  const cs = getComputedStyle(row);
  const ss = getComputedStyle(stepper);
  return {
    found: true,
    rowWrap: cs.flexWrap,
    rowWidth: row.getBoundingClientRect().width,
    stepperWidth: stepper.getBoundingClientRect().width,
    stepperDisplay: ss.display,
    stepperFlex: ss.flex,
    stepperWrap: ss.flexWrap,
    stepperInline: [...document.styleSheets].flatMap((sheet) => {
      try { return [...sheet.cssRules]; } catch { return []; }
    }).length
  };
});
const rules = await page.evaluate(() =>
    [...document.styleSheets].flatMap((sheet) => {
      try { return [...sheet.cssRules]; } catch { return []; }
    }).filter((r) => r.selectorText && r.selectorText.includes('tuning-row--inline')).map((r) => r.cssText)
  );
  console.log('MATCHING RULES:', JSON.stringify(rules, null, 1));
  console.log(JSON.stringify(out, null, 1));
await browser.close();
server.kill();
