// Guided setup wizard (services/wizard.js): resume-from-reality semantics
// (start re-evaluates every step and lands where the device actually is),
// auto-advance on observed state (connected readouts, calibration status,
// health summary), the manual thresholds step, and exit/cancel behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc, windowListeners } = installGatingDom();
await import('../app/js/main.js'); // DOMContentLoaded wiring first
(windowListeners['DOMContentLoaded'] || []).forEach((fn) => fn());
const { startWizard, exitWizard, isWizardActive } = await import('../app/js/services/wizard.js');
const { modeState } = await import('../app/js/state/modes.js');
const { getLogHistory } = await import('../app/js/services/log.js');
const { testHooks } = await import('./harness/test-hooks.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stepText = () => doc.getElementById('wizStepText').textContent;

test('starting on a fully-ready device resumes past every detectable step', async () => {
  // Reality: connected, calibrated, health passed — only the judgment-call
  // thresholds step remains manual.
  testHooks.attach({ simulated: true }, { write() {} });
  doc.getElementById('version').textContent = '4.5.4';
  doc.getElementById('calStatus').textContent = 'Calibration complete ✓ All four corners verified.';
  doc.getElementById('healthSummary').textContent = 'Passed';
  startWizard();
  assert.ok(isWizardActive());
  assert.match(stepText(), /Step 3 of 4 \u2014 Thresholds/);
  // The manual step advances on Next, then verify is already satisfied: the
  // next poll lands the wizard on complete.
  doc.getElementById('wizNext').dispatch('click');
  await sleep(650);
  assert.match(stepText(), /Guided setup complete/);
  // The steps list carries the visual history.
  assert.ok(doc.querySelector('.wiz-steps li[data-step="connect"]').classList.contains('done'));
  exitWizard();
  assert.equal(isWizardActive(), false);
  assert.equal(doc.getElementById('wizardPanel').hidden, true);
  testHooks.detach();
});

test('a blank device starts at Connect and auto-advances when the settings load', async () => {
  testHooks.attach({ simulated: true }, { write() {} });
  // Reset the step signals — the shared DOM carries the previous test's
  // ready-device state.
  doc.getElementById('version').textContent = '\u2014';
  doc.getElementById('calStatus').textContent = '';
  doc.getElementById('healthSummary').textContent = 'Not run';
  startWizard();
  assert.match(stepText(), /Step 1 of 4 \u2014 Connect/);
  // Simulate the load landing: version + calibration state appear.
  doc.getElementById('version').textContent = '4.5.4';
  await sleep(650);
  assert.match(stepText(), /Step 2 of 4 \u2014 Calibrate/);
  doc.getElementById('calStatus').textContent = 'Calibration complete ✓';
  await sleep(650);
  assert.match(stepText(), /Step 3 of 4 \u2014 Thresholds/);
  exitWizard();
  testHooks.detach();
});

test('the action button runs the step affordance', () => {
  testHooks.attach({ simulated: true }, { write() {} });
  startWizard();
  // Step 1's action is the connect call — safe to invoke against the stub
  // (the writer swallows it); what matters is the binding fires.
  doc.getElementById('wizAction').dispatch('click');
  exitWizard();
  testHooks.detach();
});

test('the Calibrate step can be skipped for devices used without the joystick', async () => {
  testHooks.attach({ simulated: true }, { write() {} });
  doc.getElementById('version').textContent = '\u2014';
  doc.getElementById('calStatus').textContent = '';
  doc.getElementById('healthSummary').textContent = 'Not run';
  startWizard();
  assert.match(stepText(), /Step 1 of 4 \u2014 Connect/);
  // Connect declares no skip affordance.
  assert.equal(doc.getElementById('wizSkip').hidden, true);
  // Land on Calibrate.
  doc.getElementById('version').textContent = '4.5.4';
  await sleep(650);
  assert.match(stepText(), /Step 2 of 4 \u2014 Calibrate/);
  // renderStep reveals the skip affordance on the step that declares it.
  const skip = doc.getElementById('wizSkip');
  assert.equal(skip.hidden, false);
  assert.match(skip.textContent, /Skip/);
  skip.dispatch('click');
  // The skip advances (never dead-ends on unused hardware) and is recorded.
  assert.match(stepText(), /Step 3 of 4 \u2014 Thresholds/);
  assert.match(getLogHistory().at(-1), /Calibrate skipped in guided setup/);
  exitWizard();
  testHooks.detach();
});

test('an unstarted wizard panel stays hidden', () => {
  assert.equal(doc.getElementById('wizardPanel').hidden, true);
});

// ---- Done-state profile handoff ---------------------------------------------

const seedLoadedSettings = () => {
  const values = {
    speedVal: '7',
    scrollVal: '5',
    accelVal: '3',
    sipVal: '12.50',
    puffVal: '25.00',
    innerDeadzoneVal: '0.10',
    outerDeadzoneVal: '0.90',
    soundModeVal: 'Basic',
    lightModeVal: 'Basic',
    brightnessVal: '8',
    w1Val: '600',
    w2Val: '1000',
    w3Val: '2500',
    // 4.9.1: OM/CM are core endpoints the snapshot requires (a live load
    // always populates them; a failed one fails the snapshot by design).
    opmode: 'Mouse',
    commode: 'USB',
  };
  for (const [id, v] of Object.entries(values)) doc.getElementById(id).textContent = v;
  // (app fix 2026-11-12) OM/CM snapshot values now come from modeState — seed
  // it alongside the DOM, the way a live load does.
  modeState.currentOpMode = '1'; // Mouse
  modeState.currentComMode = '1'; // USB
};

test('the done state offers a zero-typing profile save that lands and latches', async () => {
  testHooks.attach({ simulated: true }, { write() {} });
  seedLoadedSettings();
  doc.getElementById('version').textContent = '4.5.4';
  doc.getElementById('calStatus').textContent = 'Calibration complete ✓';
  doc.getElementById('healthSummary').textContent = 'Passed';
  localStorage.removeItem('lipsync-profiles');
  startWizard();
  doc.getElementById('wizNext').dispatch('click'); // past the manual Thresholds step
  await sleep(650); // verify auto-completes to done
  const action = doc.getElementById('wizAction');
  assert.equal(action.hidden, false);
  assert.equal(action.textContent, 'Save this setup as a profile');
  action.dispatch('click');
  const stored = JSON.parse(localStorage.getItem('lipsync-profiles'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].snapshot.SS, '7'); // the tuned setup, captured
  assert.match(action.textContent, /Saved/);
  assert.equal(action.disabled, true); // latched: one save per run
  // Restarting the flow re-arms the offer (a fresh run may save again).
  exitWizard();
  startWizard();
  doc.getElementById('wizNext').dispatch('click');
  await sleep(650);
  assert.equal(doc.getElementById('wizAction').textContent, 'Save this setup as a profile');
  exitWizard();
  testHooks.detach();
});
