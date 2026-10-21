// Health-check behavior (services/health.js), including the firmware-4.3.0+
// "I2C bus" step (roadmap item 3): the BH,0:0 telemetry read, its healthy vs.
// troubled verdicts, and the unavailable-step reporting on older firmware.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc } = installGatingDom();
const app = await import('../app/js/main.js');
const { runDiagnostics } = await import('../app/js/services/health.js');
const { testHooks } = await import('./harness/test-hooks.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The five diagnostic reads with healthy defaults; individual tests override
// the BH payload or drop it entirely. (Keys are the 4-char command prefix the
// writer slices from the wire text.)
function launch(responses = {}) {
  const defaults = {
    'PV,0': '400,1000,3',
    'JV,0': '1.0,2.0,3.0,4.0,5.0,6.0',
    'IN,0': '0.5|0.5',
    'CA,0': '0.69|1.14,-1.00|1.00,1.00|1.00,1.00|-1.00,-1.00|-1.00',
    'BH,0': '0,1,1,1,1,-1',
  };
  const merged = { ...defaults, ...responses };
  const sent = [];
  const writer = {
    write(bytes) {
      const text = Buffer.from(bytes).toString('utf8');
      sent.push(text);
      const reply = (line) => setTimeout(() => app.handleLine(line), 5);
      if (text === 'SETTINGS') {
        reply('SUCCESS,0:SETTINGS');
        return;
      }
      const cmd = text.slice(0, 4);
      if (cmd in merged) reply(`SUCCESS,0:${cmd}:${merged[cmd]}`);
    },
  };
  testHooks.attach({ simulated: true }, writer);
  return sent;
}

test('health check passes all five steps on a healthy 4.3.0 device', async () => {
  doc.getElementById('version').textContent = '4.3.0';
  const sent = launch();
  await runDiagnostics();
  await sleep(30);
  assert.ok(sent.includes('BH,0:0'), 'the bus-health endpoint was read');
  assert.equal(doc.getElementById('hcBus').getAttribute('data-state'), 'ok');
  assert.equal(doc.getElementById('healthSummary').textContent, 'Passed');
  assert.match(doc.getElementById('healthDetails').textContent, /All 5 checks passed/);
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('health check reports a troubled I2C bus with specific findings', async () => {
  doc.getElementById('version').textContent = '4.3.0';
  launch({ 'BH,0': '3,0,2,1,1,5' });
  await runDiagnostics();
  await sleep(30);
  assert.equal(doc.getElementById('hcBus').getAttribute('data-state'), 'warn');
  assert.equal(doc.getElementById('healthSummary').textContent, 'Needs attention');
  const details = doc.getElementById('healthDetails').textContent;
  assert.match(details, /wedged 3 times since power-on/);
  assert.match(details, /last was 5s ago/);
  assert.match(details, /being held right now/);
  assert.match(details, /display stopped answering/);
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('health check flags an incomplete BH reading as an error, not a pass', async () => {
  doc.getElementById('version').textContent = '4.3.0';
  launch({ 'BH,0': '0,1,1' }); // truncated payload
  await runDiagnostics();
  await sleep(30);
  assert.equal(doc.getElementById('hcBus').getAttribute('data-state'), 'err');
  assert.equal(doc.getElementById('healthSummary').textContent, 'Needs attention');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('older firmware reports the bus step as unavailable instead of failing', async () => {
  doc.getElementById('version').textContent = '4.1.0';
  const sent = launch();
  await runDiagnostics();
  await sleep(30);
  assert.ok(!sent.includes('BH,0:0'), 'the BH endpoint is never asked of old firmware');
  assert.equal(doc.getElementById('hcBus').textContent, 'I2C bus (needs a newer firmware)');
  assert.equal(doc.getElementById('healthSummary').textContent, 'Passed');
  assert.match(doc.getElementById('healthDetails').textContent, /All 4 checks passed/);
  await app.disconnect({ quiet: true });
  testHooks.detach();
});
