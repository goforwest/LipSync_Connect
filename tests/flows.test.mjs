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
  'btnSendRaw',
]) {
  init(id, 'cmd').disabled = true;
}
init('rawCommand');
init('btnConnect').disabled = false;

const { document: doc, windowListeners } = installGatingDom(els);
// calSteps' six <li> children exist only after doc is bound.
for (let i = 1; i <= 6; i++) {
  const li = makeEl('li');
  li.dataset.step = String(i);
  doc.getElementById('calSteps').appendChild(li);
}

const app = await import('../app/js/main.js');
const { noteDeviceVersion } = await import('../app/js/serial/commands.js');
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
  noteDeviceVersion('4.1.0'); // Legacy ordered OM/CM/SR is the default test contract
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

test('mode switch: 4.6.4 atomically moves Gamepad to Bluetooth in one MP command', async () => {
  noteDeviceVersion('4.6.4');
  app.handleLine('SUCCESS,0:OM,0:2');
  app.handleLine('SUCCESS,0:CM,0:1');
  const { sent, detach } = launch((text) =>
    text.trim() === 'SETTINGS' ? [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }] : [{ delay: 5, line: 'SUCCESS,0:MP,1:2' }],
  );
  app.setConnectedUI(true);
  const sel = doc.getElementById('operatingMode');
  sel.value = 'mouse-bt';
  sel.dispatch('change');
  await clickAndDrain('btnSetOperatingMode', { confirm: true });
  detach();
  assert.deepEqual(sent, ['SETTINGS\n', 'MP,1:2\n']);
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

test('Bluetooth shortcut uses atomic MP on 4.6.4 when starting in Gamepad', async () => {
  noteDeviceVersion('4.6.4');
  app.handleLine('SUCCESS,0:OM,0:2');
  app.handleLine('SUCCESS,0:CM,0:1');
  const { sent, detach } = launch((text) =>
    text.trim() === 'SETTINGS' ? [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }] : [{ delay: 5, line: 'SUCCESS,0:MP,1:2' }],
  );
  app.setConnectedUI(true);
  await clickAndDrain('btnSwitchBt', { confirm: true });
  detach();
  assert.deepEqual(sent, ['SETTINGS\n', 'MP,1:2\n']);
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
  doc.getElementById('model').textContent = 'LipSync 4'; // pretend a load landed
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
  // The step-5 re-center line is MANUAL on firmware 4.5.2+ (device-initiated
  // center): the calibration's step-5 waiter matches on parse ok, which is
  // true for MANUAL — the flow must complete on it exactly as it did on the
  // old SUCCESS shape (pre-4.5.2 firmware).
  await sleep(200);
  app.handleLine('SUCCESS,0:CA,2:12.00|12.00');
  await sleep(50);
  app.handleLine('SUCCESS,0:CA,3:12.00|-12.00');
  await sleep(50);
  app.handleLine('SUCCESS,0:CA,4:-12.00|-12.00');
  await sleep(50);
  app.handleLine('MANUAL,0:IN,1:0.00|0.00');
  await sleep(2); // verify the in-flight status message arrives (not yet completion text)
  assert.match(doc.getElementById('calStatus').textContent, /hold the mouthpiece still/);
  await sleep(120); // in-await → read-back sendCommand
  detach();
  assert.deepEqual(sent, ['SETTINGS', 'CA,1:1', 'SETTINGS', 'CA,0:0']);
  assert.match(doc.getElementById('calStatus').textContent, /Calibration complete/);
  assert.equal(doc.getElementById('dotC1').hidden, false);
});

