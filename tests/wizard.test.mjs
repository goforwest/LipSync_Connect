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

test('an unstarted wizard panel stays hidden', () => {
  assert.equal(doc.getElementById('wizardPanel').hidden, true);
});
