// Post-connect readiness strip (services/readiness.js): the strip derives
// from the live signals — the firmware-update button's visibility, the health
// summary's state — and hides with the session. "All set ✓" only when
// nothing deserves attention; every chip is a jump-link into its section.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc, windowListeners } = installGatingDom();
await import('../app/js/main.js'); // DOMContentLoaded wiring (app must be loaded first)
(windowListeners['DOMContentLoaded'] || []).forEach((fn) => fn());
const { updateReadiness } = await import('../app/js/services/readiness.js');
const { testHooks } = await import('./harness/test-hooks.mjs');

const strip = () => doc.getElementById('readinessStrip');
const chips = () => Array.from(strip().children ?? []).map((c) => ({ text: c.textContent, cls: c.className, el: c }));
const connected = () => {
  testHooks.attach({ simulated: true }, { write() {} });
  // A real connect undims the nav (updateConnectionGating); the stub stays
  // dimmed from the pre-connect pass otherwise and openSectionById's dimmed
  // guard (correctly) refuses chip-initiated opens.
  doc.querySelectorAll('.circle-trigger').forEach((b) => {
    b.classList.remove('dimmed');
    b.removeAttribute('aria-disabled');
    b.removeAttribute('title');
  });
};

test('green signals render the all-set state', () => {
  connected();
  doc.getElementById('btnStartUpdate').hidden = true;
  doc.getElementById('healthSummary').textContent = 'Passed';
  updateReadiness();
  assert.equal(strip().hidden, false);
  const c = chips();
  assert.equal(c.length, 1);
  assert.match(c[0].text, /All set/);
  assert.match(c[0].cls, /ready-chip--ok/);
  testHooks.detach();
});

test('an available firmware update becomes a jump chip', () => {
  connected();
  doc.getElementById('btnStartUpdate').hidden = false;
  doc.getElementById('fwTargetVersion').textContent = '4.5.4';
  doc.getElementById('healthSummary').textContent = 'Passed';
  updateReadiness();
  const c = chips();
  assert.equal(c.length, 1);
  assert.equal(c[0].text, 'Firmware 4.5.4 available');
  // The chip opens the Firmware card.
  c[0].el.dispatch('click');
  const nav = doc.querySelector('.circle-trigger[data-section="sec-firmware"]');
  assert.equal(nav.getAttribute('aria-expanded'), 'true');
  testHooks.detach();
});

test('health states map: not-run -> info, attention -> warn, passed -> none', () => {
  connected();
  doc.getElementById('btnStartUpdate').hidden = true;
  for (const [summary, wantText, wantCls] of /** @type {[string,string,string][]} */ ([
    ['Not run', 'Health check not run yet', 'ready-chip--info'],
    ['Needs attention', 'Health check needs attention', 'ready-chip--warn'],
    ['Error', 'Health check could not complete', 'ready-chip--warn'],
    ['Passed', null, null],
  ])) {
    doc.getElementById('healthSummary').textContent = summary;
    updateReadiness();
    const c = chips();
    if (wantText === null) {
      assert.equal(c.length, 1, summary + ' contributes no chip');
      assert.match(c[0].text, /All set/);
    } else {
      assert.equal(c.length, 1, summary + ' renders exactly one chip');
      assert.equal(c[0].text, wantText);
      assert.match(c[0].cls, new RegExp(wantCls));
    }
  }
  testHooks.detach();
});

test('no port hides the strip (fresh session, disconnect)', () => {
  connected();
  updateReadiness();
  assert.equal(strip().hidden, false);
  testHooks.detach(); // serialSession.port = null
  updateReadiness();
  assert.equal(strip().hidden, true);
});

test('a running health check contributes no transient chip', () => {
  connected();
  doc.getElementById('btnStartUpdate').hidden = true;
  doc.getElementById('healthSummary').textContent = 'Running…';
  updateReadiness();
  const c = chips();
  assert.match(c[0].text, /All set/); // transient state reads as green
  testHooks.detach();
});

// ---- Profile mismatch chip ---------------------------------------------------

const seedProfile = (snapshot) => {
  localStorage.setItem(
    'lipsync-profiles',
    JSON.stringify([{ id: 1, name: 'Sarah', createdAt: new Date().toISOString(), snapshot }]),
  );
};
const seedLive = (values) => {
  for (const [id, v] of Object.entries(values)) doc.getElementById(id).textContent = v;
};
const mismatchChips = () =>
  chips()
    .filter((c) => c.text.includes('differs from'))
    .map((c) => c.text);

const LIVE = {
  speedVal: '7',
  scrollVal: '5',
  accelVal: '3',
  brightnessVal: '8',
  sipVal: '12.50',
  puffVal: '25.00',
  innerDeadzoneVal: '0.10',
  outerDeadzoneVal: '0.90',
  w1Val: '600',
  w2Val: '1000',
  w3Val: '2500',
  soundModeVal: 'Basic',
  lightModeVal: 'Basic',
};

test('a mostly-in-force profile with one real drift shows the mismatch chip', async () => {
  connected();
  const { updateReadiness } = await import('../app/js/services/readiness.js');
  seedLive(LIVE);
  seedProfile({ SS: '7', SL: '5', AV: '3', LL: '8', ST: '11.00', PT: '25.00' });
  updateReadiness();
  const m = mismatchChips();
  assert.equal(m.length, 1);
  assert.equal(m[0], 'Device differs from \u201cSarah\u201d in 1 setting');
  // Within the coarse stepper granularity, no chip: 12.50 vs 12.30 is a
  // rounding distance, not a config change.
  seedProfile({ SS: '7', SL: '5', AV: '3', LL: '8', ST: '12.30', PT: '25.00' });
  updateReadiness();
  assert.equal(mismatchChips().length, 0);
  testHooks.detach();
});

test('an exact match and a wholly-different config are both silent', async () => {
  connected();
  const { updateReadiness } = await import('../app/js/services/readiness.js');
  seedLive(LIVE);
  seedProfile({ SS: '7', SL: '5', AV: '3', LL: '8', ST: '12.50', PT: '25.00' });
  updateReadiness();
  assert.equal(mismatchChips().length, 0); // in force
  seedProfile({ SS: '2', SL: '2', AV: '0', LL: '3', ST: '4.00', PT: '5.00' });
  updateReadiness();
  assert.equal(mismatchChips().length, 0); // someone else's config entirely
  testHooks.detach();
});

test('thin profiles are not judgeable — no chip below six comparable keys', async () => {
  connected();
  const { updateReadiness } = await import('../app/js/services/readiness.js');
  seedLive(LIVE);
  seedProfile({ SS: '7', ST: '4.00', PT: '5.00' }); // only 3 comparable
  updateReadiness();
  assert.equal(mismatchChips().length, 0);
  testHooks.detach();
});

test('feedback modes compare by label, restrictions by checkbox state', async () => {
  connected();
  const { updateReadiness } = await import('../app/js/services/readiness.js');
  seedLive(LIVE);
  doc.getElementById('sapDisabled').checked = true;
  seedProfile({
    SS: '7',
    SL: '5',
    AV: '3',
    LL: '8',
    ST: '12.50',
    PT: '25.00',
    SM: '1',
    LM: '1',
    SD: '0', // expects sound/light Basic (in force) + restriction OFF (live: ON)
  });
  updateReadiness();
  const m = mismatchChips();
  assert.equal(m.length, 1);
  assert.match(m[0], /in 1 setting/); // only the restriction differs
  testHooks.detach();
});
