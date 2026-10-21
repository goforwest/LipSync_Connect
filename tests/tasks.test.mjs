// Task-based entry (Help card's Common tasks): a plain-language goal opens
// the section that answers it and focuses the exact control — and the
// dimmed-guard case (disconnected) opens nothing, leaving the guard's own
// notice as the answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc, windowListeners } = installGatingDom();
await import('../app/js/main.js');
(windowListeners['DOMContentLoaded'] || []).forEach((fn) => fn());
const { getOpenSection, closeCurrentSection } = await import('../app/js/ui/sections.js');
const { testHooks } = await import('./harness/test-hooks.mjs');

const taskBtn = (task) => doc.querySelectorAll('.task-btn').find((b) => b.dataset.task === task);
const undim = () =>
  doc.querySelectorAll('.circle-trigger').forEach((b) => {
    b.classList.remove('dimmed');
    b.removeAttribute('aria-disabled');
    b.removeAttribute('title');
  });

test('a task opens its section and focuses the answering control', () => {
  testHooks.attach({ simulated: true }, { write() {} });
  undim();
  taskBtn('cursor').dispatch('click');
  assert.equal(getOpenSection(), 'sec-cursor');
  // Focus landed on the speed + stepper (the stub records focus targets).
  const active = doc.activeElement;
  assert.ok(active, 'focus moved');
  assert.equal(active.dataset.target, 'speed');
  assert.equal(active.dataset.step, '1');
  // The pulse class is on and clears itself.
  assert.ok(active.classList.contains('pulse-target'));
  testHooks.detach();
});

test('every task maps to a real section', () => {
  testHooks.attach({ simulated: true }, { write() {} });
  undim();
  for (const task of ['cursor', 'clicks', 'accidents', 'health', 'update', 'switches']) {
    closeCurrentSection(); // re-clicking the same section toggles it closed
    taskBtn(task).dispatch('click');
    assert.ok(getOpenSection(), task + ' opened a section');
  }
  testHooks.detach();
});

test('disconnected, the task defers to the dimmed guard — nothing opens', () => {
  // No port: restore the disconnected gating state (previous tests undimmed
  // the shared stub navs) and confirm the guard swallows the task click.
  closeCurrentSection();
  doc.querySelectorAll('.circle-trigger').forEach((b) => {
    if (b.dataset.section !== 'sec-help' && b.dataset.section !== 'sec-log') {
      b.classList.add('dimmed');
      b.setAttribute('aria-disabled', 'true');
    }
  });
  taskBtn('cursor').dispatch('click');
  assert.equal(getOpenSection(), null); // nothing opened — the guard spoke
});

test('the setup task starts the wizard directly — no section navigation', async () => {
  const { isWizardActive } = await import('../app/js/services/wizard.js');
  taskBtn('setup').dispatch('click');
  assert.equal(isWizardActive(), true);
  assert.equal(doc.getElementById('wizardPanel').hidden, false);
  // The wizard's own Connect step is the flow's first screen — works while
  // disconnected (no port attached in this test).
  assert.match(doc.getElementById('wizStepText').textContent, /Connect/);
  const { exitWizard } = await import('../app/js/services/wizard.js');
  exitWizard();
});
