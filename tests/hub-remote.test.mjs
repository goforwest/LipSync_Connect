// Behavioral verification of the Hub remote mirror (services/hub-remote.js):
// Open/Next/Select/Close presses drive a deterministic screen state machine,
// failed presses leave the mirror untouched but surface the error, and the
// disconnect hook resyncs (closes) the mirror.
//
// The menu tree is version-gated against the connected firmware: the 4.4.0
// pages (More ▸ Acceleration/Restrictions, Sip & Puff ▸ Timing, the coarse
// threshold level scale) appear only once VN has identified 4.3.0/4.4.0+ —
// an older device must show exactly the older menu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';
import { createDeviceSimulator } from './harness/firmware-sim.mjs';

const { els, document: doc } = installGatingDom();
const app = await import('../app/js/main.js');
const { bindHubRemote, resetHubRemote } = await import('../app/js/services/hub-remote.js');
const { guard } = await import('../app/js/ui/guard.js');
const { noteDeviceVersion, resetWireNewlineFraming } = await import('../app/js/serial/commands.js');

// Auto-creating accessor for readouts the tests seed (els.get alone won't
// fabricate missing ids).
const el = (id) => doc.getElementById(id);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// guard() reports into the stub DOM and swallows hub-remote's own failures.
bindHubRemote(guard);

// The active simulator for the click helpers (set at the top of each test).
let activeDev = null;
const outSent = (dev) => dev.sent.filter((s) => s.startsWith('CH,'));
const header = () => els.get('hubScreenHeader').textContent;
const note = () => els.get('hubScreenNote').textContent;
const items = () => els.get('hubScreenItems').children;
const labels = () => items().map((li) => li.textContent);
const selectedLabel = () => items().find((li) => li.classList && li.classList.contains('selected'))?.textContent;
const wrapHidden = () => els.get('hubScreenWrap').hidden;
// The first press of a session can far exceed any fixed sleep — the command
// queue's first run pays the SETTINGS handshake plus one-time module init —
// so every click polls until its press actually reaches the wire (and its
// ack round-trips) instead of trusting a timer.
const click = async (id) => {
  const before = activeDev ? activeDev.sent.filter((s) => s.startsWith('CH,')).length : 0;
  els.get(id).dispatch('click');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await sleep(5);
    const now = activeDev ? activeDev.sent.filter((s) => s.startsWith('CH,')).length : 0;
    if (now > before) break;
  }
  await sleep(40); // the scheduled ack (5 ms) lands and the mirror advances
};
const next = async (n = 1) => {
  for (let i = 0; i < n; i++) await click('btnHubNext');
};
const select = async () => click('btnHubSelect');

// Opens the mirror against a device identified as `version` (or unidentified
// when null) and leaves the cursor on the More menu.
const openMore = async (version) => {
  resetWireNewlineFraming();
  if (version) noteDeviceVersion(version);
  else noteDeviceVersion('unknown');
  await click('btnHubOpen');
  await next(4); // Exit, Center Reset, Mode, Cursor Speed → More
  await select();
};

test('mirror follows Hub presses through a menu path', async () => {
  const dev = createDeviceSimulator({ handleLine: app.handleLine }).attachDevice((text) => {
    if (text === 'SETTINGS') return [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }];
    return [{ delay: 5, line: `SUCCESS,0:${text}` }];
  });
  activeDev = dev;

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
  activeDev = dev;

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
  activeDev = dev;
  await click('btnHubOpen');
  assert.equal(wrapHidden(), false);
  els.get('hubRemoteError').textContent = 'stale message';
  resetHubRemote();
  assert.equal(wrapHidden(), true);
  assert.equal(els.get('hubRemoteError').textContent, '');
  await app.disconnect({ quiet: true });
  dev.detach();
});

// ---- Version-gated menu tree (firmware 4.3.0/4.4.0 pages) ----

const ackAll = () =>
  createDeviceSimulator({ handleLine: app.handleLine }).attachDevice((text) => {
    if (text === 'SETTINGS') return [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }];
    return [{ delay: 5, line: `SUCCESS,0:${text}` }];
  });

test('a 4.4.0 device shows Acceleration and Restrictions in More, in firmware order', async () => {
  const dev = ackAll();
  activeDev = dev;
  await openMore('4.4.0');
  assert.deepEqual(labels(), [
    'Sound',
    'Light Brightness',
    'Scroll Speed',
    'Sip & Puff',
    'Full Calibration',
    'Restart LipSync',
    'Factory Reset',
    'Info',
    'Acceleration',
    'Restrictions',
    '... Back',
  ]);
  await app.disconnect({ quiet: true });
  dev.detach();
});

test('the Acceleration page (4.3.0+) steps and reseeds from the app readout', async () => {
  const dev = ackAll();
  activeDev = dev;
  el('accelVal').textContent = '-2';
  await openMore('4.4.0');
  await next(8); // Sound..Acceleration
  await select();
  assert.equal(header(), 'Accel: -2');
  await select(); // Increase
  assert.equal(header(), 'Accel: -1');
  await next();
  await select(); // Decrease
  assert.equal(header(), 'Accel: -2');
  await app.disconnect({ quiet: true });
  dev.detach();
});

