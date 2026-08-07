// Remote Hub menu: Open/Close plus a locally-simulated mirror of the Hub's
// OLED screen, driven by the same Next/Select presses the app sends to the
// device. Each button sends one CH,1:<n> press (OPEN=1, SELECT=2, NEXT=3,
// CLOSE=4 — the firmware's CONF_MENU_CONTROL_* enum); the serial queue
// already serializes rapid presses, so no client-side rate limiting is added.
//
// The firmware never reports menu state over serial (CH acks are a generic
// 0), so the mirror is a deterministic re-implementation of LSScreen.h's menu
// state machine, split on what the firmware makes predictable:
//  - pure navigation screens (menus, "... Back" rows, confirm pages, value
//    pages) follow the presses exactly — they are functions of
//    (current screen, selection) only;
//  - hardware/time-driven sub-screens (center-reset completion, the five
//    joystick-driven calibration prompts, mode-change/restart/factory-reset
//    reboots) cannot be predicted from CH presses and show a
//    "running on device" note instead.
// activateMenu() → mainMenu() in the firmware always reopens at main item 0,
// so Open doubles as the mirror's resync affordance after any drift
// (physical button presses, the Hub's 5-minute inactivity timeout).
import { $ } from '../ui/dom.js';
import { log } from './log.js';
import { sendCommand } from '../serial/commands.js';
import { modeState } from '../state/modes.js';

let screen = null; // current mirrored screen id; null = mirror closed
let sel = 0; // cursor index into the current screen's selectable rows
let screenTimer = 0; // pending auto-advance/return for time-driven screens
let noteText = ''; // body text for the notice/busy screens
let pendingMode = null; // mode label awaiting its "Change mode?" confirm

// Local copies for the Hub's value screens. The Hub edits settings without
// emitting responses, so these start from the app's last-known readout and
// track adjustments approximately; the on-page drift note covers the gap.
/** @type {Record<string, any>} */
const local = { speed: 5, scroll: 5, lights: 5, sip: 4, puff: 4, soundOn: true };

const readNum = (id, fallback) => {
  const n = Number.parseFloat($(id)?.textContent ?? '');
  return Number.isFinite(n) ? n : fallback;
};

function currentModeKey() {
  const om = String(modeState.currentOpMode ?? '');
  const cm = String(modeState.currentComMode ?? '');
  if (om === '2') return 'GAMEPAD';
  if (om === '1' && cm === '2') return 'MOUSE BT';
  if (om === '1') return 'MOUSE USB';
  return null;
}

// Value screens mimic the firmware's _cursorStart offset: the "Name: N"
// header line is display-only and the first selectable row is the first
// action (Increase).
function valueScreen(name, key, min, max, step, backTo) {
  const fmt = (v) => (step < 1 ? v.toFixed(2) : String(v));
  const adjust = (dir) => {
    const next = Math.round((local[key] + dir * step) / step) * step;
    local[key] = Math.min(max, Math.max(min, next));
    render();
  };
  return {
    header: `${name}: ${fmt(local[key])}`,
    items: [
      { label: 'Increase', select: () => adjust(1) },
      { label: 'Decrease', select: () => adjust(-1) },
      { label: '... Back', select: () => go(backTo) },
    ],
  };
}

