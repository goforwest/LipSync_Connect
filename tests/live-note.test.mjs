// Live-stream note + settings-select writes (the 2026-11-13 consistency
// pass): the Sip & Puff card names the stream that is currently running —
// the device sends one live view at a time, so a paused gauge or timeline
// explains itself — and the sound/light/stream selects write on change with
// revert-to-last-confirmed, enabled only by their device answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc, windowListeners } = installGatingDom();
const app = await import('../app/js/main.js');
(windowListeners['DOMContentLoaded'] || []).forEach((fn) => fn());
const { loadDeviceInfo } = await import('../app/js/services/settings-service.js');
const { testHooks } = await import('./harness/test-hooks.mjs');
const { resetWireNewlineFraming } = await import('../app/js/serial/commands.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, desc, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for: ' + desc);
    await sleep(5);
  }
};

const BASE_RESPONSES = {
  'MN,0': '1',
  'VN,0': '4.4.0',
  'ID,0': 'a1b2c3d4',
  'OM,0': '1',
  'CM,0': '1',
  'SS,0': '5',
  'SL,0': '5',
  'AV,0': '0',
  'ST,0': '3.00',
  'PT,0': '3.00',
  'IZ,0': '0.07',
  'OZ,0': '0.95',
  'IN,0': '0.00|0.00',
  'CA,0': '0.00|0.00,-13.00|13.00,13.00|13.00,13.00|-13.00,-13.00|-13.00',
  'SM,0': '1',
  'LM,0': '1',
  'LL,0': '5',
  'DM,0': '0',
  'SD,0': '0',
  'MA,0': '0',
  'LK,0': '0',
  'CF,0': '0',
  'WS,0': '1000',
  'WL,0': '3000',
  'WM,0': '6000',
};

// 4.4.0 everywhere the version doesn't matter: a 4.7.0 fake would also get
// the switch-jack and hard-band reads, which this fixture doesn't answer —
// every unanswered command stalls the load through its handshake timeout.
function launchDevice({ version = '4.4.0', writeFailures = {} } = {}) {
  const sent = [];
  const responses = { ...BASE_RESPONSES, 'VN,0': version };
  const writer = {
    write(bytes) {
      const text = Buffer.from(bytes)
        .toString('utf8')
        .replace(/\r?\n$/, '');
      sent.push(text);
      const reply = (line) => setTimeout(() => app.handleLine(line), 3);
      if (text === 'SETTINGS') {
        reply('SUCCESS,0:SETTINGS');
        return;
      }
      if (writeFailures[text]) {
        reply(`FAIL,3:${text}`);
        return;
      }
      const write = text.match(/^([A-Z]{2}),1:/);
      if (write) {
        reply(`SUCCESS,0:${text}`);
        return;
      }
      const cmd = text.slice(0, 4);
      if (cmd in responses) reply(`SUCCESS,0:${cmd}:${responses[cmd]}`);
    },
  };
  testHooks.attach({ simulated: true }, writer);
  return sent;
}

const note = () => doc.getElementById('liveStreamNote');

