// Health-check history (services/health-history.js): every run records its
// outcome + step states, the trend row renders colored dots with timestamps
// (and per-step notes) on hover, the list is bounded, malformed storage
// reads as empty, and Clear removes it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc } = installGatingDom();
const { recordHealthRun, renderHealthHistory, resetHealthHistory } =
  await import('../app/js/services/health-history.js');

const dots = () =>
  Array.from(doc.getElementById('healthHistory').children ?? [])
    .filter((c) => c.className.includes('health-dot'))
    .map((c) => ({ cls: c.className, title: c.title }));

test('runs render as a bounded, time-ordered trend of dots', () => {
  doc.getElementById('version').textContent = '4.5.4';
  recordHealthRun('passed', { hcPressure: 'ok', hcJoystick: 'ok', hcNeutral: 'ok', hcCalibration: 'ok', hcBus: 'ok' });
  recordHealthRun('attention', {
    hcPressure: 'ok',
    hcJoystick: 'ok',
    hcNeutral: 'warn',
    hcCalibration: 'ok',
    hcBus: 'ok',
  });
  recordHealthRun('error', {
    hcPressure: 'err',
    hcJoystick: 'running',
    hcNeutral: 'running',
    hcCalibration: 'running',
    hcBus: 'running',
  });
  renderHealthHistory();
  const d = dots();
  assert.equal(d.length, 3);
  assert.match(d[0].cls, /health-dot--ok/);
  assert.match(d[1].cls, /health-dot--warn/);
  assert.match(d[1].title, /Neutral warn/); // the failing step is named in the hover
  assert.match(d[2].cls, /health-dot--err/);
  assert.match(d[2].title, /fw 4\.5\.4/); // the version rode along
});

test('the history is bounded at 20 entries', () => {
  resetHealthHistory();
  for (let i = 0; i < 25; i++) recordHealthRun('passed', {});
  renderHealthHistory();
  const stored = JSON.parse(localStorage.getItem('lipsync-health-history'));
  assert.equal(stored.length, 20);
  assert.equal(dots().length, 20);
});

test('an empty or malformed history renders nothing and never crashes', () => {
  localStorage.setItem('lipsync-health-history', '[{bad');
  renderHealthHistory();
  assert.equal(doc.getElementById('healthHistory').hidden, true);
  assert.equal(dots().length, 0);
});

test('Clear removes the stored history and hides the row', () => {
  recordHealthRun('passed', {});
  renderHealthHistory();
  assert.equal(doc.getElementById('healthHistory').hidden, false);
  resetHealthHistory();
  assert.equal(localStorage.getItem('lipsync-health-history'), null);
  assert.equal(doc.getElementById('healthHistory').hidden, true);
});

test('history dots are focusable and describe their outcome to AT', () => {
  doc.getElementById('version').textContent = '4.5.4';
  recordHealthRun('attention', { hcNeutral: 'warn' });
  renderHealthHistory();
  const dot = Array.from(doc.getElementById('healthHistory').children).find((c) =>
    String(c.className).includes('health-dot'),
  );
  assert.equal(dot.getAttribute('role'), 'img');
  assert.equal(dot.tabIndex, 0);
  assert.match(dot.getAttribute('aria-label'), /Health check attention/);
  assert.match(dot.getAttribute('aria-label'), /Neutral warn/);
});

test('clearing while focused lands focus on the Run health check button', () => {
  recordHealthRun('passed', {});
  renderHealthHistory();
  const clearBtn = Array.from(doc.getElementById('healthHistory').children).find((c) =>
    String(c.className).includes('health-history-clear'),
  );
  clearBtn.focus();
  assert.equal(doc.activeElement, clearBtn);
  resetHealthHistory();
  assert.equal(doc.activeElement?.id, 'btnRunDiagnostics');
});
