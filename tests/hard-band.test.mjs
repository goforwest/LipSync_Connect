// Hard sip/puff band (firmware 4.7.0+, upstream #58): the version-gated load
// (never sent to older firmware), the threshold pair rule (hard >= regular +
// margin) enforced client-side before the wire, the action write path with
// revert-on-FAIL, the update snapshot/restore round-trip, the settings-export
// coverage, and the gauge's hard-band markers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc } = installGatingDom();
const app = await import('../app/js/main.js');
const { loadDeviceInfo, setHardThreshold, setHardAction, resetHardBandUi, populateHardActionSelects, step } =
  await import('../app/js/services/settings-service.js');
const { captureSettingsSnapshot, restoreSettingsSnapshot } = await import('../app/js/services/firmware-update.js');
const { collectSettingsExport } = await import('../app/js/services/settings-export.js');
const { recalcGaugeRange } = await import('../app/js/plotting/gauge.js');
const { testHooks } = await import('./harness/test-hooks.mjs');
const { resetWireNewlineFraming } = await import('../app/js/serial/commands.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byId = (id) => doc.getElementById(id);

const BASE_RESPONSES = {
  'MN,0': '1',
  'VN,0': '4.7.0',
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
  'SA,0': '1,4,19',
  'SB,0': '3,0,14',
  'SC,0': '2,5,3',
  'GA,0': '6,8,19',
  'GB,0': '10,11,14',
  'GC,0': '7,9,0',
  // The settings2 seeds (LSConfig.h's CONF_SETTINGS2_JSON): hard defaults
  // mirror the compiled hard rows — 5 = Scroll for hard sip, 4 = Drag for
  // hard puff.
  'HS,0': '10.00',
  'HP,0': '10.00',
  'HA,0': '5',
  'HB,0': '4',
};

// Loads the whole settings surface; overrides replace individual reads,
// writeFailures maps "HB,1:8"-style write commands to FAIL.
function launchDevice({ version = '4.7.0', overrides = {}, writeFailures = {} } = {}) {
  const sent = [];
  const responses = { ...BASE_RESPONSES, 'VN,0': version, ...overrides };
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
        // The firmware echoes the written value verbatim (HS/HP floats, HA/HB
        // ints — same contract as ST/PT and the switch endpoints).
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

populateHardActionSelects();

test('a 4.7.0 device loads the hard band into its controls', async () => {
  resetWireNewlineFraming();
  resetHardBandUi();
  const sent = launchDevice();
  await loadDeviceInfo();
  await sleep(30);
  // The four endpoints were read, gated at 4.7.0.
  for (const ep of ['HS,0:0', 'HP,0:0', 'HA,0:0', 'HB,0:0']) assert.ok(sent.includes(ep), `sent ${ep}`);
  assert.equal(byId('hardSipVal').textContent, '10.00');
  assert.equal(byId('hardPuffVal').textContent, '10.00');
  assert.equal(byId('hardSipInput').value, '10.00');
  assert.equal(byId('hardPuffInput').value, '10.00');
  assert.equal(byId('hardSipAction').value, '5'); // Scroll (the compiled hard-sip default)
  assert.equal(byId('hardPuffAction').value, '4'); // Drag (the compiled hard-puff default)
  assert.equal(byId('hardSipAction').disabled, false);
  assert.equal(byId('hardBandNote').textContent, '');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('pre-4.7 firmware never sees the hard endpoints — the card says why', async () => {
  resetWireNewlineFraming();
  resetHardBandUi();
  const sent = launchDevice({ version: '4.6.6' });
  await loadDeviceInfo();
  await sleep(30);
  for (const ep of ['HS,0:0', 'HP,0:0', 'HA,0:0', 'HB,0:0'])
    assert.ok(!sent.includes(ep), `${ep} must not be sent to 4.6.6`);
  assert.equal(byId('hardSipVal').textContent, '—');
  assert.equal(byId('hardPuffVal').textContent, '—');
  assert.equal(byId('hardSipAction').disabled, true);
  assert.equal(byId('hardPuffAction').disabled, true);
  assert.match(byId('hardBandNote').textContent, /4\.7\.0/);
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('threshold writes are pre-checked against the hard >= regular + margin rule', async () => {
  resetWireNewlineFraming();
  resetHardBandUi();
  const sent = launchDevice();
  await loadDeviceInfo();
  await sleep(30);
  // Regular sip is 3.00 → the hard sip floor is 3.00 + 1.0 = 4.00.
  await assert.rejects(() => setHardThreshold('HS', 3.5), /at least 1 hPa above the regular one/);
  assert.ok(!sent.some((s) => s.startsWith('HS,1:')), 'refused value must never reach the wire');
  // A value at the floor is accepted and the readout re-syncs from the echo.
  await setHardThreshold('HS', 4.0);
  assert.ok(sent.includes('HS,1:4.00'));
  assert.equal(byId('hardSipVal').textContent, '4.00');
  // Out-of-range values are refused before the wire too.
  await assert.rejects(() => setHardThreshold('HP', 150), /between 2 and 149\.99/);
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('the hard-threshold steppers respect the margin rule', async () => {
  resetWireNewlineFraming();
  resetHardBandUi();
  const sent = launchDevice({ overrides: { 'HS,0': '4.25' } });
  await loadDeviceInfo();
  await sleep(30);
  assert.equal(byId('hardSipVal').textContent, '4.25');
  // Stepping down to the floor (4.00) is allowed.
  await step('hs', -1);
  assert.ok(sent.includes('HS,1:4.00'));
  assert.equal(byId('hardSipVal').textContent, '4.00');
  // Stepping below the floor (3.75) is refused client-side with the honest
  // message; nothing reaches the wire.
  const before = sent.filter((s) => s.startsWith('HS,1:')).length;
  await step('hs', -1);
  assert.equal(byId('sapError').textContent, 'The hard sip threshold must stay at least 1 hPa above the regular one.');
  assert.equal(sent.filter((s) => s.startsWith('HS,1:')).length, before);
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('a rejected hard-action write reverts the select to the device truth', async () => {
  resetWireNewlineFraming();
  resetHardBandUi();
  launchDevice({ writeFailures: { 'HB,1:8': true } });
  await loadDeviceInfo();
  await sleep(30);
  assert.equal(byId('hardPuffAction').value, '4');
  byId('hardPuffAction').value = '8'; // Gamepad B3 — not the point; the write fails
  await assert.rejects(() => setHardAction('HB'), /FAIL|refused|rejected|timed out/i);
  assert.equal(byId('hardPuffAction').value, '4'); // reverted to the device-confirmed value
  // A successful write re-syncs through the renderer's echo.
  byId('hardSipAction').value = '3';
  await setHardAction('HA');
  assert.equal(byId('hardSipAction').value, '3');
  // Nothing-to-pick is refused before the wire.
  byId('hardSipAction').value = '';
  await assert.rejects(() => setHardAction('HA'), /Pick an action/);
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('a future action number renders honestly instead of blanking the select', async () => {
  resetWireNewlineFraming();
  resetHardBandUi();
  launchDevice({ overrides: { 'HA,0': '99' } });
  await loadDeviceInfo();
  await sleep(30);
  const sel = byId('hardSipAction');
  assert.equal(sel.value, '99');
  const opt = sel.children.find((o) => o.value === '99');
  assert.ok(opt, 'honest "Action #99" option exists');
  assert.equal(opt.textContent, 'Action #99');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('the gauge shows hard-band markers once the values load', async () => {
  resetWireNewlineFraming();
  resetHardBandUi();
  launchDevice();
  await loadDeviceInfo();
  await sleep(30);
  recalcGaugeRange();
  const hardPuff = byId('gaugeHardPuffMark');
  const hardSip = byId('gaugeHardSipMark');
  assert.equal(hardPuff.hidden, false);
  assert.equal(hardSip.hidden, false);
  assert.match(hardPuff.style.left, /%$/);
  assert.match(hardSip.style.left, /%$/);
  await app.disconnect({ quiet: true });
  // Disconnect hides them again with the readouts.
  assert.equal(byId('gaugeHardPuffMark').hidden, true);
  testHooks.detach();
});

test('a Hub-menu MANUAL push updates the hard-band readout', async () => {
  resetWireNewlineFraming();
  resetHardBandUi();
  launchDevice();
  await loadDeviceInfo();
  await sleep(30);
  // The Hub's hard pages and pair-heals emit MANUAL,0:HS,1:<v> lines on
  // every step (upstream #58) — the readouts and selects must follow device
  // truth exactly like the ST/PT menu pushes do. This is the generic
  // applyDeviceResponse path, not the API-layer self-sync.
  app.handleLine('MANUAL,0:HS,1:22.00');
  assert.equal(byId('hardSipVal').textContent, '22.00');
  app.handleLine('MANUAL,0:HB,1:8');
  assert.equal(byId('hardPuffAction').value, '8');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('the update snapshot carries the hard band on 4.7.0 and skips it on 4.6.6', async () => {
  resetWireNewlineFraming();
  resetHardBandUi();
  const sent = launchDevice();
  await loadDeviceInfo();
  await sleep(30);
  const snapshot = captureSettingsSnapshot();
  assert.equal(snapshot.HS, '10.00');
  assert.equal(snapshot.HP, '10.00');
  assert.equal(snapshot.HA, '5');
  assert.equal(snapshot.HB, '4');
  // Restore writes thresholds (after the regular ones) and actions. The
  // float normalization pads to a legal line length: 10.00 -> 10.000.
  const failures = await restoreSettingsSnapshot(snapshot);
  assert.deepEqual(failures, []);
  assert.ok(sent.includes('HS,1:10.000'));
  assert.ok(sent.includes('HA,1:5'));
  assert.ok(sent.includes('HB,1:4'));
  const hsIndex = sent.findIndex((s) => s === 'HS,1:10.000');
  const stIndex = sent.findIndex((s) => s.startsWith('ST,1:'));
  assert.ok(stIndex !== -1 && hsIndex > stIndex, 'hard thresholds restore after the regular ones');
  await app.disconnect({ quiet: true });
  testHooks.detach();

  // Older firmware: no hard keys in the snapshot at all (the gate skips
  // them; nothing is invented, nothing fails).
  resetWireNewlineFraming();
  resetHardBandUi();
  launchDevice({ version: '4.6.6' });
  await loadDeviceInfo();
  await sleep(30);
  const oldSnapshot = captureSettingsSnapshot();
  assert.ok(!('HS' in oldSnapshot));
  assert.ok(!('HA' in oldSnapshot));
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('the settings export includes the hard-band values and actions', async () => {
  resetWireNewlineFraming();
  resetHardBandUi();
  launchDevice();
  await loadDeviceInfo();
  await sleep(30);
  const data = collectSettingsExport();
  assert.equal(data.settings.hardSipThresholdhPa, '10.00');
  assert.equal(data.settings.hardPuffThresholdhPa, '10.00');
  assert.equal(data.settings.hardSipAction, 5);
  assert.equal(data.settings.hardPuffAction, 4);
  assert.ok(!data.notLoaded.includes('hardSipThresholdhPa'));
  assert.ok(!data.notLoaded.includes('hardPuffAction'));
  await app.disconnect({ quiet: true });
  testHooks.detach();

  // Older firmware: the hard keys are honest holes, not garbage.
  resetWireNewlineFraming();
  resetHardBandUi();
  launchDevice({ version: '4.6.6' });
  await loadDeviceInfo();
  await sleep(30);
  const oldData = collectSettingsExport();
  assert.equal(oldData.settings.hardSipThresholdhPa, undefined);
  for (const key of ['hardSipThresholdhPa', 'hardPuffThresholdhPa', 'hardSipAction', 'hardPuffAction'])
    assert.ok(oldData.notLoaded.includes(key), `${key} listed as notLoaded`);
  await app.disconnect({ quiet: true });
  testHooks.detach();
});
