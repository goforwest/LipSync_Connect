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
