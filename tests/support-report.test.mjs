// Combined support artifact: one file identifies the app/device, records the
// dump outcome, includes the full session transcript, and applies the existing
// device-identity redaction before it can be downloaded or shared.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc } = installGatingDom();
const { buildSupportReport } = await import('../app/js/services/log-export.js');
const { createSupportReport } = await import('../app/js/services/support-report.js');
const { getLogHistory } = await import('../app/js/services/log.js');
const { APP_BUILD_ID } = await import('../app/js/config/constants.js');

doc.getElementById('homeConnection').textContent = 'USB connected';
doc.getElementById('model').textContent = 'LipSync 4';
doc.getElementById('version').textContent = '4.6.5';
doc.getElementById('opmode').textContent = 'Mouse';
doc.getElementById('commode').textContent = 'USB';
doc.getElementById('healthSummary').textContent = 'Passed';
doc.getElementById('deviceId').textContent = 'a1b2c3d4';
// A completed health run: the grid is visible and every step carries its
// outcome — exactly what the report's per-step line should mirror.
doc.getElementById('healthGrid').hidden = false;
for (const [id, state] of [
  ['hcPressure', 'ok'],
  ['hcJoystick', 'ok'],
  ['hcNeutral', 'warn'],
  ['hcCalibration', 'ok'],
  ['hcBus', 'err'],
]) {
  doc.getElementById(id).setAttribute('data-state', state);
}
getLogHistory().push('2026-11-01T00:00:00.000Z  SUCCESS,1:ID,1:a1b2c3d4');
getLogHistory().push('2026-11-01T00:00:01.000Z  SUCCESS,0:EX,0:END');

test('support report combines app, device, health, dump, and session context', () => {
  const { text, filename } = buildSupportReport({ dumpStatus: 'Included in the session log' });
  assert.match(text, /^LipSync Connect support report/m);
  assert.match(text, new RegExp(`App build: ${APP_BUILD_ID.replaceAll('.', '\\.')}`));
  assert.match(text, /Device model: LipSync 4/);
  assert.match(text, /Firmware: 4\.6\.5/);
  assert.match(text, /Operating mode: Mouse/);
  assert.match(text, /Health check: Passed/);
  assert.match(text, /Settings dump: Included in the session log/);
  assert.match(text, /SUCCESS,0:EX,0:END/);
  assert.match(filename, /^lipsync-support-.*\.txt$/);
});

test('support report ships the per-step health outcomes, not just the summary', () => {
  const { text } = buildSupportReport();
  assert.match(
    text,
    /Health check steps: Pressure sensors — OK; Joystick response — OK; Neutral position — Warning; Stored calibration — OK; Internal sensors \(I2C\) — Failed/,
  );
});

test('a runless session omits the health-steps line instead of reporting Unknown', () => {
  doc.getElementById('healthGrid').hidden = true;
  const { text } = buildSupportReport();
  assert.match(text, /Health check: Passed/);
  assert.ok(!text.includes('Health check steps:'), 'no steps line without a populated grid');
  doc.getElementById('healthGrid').hidden = false;
});

test('hold practice stats join the report only when holds were measured', async () => {
  const before = buildSupportReport();
  assert.ok(!before.text.includes('Hold practice:'), 'no practice line with an empty session');
  const { notePracticeHold, resetPracticeStats } = await import('../app/js/services/practice-stats.js');
  notePracticeHold('sip', 900);
  notePracticeHold('puff', 1500);
  const { text } = buildSupportReport();
  assert.match(text, /Hold practice: Sip: 1 hold · avg 900 ms · spread ±0 ms · max 900 ms · Puff: 1 hold/);
  resetPracticeStats();
  assert.ok(!buildSupportReport().text.includes('Hold practice:'), 'reset clears the line');
});

test('support report removes device identity from its transcript', () => {
  const { text } = buildSupportReport();
  assert.ok(!text.includes('a1b2c3d4'));
  assert.match(text, /\[device-id\]/);
  assert.match(text, /Device identifiers: redacted/);
});

test('disconnected report still succeeds and names the missing settings dump', async () => {
  doc.getElementById('homeConnection').textContent = 'Not connected';
  const { text } = await createSupportReport();
  assert.match(text, /Connection: Not connected/);
  assert.match(text, /Settings dump: Not captured \(no LipSync connected\)/);
});

test('paired Bluetooth host names ship only when the option is ticked — never MACs', async () => {
  const { btHostTable } = await import('../app/js/services/bt-hosts.js');
  btHostTable.count = 2;
  btHostTable.rows = {
    1: { i: 1, mac: 'AA:BB:CC:DD:EE:F1', name: 'Marys_iPad', active: 1 },
    2: { i: 2, mac: 'AA:BB:CC:DD:EE:F2', name: 'School_Laptop', active: 0 },
  };
  try {
    const without = buildSupportReport();
    assert.ok(!without.text.includes('Marys_iPad'), 'names stay out by default');
    assert.ok(!without.text.includes('Paired Bluetooth hosts'));
    const withHosts = buildSupportReport({ includeBtHosts: true });
    assert.match(withHosts.text, /Paired Bluetooth hosts: 2/);
    assert.match(withHosts.text, /1\. Marys_iPad \(active\)/);
    assert.match(withHosts.text, /2\. School_Laptop/);
    assert.ok(!withHosts.text.includes('AA:BB'), 'MAC addresses never ship, even opted in');
  } finally {
    btHostTable.count = 0;
    btHostTable.rows = {};
  }
});

test('an empty host table omits the line even when opted in', () => {
  const { text } = buildSupportReport({ includeBtHosts: true });
  assert.ok(!text.includes('Paired Bluetooth hosts'));
});
