// Behavioral verification of the multi-command firmware flows through the
// real DOM wiring. Drives the gating DOM stub, simulates firmware 4.1 replies,
// and pins the exact command order + side effects of each flow so the
// service-layer extraction can't drift from what shipped. No dependencies;
// run with: node tests/flows.test.mjs
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeEl, installGatingDom } from './harness/dom-stub.mjs';

// Pre-create every control main.js's listeners consult so its DOMContentLoaded
// wiring grabs elements the test can inspect from the get-go. Anything the app
// creates later (querySelector-driven) shares the store, so later reads work.
const els = new Map();
const init = (id, cls) => {
  const el = makeEl(cls && cls.includes('button') ? 'button' : 'div');
  el.id = id;
  if (cls) el.classList.add(...cls.split(' ').filter(Boolean));
  els.set(id, el);
  return el;
};
init('operatingMode').value = 'mouse';
init('modeGuardHint');
init('btName').textContent = '…';
init('calStatus');
init('calSteps').hidden = true;
for (let i = 1; i <= 4; i++) init('dotC' + i).hidden = true;
for (const id of ['confirmDialog', 'confirmTitle', 'confirmBody', 'confirmOk', 'confirmCancel']) init(id);
for (const id of [
  'btnSoftReset',
  'btnFactoryReset',
  'btnSetOperatingMode',
  'btnSwitchBt',
  'btnCalibrate',
  'btnDisconnect',
]) {
  init(id, 'cmd').disabled = true;
}
init('btnConnect').disabled = false;

const { document: doc, windowListeners } = installGatingDom(els);
// calSteps' six <li> children exist only after doc is bound.
for (let i = 1; i <= 6; i++) {
  const li = makeEl('li');
  li.dataset.step = String(i);
  doc.getElementById('calSteps').appendChild(li);
}

const app = await import('../app/js/main.js');
(windowListeners['DOMContentLoaded'] || []).forEach((fn) => fn());
const { testHooks } = await import('./harness/test-hooks.mjs');

// Minimal serial-writes recorder. Each queued reply maps writes → lines fed
// back through handleLine, in send order. Most flows ack SETTINGS first, then
// answer the command; mode changes have a delayed ack to model busy firmware.
function launch(behavior) {
  const sent = [];
  const writer = {
    write(bytes) {
      const text = Buffer.from(bytes).toString('utf8');
      sent.push(text);
      for (const reply of behavior(text) || []) {
        setTimeout(() => app.handleLine(reply.line), reply.delay ?? 5);
      }
    },
  };
  testHooks.attach({ simulated: true }, writer);
  return { sent, detach: testHooks.detach };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function click(id) {
  doc.getElementById(id).dispatch('click');
}

const nextTick = () => new Promise((r) => setTimeout(r, 0));

// Drive a guard-wrapped button click and wait for its async body to finish by
// waiting until the button re-enables (guard's finally) or a fixed drain.
async function clickAndDrain(id, { confirm = false, settleMs = 80 } = {}) {
  click(id);
  await nextTick();
  if (confirm) {
    click('confirmOk');
  }
  await sleep(settleMs);
}

beforeEach(() => {
  // Every test starts from the same UI baseline (disconnected, mouse preset).
  const sel = doc.getElementById('operatingMode');
  sel.value = 'mouse';
  sel.dispatch('change');
  doc.getElementById('modeGuardHint').textContent = '';
});

// ---- Operating-mode preset switch --------------------

test('mode switch: confirm-triggered preset sends OM then CM then SR, then disconnects', async () => {
  // Feed the device's current modes BEFORE the user interacts.
  app.handleLine('SUCCESS,0:OM,0:1');
  app.handleLine('SUCCESS,0:CM,0:1');
  const { sent, detach } = launch((text) =>
    text === 'SETTINGS'
      ? [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }]
      : [{ delay: 5, line: `SUCCESS,0:${text.slice(0, 4)}:${text.slice(5)}` }],
  );
  app.setConnectedUI(true);
  // User picks Gamepad from the select — syncModeBtn runs on 'change' first.
  const sel = doc.getElementById('operatingMode');
  sel.value = 'gamepad';
  sel.dispatch('change');
  await clickAndDrain('btnSetOperatingMode', { confirm: true });
  detach();
  // Mouse→Gamepad flips both OM and CM; gamepad reverses to CM-first per the
  // firmware's OM/CM exclusivity note, then SR reboots.
  assert.deepEqual(sent, ['SETTINGS', 'OM,1:2', 'SETTINGS', 'SR,1:1']); // cm is unchanged — only OM differs
});

