// Remote Hub menu: Open/Close plus a locally-simulated mirror of the Hub's
// OLED screen, driven by the same Next/Select presses the app sends to the
// device. Each button sends one CH,1:<n> press (OPEN=1, SELECT=2, NEXT=3,
// CLOSE=4 — the firmware's CONF_MENU_CONTROL_* enum); the serial queue
// already serializes rapid presses, so no client-side rate limiting is added.
//
// The mirror is a deterministic re-implementation of LSScreen.h's menu state
// machine, split on what the firmware makes predictable:
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
// DEVICE-TRUTH RE-SYNC (firmware 4.5.1+): the firmware acks CH,1 presses
// SUCCESS even when the press was REFUSED (a locked mode row answers with
// the ~2 s "Mode is locked" page — and its frozen-input window DROPS later
// presses, still acking them), so a purely client-side model drifts the
// moment a select does not land where it predicted (bench 2026-10-16:
// "drift between actual menu and hub remote control menu when LK is set").
// On 4.5.1+ the firmware exposes the live menu state (CH,0:0 → active,
// page id, row), and after every press the app re-reads it and reconciles
// the mirror to device truth. The local advance still runs first — the
// mirror stays responsive, and the sync silently corrects it when the
// device went elsewhere. Older firmware keeps the model-only behavior (the
// Open-resync affordance covers it).
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
let syncTimer = 0; // pending follow-up CH,0:0 poll (transient device pages)
let closeGraceUntil = 0; // ms-timestamp: an exit is in flight; don't reopen the mirror on the transitional state
let syncFailureLogged = false; // one log line per session is enough for a failing sync

// The firmware version whose CH,0:0 menu-state read exists. The endpoint is
// NEVER sent to older firmware (it would FAIL and log noise); those devices
// keep the model-only mirror with its Open-resync affordance.
const MENU_STATE_MIN_FIRMWARE = [4, 5, 1];

// Firmware page ids (LSScreen.h) → mirror screen ids. The firmware's
// _currentSelection is already the SELECTABLE-row index (the cursor renders
// at _cursorStart + selection), which is exactly the mirror's sel semantics —
// only the displayOnly snap for 'info' differs.
const FW_PAGE_TO_MIRROR = {
  0: 'main', // MAIN_MENU
  1: 'exitConfirm', // EXIT_MENU
  2: 'centerMenu', // CALIB_MENU
  3: 'modeMenu', // MODE_MENU
  4: 'speed', // CURSOR_SP_MENU
  5: 'more', // MORE_MENU
  6: 'safeModeOptions', // SAFEMODE_MENU
  21: 'centerResetRunning', // CENTER_RESET_PAGE
  31: 'modeConfirm', // CONFIRM_MODE_CHANGE
  32: 'modeLocked', // MODE_LOCKED_PAGE (4.5.1+)
  51: 'sound', // SOUND_MENU
  52: 'lights', // LIGHT_BRIGHT_MENU
  53: 'scroll', // SCROLL_SP_MENU
  54: 'sap', // SIP_PUFF_MENU
  541: 'sip', // SIP_THRESH_MENU
  542: 'puff', // PUFF_THRESH_MENU
  55: 'fullCalibWarning', // FULL_CALIB_PAGE (the warning page)
  551: 'calConfirm', // FULL_CALIB_CONFIRM_PAGE
  56: 'restartConfirm', // RESTART_PAGE
  57: 'frConfirm', // FACTORY_RESET_PAGE (confirm 1)
  571: 'frConfirm2', // FACTORY_RESET_CONFIRM2_PAGE (confirm 2)
  58: 'info', // INFO_MENU
  59: 'accel', // ACCEL_MENU
  60: 'restrictions', // RESTRICTIONS_MENU
  61: 'timing', // TIMING_MENU
  611: 'timingAdjust', // TIMING_ADJUST_MENU
};

