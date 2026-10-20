// The generalized steppers (settings-service step/updateStepButtons): the
// typed-number fields became stepper-first — floats snap to their step grid
// (binary drift can never reach the wire), float writes ride fmtApiFloat
// exactly like the exact-value Set buttons, the window steppers delegate to
// setTimingWindow so the short < long < max ordering refusal surfaces in
// sapError instead of a device round-trip, and bounds disable coarse+fine
// alike per value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc } = installGatingDom();
const app = await import('../app/js/main.js');
const { step, updateStepButtons } = await import('../app/js/services/settings-service.js');
const { testHooks } = await import('./harness/test-hooks.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const launch = (replies = {}) => {
  const sent = [];
  const writer = {
    write(bytes) {
      const text = Buffer.from(bytes).toString('utf8').replace(/\r?\n$/, '');
      sent.push(text);
      const reply = replies[text];
      if (reply) setTimeout(() => app.handleLine(reply), 3);
    },
  };
  testHooks.attach({ simulated: true }, writer);
  return sent;
};

test('a threshold fine step snaps to the 0.25 grid and writes fmtApiFloat', async () => {
  const sent = launch({
    SETTINGS: 'SUCCESS,0:SETTINGS',
    'ST,1:12.750': 'SUCCESS,0:ST,1:12.750',
  });
  doc.getElementById('sipVal').textContent = '12.50';
  await step('st', 1);
  assert.ok(sent.includes('ST,1:12.750'), JSON.stringify(sent));
  assert.equal(doc.getElementById('sipVal').textContent, '12.75'); // fmtHpa-normalized display
  testHooks.detach();
});

test('a coarse threshold step moves 1 hPa and the readout follows', async () => {
  const sent = launch({
    SETTINGS: 'SUCCESS,0:SETTINGS',
    'ST,1:13.500': 'SUCCESS,0:ST,1:13.500',
  });
  doc.getElementById('sipVal').textContent = '12.50';
  await step('st', 4); // coarse: 4 × 0.25
  assert.ok(sent.includes('ST,1:13.500'), JSON.stringify(sent));
  testHooks.detach();
});

test('deadzone steps stay on the 0.01 grid despite binary drift', async () => {
  const sent = launch({
    SETTINGS: 'SUCCESS,0:SETTINGS',
    'IZ,1:0.08': 'SUCCESS,0:IZ,1:0.08',
  });
  doc.getElementById('innerDeadzoneVal').textContent = '0.07';
  await step('iz', 1);
  assert.ok(sent.includes('IZ,1:0.08'), JSON.stringify(sent));
  testHooks.detach();
});

test('window steps delegate to the validated write and refuse out-of-order', async () => {
  const sent = launch({
    SETTINGS: 'SUCCESS,0:SETTINGS',
    'WS,1:650': 'SUCCESS,0:WS,1:650',
    'WL,1:950': 'SUCCESS,0:WL,1:950',
  });
  doc.getElementById('w1Val').textContent = '600';
  doc.getElementById('w2Val').textContent = '1000';
  doc.getElementById('w3Val').textContent = '2500';
  await step('ws', 1); // 600 + 50 → 650
  assert.ok(sent.includes('WS,1:650'), JSON.stringify(sent));
  doc.getElementById('w1Val').textContent = '650';
  doc.getElementById('w2Val').textContent = '1000';
  doc.getElementById('w3Val').textContent = '2500';
  await step('wl', -1); // 1000 − 50 → 950, still strictly ordered
  assert.ok(sent.includes('WL,1:950'), JSON.stringify(sent));
  await sleep(10);
  doc.getElementById('w2Val').textContent = '700';
  const sentBefore = sent.length;
  doc.getElementById('sapError').textContent = '';
  await step('wl', -1); // 700 − 50 = 650 == the short window → refused in-app
  assert.match(doc.getElementById('sapError').textContent, /ordered/);
  assert.equal(sent.length, sentBefore, 'no wire write for an out-of-order step');
  testHooks.detach();
});

test('bounds disable the stepper buttons per current value', () => {
  doc.getElementById('outerDeadzoneVal').textContent = '1.00'; // the oz max
  updateStepButtons();
  const ozPlus = doc.querySelector('button[data-target="oz"][data-step="1"]');
  assert.ok(ozPlus.disabled, 'fine + disabled at max');
  assert.ok(!doc.querySelector('button[data-target="oz"][data-step="-1"]').disabled, 'fine − stays live');
  assert.ok(doc.querySelector('button[data-target="oz"][data-step="5"]').disabled, 'coarse + disabled at max');
  doc.getElementById('outerDeadzoneVal').textContent = '0.99';
  updateStepButtons();
  assert.ok(!doc.querySelector('button[data-target="oz"][data-step="1"]').disabled, 'fine + re-enables below max');
});