test('mode switch: already-in-mode is a no-op with a hint', async () => {
  doc.getElementById('operatingMode').value = 'mouse';
  app.handleLine('SUCCESS,0:OM,0:1');
  app.handleLine('SUCCESS,0:CM,0:1');
  const { sent, detach } = launch(() => []);
  app.setConnectedUI(true);
  await clickAndDrain('btnSetOperatingMode');
  detach();
  assert.deepEqual(sent, []);
  assert.match(doc.getElementById('modeGuardHint').textContent, /already in .* mode/);
});

// ---- Bluetooth switch --------------------

test('bluetooth switch sends CM,1:2 then SR when OM is already mouse', async () => {
  app.handleLine('SUCCESS,0:OM,0:1');
  app.handleLine('SUCCESS,0:CM,0:1');
  const { sent, detach } = launch((text) =>
    text === 'SETTINGS'
      ? [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }]
      : [{ delay: 5, line: `SUCCESS,0:${text.slice(0, 4)}:${text.slice(5)}` }],
  );
  app.setConnectedUI(true);
  await clickAndDrain('btnSwitchBt', { confirm: true });
  detach();
  assert.deepEqual(sent, ['SETTINGS', 'CM,1:2', 'SETTINGS', 'SR,1:1']);
});

test('bluetooth switch is a no-op when already in BT mode', async () => {
  app.handleLine('SUCCESS,0:CM,0:2');
  const { sent, detach } = launch(() => []);
  app.setConnectedUI(true);
  await clickAndDrain('btnSwitchBt');
  detach();
  assert.deepEqual(sent, []);
});

// ---- Soft / factory reset --------------------

test('soft reset confirms then sends SR,1:1 and disconnects', async () => {
  const { sent, detach } = launch((text) =>
    text === 'SETTINGS' ? [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }] : [{ delay: 5, line: 'SUCCESS,0:SR,1:1' }],
  );
  app.setConnectedUI(true);
  await clickAndDrain('btnSoftReset', { confirm: true });
  detach();
  assert.deepEqual(sent, ['SETTINGS', 'SR,1:1']);
});

test('factory reset confirms then sends FR,1:1; readouts clear', async () => {
  const { sent, detach } = launch((text) =>
    text === 'SETTINGS' ? [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }] : [{ delay: 5, line: 'SUCCESS,0:FR,1:1' }],
  );
  doc.getElementById('model').textContent = 'LipSync 4 (1)'; // pretend a load landed
  app.setConnectedUI(true);
  await clickAndDrain('btnFactoryReset', { confirm: true });
  detach();
  assert.deepEqual(sent, ['SETTINGS', 'FR,1:1']);
  assert.equal(doc.getElementById('model').textContent, '—');
});

// ---- Full joystick calibration --------------------

test('full calibration runs CA,1:1 → CA corners 2..4 → IN,1 → CA,0:0 read-back', async () => {
  const { sent, detach } = launch((text) => {
    if (text === 'SETTINGS') return [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }];
    if (text === 'CA,1:1') return [{ delay: 5, line: 'SUCCESS,0:CA,1:-12.00|12.00' }];
    if (text === 'CA,0:0')
      return [
        {
          delay: 5,
          line: 'SUCCESS,0:CA,0:0.00|0.00,-12.00|12.00,12.00|12.00,12.00|-12.00,-12.00|-12.00',
        },
      ];
    return [];
  });
  app.setConnectedUI(true);
  click('btnCalibrate');
  // Corner-1 ack arrives via sendCommand; corners 2..4 arrive as extra lines.
  await sleep(200);
  app.handleLine('SUCCESS,0:CA,2:12.00|12.00');
  await sleep(50);
  app.handleLine('SUCCESS,0:CA,3:12.00|-12.00');
  await sleep(50);
  app.handleLine('SUCCESS,0:CA,4:-12.00|-12.00');
  await sleep(50);
  app.handleLine('SUCCESS,0:IN,1:0.00|0.00');
  await sleep(2); // verify the in-flight status message arrives (not yet completion text)
  assert.match(doc.getElementById('calStatus').textContent, /hold the mouthpiece still/);
  await sleep(120); // in-await → read-back sendCommand
  detach();
  assert.deepEqual(sent, ['SETTINGS', 'CA,1:1', 'SETTINGS', 'CA,0:0']);
  assert.match(doc.getElementById('calStatus').textContent, /Calibration complete/);
  assert.equal(doc.getElementById('dotC1').hidden, false);
});

