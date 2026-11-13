// Settings import (services/settings-export.js): the exported file's JSON
// keys map back into the wire snapshot the proven restore path writes —
// feedback labels reverse-map to numbers, restrictions to '1'/'0', switch
// triples re-pack, and the deliberately excluded surfaces (mode changes,
// the live-view selection, calibration) are named in the summary instead of
// silently dropped. Data-level inconsistencies a valid export can never
// carry (unordered windows) refuse the import; device-rule violations (the
// hard-band margin) skip their own value. Version gates stay honest: what
// the connected firmware cannot hold is skipped with a reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc } = installGatingDom();
const app = await import('../app/js/main.js');
const { mapSettingsExportToSnapshot, importSettingsFromFile } = await import('../app/js/services/settings-export.js');
const { loadDeviceInfo } = await import('../app/js/services/settings-service.js');
const { testHooks } = await import('./harness/test-hooks.mjs');
const { noteDeviceVersion, resetWireNewlineFraming } = await import('../app/js/serial/commands.js');
const { getLogHistory } = await import('../app/js/services/log.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fullSettings = {
  firmwareVersion: '4.7.0',
  model: 'LipSync 4',
  operatingMode: 'Mouse',
  communicationMode: 'USB',
  cursorSpeedLevel: '5',
  scrollLevel: '6',
  cursorAcceleration: '2',
  sipThresholdhPa: '12.50',
  puffThresholdhPa: '25.00',
  hardSipThresholdhPa: '26.00',
  hardPuffThresholdhPa: '40.00',
  innerDeadzone: '0.07',
  outerDeadzone: '0.95',
  soundFeedback: 'Basic',
  lightFeedback: 'All',
  ledBrightness: '7',
  debugMode: 'Off',
  inputWindowShortMs: '600',
  inputWindowLongMs: '1200',
  inputWindowMaxMs: '3000',
  neutralPosition: '0.00',
  calibrationCorner1: '-13.00|13.00',
  sipPuffDisabled: false,
  menuButtonsOnly: true,
  switch1MouseActions: [1, 4, 19],
  switch1GamepadActions: [6, 8, 19],
  hardSipAction: 5,
  hardPuffAction: 4,
};

test('the mapper turns export keys into the wire snapshot the restore writes', () => {
  const { snapshot, skipped, holes, unknown, count } = mapSettingsExportToSnapshot({ settings: fullSettings });
  assert.equal(snapshot.VN, '4.7.0');
  assert.equal(snapshot.SS, '5');
  assert.equal(snapshot.SL, '6');
  assert.equal(snapshot.AV, '2');
  assert.equal(snapshot.ST, '12.5', 'numeric normalization is harmless: fmtApiFloat re-pads on the wire');
  assert.equal(snapshot.PT, '25');
  assert.equal(snapshot.HS, '26');
  assert.equal(snapshot.HP, '40');
  assert.equal(snapshot.IZ, '0.07');
  assert.equal(snapshot.OZ, '0.95');
  assert.equal(snapshot.LL, '7');
  assert.equal(snapshot.WS, '600');
  assert.equal(snapshot.WL, '1200');
  assert.equal(snapshot.WM, '3000');
  assert.equal(snapshot.SM, '1', 'the feedback label reverse-maps to its wire number');
  assert.equal(snapshot.LM, '2');
  assert.equal(snapshot.SD, '0');
  assert.equal(snapshot.MA, '1');
  assert.equal(snapshot.SA, '110419', 'the switch triple re-packs (100000 + 1·10000 + 4·100 + 19)');
  assert.equal(snapshot.GA, '160819');
  assert.equal(snapshot.HA, '5');
  assert.equal(snapshot.HB, '4');
  assert.equal(count, Object.keys(snapshot).length - 1, 'VN is informational, never counted');
  // The deliberately excluded surfaces are named, not silent.
  for (const key of ['operatingMode', 'communicationMode', 'debugMode', 'neutralPosition', 'calibrationCorner1'])
    assert.ok(
      skipped.some((s) => s.key === key),
      key + ' is excluded with a reason',
    );
  assert.deepEqual(holes, []);
  assert.deepEqual(unknown, []);
});

test('unrecognized feedback labels and malformed values skip with reasons', () => {
  const { snapshot, skipped } = mapSettingsExportToSnapshot({
    settings: { soundFeedback: 'Loud', ledBrightness: 'bright', sipPuffDisabled: 'yes', sipThresholdhPa: '12.50' },
  });
  assert.equal(snapshot.SM, undefined);
  assert.equal(snapshot.LL, undefined);
  assert.equal(snapshot.ST, '12.5');
  assert.ok(skipped.some((s) => s.key === 'soundFeedback' && /unrecognized/.test(s.reason)));
  assert.ok(skipped.some((s) => s.key === 'ledBrightness'));
  assert.ok(skipped.some((s) => s.key === 'sipPuffDisabled' && /true or false/.test(s.reason)));
});

