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
  'accelVal',
  'sipVal',
  'puffVal',
  'innerDeadzoneVal',
  'outerDeadzoneVal',
  'soundModeVal',
  'lightModeVal',
  'brightnessVal',
  'w1Val',
  'w2Val',
  'w3Val',
];
export const VALUE_LABELS = {
  model: 'Model',
  version: 'Firmware version',
  deviceId: 'Device ID',
  opmode: 'Operating mode',
  commode: 'Communication mode',
  speedVal: 'Cursor speed level',
  scrollVal: 'Scroll level',
  accelVal: 'Cursor acceleration',
  sipVal: 'Sip threshold',
  puffVal: 'Puff threshold',
  innerDeadzoneVal: 'Inner deadzone',
  outerDeadzoneVal: 'Outer deadzone',
  soundModeVal: 'Sound feedback',
  lightModeVal: 'Light feedback',
  brightnessVal: 'LED brightness',
  w1Val: 'Short input window',
  w2Val: 'Long input window',
  w3Val: 'Max input window',
};
// Light feedback tier 3 (firmware 4.4.0+, roadmap item 16 / upstream #43):
// LEDs keyed to the input's window (green/yellow/red while held) instead of
// the pending action. Sound feedback has no tier 3 — the label applies to
// the light mode only when read back.
export const FEEDBACK_MODES = { 0: 'Off', 1: 'Basic', 2: 'All', 3: 'Input state' };
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

// ---- Firmware update check ----
// "Latest" is decided by the GitHub release; the flashable artifacts are read
// through api.github.com (the only GitHub surface with CORS headers usable
// from a browser — release download URLs and the asset CDN are not
// fetchable cross-origin). The release workflow publishes the artifacts to
// the FIRMWARE_BINARIES_BRANCH, and the app fetches them via the contents
// and git-blob endpoints as base64. Manifest shape:
//   { firmwareVersion, files: { dfu: { fileName, size, sha256 }, uf2: {...} } }
export const FIRMWARE_RELEASE_API = 'https://api.github.com/repos/makersmakingchange/LipSync/releases/latest';
// The api.github.com base (constant; kept separate so tests/CSP read clearly).
export const FIRMWARE_API_BASE = 'https://api.github.com';
export const FIRMWARE_BINARIES_BRANCH = 'firmware-binaries';
export const FIRMWARE_MANIFEST_PATH = 'firmware-manifest.json';
// Dev affordance: set this localStorage key to a manifest URL (e.g. the dev
// server's /firmware-manifest.json route) to check against a local build.
export const FIRMWARE_MANIFEST_URL_OVERRIDE_KEY = 'lipsync-fw-manifest-url';
// Dev affordance: set this key to a release-API URL (e.g. a fork's
// https://api.github.com/repos/<user>/LipSync/releases/latest) to exercise
// the full auto-detection + download + flash flow against that repo's
// releases. Same host as the real API, so CSP still confines it.
export const FIRMWARE_RELEASE_API_OVERRIDE_KEY = 'lipsync-fw-release-api';
export const FIRMWARE_CHECK_STORAGE_KEY = 'lipsync-fw-check';
// The "device likely stranded in its update loader" marker. Lives in the DOM
// (sec-firmware[data-recover] + the Recover button) but is mirrored into
// sessionStorage so a page reload keeps Recover reachable — a user whose
// flash was interrupted past START must not have to Connect (and pick the
// bootloader port) once before the button reappears. Cleared on the next
// successful settings load. serial/connection.js writes it directly (the DOM
// marker there is deliberately duplicated to keep the module graph acyclic).
export const FIRMWARE_STRANDED_STORAGE_KEY = 'lipsync-fw-stranded';
// Auto-checks are served from cache for this long so reconnect-heavy usage
// cannot burn GitHub's unauthenticated rate limit (60 req/h per IP).
export const FIRMWARE_CHECK_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const FIRMWARE_FETCH_TIMEOUT_MS = 15000;

