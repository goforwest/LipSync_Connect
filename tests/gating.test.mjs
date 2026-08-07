// Behavioral verification of connection-gating: drives the REAL app wiring
// through a stateful DOM stub. Reduced-motion = true so animations apply instantly.
// Connection-gating regression tests: verify Help is the default landing card,
// serial cards dim (but stay readable) until connect, and lifecycle transitions.
// Runs the real js/main.js as an ES module against a stateful DOM stub; no dependencies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testHooks } from './harness/test-hooks.mjs';
import { app, document as doc } from './harness/setup-gating.mjs';

const sec = (id) =>
  Array.from(doc.querySelectorAll('.section-card'))
    .map((el) => ({
      id: el.id,
      open: el.classList.contains('open'),
      cardOff: el.classList.contains('card-off'),
      inert: el.hasAttribute('inert'),
      ariaHidden: el.getAttribute('aria-hidden') ?? null,
    }))
    .find((x) => x.id === id);
const nav = (id) =>
  Array.from(doc.querySelectorAll('.circle-trigger'))
    .map((b) => ({
      section: b.dataset.section,
      dimmed: b.classList.contains('dimmed'),
      active: b.classList.contains('active'),
      ariaDisabled: b.getAttribute('aria-disabled'),
      title: b.title || null,
    }))
    .find((x) => x.section === id);
const sections = () =>
  Array.from(doc.querySelectorAll('.section-card')).map((el) => ({
    id: el.id,
    open: el.classList.contains('open'),
    cardOff: el.classList.contains('card-off'),
    inert: el.hasAttribute('inert'),
    ariaHidden: el.getAttribute('aria-hidden') ?? null,
  }));
const navs = () =>
  Array.from(doc.querySelectorAll('.circle-trigger')).map((b) => ({
    section: b.dataset.section,
    dimmed: b.classList.contains('dimmed'),
    active: b.classList.contains('active'),
    ariaDisabled: b.getAttribute('aria-disabled'),
    title: b.title || null,
  }));
const open = (id) => doc.querySelector('.circle-trigger[data-section="' + id + '"]').dispatch('click');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Initial state (init opened Help itself — no manual open needed)
test('Help is the default-open section on first load', () => {
  assert.equal(sec('sec-help').open, true);
});
test('Help is interactive on first load', () => {
  assert.equal(sec('sec-help').inert, false);
});
test('Device card collapses by default now', () => {
  assert.equal(sec('sec-device').open, false);
});
test('Device card dimmed (card-off) pre-connect', () => {
  assert.equal(sec('sec-device').cardOff, true);
});
test('Log not gated pre-connect', () => {
  assert.equal(sec('sec-log').cardOff, false);
});
test('exactly 8 serial cards gated', () => {
  assert.equal(sections().filter((x) => x.cardOff).length, 8);
});
test('nav dimming correct pre-connect', () => {
  assert.equal(nav('sec-device').dimmed, true);
  assert.equal(nav('sec-help').dimmed, false);
  assert.equal(nav('sec-log').dimmed, false);
});
test('gated serial nav exposes aria-disabled to AT/keyboard', () => {
  assert.equal(nav('sec-device').ariaDisabled, 'true');
});
test('gated serial nav has explanatory tooltip', () => {
  assert.equal(nav('sec-device').title, 'Connect a LipSync device first');
});
test('non-gated nav has no aria-disabled', () => {
  assert.equal(nav('sec-help').ariaDisabled, null);
});

// 2. Pre-connect: serial nav is hard-blocked. Clicking Device does NOT switch
//    the section; Help stays open/active. (Card progress bar remains visible in
//    the markup but nav access waits for a device.)
test('clicking gated serial nav does not open it pre-connect', () => {
  open('sec-device');
  assert.equal(sec('sec-help').open, true);
  assert.equal(sec('sec-device').open, false);
});
test('nav single-highlight stays on Help (device was blocked)', () => {
  assert.equal(nav('sec-help').active, true);
  assert.equal(nav('sec-device').active, false);
});

// 3. Connect: open serial card becomes interactive; gating class lifts everywhere
test('card-off cleared on connect', () => {
  testHooks.attach({ sim: true }, { write() {} });
  app.setConnectedUI(true);
  open('sec-device');
  assert.ok(sections().every((x) => !x.cardOff));
});
test('open Device card interactive after connect', () => {
  assert.equal(sec('sec-device').inert, false);
});
test('closed cards still inert after connect (collapse semantics preserved)', () => {
  assert.equal(sec('sec-sip').inert, true);
});
test('nav undimmed after connect', () => {
  assert.ok(navs().every((x) => !x.dimmed));
});

// 4. Normal open/close still toggles inert as before while connected
test('inert still follows open/close when connected', () => {
  open('sec-sip');
  assert.equal(sec('sec-sip').inert, false);
  assert.equal(sec('sec-device').inert, true);
});