test('unordered timing windows refuse the import', () => {
  assert.throws(
    () =>
      mapSettingsExportToSnapshot({
        settings: { inputWindowShortMs: '2500', inputWindowLongMs: '1000', inputWindowMaxMs: '3000' },
      }),
    /not ordered/,
  );
});

test("a hard threshold below the file's own regular one skips, not aborts", () => {
  const { snapshot, skipped } = mapSettingsExportToSnapshot({
    settings: { sipThresholdhPa: '20.00', hardSipThresholdhPa: '19.00', hardPuffThresholdhPa: '40.00' },
  });
  assert.equal(snapshot.HS, undefined, 'the violating hard sip is dropped');
  assert.equal(snapshot.HP, '40', 'the valid hard puff still applies');
  assert.ok(skipped.some((s) => s.key === 'HS' && /at least 1 hPa above/.test(s.reason)));
});

test('version gates are honest in the summary, not silent', () => {
  noteDeviceVersion('4.3.0');
  const { snapshot, skipped } = mapSettingsExportToSnapshot({ settings: fullSettings });
  // The connected device is 4.3.0: switches (4.5.0+) and the hard band (4.7.0+) cannot hold.
  assert.equal(snapshot.SA, undefined);
  assert.equal(snapshot.HS, undefined);
  assert.ok(skipped.some((s) => s.key === 'SA' && /4\.5\.0\+/.test(s.reason)));
  assert.ok(skipped.some((s) => s.key === 'HS' && /4\.7\.0\+/.test(s.reason)));
  // Restrictions (4.4.0+) and the base values survive.
  assert.equal(snapshot.SD, undefined, 'restrictions are 4.4.0-gated too');
  assert.equal(snapshot.ST, '12.5');
});

test('not-a-file shapes refuse cleanly', () => {
  assert.throws(() => mapSettingsExportToSnapshot(null), /not a LipSync Connect settings export/);
  assert.throws(() => mapSettingsExportToSnapshot({ settings: [] }), /not a LipSync Connect settings export/);
  assert.throws(() => mapSettingsExportToSnapshot({ settings: { model: 'X' } }), /no values this app can apply/);
});

// ---- End-to-end: confirm → restore burst → honest summary -------------------

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

function launchDevice() {
  const sent = [];
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
      const write = text.match(/^([A-Z]{2}),1:/);
      if (write) {
        reply(`SUCCESS,0:${text}`);
        return;
      }
      const cmd = text.slice(0, 4);
      if (cmd in BASE_RESPONSES) reply(`SUCCESS,0:${cmd}:${BASE_RESPONSES[cmd]}`);
    },
  };
  testHooks.attach({ simulated: true }, writer);
  return sent;
}

test('importing a file applies it through the restore burst with a summary', async () => {
  resetWireNewlineFraming();
  const sent = launchDevice();
  await loadDeviceInfo();
  await sleep(20);
  const fileText = JSON.stringify({
    device: 'LipSync',
    exportedAt: '2026-11-13T00:00:00.000Z',
    settings: {
      firmwareVersion: '4.4.0',
      cursorSpeedLevel: '7',
      sipThresholdhPa: '12.50',
      soundFeedback: 'All',
      inputWindowShortMs: '600',
      inputWindowLongMs: '1200',
      inputWindowMaxMs: '3000',
      operatingMode: 'Mouse',
    },
    notLoaded: ['ledBrightness'],
  });
  const done = importSettingsFromFile(fileText);
  await sleep(30); // the confirm dialog renders
  doc.getElementById('confirmOk').dispatch('click');
  const result = await done;
  assert.equal(result.applied, 6, 'SS, ST, SM, WS, WL, WM');
  assert.equal(result.count, 6);
  for (const cmd of ['SS,1:7', 'ST,1:12.500', 'SM,1:2', 'WS,1:600', 'WL,1:1200', 'WM,1:3000'])
    assert.ok(sent.includes(cmd), cmd + ' reaches the wire (fmtApiFloat form for floats)');
  assert.ok(getLogHistory().join('\n').includes('Settings import: 6 of 6 values applied.'));
  assert.ok(getLogHistory().join('\n').includes('operatingMode'), 'the exclusion is named in the summary');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('declining the confirm writes nothing', async () => {
  resetWireNewlineFraming();
  const sent = launchDevice();
  await loadDeviceInfo();
  await sleep(20);
  const done = importSettingsFromFile(JSON.stringify({ settings: { cursorSpeedLevel: '7' } }));
  await sleep(30);
  doc.getElementById('confirmCancel').dispatch('click');
  const result = await done;
  assert.equal(result, null);
  assert.ok(!sent.some((s) => s.startsWith('SS,1:')), 'no wire write without the confirm');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});