test('a boot-straggler MANUAL center line never resolves a pending IN,1:1', async () => {
  // The 4.5.2 wire-hygiene contract, end to end: the firmware's
  // device-initiated centers (boot auto-center, Hub-menu Center Reset) push
  // MANUAL,0:IN,1 — same data, but a command waiter must never match it.
  // The failure this guards: on ≤4.5.1 firmware the boot auto-center could
  // land an UNSOLICITED SUCCESS,0:IN,1 while the app's center-reset request
  // was in flight, falsely resolving the waiter with the boot center's
  // value. Simulate the straggler arriving between the request and its real
  // ack: the reset must resolve on the ACK's value only, and the
  // "Neutral position updated on device." status (reserved for requested
  // resets) must come from the ack, never the push.
  let manualPushed = false;
  const { sent, detach } = launch((text) => {
    if (text === 'SETTINGS') return [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }];
    if (text === 'IN,1:1') {
      // The device's boot auto-center completes mid-exchange (straggler)…
      if (!manualPushed) {
        manualPushed = true;
        return [
          { delay: 2, line: 'MANUAL,0:IN,1:9.99|-9.99' },
          { delay: 8, line: 'SUCCESS,0:IN,1:1.23|-1.55' },
        ];
      }
      return [{ delay: 5, line: 'SUCCESS,0:IN,1:1.23|-1.55' }];
    }
    return [];
  });
  app.setConnectedUI(true);
  await clickAndDrain('btnInit', { settleMs: 150 });
  detach();
  assert.deepEqual(sent, ['SETTINGS', 'IN,1:1']);
  // The request resolved on the real ack, not the straggler.
  assert.equal(doc.getElementById('calStatus').textContent, 'Neutral position set to 1.23|-1.55.');
  assert.equal(doc.getElementById('neutralVal').textContent, '1.23|-1.55');
  assert.ok(!doc.getElementById('calStatus').textContent.includes('9.99'));
  assert.ok(!doc.getElementById('neutralVal').textContent.includes('9.99'));
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
  // Step-5 line in the PRE-4.5.2 shape (SUCCESS): kept deliberately so both
  // wire generations stay covered — the waiter matches on parse ok.
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

// ---- Dead-link diagnosis: open port, zero answers -----------------------

const { getLogHistory } = await import('../app/js/services/log.js');
const getLogHistoryLength = () => getLogHistory().length;

test('a silent port aborts the load early with an honest diagnosis', async () => {
  const sent = [];
  const silentWriter = {
    write(bytes) {
      sent.push(Buffer.from(bytes).toString('utf8'));
      // deliberately no replies — the wedged OS port / frozen device case
    },
  };
  testHooks.attach({ simulated: true }, silentWriter);
  await sleep(30);

  const histStart = getLogHistoryLength();
  click('btnRefreshAll');
  await sleep(9000); // two handshake timeouts (~4 s each) + settle

  const newLines = getLogHistory().slice(histStart);
  const failedLines = newLines.filter((l) => /Failed to load/.test(l));
  assert.equal(failedLines.length, 2, 'the load gives up after two consecutive dead handshakes');
  assert.ok(
    newLines.some((l) => /not responding/.test(l) && /Unplug it, plug it back in/.test(l)),
    'the dead-link diagnosis with recovery guidance is logged',
  );
  assert.ok(!newLines.some((l) => /17 error/.test(l)), 'the misleading 17-errors summary never appears');
  assert.ok(sent.filter((s) => s === 'SETTINGS').length >= 2, 'the handshake was genuinely attempted');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('a close failure during disconnect is logged honestly', async () => {
  testHooks.attach(
    {
      getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8045 }),
      async close() {
        throw new Error('NetworkError: the port is wedged');
      },
    },
    { write() {} },
  );
  const histStart = getLogHistoryLength();
  await app.disconnect({ quiet: true });
  const newLines = getLogHistory().slice(histStart);
  assert.ok(
    newLines.some((l) => /did not close cleanly/.test(l)),
    'the close failure is named instead of swallowed',
  );
  assert.ok(
    newLines.some((l) => /unplug and replug the LipSync or reload the page/.test(l)),
    'the remedy is stated',
  );
  testHooks.detach();
});

test('a wedged close cannot hang disconnect (bounded like every port operation)', async () => {
  const { setPortCloseTimeoutForTests, PORT_CLOSE_TIMEOUT_MS } = await import('../app/js/utils/port-open.js');
  // The production bound is deliberately generous (real macOS closes after a
  // full settings load resolve in 5–20 s — a tight bound declares healthy
  // closes "stalled" and poisons every later flow). Shrink it here so the
  // wedged scenario stays fast; restore before finishing.
  setPortCloseTimeoutForTests(100);
  try {
    testHooks.attach(
      {
        getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8045 }),
        // The OS-level close never settles — the wedged-port pathology.
        // disconnect must still finish (its finally owns the UI reset and
        // waiter cleanup) instead of hanging.
        close() {
          return new Promise(() => {});
        },
      },
      { write() {} },
    );
    const histStart = getLogHistoryLength();
    const settled = await Promise.race([
      app.disconnect({ quiet: true }).then(() => 'settled'),
      sleep(1500).then(() => 'hung'),
    ]);
    assert.equal(settled, 'settled', 'disconnect completes despite the wedged close');
    assert.equal(testHooks.pendingWaiters(), 0, 'waiters were cleaned up by the finally');
    const newLines = getLogHistory().slice(histStart);
    assert.ok(
      newLines.some((l) => /did not close cleanly \(the close stalled\)/.test(l)),
      'the stalled close is named with its remedy',
    );
    testHooks.detach();
  } finally {
    setPortCloseTimeoutForTests(PORT_CLOSE_TIMEOUT_MS);
  }
});

// ---- Raw command console (checklist E3 / upstream #67) --------------------

test('raw command sends EX,0:0 after the handshake; the dump streams into the log', async () => {
  const { sent, detach } = launch((text) =>
    text === 'SETTINGS'
      ? [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }]
      : text === 'EX,0:0'
        ? [
            { delay: 5, line: 'SUCCESS,0:EX,0:BEGIN' },
            { delay: 6, line: 'SUCCESS,0:SA,0:1,4,19' },
            { delay: 7, line: 'SUCCESS,0:EX,0:END' },
          ]
        : [],
  );
  app.setConnectedUI(true);
  doc.getElementById('rawCommand').value = 'EX,0:0';
  await clickAndDrain('btnSendRaw');
  detach();
  assert.deepEqual(sent, ['SETTINGS', 'EX,0:0']);
});