/** @type {Record<string, () => { header: string, items: { label: string, current?: boolean, select: () => void }[], note?: string }>} */
const SCREENS = {
  main: () => ({
    header: 'Main menu',
    items: [
      { label: 'Exit Menu', select: () => go('exitConfirm') },
      { label: 'Center Reset', select: () => go('centerMenu') },
      { label: 'Mode', select: () => go('modeMenu') },
      {
        label: 'Cursor Speed',
        select: () => {
          local.speed = readNum('speedVal', local.speed);
          go('speed');
        },
      },
      { label: 'More', select: () => go('more') },
    ],
  }),
  exitConfirm: () => ({
    header: 'Exiting settings?',
    items: [
      {
        label: 'Confirm',
        select: () => {
          log('Hub menu closed (Exit Menu).', 'log-info');
          closeMirror();
        },
      },
      { label: '... Back', select: () => go('main') },
    ],
  }),
  centerMenu: () => ({
    header: 'Center Reset',
    items: [
      {
        label: 'Center Reset',
        select: () =>
          busy('Center reset running — do not move the joystick. Returning to the main menu…', {
            returnTo: 'main',
            after: 3000,
          }),
      },
      { label: '... Back', select: () => go('main') },
    ],
  }),
  modeMenu: () => {
    const current = currentModeKey();
    const modeItem = (label) => ({
      label,
      current: label === current,
      select: () => {
        pendingMode = label;
        go('modeConfirm');
      },
    });
    return {
      header: 'Mode',
      items: [
        modeItem('MOUSE USB'),
        modeItem('MOUSE BT'),
        modeItem('GAMEPAD'),
        { label: '... Back', select: () => go('main') },
      ],
    };
  },
  modeConfirm: () => ({
    header: `Change mode to ${pendingMode}?`,
    items: [
      {
        label: 'Confirm',
        select: () => busy('Changing mode — release the joystick. The device restarts and disconnects.'),
      },
      { label: '... Back', select: () => go('modeMenu') },
    ],
  }),
  speed: () => valueScreen('Speed', 'speed', 1, 10, 1, 'main'),
  more: () => ({
    header: 'More',
    items: [
      {
        label: 'Sound',
        select: () => {
          local.soundOn = ($('soundModeVal')?.textContent ?? 'On') !== 'Off';
          go('sound');
        },
      },
      {
        label: 'Light Brightness',
        select: () => {
          local.lights = readNum('brightnessVal', local.lights);
          go('lights');
        },
      },
      {
        label: 'Scroll Speed',
        select: () => {
          local.scroll = readNum('scrollVal', local.scroll);
          go('scroll');
        },
      },
      { label: 'Sip & Puff', select: () => go('sap') },
      {
        label: 'Full Calibration',
        select: () => timed('Incorrect full calibration may cause drift.', 'calConfirm', 3000),
      },
      { label: 'Restart LipSync', select: () => go('restartConfirm') },
      {
        label: 'Factory Reset',
        select: () => timed('This will erase all custom settings.', 'frConfirm', 2000),
      },
      { label: 'Info', select: () => go('info') },
      { label: '... Back', select: () => go('main') },
    ],
  }),
  sound: () => ({
    header: 'Sound: ' + (local.soundOn ? 'ON' : 'OFF'),
    items: [
      {
        label: local.soundOn ? 'Turn off' : 'Turn on',
        select: () => {
          local.soundOn = !local.soundOn;
          render();
        },
      },
      { label: '... Back', select: () => go('more') },
    ],
  }),
  lights: () => valueScreen('Lights', 'lights', 0, 10, 1, 'more'),
  scroll: () => valueScreen('Speed', 'scroll', 1, 10, 1, 'more'),
  sap: () => ({
    header: 'Sip & Puff',
    items: [
      {
        label: 'Sip Threshold',
        select: () => {
          local.sip = readNum('sipVal', local.sip);
          go('sip');
        },
      },
      {
        label: 'Puff Threshold',
        select: () => {
          local.puff = readNum('puffVal', local.puff);
          go('puff');
        },
      },
      { label: '... Back', select: () => go('more') },
    ],
  }),
  sip: () => valueScreen('Sip', 'sip', 2, 149.75, 0.25, 'sap'),
  puff: () => valueScreen('Puff', 'puff', 2, 149.75, 0.25, 'sap'),
  calConfirm: () => ({
    header: 'Are you sure?',
    items: [
      {
        label: 'Confirm',
        select: () =>
          busy(
            'Follow the prompts on the Hub display — the five corner/center steps are joystick-driven. ' +
              'Select Open to resync when the device returns to its menu.',
          ),
      },
      { label: '... Back', select: () => go('more') },
    ],
  }),
  restartConfirm: () => ({
    header: 'Restart LipSync?',
    items: [
      { label: 'Confirm', select: () => busy('Restarting — the device will disconnect.') },
      { label: '... Back', select: () => go('more') },
    ],
  }),
  frConfirm: () => ({
    header: 'Are you sure?',
    items: [
      {
        label: 'Confirm',
        select: () => busy('Factory resetting — the device restarts with defaults and disconnects.'),
      },
      { label: '... Back', select: () => go('more') },
    ],
  }),
  info: () => ({
    header: 'Info',
    items: [
      { label: 'Version: ' + ($('version')?.textContent ?? '—'), select: () => {} },
      { label: 'ID: ' + ($('deviceId')?.textContent ?? '—'), select: () => {} },
      { label: '... Back', select: () => go('more') },
    ],
  }),
  // Display-only interstitial the firmware advances on its own timer.
  notice: () => ({ header: '', items: [], note: noteText }),
  // Hardware/time-driven device screens the mirror cannot predict.
  busyScreen: () => ({ header: 'Running on device', items: [], note: noteText }),
};

