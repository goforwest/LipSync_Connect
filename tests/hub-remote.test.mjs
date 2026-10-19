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

// ---- Device-truth re-sync (firmware 4.5.1+, the CH,0:0 endpoint) ----------
//
// A simulator faithful enough to reproduce the drift: CH,1 presses ack
// SUCCESS even when REFUSED (an LK-locked mode row answers with the ~2 s
// "Mode is locked" page — page 32 on 4.5.1 — whose frozen-input window
// DROPS later presses, still acking them). State is evaluated lazily at
// CH,0:0 read time, the way the firmware's scheduled transitions behave.
function createMenuFirmwareSim({ locked = false } = {}) {
  const st = { active: 0, page: 0, row: 0, frozenUntil: 0 };
  // Selectable-row counts per page (LSScreen.h _currentMenuLength values).
  const LEN = { 0: 5, 1: 2, 3: 4, 31: 2, 5: 11, 51: 2, 54: 4, 551: 2, 57: 2, 59: 3, 60: 5, 61: 4, 611: 3 };
  const MORE_SELECT = [51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 0]; // Sound..Back
  const advanceTransients = () => {
    const now = Date.now();
    if (st.page === 32 && now >= st.frozenUntil) {
      st.page = 3; // finishModeLocked → modeMenu()
      st.row = 0;
      st.frozenUntil = 0;
    }
    if (st.page === 55 && now >= st.frozenUntil) {
      st.page = 551; // fullCalibrationConfirmMenu
      st.row = 0;
      st.frozenUntil = 0;
    }
  };
  const select = () => {
    switch (st.page) {
      case 0:
        st.page = st.row + 1;
        st.row = 0;
        break; // main → exit/calib/mode/speed/more
      case 3:
        if (st.row < 3 && locked) {
          st.page = 32; // modeLockedPage: input frozen ~2 s
          st.row = 0;
          st.frozenUntil = Date.now() + 2000;
        } else if (st.row < 3) {
          st.page = 31;
          st.row = 0;
        } // else: Back → handled below
        break;
      case 5:
        st.page = MORE_SELECT[st.row];
        st.row = 0;
        if (st.page === 55) st.frozenUntil = Date.now() + 3000; // the warning page
        break;
      case 31:
      case 551:
      case 57:
        if (st.row === 1) {
          st.page = 0;
          st.row = 0;
        } // Back
        break;
      case 54:
        st.page = st.row === 0 ? 541 : 542;
        st.row = 0;
        break;
      case 59:
      case 60:
      case 61:
        if (st.row === LEN[st.page] - 1) {
          st.page = 5;
          st.row = 0;
        }
        break;
      case 611:
        if (st.row === 2) {
          st.page = 61;
          st.row = 0;
        }
        break;
      case 1:
        if (st.row === 1) {
          st.page = 0;
          st.row = 0;
        } // Back → main
        break;
    }
  };
  return {
    behavior: (text) => {
      if (text === 'SETTINGS') return [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }];
      if (text.startsWith('CH,1:')) {
        const n = parseInt(text.slice(5), 10);
        if (st.active && Date.now() < st.frozenUntil && n !== 1) {
          // dropped in the frozen window — but still acked (the firmware bug
          // the endpoint exists to see through)
        } else if (n === 1) {
          st.active = 1;
          st.page = 0;
          st.row = 0;
        } else if (n === 4) {
          st.active = 0;
        } else if (n === 3) {
          if (st.page in LEN) st.row = (st.row + 1) % LEN[st.page];
        } else if (n === 2) {
          if (st.page in { 51: 1, 59: 1, 60: 1, 611: 1 }) {
            // value screens step values — not modeled; stay put
          } else {
            select();
          }
        }
        return [{ delay: 5, line: 'SUCCESS,0:CH,1:' + n }];
      }
      if (text === 'CH,0:0') {
        advanceTransients();
        return [{ delay: 5, line: `SUCCESS,0:CH,0:${st.active},${st.page},${st.row}` }];
      }
      return [{ delay: 5, line: 'SUCCESS,0:' + text }];
    },
    state: st,
  };
}

