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
const chips = () =>
  Array.from(strip().children ?? []).map((c) => ({ text: c.textContent, cls: c.className, el: c }));
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