test('the live-stream note names the stream that is running', async () => {
  resetWireNewlineFraming();
  launchDevice();
  await loadDeviceInfo();
  await sleep(20);
  // Nothing selected after the idle load: hidden.
  assert.equal(note().hidden, true);
  // A DM echo (device truth) drives the note through the same sync the
  // live buttons use.
  app.handleLine('SUCCESS,0:DM,0:2');
  assert.equal(note().hidden, false);
  assert.match(note().textContent, /Live now: the pressure gauge/);
  app.handleLine('SUCCESS,0:DM,0:5');
  assert.match(note().textContent, /Live now: Watch holds/);
  // A stream started elsewhere (joystick, Hub buttons): named, with the swap hint.
  app.handleLine('SUCCESS,0:DM,0:1');
  assert.match(note().textContent, /Live now: Joystick \(streaming from another view\)/);
  app.handleLine('SUCCESS,0:DM,0:0');
  assert.equal(note().hidden, true);
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('the note hides with the session, not just with the stream', async () => {
  resetWireNewlineFraming();
  launchDevice();
  await loadDeviceInfo();
  await sleep(20);
  app.handleLine('SUCCESS,0:DM,0:2');
  assert.equal(note().hidden, false);
  // Disconnect runs the session reset: a stale "Live now" must not survive.
  await app.disconnect({ quiet: true });
  assert.equal(note().hidden, true);
  testHooks.detach();
});

test('the feedback selects load enabled with their applied value', async () => {
  resetWireNewlineFraming();
  launchDevice();
  await loadDeviceInfo();
  await sleep(20);
  for (const id of ['soundMode', 'lightMode', 'debugMode']) {
    assert.equal(doc.getElementById(id).disabled, false, id + ' enabled by its device answer');
    assert.ok(doc.getElementById(id).dataset.applied !== undefined, id + ' carries the applied value');
  }
  assert.equal(doc.getElementById('soundMode').dataset.applied, '1');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('a sound pick writes immediately; a rejected pick reverts the select', async () => {
  resetWireNewlineFraming();
  const sent = launchDevice({ writeFailures: { 'SM,1:0': true } });
  await loadDeviceInfo();
  await sleep(20);
  const sel = doc.getElementById('soundMode');
  sel.value = '2';
  sel.dispatch('change');
  await waitFor(() => sent.includes('SM,1:2'), 'the change fired the SM write');
  await waitFor(() => sel.dataset.applied === '2', 'the confirmed pick became the applied value');
  assert.equal(doc.getElementById('soundModeVal').textContent, 'All');
  // Now a pick the device refuses: the select reverts to the last confirmed.
  sel.value = '0';
  sel.dispatch('change');
  await waitFor(() => sent.includes('SM,1:0'), 'the refused write still reached the wire');
  await waitFor(() => sel.value === '2', 'the select reverted to the applied value');
  assert.equal(sel.dataset.applied, '2', 'the applied value never moved');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('the stream select writes on change and reverts a refused pick', async () => {
  resetWireNewlineFraming();
  const sent = launchDevice({ writeFailures: { 'DM,1:1': true } });
  await loadDeviceInfo();
  await sleep(20);
  const sel = doc.getElementById('debugMode');
  sel.value = '2';
  sel.dispatch('change');
  await waitFor(() => sent.includes('DM,1:2'), 'the change fired the DM write');
  await waitFor(() => doc.getElementById('debugModeVal').textContent === 'Pressure', 'the readout followed the echo');
  assert.equal(note().hidden, false, 'the note names the stream the pick started');
  sel.value = '1';
  sel.dispatch('change');
  await waitFor(() => sent.includes('DM,1:1'), 'the refused write reached the wire');
  await waitFor(() => sel.value === '2', 'the select reverted to the applied stream');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('the input-state light pick is refused below 4.4.0 with the select reverted', async () => {
  resetWireNewlineFraming();
  const sent = launchDevice({ version: '4.3.0' });
  // Seed the real option set (the gating DOM makes bare elements; a <select>
  // needs an options array for the VN renderer's gate to find LM=3).
  const sel = doc.getElementById('lightMode');
  const inputStateOption = { value: '3', disabled: false, textContent: 'Input state' };
  sel.options = [{ value: '0' }, { value: '1' }, { value: '2' }, inputStateOption];
  await loadDeviceInfo();
  await sleep(20);
  // The gated option is disabled by the VN renderer; defense in depth: a
  // programmatic pick still cannot reach the wire.
  assert.equal(inputStateOption.disabled, true, 'the gated option is locked on 4.3.0');
  sel.value = '3';
  sel.dispatch('change');
  await sleep(60);
  assert.ok(!sent.includes('LM,1:3'), 'the gated pick never reached the wire');
  assert.equal(sel.value, '1', 'the pick reverted to the applied value');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});