// 5. Disconnect with Sip&Puff open: re-gates, user keeps their place, Help unaffected
test('open serial card re-dimmed but readable on disconnect', () => {
  testHooks.detach();
  app.setConnectedUI(false);
  assert.equal(sec('sec-sip').cardOff, true);
  assert.equal(sec('sec-sip').inert, false);
});
test('open card stays visibly open (not yanked away)', () => {
  assert.equal(sec('sec-sip').open, true);
});
test('nav position preserved and re-dimmed', () => {
  assert.equal(nav('sec-sip').active, true);
  assert.equal(nav('sec-sip').dimmed, true);
});
test('Help unaffected by disconnect', () => {
  assert.equal(sec('sec-help').cardOff, false);
});

// ---- Self-test button lockout (RT LED/buzzer) ----
// Smoke-test log showed firmware narrates test steps unprefixed for ~20s after
// acking RT,1:* — so after the RT ack, BOTH buttons must stay locked until the
// firmware's terminal "Test Complete" line, or the next command hits narration
// in flight and can wedge (observed: FAI...SETTINGSSETTINGS desync).
function openDiagAndConnect() {
  open('sec-diagnostics');
  testHooks.attach({ sim: true }, { write() {} });
  app.setConnectedUI(true);
}

test('RT buttons enabled after connect', () => {
  openDiagAndConnect();
  const st = {
    ledsDisabled: doc.getElementById('btnTestLeds').disabled,
    buzzerDisabled: doc.getElementById('btnTestBuzzer').disabled,
  };
  assert.equal(st.ledsDisabled, false);
  assert.equal(st.buzzerDisabled, false);
});
test('both RT buttons lock together', () => {
  app.lockSelfTestButtons();
  const st = {
    ledsDisabled: doc.getElementById('btnTestLeds').disabled,
    buzzerDisabled: doc.getElementById('btnTestBuzzer').disabled,
  };
  assert.equal(st.ledsDisabled, true);
  assert.equal(st.buzzerDisabled, true);
});
test('lock state engaged', () => {
  assert.equal(testHooks.isLocked(), true);
});
// Mid-narration lines must NOT release the lock early
test('random narration lines do not release the lock', () => {
  app.handleLine('TEST_MODE_LED: Left LED ON');
  assert.equal(testHooks.isLocked(), true);
});
// Terminal firmware message releases it after a short dwell (the last narration
// bullet and the "Test Complete" line arrive back-to-back; dwell keeps the
// buttons locked while the final state is visible on the panel).
test('terminal "Test Complete" line keeps buttons locked during dwell', () => {
  app.handleLine('Test Complete');
  const st = {
    ledsDisabled: doc.getElementById('btnTestLeds').disabled,
    buzzerDisabled: doc.getElementById('btnTestBuzzer').disabled,
  };
  assert.equal(st.ledsDisabled, true);
  assert.equal(st.buzzerDisabled, true);
});
test('lockout still engaged during dwell (via pending unlock)', () => {
  assert.equal(testHooks.isLocked(), true);
});
test('buttons unlock after the dwell expires', async () => {
  await sleep(900);
  const st = {
    ledsDisabled: doc.getElementById('btnTestLeds').disabled,
    buzzerDisabled: doc.getElementById('btnTestBuzzer').disabled,
  };
  assert.equal(st.ledsDisabled, false);
  assert.equal(st.buzzerDisabled, false);
});
test('lockout fully cleared after dwell', () => {
  assert.equal(testHooks.isLocked(), false);
});

// Narration drives the step panel through the real narration hook
test('narration without an active test is ignored gracefully', () => {
  testHooks.attach({ sim: true }, { write() {} });
  app.lockSelfTestButtons();
  app.handleLine(''); // no-op to settle any pending line
  // advanceSelfTest early-returns when selfTestMode is null
  app.handleLine('TEST_MODE_LED: Left LED ON');
  assert.equal(testHooks.selfTestState().mode, null);
  app.unlockSelfTestButtons();
});

// Assert that narration text never enters the corrupt-drop log path (log-err class),
// whether or not a test is running. The '<<' RX receipt log line is expected.
test('TEST_MODE_* narration does not log as "undecodable" when no test is active', () => {
  const logBox = doc.getElementById('log');
  logBox.children.length = 0;
  app.handleLine('TEST_MODE_BUZZER: Playing error sound.');
  assert.equal(logBox.children.filter((c) => c.className === 'log-err').length, 0);
});
test('TEST_MODE_* narration does not log as "undecodable" during an active test', () => {
  const logBox = doc.getElementById('log');
  logBox.children.length = 0;
  app.lockSelfTestButtons(); // simulate an active self-test whose narration is being consumed
  app.handleLine('TEST_MODE_LED: Micro LED Blue');
  assert.equal(logBox.children.filter((c) => c.className === 'log-err').length, 0);
  app.unlockSelfTestButtons();
});

// Stale health results must not survive a disconnect — driven through the real
// module-level disconnect() (which calls clearHealthResults in its finally).
test('disconnect clears stale health-check grid + summary', async () => {
  const hcGrid = doc.getElementById('healthGrid');
  hcGrid.hidden = false;
  doc.getElementById('healthSummary').textContent = 'Passed';
  testHooks.attach({ sim: true }, { write() {} });
  await app.disconnect({ preserveBanner: true, quiet: true });
  assert.equal(hcGrid.hidden, true);
  assert.equal(doc.getElementById('healthSummary').textContent, 'Not run');
});
