// Behavioral verification of the Hub remote mirror (services/hub-remote.js):
// Open/Next/Select/Close presses drive a deterministic screen state machine,
// failed presses leave the mirror untouched but surface the error, and the
// disconnect hook resyncs (closes) the mirror.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';
import { createDeviceSimulator } from './harness/firmware-sim.mjs';

const { els } = installGatingDom();
const app = await import('../app/js/main.js');
const { bindHubRemote, resetHubRemote } = await import('../app/js/services/hub-remote.js');
const { guard } = await import('../app/js/ui/guard.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// guard() reports into the stub DOM and swallows hub-remote's own failures.
bindHubRemote(guard);

const outSent = (dev) => dev.sent.filter((s) => s.startsWith('CH,'));
const header = () => els.get('hubScreenHeader').textContent;
const note = () => els.get('hubScreenNote').textContent;
const items = () => els.get('hubScreenItems').children;
const selectedLabel = () => items().find((li) => li.classList && li.classList.contains('selected'))?.textContent;
const wrapHidden = () => els.get('hubScreenWrap').hidden;
const click = async (id) => {
  els.get(id).dispatch('click');
  await sleep(50); // sendCommand round-trip through the simulator
};

test('mirror follows Hub presses through a menu path', async () => {
  const dev = createDeviceSimulator({ handleLine: app.handleLine }).attachDevice((text) => {
    if (text === 'SETTINGS') return [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }];
    return [{ delay: 5, line: `SUCCESS,0:${text}` }];
  });

  await click('btnHubOpen');
  assert.equal(wrapHidden(), false);
  assert.equal(header(), 'Main menu');
  assert.equal(items().length, 5);
  assert.equal(selectedLabel(), 'Exit Menu');

  await click('btnHubNext');
  assert.equal(selectedLabel(), 'Center Reset');
  await click('btnHubNext');
  assert.equal(selectedLabel(), 'Mode');
  await click('btnHubSelect');
  assert.equal(header(), 'Mode');
  assert.equal(items().length, 4);

  await click('btnHubNext');
  await click('btnHubNext');
  assert.equal(selectedLabel(), 'GAMEPAD');
  await click('btnHubSelect');
  assert.equal(header(), 'Change mode to GAMEPAD?');
  await click('btnHubSelect');
  assert.equal(header(), 'Running on device');
  assert.match(note(), /release the joystick/);

  await click('btnHubClose');
  assert.equal(wrapHidden(), true);

  assert.deepEqual(outSent(dev), [
    'CH,1:1',
    'CH,1:3',
    'CH,1:3',
    'CH,1:2',
    'CH,1:3',
    'CH,1:3',
    'CH,1:2',
    'CH,1:2',
    'CH,1:4',
  ]);
  await app.disconnect({ quiet: true });
  dev.detach();
});

test('a failed press surfaces the error and does not advance the mirror', async () => {
  const dev = createDeviceSimulator({ handleLine: app.handleLine }).attachDevice((text) => {
    if (text === 'SETTINGS') return [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }];
    return [{ delay: 5, line: 'FAIL,0:' + text }];
  });

  await click('btnHubOpen');
  assert.match(els.get('hubRemoteError').textContent, /rejected/i);
  assert.equal(wrapHidden(), true); // Open failed — the mirror never opened
  assert.deepEqual(outSent(dev), ['CH,1:1']);

  // The next successful Open is the resync affordance.
  await app.disconnect({ quiet: true });
  dev.detach();
});

test('resetHubRemote closes the mirror and clears the error on disconnect', async () => {
  const dev = createDeviceSimulator({ handleLine: app.handleLine }).attachDevice((text) => {
    if (text === 'SETTINGS') return [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }];
    return [{ delay: 5, line: `SUCCESS,0:${text}` }];
  });
  await click('btnHubOpen');
  assert.equal(wrapHidden(), false);
  els.get('hubRemoteError').textContent = 'stale message';
  resetHubRemote();
  assert.equal(wrapHidden(), true);
  assert.equal(els.get('hubRemoteError').textContent, '');
  await app.disconnect({ quiet: true });
  dev.detach();
});
