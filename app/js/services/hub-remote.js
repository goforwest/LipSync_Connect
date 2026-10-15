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
//
// The menu TREE itself is version-gated (the mirror must show exactly what
// the connected device shows): Acceleration joined More on 4.3.0, and the
// Restrictions page, the Sip & Puff ▸ Timing pages and the coarse threshold
// level scale arrived with 4.4.0 — a 4.1 device has none of them, and showing
// rows the device does not have would desync every Next/Select after them.
import { $ } from '../ui/dom.js';
import { log } from './log.js';
import { sendCommand, deviceFirmwareAtLeast } from '../serial/commands.js';
import { modeState } from '../state/modes.js';
import { WINDOW_SETTINGS, PRESS_THRESHOLD_LEVELS } from '../config/constants.js';

let screen = null; // current mirrored screen id; null = mirror closed
let sel = 0; // cursor index into the current screen's rows (displayOnly rows never hold it)
let screenTimer = 0; // pending auto-advance/return for time-driven screens
let noteText = ''; // body text for the notice/busy screens
let pendingMode = null; // mode label awaiting its "Change mode?" confirm
let timingWindowSel = 0; // which window the Timing adjust screen edits (0/1/2 = WS/WL/WM)

// Local copies for the Hub's value screens. The Hub edits settings without
// emitting responses, so these start from the app's last-known readout and
// track adjustments approximately; the on-page drift note covers the gap.
/** @type {Record<string, any>} */
const local = { speed: 5, scroll: 5, lights: 5, accel: 0, sip: 4, puff: 4, soundOn: true };
/** @type {number[]} */
const localWindows = [1000, 3000, 8000];
/** @type {Record<string, boolean>} */
const localRestrictions = { sap: false, menuButtons: false, modeLock: false, cursorHold: false };

// Threshold level scale (4.4.0+, roadmap item 15 / upstream #22): the Hub
// menu steps these coarse levels instead of fine hPa. The three helpers mirror
// the firmware's pressThresholdLevelUp/Down/For exactly, epsilon included —
// a fine value set from the app (e.g. 3.50) reads as the level whose span
// contains it and steps to that level's edges.
const LEVEL_EPS = 0.01;
const levelUp = (v) => {
  for (const t of PRESS_THRESHOLD_LEVELS) if (t > v + LEVEL_EPS) return t;
  return v;
};
const levelDown = (v) => {
  for (let i = PRESS_THRESHOLD_LEVELS.length - 1; i >= 0; i--) {
    const t = PRESS_THRESHOLD_LEVELS[i];
    if (t < v - LEVEL_EPS) return t;
  }
  return v;
};
const levelFor = (v) => {
  for (let i = 0; i < PRESS_THRESHOLD_LEVELS.length; i++) if (PRESS_THRESHOLD_LEVELS[i] >= v - LEVEL_EPS) return i + 1;
  return PRESS_THRESHOLD_LEVELS.length;
};

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

// Sip/puff threshold screens. Firmware 4.4.0+ steps the coarse 10-level
// scale ("Sip: L3 3.50"); older firmware steps ±1 hPa with a plain "Sip:
// 3.50" header (the fine hPa granularity stays on the serial API and here).
function threshScreen(name, key, backTo) {
  const hasLevels = deviceFirmwareAtLeast(4, 4, 0);
  const fmt = (v) => Number(v).toFixed(2);
  const adjust = (dir) => {
    if (hasLevels) local[key] = dir > 0 ? levelUp(local[key]) : levelDown(local[key]);
    else local[key] = Math.min(150, Math.max(2, local[key] + dir));
    render();
  };
  return {
    header: hasLevels ? `${name}: L${levelFor(local[key])} ${fmt(local[key])}` : `${name}: ${fmt(local[key])}`,
    items: [
      { label: 'Increase', select: () => adjust(1) },
      { label: 'Decrease', select: () => adjust(-1) },
      { label: '... Back', select: () => go(backTo) },
    ],
  };
}

