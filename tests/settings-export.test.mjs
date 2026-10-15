// Settings snapshot export (services/settings-export.js, roadmap item 13 /
// upstream #67): the JSON download that replaces endpoint-by-endpoint
// walkthroughs during support — labeled values, visible holes, and the
// device identifier left out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc } = installGatingDom();
await import('../app/js/main.js');
const { collectSettingsExport, buildSettingsExportFile } = await import(
  '../app/js/services/settings-export.js'
);

function setLoadedValues(v = {}) {
  const defaults = {
    model: 'LipSync 4 (1)',
    version: '4.3.0',
    opmode: 'Mouse',
    commode: 'USB',
    speedVal: '5',
    scrollVal: '5',
    accelVal: '0',
    sipVal: '3.00',
    puffVal: '3.00',
    innerDeadzoneVal: '0.07',
    outerDeadzoneVal: '0.95',
    soundModeVal: 'Basic',
    lightModeVal: 'Basic',
    brightnessVal: '5',
    debugModeVal: 'Off',
    neutralVal: '0.00',
    corner1: '-13.00|13.00',
    corner2: '13.00|13.00',
    corner3: '13.00|-13.00',
    corner4: '-13.00|-13.00',
  };
  for (const [id, value] of Object.entries({ ...defaults, ...v })) doc.getElementById(id).textContent = value;
}

test('a loaded device exports labeled settings with no holes', () => {
  setLoadedValues();
  const data = collectSettingsExport();
  assert.equal(data.device, 'LipSync');
  assert.equal(data.settings.firmwareVersion, '4.3.0');
  assert.equal(data.settings.model, 'LipSync 4 (1)');
  assert.equal(data.settings.operatingMode, 'Mouse');
  assert.equal(data.settings.accelVal, undefined, 'wire keys are not exported — human labels only');
  assert.equal(data.settings.cursorSpeedLevel, '5');
  assert.equal(data.settings.calibrationCorner1, '-13.00|13.00');
  assert.deepEqual(data.notLoaded, [
    'inputWindowShortMs',
    'inputWindowLongMs',
    'inputWindowMaxMs',
    'sipPuffDisabled',
    'menuButtonsOnly',
    'modeLocked',
    'cursorHoldDuringSap',
    'switch1MouseActions',
    'switch2MouseActions',
    'switch3MouseActions',
    'switch1GamepadActions',
    'switch2GamepadActions',
    'switch3GamepadActions',
  ]);
  assert.match(data.note, /identifier is redacted/);
});

test('values that did not load are listed as holes, not exported as garbage', () => {
  setLoadedValues({ sipVal: 'ERR', puffVal: '—', debugModeVal: '…' });
  const data = collectSettingsExport();
  assert.equal(data.settings.sipThresholdhPa, undefined);
  assert.deepEqual(data.notLoaded, [
    'sipThresholdhPa',
    'puffThresholdhPa',
    'debugMode',
    'inputWindowShortMs',
    'inputWindowLongMs',
    'inputWindowMaxMs',
    'sipPuffDisabled',
    'menuButtonsOnly',
    'modeLocked',
    'cursorHoldDuringSap',
    'switch1MouseActions',
    'switch2MouseActions',
    'switch3MouseActions',
    'switch1GamepadActions',
    'switch2GamepadActions',
    'switch3GamepadActions',
  ]);
  assert.match(data.note, /notLoaded/);
});

test('the export never contains the device identifier', () => {
  setLoadedValues();
  // The one value that could identify the user's device is the ID — the
  // export deliberately does not read it at all.
  doc.getElementById('deviceId').textContent = 'a1b2c3d4e5f6';
  const text = buildSettingsExportFile().text;
  assert.ok(!text.includes('a1b2c3d4e5f6'), 'the device id is absent from the exported JSON');
  assert.match(text, /"device": "LipSync"/);
  assert.match(text, /"exportedAt"/);
});

test('the export filename carries the firmware version and a filesystem-safe timestamp', () => {
  setLoadedValues();
  const { filename } = buildSettingsExportFile();
  assert.match(filename, /^lipsync-settings-4\.3\.0-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/);
});
