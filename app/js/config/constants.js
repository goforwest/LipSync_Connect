// Central constants for LipSync Connect. Pure data only — no imports, no DOM,
// no mutable state. Anything that used to be a top-level `const` in app.js lives
// here so every consumer shares exactly one definition.

export const BAUD = 115200;

// ---- Visualization ----
export const PLOT_BASE_EXTENT = 13;
export const CMD_DEFAULT_TIMEOUT = 6000;
export const CMD_SETTINGS_TIMEOUT = 4000;
export const CMD_MODE_TIMEOUT = 12000;
export const CMD_RESET_TIMEOUT = 15000;
// Firmware self-tests (RT,1:*) take up to ~20 s end-to-end; the ack itself is
// fast but the device is busy narrating afterward. Give the command headroom so
// a slow-but-healthy firmware doesn't produce a spurious timeout.
export const CMD_TEST_TIMEOUT = 25000;
export const CMD_NEUTRAL_TIMEOUT = 20000;
export const CMD_CALIBRATE_TIMEOUT = 45000;
export const LOAD_TOTAL_TIMEOUT = 120000;
export const READ_TIMEOUT = 30000;
export const LOG_MAX_LINES = 400;
export const THEME_STORAGE_KEY = 'lipsync-theme';
export const METER_SEGMENTS = 10;
// Firmware's real minimum corner magnitude is 3 (CONF_JOY_CALIB_CORNER_MIN),
// NOT 1 — and any corner below it is *silently replaced with the ±13 default*
// while still printing SUCCESS. Detect both "weak" (<3) and substituted (==13)
// so the user isn't told calibration passed when the device flagged an error.
export const WEAK_CORNER_THRESHOLD = 3;
export const JOY_CORNER_DEFAULT = 13.0; // CONF_JOY_CALIB_CORNER_DEFAULT
export const HEADER_SCROLL_THRESHOLD = 10;
export const LOG_HISTORY_MAX = 5000; // full session, ~500k chars — several minutes of DEBUG at 10Hz
export const SHARE_TEXT_LIMIT = 20000; // share sheets choke on huge payloads
export const MAIL_BODY_LIMIT = 8000;
export const MAX_WAITERS = 8;
export const SELF_TEST_COMPLETE_DWELL_MS = 800;
// How long the completed narration panel lingers after "Test Complete" so the
// user sees the finished sequence. The self-test buttons stay locked for this
// same window — unlocking earlier let a click land while the previous run's
// panel-close timer was still pending, killing the new run's narration.
export const SELF_TEST_PANEL_LINGER_MS = 2500;
// Serial-dependent cards (everything except Help and Log) are visually dimmed
// until a device connects, but deliberately NOT made inert: an open card's
// status text (loading progress, current values) must remain readable by screen
// readers, and every interactive control inside is already disabled while
// disconnected. Help and Log stay fully interactive — a first-time user lands
// on Help and can read it and watch the log before ever connecting.
export const CORNER_SIGNS = { 1: [-1, 1], 2: [1, 1], 3: [1, -1], 4: [-1, -1] };

// pvMouth/pvAmbient/pvDiff intentionally omitted — pressure values are live sensor reads, not stored settings.
// Human-readable names below (VALUE_LABELS) are used for screen-reader failure
// announcements; keep them in sync with the visible labels in index.html. A
// drift check in tests/protocol.test.mjs fails CI if these diverge.
export const VALUE_IDS = [
  'model',
  'version',
  'deviceId',
  'opmode',
  'commode',
  'speedVal',
  'scrollVal',
  'sipVal',
  'puffVal',
  'innerDeadzoneVal',
  'outerDeadzoneVal',
  'soundModeVal',
  'lightModeVal',
  'brightnessVal',
];
export const VALUE_LABELS = {
  model: 'Model',
  version: 'Firmware version',
  deviceId: 'Device ID',
  opmode: 'Operating mode',
  commode: 'Communication mode',
  speedVal: 'Cursor speed level',
  scrollVal: 'Scroll level',
  sipVal: 'Sip threshold',
  puffVal: 'Puff threshold',
  innerDeadzoneVal: 'Inner deadzone',
  outerDeadzoneVal: 'Outer deadzone',
  soundModeVal: 'Sound feedback',
  lightModeVal: 'Light feedback',
  brightnessVal: 'LED brightness',
};
export const FEEDBACK_MODES = { 0: 'Off', 1: 'Basic', 2: 'All' };
export const DEBUG_MODES = {
  0: 'Off',
  1: 'Joystick',
  2: 'Pressure',
  3: 'Hub buttons',
  4: 'External switches',
  5: 'Sip & puff state',
};

// ---- Live diagnostic visualizations ----
export const DIAG_PANELS = { 1: 'diagJoy', 2: 'diagPressure', 3: 'diagButtons', 4: 'diagSwitches', 5: 'diagSap' };
export const LIVE_STREAM_BUTTONS = { btnLiveJoy: '1', btnLivePressure: '2' };
export const LIVE_READ_BUTTONS = { btnLiveJoy: 'btnReadJoy', btnLivePressure: 'btnReadPressure' };