// Seeding helpers: entering a value screen refreshes the local copy from the
// app's last-known readout, the same contract every existing screen uses.
function seedWindows() {
  WINDOW_SETTINGS.forEach((w, i) => {
    const n = Number.parseFloat($(w.valueId)?.textContent ?? '');
    localWindows[i] = Number.isFinite(n) && n > 0 ? n : w.min;
  });
}

/** @type {Record<string, () => { header: string, items: { label: string, current?: boolean, displayOnly?: boolean, select: () => void }[], note?: string }>} */
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
      // 4.3.0+ (roadmap item 9, upstream #86): the Hub menu's Acceleration
      // page. Older firmware has no such row — showing one would desync the
      // cursor for every row after it.
      ...(deviceFirmwareAtLeast(4, 3, 0)
        ? [
            {
              label: 'Acceleration',
              select: () => {
                local.accel = readNum('accelVal', local.accel);
                go('accel');
              },
            },
          ]
        : []),
      // 4.4.0+ (roadmap item 11): the Restrictions page, seeded from the
      // app's checkboxes (the last-known device truth).
      ...(deviceFirmwareAtLeast(4, 4, 0)
        ? [
            {
              label: 'Restrictions',
              select: () => {
                localRestrictions.sap = !!$('sapDisabled')?.checked;
                localRestrictions.menuButtons = !!$('menuButtonsOnly')?.checked;
                localRestrictions.modeLock = !!$('modeLock')?.checked;
                localRestrictions.cursorHold = !!$('cursorHold')?.checked;
                go('restrictions');
              },
            },
          ]
        : []),
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
  accel: () => valueScreen('Accel', 'accel', -10, 10, 1, 'more'),
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
      // 4.4.0+ (roadmap item 15, upstream #62): the Timing pages.
      ...(deviceFirmwareAtLeast(4, 4, 0)
        ? [
            {
              label: 'Timing',
              select: () => {
                seedWindows();
                go('timing');
              },
            },
          ]
        : []),
      { label: '... Back', select: () => go('more') },
    ],
  }),
  sip: () => threshScreen('Sip', 'sip', 'sap'),
  puff: () => threshScreen('Puff', 'puff', 'sap'),
  // Restrictions (4.4.0+, roadmap item 11): state-bearing toggle lines —
  // selecting a line flips that restriction and re-renders its label, the
  // exact shape of the firmware's RESTRICTIONS_MENU. The device pushes the
  // change to the app as a MANUAL line, so the app's checkboxes follow on
  // their own; the local copy here only feeds the mirrored labels.
  restrictions: () => ({
    header: '',
    items: [
      {
        label: 'Sip&Puff: ' + (localRestrictions.sap ? 'Off' : 'On'),
        select: () => {
          localRestrictions.sap = !localRestrictions.sap;
          render();
        },
      },
      {
        label: 'Menu: ' + (localRestrictions.menuButtons ? 'Buttons' : 'All'),
        select: () => {
          localRestrictions.menuButtons = !localRestrictions.menuButtons;
          render();
        },
      },
      {
        label: 'Mode lock: ' + (localRestrictions.modeLock ? 'On' : 'Off'),
        select: () => {
          localRestrictions.modeLock = !localRestrictions.modeLock;
          render();
        },
      },
      {
        label: 'Cursor hold: ' + (localRestrictions.cursorHold ? 'On' : 'Off'),
        select: () => {
          localRestrictions.cursorHold = !localRestrictions.cursorHold;
          render();
        },
      },
      { label: '... Back', select: () => go('more') },
    ],
  }),
  // Timing (4.4.0+): one row per window boundary, each opening its adjust
  // page. The firmware renders these with no header row (all four lines are
  // selectable), so the mirror keeps its header empty.
  timing: () => {
    const names = ['Short', 'Long', 'Max'];
    const items = WINDOW_SETTINGS.map((w, i) => ({
      label: `${names[i]}: ${localWindows[i]}ms`,
      select: () => {
        timingWindowSel = i;
        go('timingAdjust');
      },
    }));
    items.push({ label: '... Back', select: () => go('sap') });
    return { header: '', items };
  },
  // 250 ms steps, mirroring TIMING_ADJUST_MENU: the range clamp and the
  // short < long < max ordering are the firmware setter's validation — a
  // refused step re-renders with the value unchanged, never drifts past a
  // boundary the device would reject.
  timingAdjust: () => {
    const names = ['Short', 'Long', 'Max'];
    const w = WINDOW_SETTINGS[timingWindowSel];
    const adjust = (dir) => {
      const next = localWindows[timingWindowSel] + dir * 250;
      if (next < w.min || next > w.max) return render();
      if (timingWindowSel === 0 && next >= localWindows[1]) return render();
      if (timingWindowSel === 1 && (next <= localWindows[0] || next >= localWindows[2])) return render();
      if (timingWindowSel === 2 && next <= localWindows[1]) return render();
      localWindows[timingWindowSel] = next;
      render();
    };
    return {
      header: `${names[timingWindowSel]}: ${localWindows[timingWindowSel]}ms`,
      items: [
        { label: 'Increase', select: () => adjust(1) },
        { label: 'Decrease', select: () => adjust(-1) },
        { label: '... Back', select: () => go('timing') },
      ],
    };
  },
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
      // The firmware's INFO_MENU shows Version/ID as display rows with
      // _cursorStart = 3: "... Back" is the only line the cursor can sit on.
      {
        label: 'Version: ' + ($('version')?.textContent ?? '—'),
        displayOnly: true,
        select: () => {},
      },
      { label: 'ID: ' + ($('deviceId')?.textContent ?? '—'), displayOnly: true, select: () => {} },
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
      if (it.displayOnly) li.classList.add('display-only');
      list.appendChild(li);
    });
  }
  const note = $('hubScreenNote');
  if (note) {
    note.textContent = def.note ?? '';
    note.hidden = !def.note;
  }
}