// Device pages that advance THEMSELVES after a fixed dwell (scheduled
// transitions): after syncing onto one, poll again at dwell + margin for
// the page the device moved to (the locked page returns to the Mode menu,
// the center-reset page returns to main, the calibration warning shows its
// confirm page). Times follow the firmware sources, plus scheduling margin.
const FW_TRANSIENT_PAGE_MS = {
  32: 2000 + 600, // modeLockedPage → modeMenu (finishModeLocked)
  21: 2500 + 700, // centerResetPage → centerResetCompletePage → main menu
  55: 3000 + 600, // fullCalibrationPage → fullCalibrationConfirmPage
};

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
          // The device shows its "Exiting" page for ~500 ms before the menu
          // actually closes — a CH,0:0 poll landing inside that window would
          // read active=EXIT_MENU and reopen the mirror on the transition.
          closeGraceUntil = Date.now() + 1500;
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
        select: () => {
          // The firmware inserts a 2 s "This will erase all custom
          // settings" page before the SECOND confirm — with device-truth
          // sync (4.5.1+) the mirror follows it there for real; without
          // sync the optimistic close enough was a single confirm.
          busy('Factory resetting — the device restarts with defaults and disconnects.');
        },
      },
      { label: '... Back', select: () => go('more') },
    ],
  }),
  // The firmware's second factory-reset confirm (page 571), reached after
  // the erase warning's 2 s dwell. Reachable in the optimistic model only
  // via device-truth sync (the warning page is a scheduled transition), but
  // rendered honestly when it is the live page.
  frConfirm2: () => ({
    header: 'Are you sure?',
    items: [
      {
        label: 'Confirm',
        select: () => busy('Factory resetting — the device restarts with defaults and disconnects.'),
      },
      { label: '... Back', select: () => go('frConfirm') },
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
  // Device pages reached only via the CH,0:0 re-sync (they are refusal or
  // scheduled-transition pages, not CH-press-predictable): rendered from the
  // same text the firmware's OLED shows, so the remote tells the user what
  // the Hub is telling them.
  modeLocked: () => ({
    header: 'Mode is locked.',
    items: [],
    note: 'Unlock via the app. The Hub returns to the Mode page in a moment.',
  }),
  centerResetRunning: () => ({
    header: 'Running on device',
    items: [],
    note: 'Center reset running — do not move the joystick. Returning to the main menu…',
  }),
  fullCalibWarning: () => ({
    header: 'Running on device',
    items: [],
    note: 'Incorrect full calibration may cause drift. The confirm page follows…',
  }),
  safeModeOptions: () => ({
    header: 'Safe mode',
    items: [],
    note: 'The Hub is showing its safe-mode options (Restart / Factory Reset). Drive them from the Hub display.',
  }),
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
      // The mirror is a passive listbox: the device, not the user, moves the
      // cursor, so each row exposes its selected state (and the current-mode
      // marker that is otherwise color-only) without becoming a tab stop.
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === sel));
      if (i === sel) li.classList.add('selected');
      if (it.current) {
        li.classList.add('current');
        li.setAttribute('aria-label', it.label + ' (current mode)');
        li.title = it.label + ' (current mode)';
      }
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

// ---- Device-truth re-sync (4.5.1+) ------------------------------------------
// applyMenuState(): reconcile the mirror with the CH,0:0 triple
// [active, pageId, row]. Corrections are silent — the mirror is an
// optimistic prediction; when the device went elsewhere, device wins.
function snapSel(items, row) {
  // The firmware's selection index is over selectable rows; if the mapped
  // item is display-only (info's Version/ID rows) or out of range, land on
  // the first row a press can actually hit.
  if (!Number.isFinite(row) || row < 0 || row >= items.length || items[row].displayOnly) {
    return firstSelectable(items);
  }
  return row;
}

function applyMenuState(value) {
  const parts = (value || '').split(',').map(Number);
  const [active, page, row] = parts;
  clearTimeout(syncTimer);
  syncTimer = 0;
  if (!Number.isFinite(active)) return;
  // An exit is in flight (its ~500 ms "Exiting" page still reads active):
  // ignore the transitional state until the grace lapses — unless the device
  // reports something genuinely different, which wins immediately.
  if (Date.now() < closeGraceUntil && (active === 0 || page === 1)) return;
  if (active !== 1) {
    closeMirror(); // device truth: the menu is closed
    return;
  }
  closeGraceUntil = 0;
  const screenId = FW_PAGE_TO_MIRROR[page];
  if (screenId === undefined) {
    // An unmapped page (future firmware, or a page this mirror predates):
    // say so honestly instead of guessing wrong.
    noteText = 'The Hub is showing a page this remote does not render. Select Open to resync.';
    go('busyScreen');
    return;
  }
  if (screen === screenId) {
    sel = snapSel(SCREENS[screenId]().items ?? [], row);
    render();
  } else {
    go(screenId); // resets sel to the first selectable…
    sel = snapSel(SCREENS[screenId]().items ?? [], row); // …then device truth places the cursor
    render();
  }
  // A page the device advances on its own schedule: poll again after its
  // dwell so the mirror lands on the page it becomes (the locked page
  // returns to the Mode menu at row 0 — without this poll the mirror would
  // freeze on the locked notice until the next press).
  const dwellMs = FW_TRANSIENT_PAGE_MS[page];
  if (dwellMs && Date.now() >= closeGraceUntil) {
    syncTimer = setTimeout(() => {
      syncTimer = 0;
      syncMenuFromDevice();
    }, dwellMs);
  }
}

// syncMenuFromDevice(): re-read the live menu state and reconcile. Fired
// after every press (and after transient dwells); failures are swallowed —
// the optimistic model stands, and the next press retries the sync.
function syncMenuFromDevice() {
  // Never sent to older firmware (the gate reads [4, 5, 1] tuple-typed).
  if (!deviceFirmwareAtLeast(MENU_STATE_MIN_FIRMWARE[0], MENU_STATE_MIN_FIRMWARE[1], MENU_STATE_MIN_FIRMWARE[2]))
    return;
  sendCommand('CH,0:0')
    .then((resp) => {
      applyMenuState(resp?.value);
      syncFailureLogged = false;
    })
    .catch((e) => {
      // The mirror keeps its optimistic state; one log line per session
      // notes the device stopped answering the sync read.
      if (!syncFailureLogged) {
        syncFailureLogged = true;
        log('Hub menu state read failed — the mirror may be out of sync until the next press. ' + e.message, 'log-err');
      }
    });
}

// TWO-WAY HUB REMOTE — the firmware's menu-state PUSH (protocol proposal in
// docs/upstream-issue-comments.md): MANUAL,0:CH,5:<active>,<pageId>,<row>,
// emitted on every physical menu redraw (Next/Select on the device,
// joystick-driven steps, the inactivity timeout) while a serial session is
// open. Same triple as the CH,0:0 read, so applyMenuState is the entire
// reconciliation: the mirror follows presses this app never sent, opens
// when the device menu opens, and closes when it times out. MANUAL + seq 0
// keeps the 4.5.2 initiator contract (a device-initiated push can never
// resolve a pending command waiter — the re-center precedent), and firmware
// that never sends the line changes nothing: the app's own press-then-poll
// sync stands.
/** @param {string} value "active,pageId,row" */
export function applyHubMenuPush(value) {
  applyMenuState(value);
}

// MANUAL pushes (a physical Hub-menu change) must refresh a visible value
// screen: the local copies are estimates, device truth just replaced them.
// Called from applyDeviceResponse for every MANUAL line (serial/device.js).
const VALUE_ENDPOINT_TO_KEY = { SS: 'speed', SL: 'scroll', AV: 'accel', LL: 'lights', ST: 'sip', PT: 'puff' };
const RESTRICTION_ENDPOINT_TO_KEY = { SD: 'sap', MA: 'menuButtons', LK: 'modeLock', CF: 'cursorHold' };
const WINDOW_ENDPOINT_TO_INDEX = { WS: 0, WL: 1, WM: 2 };

export function noteExternalSettingsChange(endpoint) {
  if (!screen) return; // mirror closed: the value reseed happens on entry anyway
  if (endpoint in VALUE_ENDPOINT_TO_KEY && ['speed', 'scroll', 'lights', 'accel', 'sip', 'puff'].includes(screen)) {
    const key = VALUE_ENDPOINT_TO_KEY[endpoint];
    local[key] = readNum(
      key === 'speed'
        ? 'speedVal'
        : key === 'scroll'
          ? 'scrollVal'
          : key === 'lights'
            ? 'brightnessVal'
            : key === 'accel'
              ? 'accelVal'
              : key === 'sip'
                ? 'sipVal'
                : 'puffVal',
      local[key],
    );
    render();
  } else if (screen === 'sound' && endpoint === 'SM') {
    local.soundOn = ($('soundModeVal')?.textContent ?? 'On') !== 'Off';
    render();
  } else if (screen === 'restrictions' && endpoint in RESTRICTION_ENDPOINT_TO_KEY) {
    localRestrictions[RESTRICTION_ENDPOINT_TO_KEY[endpoint]] = !!$(
      { SD: 'sapDisabled', MA: 'menuButtonsOnly', LK: 'modeLock', CF: 'cursorHold' }[endpoint],
    )?.checked;
    render();
  } else if ((screen === 'timing' || screen === 'timingAdjust') && endpoint in WINDOW_ENDPOINT_TO_INDEX) {
    const w = WINDOW_SETTINGS[WINDOW_ENDPOINT_TO_INDEX[endpoint]];
    const n = Number.parseFloat($(w.valueId)?.textContent ?? '');
    if (Number.isFinite(n) && n > 0) {
      localWindows[WINDOW_ENDPOINT_TO_INDEX[endpoint]] = n;
      render();
    }
  }
}

// Disconnect / fresh-load hook (wired in main.js): the device's menu dies
// with the port, so a lingering mirror would show a screen that no longer
// exists.
export function resetHubRemote() {
  closeMirror();
  clearTimeout(syncTimer);
  syncTimer = 0;
  closeGraceUntil = 0;
  syncFailureLogged = false;
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
      syncMenuFromDevice(); // 4.5.1+: confirm from device truth
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
      syncMenuFromDevice(); // a dropped press (frozen window) shows here
    }),
  );
  $('btnHubSelect').addEventListener(
    'click',
    guarded(async () => {
      await press('select', '2');
      const items = screen ? (SCREENS[screen]().items ?? []) : [];
      items[sel]?.select?.();
      // A refused select (LK-locked mode row) or a transition the device
      // drives itself is exactly what the re-read corrects — the optimistic
      // advance above stays visible only until the device answers.
      syncMenuFromDevice();
    }),
  );
  $('btnHubClose').addEventListener(
    'click',
    guarded(async () => {
      await press('close', '4');
      closeMirror();
      closeGraceUntil = Date.now() + 1500; // the device's "Exiting" page takes ~500 ms to close
      // No sync poll here: the device's deactivateMenu() is unconditional,
      // and re-reading inside its exit dwell would briefly reopen the
      // mirror on the transitional EXIT_MENU state.
    }),
  );
}
