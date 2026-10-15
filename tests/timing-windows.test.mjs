// Input timing windows (roadmap item 15; firmware 4.4.0+, upstream #62/#9):
// the version-gated load, the render path (initial load + MANUAL sync), the
// write path with range/ordering validation and revert, and the update
// snapshot/restore round-trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc } = installGatingDom();
const app = await import('../app/js/main.js');
const { loadDeviceInfo, setTimingWindow, applyTimingWindowValue } = await import(
  '../app/js/services/settings-service.js'
);
const { captureSettingsSnapshot, restoreSettingsSnapshot } = await import('../app/js/services/firmware-update.js');
const { collectSettingsExport } = await import('../app/js/services/settings-export.js');
const { testHooks } = await import('./harness/test-hooks.mjs');
const { resetWireNewlineFraming } = await import('../app/js/serial/commands.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  'WM,0': '8000',
};

function launchDevice({ version = '4.4.0', windowValues = {}, writeFailures = {} } = {}) {
  const sent = [];
  const responses = { ...BASE_RESPONSES, 'VN,0': version, ...windowValues };
  const writer = {
    write(bytes) {
      const text = Buffer.from(bytes).toString('utf8').replace(/\r?\n$/, '');
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

test('a 4.4.0 device loads the timing windows into the readouts', async () => {
  resetWireNewlineFraming();
  launchDevice({ windowValues: { 'WS,0': '750', 'WL,0': '2500', 'WM,0': '6000' } });
  await loadDeviceInfo();
  await sleep(30);
  assert.equal(doc.getElementById('w1Val').textContent, '750');
  assert.equal(doc.getElementById('w2Val').textContent, '2500');
  assert.equal(doc.getElementById('w3Val').textContent, '6000');
  assert.equal(doc.getElementById('w1Input').disabled, false);
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('older firmware never sees the window endpoints — the readouts show not-applicable, not ERR', async () => {
  resetWireNewlineFraming();
  const sent = launchDevice({ version: '4.3.0' });
  await loadDeviceInfo();
  await sleep(30);
  for (const ep of ['WS,0:0', 'WL,0:0', 'WM,0:0'])
    assert.ok(!sent.includes(ep), ep + ' must not be sent to pre-4.4.0 firmware');
  for (const id of ['w1Val', 'w2Val', 'w3Val']) {
    assert.equal(doc.getElementById(id).textContent, '—', id + ' shows the unavailable placeholder');
    assert.equal(doc.getElementById(id).classList.contains('err'), false, id + ' is not an error');
  }
  assert.equal(doc.getElementById('w1Input').disabled, true, 'the input locks without the endpoint');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('a MANUAL push from the Hub menu keeps the window readouts in sync', async () => {
  applyTimingWindowValue('WS', '500');
  assert.equal(doc.getElementById('w1Val').textContent, '500');
  app.handleLine('MANUAL,0:WL,0:2000');
  assert.equal(doc.getElementById('w2Val').textContent, '2000');
  testHooks.detach();
});

test('window writes validate range and ordering before hitting the wire', async () => {
  resetWireNewlineFraming();
  launchDevice({ writeFailures: { 'WM,1:9000': true } });
  applyTimingWindowValue('WS', '1000');
  applyTimingWindowValue('WL', '3000');
  applyTimingWindowValue('WM', '8000');

  // Out of range: rejected client-side, nothing sent.
  await assert.rejects(() => setTimingWindow('WS', 100), /between 200 and 2500/);
  // Ordering violation (in range, but long > max): rejected client-side.
  applyTimingWindowValue('WM', '2000');
  await assert.rejects(() => setTimingWindow('WL', 2500), /ordered/);
  applyTimingWindowValue('WM', '8000');

  // Valid write lands and syncs from the response.
  await setTimingWindow('WS', 500);
  assert.equal(doc.getElementById('w1Val').textContent, '500');

  // A device-side rejection (FAIL) throws; the readout keeps the device truth.
  await assert.rejects(() => setTimingWindow('WM', 9000), /rejected/);
  assert.equal(doc.getElementById('w3Val').textContent, '8000', 'the readout keeps the device truth');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('the update snapshot round-trips the windows; old firmware snapshots without them', async () => {
  resetWireNewlineFraming();
  launchDevice({ windowValues: { 'WS,0': '600', 'WL,0': '2000', 'WM,0': '5000' } });
  await loadDeviceInfo();
  await sleep(30);
  const snapshot = captureSettingsSnapshot();
  assert.equal(snapshot.WS, '600');
  assert.equal(snapshot.WL, '2000');
  assert.equal(snapshot.WM, '5000');
  await app.disconnect({ quiet: true });
  testHooks.detach();

  const sent = [];
  testHooks.attach({ simulated: true }, {
    write(bytes) {
      const text = Buffer.from(bytes).toString('utf8').replace(/\r?\n$/, '');
      sent.push(text);
      const reply = (line) => setTimeout(() => app.handleLine(line), 3);
      reply(text === 'SETTINGS' ? 'SUCCESS,0:SETTINGS' : `SUCCESS,0:${text}`);
    },
  });
  await restoreSettingsSnapshot(snapshot);
  for (const ep of ['WS', 'WL', 'WM'])
    assert.ok(sent.some((s) => s.startsWith(`${ep},1:`)), ep + ' restored');
  testHooks.detach();

  // Pre-4.4.0: no window keys in the snapshot at all.
  resetWireNewlineFraming();
  launchDevice({ version: '4.3.0' });
  await loadDeviceInfo();
  await sleep(30);
  const oldSnapshot = captureSettingsSnapshot();
  assert.equal(oldSnapshot.WS, undefined);
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('the settings export carries the windows as values or holes', async () => {
  resetWireNewlineFraming();
  launchDevice({ windowValues: { 'WS,0': '750' } });
  await loadDeviceInfo();
  await sleep(30);
  const data = collectSettingsExport();
  assert.equal(data.settings.inputWindowShortMs, '750');
  assert.equal(data.settings.inputWindowLongMs, '3000');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});