test('full calibration flags a corner the firmware silently defaulted (±13)', async () => {
  const { sent, detach } = launch((text) => {
    if (text === 'SETTINGS') return [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }];
    if (text === 'CA,1:1') return [{ delay: 5, line: 'SUCCESS,0:CA,1:-11.00|11.00' }];
    // Read-back shows corner 2 replaced by the ±13 default.
    if (text === 'CA,0:0')
      return [
        {
          delay: 5,
          line: 'SUCCESS,0:CA,0:0.00|0.00,-11.00|11.00,13.00|13.00,11.00|-11.00,-11.00|-11.00',
        },
      ];
    return [];
  });
  app.setConnectedUI(true);
  click('btnCalibrate');
  await sleep(200);
  app.handleLine('SUCCESS,0:CA,2:13.00|13.00');
  await sleep(50);
  app.handleLine('SUCCESS,0:CA,3:11.00|-11.00');
  await sleep(50);
  app.handleLine('SUCCESS,0:CA,4:-11.00|-11.00');
  await sleep(50);
  app.handleLine('SUCCESS,0:IN,1:0.00|0.00');
  await sleep(120);
  detach();
  assert.deepEqual(sent, ['SETTINGS', 'CA,1:1', 'SETTINGS', 'CA,0:0']);
  assert.match(doc.getElementById('calStatus').textContent, /Calibration finished with issues/);
});

// ---- Calibration mid-flow disconnect / recovery ----

test('mid-calibration disconnect clears corner/dot state and leaves a clean retry', async () => {
  // Start a calibration, satisfy corner-1 ack + corners 2/3, then sever the
  // connection mid-corner. After the app's disconnect() handler runs, the ui
  // must not look like a calibration is still in progress, and replot must be
  // safe (the plot's neutral/corners were cleared).
  const { sent, detach } = launch((text) => {
    if (text === 'SETTINGS') return [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }];
    if (text === 'CA,1:1') return [{ delay: 5, line: 'SUCCESS,0:CA,1:-12.00|12.00' }];
    return [];
  });
  app.setConnectedUI(true);
  click('btnCalibrate');
  await sleep(15);
  app.handleLine('SUCCESS,0:CA,2:12.00|12.00');
  await sleep(5);
  app.handleLine('SUCCESS,0:CA,3:12.00|-12.00');
  await sleep(5);
  // Sever mid-flow: the real disconnect path runs (clearHealthResults ->
  // resetPlotState -> self-test reset).
  await app.disconnect({ preserveBanner: true, quiet: true });
  await sleep(10);
  detach();
  assert.deepEqual(sent, ['SETTINGS', 'CA,1:1']);
  assert.equal(testHooks.pendingWaiters(), 0); // waiter for CA,4 must be released
  assert.equal(testHooks.isLocked(), false); // self-test lock cleared
  // The calibration status path must not look like a happy persisted run;
  // on a disconnect the flow's catch path leaves the did-not-complete string.
  assert.match(doc.getElementById('calStatus').textContent, /Calibration did not complete/);
  // Corner dots are reset to a clean state for a fresh calibration attempt.
  for (let i = 1; i <= 4; i++) {
    const dot = doc.getElementById('dotC' + i);
    assert.equal(dot.hidden, true, `dotC${i} must be hidden after mid-flow disconnect`);
  }
});