// The first row a press can land on (display-only rows never hold the cursor —
// the firmware's _cursorStart mechanic).
function firstSelectable(items) {
  const i = items.findIndex((it) => !it.displayOnly);
  return i < 0 ? 0 : i;
}

function go(id) {
  clearTimeout(screenTimer);
  screenTimer = 0;
  screen = id;
  sel = firstSelectable(SCREENS[id]().items ?? []);
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
  // press() already surfaces failures in #hubRemoteError and the log, so the
  // guard wrapper swallows its own duplicate notification + log line.
  const guarded = (fn) => guard(fn, { swallow: true });
  $('btnHubOpen').addEventListener(
    'click',
    guarded(async () => {
      await press('open', '1');
      // The firmware always reopens at the main menu (activateMenu → mainMenu),
      // so Open doubles as the mirror's resync affordance.
      go('main');
    }),
  );
  $('btnHubNext').addEventListener(
    'click',
    guarded(async () => {
      await press('next', '3');
      const items = screen ? (SCREENS[screen]().items ?? []) : [];
      if (items.length) {
        // nextMenuItem() wraps to the first item; display-only rows can
        // never hold the cursor, so the wrap skips them.
        let n = sel;
        for (let steps = 0; steps < items.length; steps++) {
          n = (n + 1) % items.length;
          if (!items[n].displayOnly) break;
        }
        if (!items[n].displayOnly) sel = n;
        render();
      }
    }),
  );
  $('btnHubSelect').addEventListener(
    'click',
    guarded(async () => {
      await press('select', '2');
      const items = screen ? (SCREENS[screen]().items ?? []) : [];
      items[sel]?.select?.();
    }),
  );
  $('btnHubClose').addEventListener(
    'click',
    guarded(async () => {
      await press('close', '4');
      closeMirror();
    }),
  );
}