function render() {
  const wrap = $('hubScreenWrap');
  if (!wrap) return;
  if (!screen) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const def = SCREENS[screen]();
  const header = $('hubScreenHeader');
  if (header) header.textContent = def.header ?? '';
  const list = $('hubScreenItems');
  if (list) {
    list.innerHTML = '';
    (def.items ?? []).forEach((it, i) => {
      const li = document.createElement('li');
      li.textContent = it.label;
      if (i === sel) li.classList.add('selected');
      if (it.current) li.classList.add('current');
      list.appendChild(li);
    });
  }
  const note = $('hubScreenNote');
  if (note) {
    note.textContent = def.note ?? '';
    note.hidden = !def.note;
  }
}

function go(id) {
  clearTimeout(screenTimer);
  screenTimer = 0;
  screen = id;
  sel = 0;
  render();
}

// A display-only screen the firmware shows for a fixed time, then advances.
function timed(text, nextScreen, ms) {
  noteText = text;
  go('notice');
  screenTimer = setTimeout(() => {
    screenTimer = 0;
    go(nextScreen);
  }, ms);
}

// A device-owned action; optionally auto-returns (center reset ends back at
// the main menu after ~2.5 s on the device — mirror that approximately).
function busy(text, opts = {}) {
  noteText = text;
  go('busyScreen');
  if (opts.returnTo) {
    screenTimer = setTimeout(() => {
      screenTimer = 0;
      go(opts.returnTo);
    }, opts.after ?? 3000);
  }
}

function closeMirror() {
  clearTimeout(screenTimer);
  screenTimer = 0;
  screen = null;
  sel = 0;
  render();
}

// Disconnect / fresh-load hook (wired in main.js): the device's menu dies
// with the port, so a lingering mirror would show a screen that no longer
// exists.
export function resetHubRemote() {
  closeMirror();
  const err = $('hubRemoteError');
  if (err) err.textContent = '';
}

export function bindHubRemote(guard) {
  const press = async (action, code) => {
    const errEl = $('hubRemoteError');
    if (errEl) errEl.textContent = '';
    try {
      await sendCommand('CH,1:' + code);
      log('Hub menu: ' + action + '.', 'log-info');
    } catch (e) {
      if (errEl) errEl.textContent = e.message;
      log('Hub menu: ' + action + ' failed — ' + e.message, 'log-err');
      throw e; // the mirror is NOT advanced when the press never reached the device
    }
  };
  $('btnHubOpen').addEventListener(
    'click',
    guard(async () => {
      await press('open', '1');
      // The firmware always reopens at the main menu (activateMenu → mainMenu),
      // so Open doubles as the mirror's resync affordance.
      go('main');
    }),
  );
  $('btnHubNext').addEventListener(
    'click',
    guard(async () => {
      await press('next', '3');
      const items = screen ? (SCREENS[screen]().items ?? []) : [];
      if (items.length) {
        sel = (sel + 1) % items.length; // nextMenuItem() wraps to the first item
        render();
      }
    }),
  );
  $('btnHubSelect').addEventListener(
    'click',
    guard(async () => {
      await press('select', '2');
      const items = screen ? (SCREENS[screen]().items ?? []) : [];
      items[sel]?.select?.();
    }),
  );
  $('btnHubClose').addEventListener(
    'click',
    guard(async () => {
      await press('close', '4');
      closeMirror();
    }),
  );
}
