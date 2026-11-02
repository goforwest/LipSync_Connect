// Task-based entry (Home's collapsed More tasks): a plain-language goal opens
// the section that answers it and focuses the exact control — and the
// disconnected case still opens the readable page while hardware controls stay
// disabled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc, windowListeners } = installGatingDom();
await import('../app/js/main.js');
(windowListeners['DOMContentLoaded'] || []).forEach((fn) => fn());
const { getOpenSection, closeCurrentSection } = await import('../app/js/ui/sections.js');
const { testHooks } = await import('./harness/test-hooks.mjs');

const taskBtn = (task) => doc.querySelectorAll('.task-btn').find((b) => b.dataset.task === task);

test('a task opens its section and focuses the answering control', () => {
  testHooks.attach({ simulated: true }, { write() {} });
  taskBtn('clicks').dispatch('click');
  assert.equal(getOpenSection(), 'sec-sip');
  // Focus landed on the fine sip-threshold + stepper.
  const active = doc.activeElement;
  assert.ok(active, 'focus moved');
  assert.equal(active.dataset.target, 'st');
  assert.equal(active.dataset.step, '1');
  // The pulse class is on and clears itself.
  assert.ok(active.classList.contains('pulse-target'));
  testHooks.detach();
});

test('every task maps to a real section', () => {
  testHooks.attach({ simulated: true }, { write() {} });
  for (const task of ['clicks', 'accidents', 'profile', 'update', 'switches']) {
    closeCurrentSection(); // reset between independent task destinations
    taskBtn(task).dispatch('click');
    assert.ok(getOpenSection(), task + ' opened a section');
  }
  testHooks.detach();
});

test('disconnected, a task still opens the readable destination', () => {
  closeCurrentSection();
  taskBtn('clicks').dispatch('click');
  assert.equal(getOpenSection(), 'sec-sip');
});

test('the prominent guided-setup action starts the wizard directly', async () => {
  const { isWizardActive } = await import('../app/js/services/wizard.js');
  doc.getElementById('btnStartWizard').dispatch('click');
  assert.equal(isWizardActive(), true);
  assert.equal(doc.getElementById('wizardPanel').hidden, false);
  // The wizard's own Connect step is the flow's first screen — works while
  // disconnected (no port attached in this test).
  assert.match(doc.getElementById('wizStepText').textContent, /Connect/);
  const { exitWizard } = await import('../app/js/services/wizard.js');
  exitWizard();
});