test('raw command rejects empty and malformed input without touching the wire', async () => {
  const { sent, detach } = launch(() => []);
  app.setConnectedUI(true);
  doc.getElementById('rawCommand').value = '   ';
  await clickAndDrain('btnSendRaw');
  doc.getElementById('rawCommand').value = 'hello';
  await clickAndDrain('btnSendRaw');
  doc.getElementById('rawCommand').value = 'ex,0:0';
  await clickAndDrain('btnSendRaw');
  detach();
  assert.deepEqual(sent, []);
});

test('raw state-changing commands keep their confirm: cancel sends nothing', async () => {
  const { sent, detach } = launch((text) =>
    text === 'SETTINGS' ? [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }] : [],
  );
  app.setConnectedUI(true);
  doc.getElementById('rawCommand').value = 'SR,1:1';
  click('btnSendRaw');
  await nextTick();
  click('confirmCancel');
  await sleep(80);
  detach();
  assert.deepEqual(sent, []);
});

test('raw state-changing commands keep their confirm: ok sends the command', async () => {
  const { sent, detach } = launch((text) =>
    text === 'SETTINGS' ? [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }] : [{ delay: 5, line: 'SUCCESS,0:SR,1:1' }],
  );
  app.setConnectedUI(true);
  doc.getElementById('rawCommand').value = 'SR,1:1';
  click('btnSendRaw');
  await nextTick();
  click('confirmOk');
  await sleep(80);
  detach();
  assert.deepEqual(sent, ['SETTINGS', 'SR,1:1']);
});

test("raw command longer than the firmware's 11-character line cap is refused", async () => {
  const { sent } = launch(() => []);
  const logBefore = getLogHistory().length;
  doc.getElementById('rawCommand').value = 'SS,1:123456789';
  await clickAndDrain('btnSendRaw');
  assert.ok(!sent.some((t) => t.includes('SS,1:123456789')), JSON.stringify(sent));
  assert.ok(
    getLogHistory()
      .slice(logBefore)
      .some((entry) => entry.includes('at most 11 characters')),
  );
  doc.getElementById('rawCommand').value = 'EX,0:0';
});

// ---- Exact-value typed Set: the single write gate ----
// An empty or out-of-range draft must never be silently rewritten into a
// boundary value and sent: the Set click refuses inline, the wire stays
// quiet, and the draft stays in the field for the user to fix.

test('typed threshold Set refuses empty and out-of-range drafts without a wire write', async () => {
  const { sent, detach } = launch((text) =>
    text === 'SETTINGS'
      ? [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }]
      : [{ delay: 5, line: `SUCCESS,0:${text.slice(0, 4)}:${text.slice(5)}` }],
  );
  app.setConnectedUI(true);
  doc.getElementById('sapError').textContent = '';
  const before = sent.length;
  doc.getElementById('sipInput').value = '';
  await clickAndDrain('btnSetSip');
  assert.match(doc.getElementById('sapError').textContent, /between 2 and 149\.99/);
  doc.getElementById('sipInput').value = '500';
  await clickAndDrain('btnSetSip');
  assert.match(doc.getElementById('sapError').textContent, /between 2 and 149\.99/);
  detach();
  assert.equal(sent.length, before, 'an invalid draft never reaches the wire');
});

test('typed deadzone Set snaps to the 0.01 grid and refuses the 1.0 ceiling', async () => {
  const { sent, detach } = launch((text) =>
    text === 'SETTINGS'
      ? [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }]
      : [{ delay: 5, line: `SUCCESS,0:${text.slice(0, 4)}:${text.slice(5)}` }],
  );
  app.setConnectedUI(true);
  doc.getElementById('innerDeadzoneVal').textContent = '0.05';
  doc.getElementById('outerDeadzoneVal').textContent = '0.95';
  doc.getElementById('formError').textContent = '';
  // Off-grid drafts snap to the grid the device echoes — 0.1234 cannot
  // round-trip (the firmware would store and echo 0.12), so the app sends
  // 0.12 instead of writing a value it would then report as failed.
  doc.getElementById('innerDeadzone').value = '0.1234';
  await clickAndDrain('btnSetInnerDeadzone');
  assert.ok(sent.some((t) => t.includes('IZ,1:0.12')), JSON.stringify(sent));
  assert.ok(!sent.some((t) => t.includes('0.1234')), JSON.stringify(sent));
  assert.equal(doc.getElementById('innerDeadzoneVal').textContent, '0.12');
  // 1.00 "succeeds" on the wire but the firmware normalizes >= 1.0 back to
  // its defaults on read — the app refuses it up front.
  const sentBefore = sent.length;
  doc.getElementById('formError').textContent = '';
  doc.getElementById('innerDeadzone').value = '1';
  await clickAndDrain('btnSetInnerDeadzone');
  assert.match(doc.getElementById('formError').textContent, /between 0\.01 and 0\.99/);
  detach();
  assert.equal(sent.length, sentBefore, 'the unholdable 1.00 never reaches the wire');
});