test('the Restrictions page (4.4.0+) shows state-bearing lines and toggles them', async () => {
  const dev = ackAll();
  activeDev = dev;
  el('sapDisabled').checked = true;
  el('menuButtonsOnly').checked = false;
  el('modeLock').checked = false;
  el('cursorHold').checked = false;
  await openMore('4.4.0');
  await next(9); // Sound..Restrictions
  await select();
  assert.deepEqual(labels(), ['Sip&Puff: Off', 'Menu: All', 'Mode lock: Off', 'Cursor hold: Off', '... Back']);
  await select(); // toggle sip&puff
  assert.deepEqual(labels(), ['Sip&Puff: On', 'Menu: All', 'Mode lock: Off', 'Cursor hold: Off', '... Back']);
  await next(3);
  await select(); // toggle cursor hold
  assert.deepEqual(labels(), ['Sip&Puff: On', 'Menu: All', 'Mode lock: Off', 'Cursor hold: On', '... Back']);
  await app.disconnect({ quiet: true });
  dev.detach();
});

test('the Timing pages (4.4.0+) step 250 ms and refuse boundary/ordering breaks', async () => {
  const dev = ackAll();
  activeDev = dev;
  el('w1Val').textContent = '500';
  el('w2Val').textContent = '1500';
  el('w3Val').textContent = '4000';
  await openMore('4.4.0');
  await next(3); // Sip & Puff
  await select();
  assert.deepEqual(labels(), ['Sip Threshold', 'Puff Threshold', 'Timing', '... Back']);
  await next(2);
  await select(); // Timing
  assert.deepEqual(labels(), ['Short: 500ms', 'Long: 1500ms', 'Max: 4000ms', '... Back']);
  await select(); // Short adjust page
  assert.equal(header(), 'Short: 500ms');
  await select(); // Increase 250
  assert.equal(header(), 'Short: 750ms');
  await select();
  await select(); // → 1250
  assert.equal(header(), 'Short: 1250ms');
  await select(); // would be 1500 == long → refused
  assert.equal(header(), 'Short: 1250ms');
  await next(2);
  await select(); // Back to the timing menu — the refused steps never wrote
  assert.deepEqual(labels(), ['Short: 1250ms', 'Long: 1500ms', 'Max: 4000ms', '... Back']);
  await app.disconnect({ quiet: true });
  dev.detach();
});

test('threshold pages on 4.4.0+ step the coarse level scale with L# labels', async () => {
  const dev = ackAll();
  activeDev = dev;
  el('sipVal').textContent = '3.50';
  await openMore('4.4.0');
  await next(3); // Sip & Puff
  await select();
  await select(); // Sip Threshold
  assert.equal(header(), 'Sip: L3 3.50');
  await select(); // Increase → 4.00 (still level 3's span)
  assert.equal(header(), 'Sip: L3 4.00');
  await next();
  await select(); // Decrease → 3.00 (level 2's span)
  assert.equal(header(), 'Sip: L2 3.00');
  await app.disconnect({ quiet: true });
  dev.detach();
});

test('a 4.1 device shows the old menu: no Acceleration/Restrictions/Timing, ±1 hPa steps', async () => {
  const dev = ackAll();
  activeDev = dev;
  el('sipVal').textContent = '3.50';
  await openMore('4.1.0');
  assert.deepEqual(labels(), [
    'Sound',
    'Light Brightness',
    'Scroll Speed',
    'Sip & Puff',
    'Full Calibration',
    'Restart LipSync',
    'Factory Reset',
    'Info',
    '... Back',
  ]);
  await next(3); // Sip & Puff
  await select();
  assert.deepEqual(labels(), ['Sip Threshold', 'Puff Threshold', '... Back']);
  await select(); // Sip Threshold
  assert.equal(header(), 'Sip: 3.50');
  await select(); // Increase (plain +1 hPa on this firmware)
  assert.equal(header(), 'Sip: 4.50');
  await app.disconnect({ quiet: true });
  dev.detach();
});

test('the Info page keeps Version/ID display-only — the cursor never leaves Back', async () => {
  const dev = ackAll();
  activeDev = dev;
  el('version').textContent = '4.4.0';
  el('deviceId').textContent = 'LS_test';
  await openMore('4.4.0');
  await next(7); // Info
  await select();
  assert.deepEqual(labels(), ['Version: 4.4.0', 'ID: LS_test', '... Back']);
  assert.equal(selectedLabel(), '... Back');
  await next();
  await next();
  assert.equal(selectedLabel(), '... Back'); // display rows are skipped
  await select(); // Back
  assert.equal(header(), 'More');
  await app.disconnect({ quiet: true });
  dev.detach();
});
