// Behavioral verification of the initial settings load (services/settings-service.js
// loadDeviceInfo): the 17-endpoint read-back, placeholder -> value transitions, the
// ERR state for a failed endpoint, and the progress bar lifecycle. Runs against the
// real wiring (main.js module graph + gating DOM stub) with a simulated v4.1 device.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc } = installGatingDom();
const app = await import('../app/js/main.js');
const { loadDeviceInfo } = await import('../app/js/services/settings-service.js');
const { testHooks } = await import('./harness/test-hooks.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// All 17 load endpoints with a value per endpoint; SL is overridden to FAIL by
// launch(true) to exercise the ERR path.
const RESPONSES = {
  'MN,0': '1',
  'VN,0': '4.1.0',
  'ID,0': 'a1b2c3d4',
  'OM,0': '1',
  'CM,0': '1',
  'SS,0': '6',
  'SL,0': '5',
  'ST,0': '12',
  'PT,0': '14',
  'IZ,0': '0.25',
  'OZ,0': '0.75',
  'IN,0': '0.5|0.5',
  'CA,0': '0.69|1.14,-1.00|1.00,1.00|1.00,1.00|-1.00,-1.00|-1.00',
  'SM,0': '1',
  'LM,0': '1',
  'LL,0': '8',
  'DM,0': '0',
};

function launch(failSl) {
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
      if (failSl && text === 'SL,0:0') {
        reply('FAIL,0:SL,0:0');
        return;
      }
      const cmd = text.slice(0, 4);
      if (cmd in RESPONSES) reply(`SUCCESS,0:${cmd}:${RESPONSES[cmd]}`);
    },
  };
  testHooks.attach({ simulated: true }, writer);
  return sent;
}

test('settings load populates every endpoint and clears loading placeholders', async () => {
  const sent = launch(false);
  doc.getElementById('loadProgressRow').hidden = false;
  await loadDeviceInfo();
  await sleep(30); // drain the last queued reply
  assert.deepEqual(sent, [
    'SETTINGS', 'MN,0:0', 'SETTINGS', 'VN,0:0', 'SETTINGS', 'ID,0:0', 'SETTINGS', 'OM,0:0',
    'SETTINGS', 'CM,0:0', 'SETTINGS', 'SS,0:0', 'SETTINGS', 'SL,0:0', 'SETTINGS', 'ST,0:0',
    'SETTINGS', 'PT,0:0', 'SETTINGS', 'IZ,0:0', 'SETTINGS', 'OZ,0:0', 'SETTINGS', 'IN,0:0',
    'SETTINGS', 'CA,0:0', 'SETTINGS', 'SM,0:0', 'SETTINGS', 'LM,0:0', 'SETTINGS', 'LL,0:0',
    'SETTINGS', 'DM,0:0',
  ]);
  assert.equal(doc.getElementById('model').textContent, 'LipSync 4 (1)');
  assert.equal(doc.getElementById('version').textContent, '4.1.0');
  assert.equal(doc.getElementById('speedVal').textContent, '6');
  assert.equal(doc.getElementById('modeGuardHint').textContent, '');
  // Reduced-motion stub makes the progress row collapse instantly.
  assert.equal(doc.getElementById('loadProgressRow').hidden, true);
  assert.equal(doc.getElementById('loadProgress').value, 17);
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('a failed endpoint renders ERR and a recovery hint', async () => {
  const _sent = launch(true);
  await loadDeviceInfo();
  await sleep(30); // drain the final queued replies
  const errCell = doc.getElementById('scrollVal');
  assert.equal(errCell.textContent, 'ERR');
  assert.ok(errCell.classList.contains('err'));
  assert.equal(errCell.getAttribute('aria-label'), 'Scroll level failed to load');
  assert.match(doc.getElementById('modeGuardHint').textContent, /1 of 17 settings failed to load/);
  // The rest of the load still landed.
  assert.equal(doc.getElementById('sipVal').textContent, '12');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});