// Waits until the simulator's menu traffic settles (a press plus its sync
// read plus any scheduled transient re-read), then one extra beat for the
// mirror to reconcile. Device truth settles; polling beats fixed sleeps.
// Commands are compared newline-stripped: a 4.2.0+ device (like the 4.5.1
// sim) receives protocol-v2 newline-terminated writes.
const sentCmds = () => (activeDev ? activeDev.sent.map((s) => s.replace(/\r?\n$/, '')) : []);
const settle = async (ms = 400) => {
  for (;;) {
    const before = activeDev ? activeDev.sent.length : 0;
    await sleep(120);
    if (activeDev && activeDev.sent.length === before) break;
  }
  await sleep(ms);
};

test('a 4.5.1 remote re-syncs from device truth after every press', async () => {
  const sim = createMenuFirmwareSim({ locked: false });
  const dev = createDeviceSimulator({ handleLine: app.handleLine }).attachDevice(sim.behavior);
  activeDev = dev;
  noteDeviceVersion('4.5.1');
  await click('btnHubOpen');
  await settle();
  assert.equal(header(), 'Main menu');
  assert.ok(sentCmds().includes('CH,0:0'), 'the menu-state read was issued');

  await next(2); // → Mode row
  await select(); // enters the Mode page
  await settle();
  assert.equal(header(), 'Mode');
  await select(); // → the change-mode confirm page
  await settle();
  // The optimistic advance and the device agree — the sync confirms the
  // page AND the cursor position from device truth.
  assert.equal(header(), 'Change mode to MOUSE USB?');
  assert.equal(selectedLabel(), 'Confirm');
  // (Pressing Confirm here restarts the device — not modelable in the sim,
  // and the disconnect path is covered by the close test below.)

  await click('btnHubClose');
  await settle();
  assert.equal(wrapHidden(), true);
  assert.equal(sim.state.active, 0, 'the close reached the device');
  await app.disconnect({ quiet: true });
  dev.detach();
});

test('an LK-locked select no longer desyncs the mirror — device truth wins', async () => {
  const sim = createMenuFirmwareSim({ locked: true });
  const dev = createDeviceSimulator({ handleLine: app.handleLine }).attachDevice(sim.behavior);
  activeDev = dev;
  noteDeviceVersion('4.5.1');
  await click('btnHubOpen');
  await settle();
  await next(2); // → Mode row
  await select(); // enters the Mode page (never locked-refused: navigation is open)
  await settle();
  assert.equal(header(), 'Mode');
  assert.equal(selectedLabel(), 'MOUSE USB');
  await select(); // REFUSED by the lock: device shows the "Mode is locked" page
  await settle();
  // The optimistic model went to the confirm page; the sync must correct it
  // to the locked page the device is actually showing.
  assert.equal(header(), 'Mode is locked.');
  assert.match(note(), /Unlock via the app/);

  // A press inside the frozen window is DROPPED by the device but acked
  // SUCCESS — the classic drift source. The sync keeps the mirror honest.
  await click('btnHubNext');
  await settle();
  assert.equal(header(), 'Mode is locked.'); // still the locked page: the press was dropped

  // The device returns to the Mode page by itself (~2 s dwell): the
  // scheduled transient re-read lands the mirror on device truth.
  await sleep(2800);
  await settle();
  assert.equal(header(), 'Mode');
  assert.equal(selectedLabel(), 'MOUSE USB'); // modeMenu redraws at row 0
  assert.equal(sentCmds().filter((s) => s === 'CH,0:0').length >= 2, true, 'the transient re-read fired');
  await app.disconnect({ quiet: true });
  dev.detach();
});

