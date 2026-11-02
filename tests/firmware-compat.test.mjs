// Firmware compatibility matrix: firmware 4.1.0 (the widely deployed legacy
// line) ↔ 4.6.5 (the new release). This file is the single place that pins
// the WHOLE version-gated span so a future change cannot quietly break either
// the firmware every field device runs today or the release that lights up
// every feature tier. The unreleased milestones in between (4.2.0–4.6.4) are
// never shipped as such — they are the boundaries the gates below encode, so
// enumerating the gates covers them by construction.
//
// Behaviors pinned here: the deviceFirmwareAtLeast tier map, the wire-framing
// generation switch, which endpoints the load may send, the UI's
// unavailable/live states, the input-state light option, and the
// backup/restore downgrade-safety. The two multi-command mode-switch flows
// (legacy OM/CM/SR vs. atomic MP, and the 4.5.8–4.6.3 half-transition refusal)
// are pinned in flows.test.mjs; this file only asserts their version gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc } = installGatingDom();
const app = await import('../app/js/main.js');
const { loadDeviceInfo, resetRestrictionsUi, resetSwitchActionsUi, step } = await import(
  '../app/js/services/settings-service.js'
);
const { captureSettingsSnapshot, restoreSettingsSnapshot } = await import('../app/js/services/firmware-update.js');
const { ENDPOINT_RENDERERS } = await import('../app/js/serial/endpoints.js');
const { testHooks } = await import('./harness/test-hooks.mjs');
const { noteDeviceVersion, resetWireNewlineFraming, deviceFirmwareAtLeast } = await import(
  '../app/js/serial/commands.js'
);
const {
  ACCELERATION_MIN_FIRMWARE,
  INPUT_STATE_LIGHT_MIN_FIRMWARE,
  RESTRICTIONS_MIN_FIRMWARE,
  SWITCH_ACTIONS_MIN_FIRMWARE,
  MODE_RESET_PER_SETTING_MIN_FIRMWARE,
  MODE_PRESET_MIN_FIRMWARE,
} = await import('../app/js/config/constants.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LEGACY = '4.1.0';
const RELEASE = '4.6.5';

// Every endpoint the initial load reads, with a plausible value. The gated
// families (SD… onward) are answered too, but a legacy device never gets
// asked — the load loop withholds them before the wire.
const FULL_RESPONSES = {
  'MN,0': '1',
  'VN,0': RELEASE,
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
  // Compiled factory mappings (LSConfig.h switchActionProperty): the GET
  // answers the "short,long,max" triple.
  'SA,0': '1,4,19',
  'SB,0': '3,0,14',
  'SC,0': '2,5,3',
  'GA,0': '6,8,19',
  'GB,0': '10,11,14',
  'GC,0': '7,9,0',
};

// The fourteen reads that exist only on newer firmware (acceleration at
// 4.3.0, restrictions + timing windows at 4.4.0, switch actions at 4.5.0).
const GATED_READS = [
  'AV,0:0',
  'SD,0:0',
  'MA,0:0',
  'LK,0:0',
  'CF,0:0',
  'WS,0:0',
  'WL,0:0',
  'WM,0:0',
  'SA,0:0',
  'SB,0:0',
  'SC,0:0',
  'GA,0:0',
  'GB,0:0',
  'GC,0:0',
];

// Attaches a simulated device identified as `version`. Returns two views of
// what the app wrote: `raw` keeps the exact bytes (framing preserved, so the
// newline-generation switch is observable), `sent` is the command alone.
function launchDevice(version) {
  const raw = [];
  const sent = [];
  const responses = { ...FULL_RESPONSES, 'VN,0': version };
  const writer = {
    write(bytes) {
      const text = Buffer.from(bytes).toString('utf8');
      raw.push(text);
      const command = text.replace(/\r?\n$/, '');
      sent.push(command);
      const reply = (line) => setTimeout(() => app.handleLine(line), 3);
      if (command === 'SETTINGS') {
        reply('SUCCESS,0:SETTINGS');
        return;
      }
      if (/^[A-Z]{2},1:/.test(command)) {
        reply(`SUCCESS,0:${command}`);
        return;
      }
      const cmd = command.slice(0, 4);
      if (cmd in responses) reply(`SUCCESS,0:${cmd}:${responses[cmd]}`);
    },
  };
  testHooks.attach({ simulated: true }, writer);
  return { raw, sent };
}

// A bare write/ack recorder for restore runs (no load; the gate is set
// directly through noteDeviceVersion). Mirrors the restore harness the
// per-feature tests use.
function restoreRecorder() {
  const sent = [];
  testHooks.attach(
    { simulated: true },
    {
      write(bytes) {
        const text = Buffer.from(bytes).toString('utf8').replace(/\r?\n$/, '');
        sent.push(text);
        const reply = (line) => setTimeout(() => app.handleLine(line), 3);
        reply(text === 'SETTINGS' ? 'SUCCESS,0:SETTINGS' : `SUCCESS,0:${text}`);
      },
    },
  );
  return { sent };
}

function resetGatedUi() {
  resetRestrictionsUi();
  resetSwitchActionsUi();
}

// ---- The feature-tier gate map -------------------------------------------

test('deviceFirmwareAtLeast draws the feature-tier boundaries for the whole span', () => {
  // Legacy 4.1.0 satisfies only its own tier; every later feature is off,
  // including the 4.2.0 wire-protocol generation.
  resetWireNewlineFraming();
  noteDeviceVersion(LEGACY);
  assert.ok(deviceFirmwareAtLeast(4, 1, 0), '4.1.0 is itself');
  assert.equal(deviceFirmwareAtLeast(4, 2, 0), false, 'wire v2 is gated off on 4.1.0');
  for (const gate of [
    ACCELERATION_MIN_FIRMWARE,
    INPUT_STATE_LIGHT_MIN_FIRMWARE,
    RESTRICTIONS_MIN_FIRMWARE,
    SWITCH_ACTIONS_MIN_FIRMWARE,
    MODE_RESET_PER_SETTING_MIN_FIRMWARE,
    MODE_PRESET_MIN_FIRMWARE,
  ])
    assert.equal(deviceFirmwareAtLeast(...gate), false, gate.join('.') + ' is gated off on 4.1.0');

  // Release 4.6.5 satisfies every published tier; a not-yet-released tier
  // (4.6.6) stays off, which is what keeps a future endpoint from leaking.
  noteDeviceVersion(RELEASE);
  for (const gate of [
    [4, 2, 0],
    ACCELERATION_MIN_FIRMWARE,
    INPUT_STATE_LIGHT_MIN_FIRMWARE,
    RESTRICTIONS_MIN_FIRMWARE,
    SWITCH_ACTIONS_MIN_FIRMWARE,
    [4, 5, 1],
    MODE_RESET_PER_SETTING_MIN_FIRMWARE,
    MODE_PRESET_MIN_FIRMWARE,
    [4, 6, 5],
  ])
    assert.ok(deviceFirmwareAtLeast(...gate), gate.join('.') + ' is available on 4.6.5');
  assert.equal(deviceFirmwareAtLeast(4, 6, 6), false, 'a not-yet-released tier stays gated');

  // An unidentified device (VN never read, or a fresh connect) is never new
  // enough — the conservative direction, so nothing gated reaches an unknown.
  resetWireNewlineFraming();
  for (const gate of [[4, 2, 0], RESTRICTIONS_MIN_FIRMWARE, SWITCH_ACTIONS_MIN_FIRMWARE, MODE_PRESET_MIN_FIRMWARE])
    assert.equal(deviceFirmwareAtLeast(...gate), false, 'unknown firmware is conservative at ' + gate.join('.'));
});

// ---- Wire-protocol framing generation ------------------------------------

test('wire framing stays bare for 4.1.0 and upgrades to newline-terminated for 4.6.5', async () => {
  // 4.1.0's parser rejects a trailing newline on every comparison, so nothing
  // the app writes to it may carry one.
  resetWireNewlineFraming();
  const legacy = launchDevice(LEGACY);
  await loadDeviceInfo();
  await sleep(40);
  assert.ok(
    legacy.raw.every((w) => !w.endsWith('\n')),
    'no write to 4.1.0 is newline-framed',
  );
  await app.disconnect({ quiet: true });
  testHooks.detach();

  // 4.6.5 flips to newline framing once VN identifies it. The opening
  // handshake and the reads through VN stay bare (every firmware accepts
  // those); everything after lands newline-terminated.
  resetWireNewlineFraming();
  const release = launchDevice(RELEASE);
  await loadDeviceInfo();
  await sleep(40);
  const vnWriteIndex = release.raw.findIndex((w) => w.startsWith('VN,0:0'));
  assert.ok(vnWriteIndex >= 0, 'the VN read happened');
  assert.ok(
    release.raw.slice(0, vnWriteIndex + 1).every((w) => !w.endsWith('\n')),
    'framing stays bare through the VN read',
  );
  assert.ok(
    release.raw.slice(vnWriteIndex + 1).some((w) => w.endsWith('\n')),
    '4.6.5 switches to newline framing after VN lands',
  );
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

// ---- Which endpoints the load may send -----------------------------------

test('the load withholds every version-gated read from 4.1.0 and sends them all to 4.6.5', async () => {
  resetWireNewlineFraming();
  resetGatedUi();
  const legacy = launchDevice(LEGACY);
  await loadDeviceInfo();
  await sleep(40);
  for (const ep of GATED_READS) assert.ok(!legacy.sent.includes(ep), ep + ' must never reach 4.1.0');
  // The base settings every firmware has still load.
  for (const ep of ['MN,0:0', 'VN,0:0', 'SS,0:0', 'CA,0:0', 'DM,0:0'])
    assert.ok(legacy.sent.includes(ep), ep + ' loads on 4.1.0');
  assert.equal(doc.getElementById('version').textContent, LEGACY);
  await app.disconnect({ quiet: true });
  testHooks.detach();

  resetWireNewlineFraming();
  resetGatedUi();
  const release = launchDevice(RELEASE);
  await loadDeviceInfo();
  await sleep(40);
  for (const ep of GATED_READS) assert.ok(release.sent.includes(ep), ep + ' is read on 4.6.5');
  assert.equal(doc.getElementById('version').textContent, RELEASE);
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

// ---- UI: locked-with-reason on 4.1.0, live on 4.6.5 ----------------------

test('4.1.0 locks the newer-firmware cards with an explanation; 4.6.5 unlocks them', async () => {
  resetWireNewlineFraming();
  resetGatedUi();
  const legacy = launchDevice(LEGACY);
  await loadDeviceInfo();
  await sleep(40);
  // Input restrictions: disabled, with the "needs firmware 4.4.0+" note.
  for (const id of ['sapDisabled', 'menuButtonsOnly', 'modeLock', 'cursorHold'])
    assert.equal(doc.getElementById(id).disabled, true, id + ' is locked on 4.1.0');
  assert.match(doc.getElementById('restrictionsNote').textContent, /4\.4\.0\+/);
  // Timing windows: the not-applicable placeholder (never ERR — nothing
  // failed), inputs locked.
  for (const id of ['w1Val', 'w2Val', 'w3Val']) {
    assert.equal(doc.getElementById(id).textContent, '—', id + ' is not-applicable on 4.1.0');
    assert.equal(doc.getElementById(id).classList.contains('err'), false, id + ' is not an error');
  }
  assert.equal(doc.getElementById('w1Input').disabled, true, 'the window input is locked on 4.1.0');
  // External switch actions: selects locked, with their own note.
  assert.equal(doc.getElementById('swSA0').disabled, true, 'the switch select is locked on 4.1.0');
  assert.match(doc.getElementById('switchActionsNote').textContent, /4\.5\.0\+/);
  // Acceleration: the getter exists but the setter is the v4.0-era stub that
  // answers FAIL,3 to every AV,1 — expose it as not-applicable, not as a
  // control whose writes can only fail.
  assert.equal(doc.getElementById('accelVal').textContent, '—', 'acceleration is not-applicable on 4.1.0');
  const legacyAccelButtons = doc
    .querySelectorAll('button[data-step]')
    .filter((b) => b.dataset.target === 'accel');
  assert.equal(legacyAccelButtons.length, 2, 'both acceleration steppers exist');
  assert.ok(
    legacyAccelButtons.every((b) => b.disabled),
    'the acceleration steppers are locked on 4.1.0',
  );
  assert.match(doc.getElementById('accelNote').textContent, /4\.3\.0\+/);
  // Defense in depth: even a stale/forced readout cannot reach AV,1.
  doc.getElementById('accelVal').textContent = '0';
  await step('accel', 1);
  assert.ok(!legacy.sent.some((s) => s.startsWith('AV,1:')), 'AV,1 never reaches 4.1.0');
  assert.ok(
    legacyAccelButtons.every((b) => b.disabled),
    'the acceleration steppers stay locked after a programmatic step',
  );
  const legacySnapshot = captureSettingsSnapshot();
  assert.equal('AV' in legacySnapshot, false, 'a 4.1.0 snapshot never invents acceleration');
  await app.disconnect({ quiet: true });
  testHooks.detach();

  resetWireNewlineFraming();
  resetGatedUi();
  launchDevice(RELEASE);
  await loadDeviceInfo();
  await sleep(40);
  for (const id of ['sapDisabled', 'menuButtonsOnly', 'modeLock', 'cursorHold'])
    assert.equal(doc.getElementById(id).disabled, false, id + ' is live on 4.6.5');
  assert.equal(doc.getElementById('restrictionsNote').textContent, '');
  assert.equal(doc.getElementById('w1Val').textContent, '1000', 'the window readout loads on 4.6.5');
  assert.equal(doc.getElementById('w1Input').disabled, false, 'the window input is live on 4.6.5');
  assert.equal(doc.getElementById('swSA0').disabled, false, 'the switch select is live on 4.6.5');
  assert.equal(doc.getElementById('switchActionsNote').textContent, '');
  assert.equal(doc.getElementById('accelVal').textContent, '0', 'acceleration loads on 4.6.5');
  assert.ok(
    doc
      .querySelectorAll('button[data-step]')
      .filter((b) => b.dataset.target === 'accel')
      .every((b) => !b.disabled),
    'the acceleration steppers are live on 4.6.5',
  );
  assert.doesNotMatch(doc.getElementById('accelNote').textContent, /needs firmware/);
  assert.equal(captureSettingsSnapshot().AV, '0', 'a 4.6.5 snapshot carries acceleration');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

// ---- The input-state light option (LM=3) ---------------------------------

test('the input-state light feedback option is withheld on 4.1.0 and offered on 4.6.5', () => {
  const lightSelect = doc.getElementById('lightMode');
  // Seed the real option set the VN renderer inspects (the gating DOM makes
  // bare elements; a <select> needs an options array to gate against).
  const inputStateOption = { value: '3', disabled: false, hidden: false };
  lightSelect.options = [{ value: '0' }, { value: '1' }, { value: '2' }, inputStateOption];
  lightSelect.value = '3';

  resetWireNewlineFraming();
  ENDPOINT_RENDERERS.VN(LEGACY);
  assert.equal(inputStateOption.disabled, true, 'LM=3 is disabled on 4.1.0');
  assert.equal(inputStateOption.hidden, true, 'LM=3 is hidden on 4.1.0');
  assert.equal(lightSelect.value, '2', 'a selected LM=3 falls back to All on 4.1.0');

  ENDPOINT_RENDERERS.VN(RELEASE);
  assert.equal(inputStateOption.disabled, false, 'LM=3 is offered on 4.6.5');
  assert.equal(inputStateOption.hidden, false, 'LM=3 is visible on 4.6.5');
});

// ---- Backup / restore downgrade-safety across the span -------------------

test('a 4.6.5 settings backup restores fully onto 4.6.5 and safely (base-only) onto 4.1.0', async () => {
  // Capture a real snapshot from a fully loaded 4.6.5 device: it carries
  // every family because that firmware has every family.
  resetWireNewlineFraming();
  resetGatedUi();
  launchDevice(RELEASE);
  await loadDeviceInfo();
  await sleep(40);
  const snapshot = captureSettingsSnapshot();
  for (const ep of ['SS', 'AV', 'SM', 'LM', 'SD', 'MA', 'WS', 'WM', 'SA', 'GC'])
    assert.ok(ep in snapshot, ep + ' is captured on 4.6.5');
  await app.disconnect({ quiet: true });
  testHooks.detach();

  // Restore onto a 4.1.0 device (the natural downgrade direction): only the
  // nine writable base settings land. Acceleration is among the withheld
  // families — its AV,1 setter pre-4.3.0 is the FAIL,3 stub. Writing any gated
  // family to firmware that lacks it is guaranteed FAIL,1 noise, and two such
  // failures abort the whole restore — so the restore gates each family on the
  // CONNECTED device, not the backup.
  resetWireNewlineFraming();
  noteDeviceVersion(LEGACY);
  const legacy = restoreRecorder();
  const legacyFailures = await restoreSettingsSnapshot(snapshot);
  await sleep(20);
  assert.deepEqual(legacyFailures, [], 'nothing fails restoring the 4.6.5 backup onto 4.1.0');
  const legacyWrites = legacy.sent.filter((s) => s.includes(',1:')).map((s) => s.slice(0, 2));
  assert.deepEqual(
    legacyWrites,
    ['SS', 'SL', 'ST', 'PT', 'IZ', 'OZ', 'SM', 'LM', 'LL'],
    'only the nine writable base settings reach 4.1.0',
  );
  assert.ok(!legacyWrites.includes('AV'), 'acceleration is withheld from 4.1.0 (AV,1 is FAIL,3 there)');
  for (const gated of ['SD', 'MA', 'LK', 'CF', 'WS', 'WL', 'WM', 'SA', 'SB', 'SC', 'GA', 'GB', 'GC'])
    assert.ok(!legacyWrites.includes(gated), gated + ' is withheld from 4.1.0');
  testHooks.detach();

  // Restore onto a 4.6.5 device (the upgrade/same-version direction): every
  // family is written back.
  resetWireNewlineFraming();
  noteDeviceVersion(RELEASE);
  const release = restoreRecorder();
  const releaseFailures = await restoreSettingsSnapshot(snapshot);
  await sleep(20);
  assert.deepEqual(releaseFailures, [], 'nothing fails restoring onto 4.6.5');
  const releaseWrites = release.sent.filter((s) => s.includes(',1:')).map((s) => s.slice(0, 2));
  assert.ok(releaseWrites.includes('AV'), 'acceleration is restored onto 4.6.5');
  for (const ep of ['SD', 'MA', 'LK', 'CF', 'WS', 'WL', 'WM', 'SA', 'SB', 'SC', 'GA', 'GB', 'GC'])
    assert.ok(releaseWrites.includes(ep), ep + ' is restored onto 4.6.5');
  testHooks.detach();
  resetWireNewlineFraming();
});