// ---- Operating mode presets ----
export const MODE_PRESETS = {
  mouse: { om: '1', cm: '1', label: 'Mouse' },
  'mouse-bt': { om: '1', cm: '2', label: 'Mouse (Bluetooth)' },
  gamepad: { om: '2', cm: '1', label: 'Gamepad' },
};

export const OP_MODES = { 0: 'None', 1: 'Mouse', 2: 'Gamepad', 3: 'Safe' };
export const COM_MODES = { 0: 'None', 1: 'USB', 2: 'Bluetooth' };
export const MODELS = { 1: 'LipSync 4' };
export const MODEL_FEATURES = { 1: { bluetooth: true, gamepad: true } };

export const STEP_TARGETS = {
  speed: { endpoint: 'SS', valueId: 'speedVal', meter: 'speedMeter', min: 1, max: 10 },
  scroll: { endpoint: 'SL', valueId: 'scrollVal', meter: 'scrollMeter', min: 1, max: 10 },
  brightness: { endpoint: 'LL', valueId: 'brightnessVal', meter: 'brightnessMeter', min: 0, max: 10 },
};

// Live self-test narration tables: each entry pairs the firmware's narration
// text with a human label; { hidden: true } steps exist purely for sequencing.
/** @type {[RegExp, string, { hidden?: boolean }?][]} */
export const LED_STEPS = [
  [/^TEST_MODE_LED: all led off$/i, 'All LEDs off'],
  [/^TEST_MODE_LED: left led on$/i, 'Show left LED'],
  [/^TEST_MODE_LED: middle led on$/i, 'Show middle LED'],
  [/^TEST_MODE_LED: right led on$/i, 'Show right LED'],
  [/^TEST_MODE_LED: all led off$/i, 'Clear segment LEDs'],
  [/^TEST_MODE_LED: micro led blue$/i, 'Micro LED: blue'],
  [/^TEST_MODE_LED: micro led purple$/i, 'Micro LED: purple'],
  [/^TEST_MODE_LED: micro led red$/i, 'Micro LED: red'],
  [/^TEST_MODE_LED: micro led orange$/i, 'Micro LED: orange'],
  [/^TEST_MODE_LED: micro led yellow$/i, 'Micro LED: yellow'],
  [/^TEST_MODE_LED: left led brightness$/i, 'Brightness sweep'],
  [/^TEST_MODE_LED: error 3$/i, 'Error blink (3×)'],
  // Shown as the final bullet: the panel now lingers with the buttons locked
  // (SELF_TEST_PANEL_LINGER_MS), so the tail no longer races the close-down.
  [/^TEST_MODE_LED: led default$/i, 'Back to normal LED state'],
  // Firmware's final line is the bare "Test Complete" emitted by activateTest,
  // which we catch generically in handleLine; nothing additional required here.
];
/** @type {[RegExp, string, { hidden?: boolean }?][]} */
export const BUZZER_STEPS = [
  [/^TEST_MODE_BUZZER: playing startup sound/i, 'Play startup sound'],
  [/^TEST_MODE_BUZZER: playing ready sounds/i, 'Play ready sound'],
  [/^TEST_MODE_BUZZER: playing error sound/i, 'Play error sound'],
  [/^TEST_MODE_BUZZER: playing corner calibration sound/i, 'Play corner-calibration sound'],
  [/^TEST_MODE_BUZZER: playing center calibration sound/i, 'Play center-calibration sound'],
  [/^TEST_MODE_BUZZER: playing shutdown sound/i, 'Play shutdown sound'],
  // Shown as the final bullet: the panel now lingers with the buttons locked
  // (SELF_TEST_PANEL_LINGER_MS), so the tail no longer races the close-down.
  [/^SOUND TEST COMPLETE$/i, 'Buzzer test complete'],
];

// ---- Theme management (dark mode + color customization) ----
export const COLOR_VARS = {
  colorAccent: '--accent',
  colorAccent2: '--accent2',
  colorBg: '--bg',
  colorPanel: '--panel',
  colorText: '--text',
  colorMuted: '--muted',
  colorBorder: '--border',
  colorBtnText: '--btn-text',
  colorSuccess: '--success',
  colorInfo: '--info',
};
export const COLOR_DEFAULTS = {
  colorAccent: '#BE2A32', // WCAG AA: 5.89:1 on white (--btn-text)
  colorAccent2: '#BE2A32',
  colorBg: '#f5f7f8',
  colorPanel: '#ffffff',
  colorText: '#3a3f42',
  colorMuted: '#45525e',
  colorBorder: '#d7dde2',
  colorBtnText: '#ffffff',
  colorSuccess: '#1e7d46',
  colorInfo: '#0072ce',
};