test('older firmware never receives the menu-state read', async () => {
  const dev = ackAll();
  activeDev = dev;
  await openMore('4.4.0'); // walks with CH,1 presses only
  assert.ok(!sentCmds().includes('CH,0:0'), 'CH,0:0 is version-gated and never sent to 4.4.0');
  await app.disconnect({ quiet: true });
  dev.detach();
});

test('a MANUAL settings push refreshes a visible value screen', async () => {
  const dev = ackAll();
  activeDev = dev;
  el('speedVal').textContent = '5';
  await openMore('4.4.0');
  await next(3); // Cursor Speed is main row 3 — reach it from main instead:
  assert.equal(header(), 'More'); // (already in More from openMore)
  // Navigate to More ▸ back to main ▸ Cursor Speed: simplest is a fresh Open.
  await click('btnHubOpen');
  await settle();
  await next(3);
  await select();
  await settle();
  assert.equal(header(), 'Speed: 5');
  // A physical Hub-menu change pushes MANUAL — the mirror's visible value
  // screen must follow the device, not its own estimate.
  el('speedVal').textContent = '8';
  app.handleLine('MANUAL,0:SS,0:8');
  assert.equal(header(), 'Speed: 8');
  await app.disconnect({ quiet: true });
  dev.detach();
});

// ---- Two-way Hub remote: the CH,5 menu-state push --------------------------
// The one-way gap this closes: physical Next/Select presses (and the
// joystick-driven steps and the inactivity timeout) redraw the Hub with no
// app traffic, so the mirror used to drift until the next app press. A
// push-capable firmware reports every redraw as MANUAL,0:CH,5:<a>,<p>,<r> —
// the app-side contract these tests pin. Older firmware simply never sends
// the line; its press-then-poll behavior is covered above.

test('firmware menu-state pushes reconcile the mirror with no app traffic', async () => {
  const dev = ackAll();
  activeDev = dev;
  resetWireNewlineFraming();
  noteDeviceVersion('4.5.1');
  await click('btnHubOpen');
  await settle();
  assert.equal(header(), 'Main menu');

  // Someone navigates the physical Hub: Next×2, Select → the Mode page, row 1.
  // The push alone must land the mirror there — no CH,1 press is issued.
  const sentBefore = sentCmds().length;
  app.handleLine('MANUAL,0:CH,5:1,3,1');
  assert.equal(header(), 'Mode');
  assert.equal(selectedLabel(), 'MOUSE BT');
  assert.equal(sentCmds().length, sentBefore, 'the push reconciled the mirror without any app command');

  // The device menu times out while the mirror is open: the push closes it.
  app.handleLine('MANUAL,0:CH,5:0,0,0');
  assert.equal(wrapHidden(), true);
  await app.disconnect({ quiet: true });
  dev.detach();
});

test('a push while the mirror is closed reopens it — the app follows the device', async () => {
  const dev = ackAll();
  activeDev = dev;
  resetWireNewlineFraming();
  noteDeviceVersion('4.5.1');
  assert.equal(wrapHidden(), true); // mirror closed, menu unused

  // The Hub menu is opened and driven physically: the mirror must appear and
  // track — that is the both-ways remote.
  app.handleLine('MANUAL,0:CH,5:1,5,0'); // More menu, cursor on Sound
  assert.equal(wrapHidden(), false);
  assert.equal(header(), 'More');
  assert.equal(selectedLabel(), 'Sound');
  await app.disconnect({ quiet: true });
  dev.detach();
});

test('a pushed unmapped page shows the honest notice instead of a guess', async () => {
  const dev = ackAll();
  activeDev = dev;
  resetWireNewlineFraming();
  noteDeviceVersion('4.5.1');
  await click('btnHubOpen');
  await settle();
  app.handleLine('MANUAL,0:CH,5:1,999,0'); // a page id the mirror predates
  assert.match(note(), /does not render/);
  assert.match(note(), /Select Open to resync/);
  await app.disconnect({ quiet: true });
  dev.detach();
});