// ---- LipSync USB identity (Seeed XIAO nRF52840) ----
// Application firmware (CDC settings + HID) vs. the stock bootloader's
// serial-DFU interface. Authoritative source: the Seeed nRF52 Arduino core
// the release pipeline compiles with (Seeeduino:nrf52@1.1.13, boards.txt —
// xiaonRF52840.pid.0=0x8044 / bootloader 0x0044; xiaonRF52840Sense.pid.0=
// 0x8045 / bootloader 0x0045), corroborated live on hardware (2026-10-11: a
// plain unit enumerated 0x2886:0x8044, "XIAO nRF52840"). App and bootloader
// share product strings — only PIDs distinguish them — so every filter and
// identity check relies on the PIDs alone. If the core is ever bumped,
// re-check these against its boards.txt in the same change.
export const USB_VENDOR_ID = 0x2886; // Seeed Technology Co., Ltd.
export const USB_PID_APPLICATION = 0x8044;
export const USB_PID_APPLICATION_SENSE = 0x8045;
export const USB_PID_BOOTLOADER = 0x0044;
export const USB_PID_BOOTLOADER_SENSE = 0x0045;

export const STEP_TARGETS = {
  speed: { endpoint: 'SS', valueId: 'speedVal', meter: 'speedMeter', min: 1, max: 10 },
  scroll: { endpoint: 'SL', valueId: 'scrollVal', meter: 'scrollMeter', min: 1, max: 10 },
  // Acceleration (AV) is bipolar: -10 (slowest, most precise) .. 10 (fastest);
  // 0 is the linear no-op default. No meter — the 10-segment meter is a
  // 0..10 display, and the numeric value carries the sign.
  accel: { endpoint: 'AV', valueId: 'accelVal', min: -10, max: 10 },
  brightness: { endpoint: 'LL', valueId: 'brightnessVal', meter: 'brightnessMeter', min: 0, max: 10 },
};

// ---- Input restrictions (roadmap item 11; firmware 4.4.0+) ----
// Four boolean gates against accidental input, all defaulting to off (the
// unrestricted legacy behavior). Every value is 1 = restriction active.
// checkboxId is the card control; jsonKey is the settings-export key.
export const RESTRICTIONS_MIN_FIRMWARE = [4, 4, 0];
export const RESTRICTION_SETTINGS = [
  { endpoint: 'SD', checkboxId: 'sapDisabled', label: 'Sip & puff disabled', jsonKey: 'sipPuffDisabled' },
  {
    endpoint: 'MA',
    checkboxId: 'menuButtonsOnly',
    label: 'Menu restricted to hub buttons',
    jsonKey: 'menuButtonsOnly',
  },
  { endpoint: 'LK', checkboxId: 'modeLock', label: 'Operating mode locked', jsonKey: 'modeLocked' },
  {
    endpoint: 'CF',
    checkboxId: 'cursorHold',
    label: 'Cursor frozen during sip & puff',
    jsonKey: 'cursorHoldDuringSap',
  },
];

// ---- Input timing windows (roadmap item 15; firmware 4.4.0+) ----
// The short/long/very-long input window boundaries in ms (upstream #62/#9):
// how long a sip/puff must be held to land in each action window. Ranges
// mirror the firmware's setters, which also enforce short < long < max.
export const WINDOW_SETTINGS = [
  {
    endpoint: 'WS',
    valueId: 'w1Val',
    inputId: 'w1Input',
    label: 'Short input window',
    unit: 'ms',
    min: 200,
    max: 2500,
    jsonKey: 'inputWindowShortMs',
  },
  {
    endpoint: 'WL',
    valueId: 'w2Val',
    inputId: 'w2Input',
    label: 'Long input window',
    unit: 'ms',
    min: 400,
    max: 6000,
    jsonKey: 'inputWindowLongMs',
  },
  {
    endpoint: 'WM',
    valueId: 'w3Val',
    inputId: 'w3Input',
    label: 'Max input window',
    unit: 'ms',
    min: 1000,
    max: 10000,
    jsonKey: 'inputWindowMaxMs',
  },
];

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
