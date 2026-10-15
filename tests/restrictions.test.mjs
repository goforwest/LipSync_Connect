// Input restrictions (roadmap item 11; firmware 4.4.0+, upstream #21 #44 #68
// #77): the version-gated load (never sent to older firmware), the checkbox
// render path (initial load + MANUAL sync), the write path with revert, the
// update snapshot/restore round-trip, and the settings-export booleans.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc } = installGatingDom();
const app = await import('../app/js/main.js');
const {
  loadDeviceInfo,
  setRestriction,
  applyRestrictionValue,
  markRestrictionsUnavailable,
  resetRestrictionsUi,
} = await import('../app/js/services/settings-service.js');
const { captureSettingsSnapshot, restoreSettingsSnapshot } = await import('../app/js/services/firmware-update.js');
const { collectSettingsExport } = await import('../app/js/services/settings-export.js');
const { testHooks } = await import('./harness/test-hooks.mjs');
const { noteDeviceVersion, resetWireNewlineFraming, deviceFirmwareAtLeast } = await import(
  '../app/js/serial/commands.js'
);

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
  'WS,0': '1000',
  'WL,0': '3000',
  'WM,0': '8000',
};

// Loads the whole settings surface; restrictionValues override the four
// restriction reads. writeFailures maps "SD,1:1"-style write commands to FAIL.
function launchDevice({ version = '4.4.0', restrictionValues = {}, writeFailures = {} } = {}) {
  const sent = [];
  const responses = { ...BASE_RESPONSES, 'VN,0': version, ...restrictionValues };
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

const CHECKBOXES = ['sapDisabled', 'menuButtonsOnly', 'modeLock', 'cursorHold'];

function assertAllCheckboxes(expected) {
  for (const id of CHECKBOXES) assert.equal(doc.getElementById(id).checked, expected, id);
}

test('a 4.4.0 device loads the four restriction settings into the checkboxes', async () => {
  resetWireNewlineFraming();
  resetRestrictionsUi();
  const sent = launchDevice({ restrictionValues: { 'SD,0': '1', 'MA,0': '0', 'LK,0': '1', 'CF,0': '0' } });
  await loadDeviceInfo();
  await sleep(30);
  // The restriction reads are sent (after VN identified 4.4.0).
  for (const ep of ['SD,0:0', 'MA,0:0', 'LK,0:0', 'CF,0:0']) assert.ok(sent.includes(ep), ep);
  assert.equal(doc.getElementById('sapDisabled').checked, true);
  assert.equal(doc.getElementById('menuButtonsOnly').checked, false);
  assert.equal(doc.getElementById('modeLock').checked, true);
  assert.equal(doc.getElementById('cursorHold').checked, false);
  for (const id of CHECKBOXES) assert.equal(doc.getElementById(id).disabled, false, id + ' enabled after load');
  assert.equal(doc.getElementById('restrictionsNote').textContent, '');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('older firmware never sees the restriction endpoints — the card reports why', async () => {
  resetWireNewlineFraming();
  resetRestrictionsUi();
  const sent = launchDevice({ version: '4.3.0' });
  await loadDeviceInfo();
  await sleep(30);
  for (const ep of ['SD,0:0', 'MA,0:0', 'LK,0:0', 'CF,0:0'])
    assert.ok(!sent.includes(ep), ep + ' must not be sent to pre-4.4.0 firmware');
  assertAllCheckboxes(false);
  for (const id of CHECKBOXES) assert.equal(doc.getElementById(id).disabled, true, id + ' stays disabled');
  assert.match(doc.getElementById('restrictionsNote').textContent, /need firmware 4\.4\.0\+/);
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('a MANUAL push from the Hub menu keeps the checkboxes in sync', async () => {
  resetRestrictionsUi();
  app.handleLine('MANUAL,0:SD,0:1');
  assert.equal(doc.getElementById('sapDisabled').checked, true);
  app.handleLine('MANUAL,0:LK,0:0');
  assert.equal(doc.getElementById('modeLock').checked, false);
  testHooks.detach();
});

test('a checkbox write lands on the wire and syncs from the response; a rejected write reverts', async () => {
  resetWireNewlineFraming();
  resetRestrictionsUi();
  launchDevice({ writeFailures: { 'MA,1:1': true } });
  const sd = doc.getElementById('sapDisabled');
  sd.checked = true;
  await setRestriction('SD', true);
  assert.equal(sd.checked, true);
  const ma = doc.getElementById('menuButtonsOnly');
  ma.checked = true;
  await assert.rejects(() => setRestriction('MA', true), /rejected/);
  assert.equal(ma.checked, false, 'a rejected write reverts the checkbox');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('the update snapshot round-trips loaded restrictions and skips unavailable ones', async () => {
  resetWireNewlineFraming();
  resetRestrictionsUi();
  // Loaded 4.4.0 device with two restrictions on.
  launchDevice({ restrictionValues: { 'SD,0': '1', 'MA,0': '0', 'LK,0': '1', 'CF,0': '0' } });
  await loadDeviceInfo();
  await sleep(30);
  const snapshot = captureSettingsSnapshot();
  assert.equal(snapshot.SD, '1');
  assert.equal(snapshot.MA, '0');
  assert.equal(snapshot.LK, '1');
  assert.equal(snapshot.CF, '0');
  await app.disconnect({ quiet: true });
  testHooks.detach();

  // Restoring re-writes all four present keys.
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
  for (const ep of ['SD', 'MA', 'LK', 'CF'])
    assert.ok(sent.some((s) => s.startsWith(`${ep},1:`)), ep + ' restored');
  testHooks.detach();

  // A pre-4.4.0 device (restrictions unavailable) snapshots without the
  // keys — no failed backup, no restore noise.
  resetWireNewlineFraming();
  resetRestrictionsUi();
  launchDevice({ version: '4.3.0' });
  await loadDeviceInfo();
  await sleep(30);
  const oldSnapshot = captureSettingsSnapshot();
  assert.equal(oldSnapshot.SD, undefined);
  assert.equal(oldSnapshot.LK, undefined);
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('the settings export carries the restrictions as booleans, or lists them as holes', async () => {
  resetWireNewlineFraming();
  resetRestrictionsUi();
  launchDevice({ restrictionValues: { 'SD,0': '1', 'MA,0': '0', 'LK,0': '0', 'CF,0': '1' } });
  await loadDeviceInfo();
  await sleep(30);
  const data = collectSettingsExport();
  assert.equal(data.settings.sipPuffDisabled, true);
  assert.equal(data.settings.menuButtonsOnly, false);
  assert.equal(data.settings.cursorHoldDuringSap, true);
  await app.disconnect({ quiet: true });
  testHooks.detach();

  // Unavailable card → holes, never a wrong "false".
  resetRestrictionsUi();
  markRestrictionsUnavailable();
  const holes = collectSettingsExport();
  assert.equal(holes.settings.sipPuffDisabled, undefined);
  for (const key of ['sipPuffDisabled', 'menuButtonsOnly', 'modeLocked', 'cursorHoldDuringSap'])
    assert.ok(holes.notLoaded.includes(key), key + ' listed as not loaded');
});

test('resetRestrictionsUi clears stale state between sessions', () => {
  applyRestrictionValue('SD', '1');
  assert.equal(doc.getElementById('sapDisabled').checked, true);
  resetRestrictionsUi();
  assertAllCheckboxes(false);
  for (const id of CHECKBOXES) assert.equal(doc.getElementById(id).disabled, true, id + ' disabled by reset');
  assert.equal(doc.getElementById('restrictionsNote').textContent, '');
});

test('noteDeviceVersion gates deviceFirmwareAtLeast for the session', () => {
  resetWireNewlineFraming();
  noteDeviceVersion('4.4.0');
  assert.ok(deviceFirmwareAtLeast(4, 4, 0));
  assert.ok(!deviceFirmwareAtLeast(4, 5, 0));
  noteDeviceVersion('4.1.0');
  assert.ok(!deviceFirmwareAtLeast(4, 4, 0));
  resetWireNewlineFraming();
  assert.ok(!deviceFirmwareAtLeast(4, 4, 0), 'unknown version after connect is never new enough');
});
