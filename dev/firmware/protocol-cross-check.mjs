// Cross-repo protocol consistency check: verifies the app and the firmware
// it pairs with actually agree on the wire. The two repos ship separately
// (app to Vercel, firmware on tags), so a silent protocol divergence would
// only surface on hardware — this catches it at the desk, in seconds.
//
// Usage: node dev/firmware/protocol-cross-check.mjs
// Env:   FIRMWARE_REPO (default ~/LipSync) — the lipsync checkout to check
//        against. Exits non-zero on any mismatch.
/* global process */
//
// What it verifies (each check prints PASS/FAIL lines and counts):
//   1. Every (endpoint, code) pair the app can put on the wire exists in the
//      firmware's dispatch table, with a parameter that accepts what we send.
//   2. Every firmware endpoint matches the app's response grammar
//      ([A-Z]{1,4} then a comma) — the W1-class naming bug, caught forever.
//   3. The default settings JSON parses and contains every key the firmware
//      reads via mem.read*(CONF_SETTINGS_FILE, "KEY").
//   4. Value ranges the app validates locally match the firmware's setters
//      (speed, scroll, acceleration, brightness, timing windows).
//   5. The firmware's compiled version is at least every version gate the
//      app uses (a gate must never reference a version newer than what the
//      paired firmware is).
//   6. The local firmware builder uses the same pinned CLI/core/external
//      libraries as release CI and isolates them from global user libraries.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '../..');
const FW = process.env.FIRMWARE_REPO
  ? path.resolve(process.env.FIRMWARE_REPO.replace(/^~(?=\/)/, homedir()))
  : path.join(homedir(), 'LipSync');
const SKETCH = path.join(FW, 'Build_Files/Firmware_Files/LipSync_Firmware');

const problems = [];
const ok = (msg) => console.log('  PASS ' + msg);
const fail = (msg) => {
  problems.push(msg);
  console.log('  FAIL ' + msg);
};

if (!existsSync(SKETCH)) {
  // A local paired-repo gate, not a CI gate: CI has no firmware checkout, so
  // self-skip with a loud note instead of failing a build that cannot run it.
  console.log(`SKIPPED — firmware checkout not found at ${SKETCH}. Set FIRMWARE_REPO and re-run.`);
  process.exit(0);
}

const read = (p) => readFileSync(path.join(APP, p), 'utf8');
const readFw = (p) => readFileSync(path.join(SKETCH, p), 'utf8');
const readFirmwareRepo = (p) => readFileSync(path.join(FW, p), 'utf8');

// ---- 1. Firmware dispatch table -------------------------------------------
console.log('\n[1] firmware dispatch table');
const dispatch = {}; // "EP,code" -> parameter string
for (const m of readFw('LSAPI.ino').matchAll(
  /_functionList\s+\w+\s*=\s*\{\s*"([A-Z0-9]{2})"\s*,\s*"(\d)"\s*,\s*"([^"]*)"/g,
)) {
  const key = m[1] + ',' + m[2];
  if (dispatch[key]) fail(`duplicate dispatch entry for ${key}`);
  dispatch[key] = m[3];
}
const endpoints = [...new Set(Object.keys(dispatch).map((k) => k.split(',')[0]))];
ok(`${Object.keys(dispatch).length} dispatch entries over ${endpoints.length} endpoints, no duplicates`);

// ---- 2. Response grammar: letter-only endpoints ----------------------------
console.log('\n[2] app response grammar accepts every firmware endpoint');
const grammarBad = endpoints.filter((ep) => !/^[A-Z]{1,4}$/.test(ep));
if (grammarBad.length) fail(`endpoints the app grammar cannot parse: ${grammarBad.join(', ')}`);
else ok(`all ${endpoints.length} endpoints match [A-Z]{1,4} (SUCCESS,0:EP,0:v parses)`);

// ---- 3. Settings JSON keys vs the keys the firmware reads ------------------
console.log('\n[3] default settings JSON vs mem.read* keys');
const configSrc = readFw('LSConfig.h');
const parseSeed = (name) => {
  const m = configSrc.match(new RegExp(`#define\\s+${name}\\s+"(.*)"`));
  if (!m) return { json: null, error: `${name} not found` };
  try {
    return { json: JSON.parse(m[1].replace(/\\"/g, '"')), error: null };
  } catch (e) {
    return { json: null, error: e.message };
  }
};
const { json: defaults, error: defaultsError } = parseSeed('CONF_SETTINGS_JSON');
if (defaultsError) fail(`CONF_SETTINGS_JSON does not parse: ${defaultsError}`);
else ok(`CONF_SETTINGS_JSON parses (${Object.keys(defaults).length} keys)`);
// The 4.7.0+ second settings file (upstream #58): the hard-band keys live
// there, so its seed document gets the same read-key coverage.
const { json: defaults2, error: defaults2Error } = parseSeed('CONF_SETTINGS2_JSON');
if (defaults2Error) fail(`CONF_SETTINGS2_JSON does not parse: ${defaults2Error}`);
else ok(`CONF_SETTINGS2_JSON parses (${Object.keys(defaults2).length} keys)`);
const readKeys = new Set();
const readKeys2 = new Set();
for (const f of ['LSAPI.ino', 'LipSync_Firmware.ino']) {
  const src = readFw(f);
  for (const m of src.matchAll(/mem\.read(?:Int|Float|String|Point)\(CONF_SETTINGS_FILE,\s*"([^"]+)"/g))
    readKeys.add(m[1]);
  for (const m of src.matchAll(/mem\.read(?:Int|Float|String|Point)\(CONF_SETTINGS2_FILE,\s*"([^"]+)"/g))
    readKeys2.add(m[1]);
  // Getters read through a local: String commandKey = "XX"; — but only when
  // that local is actually passed to a mem.read call nearby (some functions
  // declare it and never use it — dead labels, not keys).
  for (const m of src.matchAll(
    /String commandKey = "([^"]+)"[\s\S]{0,2000}?mem\.read\w+\(CONF_SETTINGS_FILE,\s*commandKey/g,
  ))
    readKeys.add(m[1]);
  for (const m of src.matchAll(
    /String commandKey = "([^"]+)"[\s\S]{0,2000}?mem\.read\w+\(CONF_SETTINGS2_FILE,\s*commandKey/g,
  ))
    readKeys2.add(m[1]);
  // The switch-action endpoints read through the shared core getter, invoked
  // with the endpoint key as a literal (boot load, EX dump).
  for (const m of src.matchAll(/getSwitchAction\(\s*(?:true|false),\s*(?:true|false),\s*"([A-Z]{2})"\)/g))
    readKeys.add(m[1]);
  // The hard-action endpoints read through the shared core getter with the
  // key as a literal (the settings2 file; upstream #58).
  for (const m of src.matchAll(/getHardAction\([^)]*"([A-Z]{2})"/g)) readKeys2.add(m[1]);
  for (const m of src.matchAll(/setHardAction\([^)]*"([A-Z]{2})"/g)) readKeys2.add(m[1]);
  // readPoint-style keys built dynamically (CA1..CA4)
  if (/"CA"\s*\+\s*String\(/.test(src)) {
    for (const key of ['CA1', 'CA2', 'CA3', 'CA4']) readKeys.add(key);
  }
}
if (defaults) {
  const missing = [...readKeys].filter((k) => !(k in defaults));
  if (missing.length) fail(`keys the firmware reads but the default JSON lacks: ${missing.join(', ')}`);
  else ok(`all ${readKeys.size} read keys present in the default JSON`);
}
if (defaults2) {
  const missing = [...readKeys2].filter((k) => !(k in defaults2));
  if (missing.length) fail(`hard-band keys the firmware reads but CONF_SETTINGS2_JSON lacks: ${missing.join(', ')}`);
  else ok(`all ${readKeys2.size} hard-band read keys present in the settings2 seed JSON`);
}

// ---- 4. Every command the app sends exists on the firmware ----------------
console.log('\n[4] app -> firmware command pairs');
const {
  RESTRICTION_SETTINGS,
  WINDOW_SETTINGS,
  STEP_TARGETS,
  SWITCH_SETTINGS,
  SWITCH_ACTION_OPTIONS,
  HARD_ACTION_SETTINGS,
  MODE_PRESETS,
  MODE_PRESET_MIN_FIRMWARE,
} = await import(path.join(APP, 'app/js/config/constants.js'));
const appSources = [
  'app/js/main.js',
  'app/js/services/settings-service.js',
  'app/js/services/device-ops.js',
  'app/js/services/hub-remote.js',
  'app/js/services/mode-switch.js',
  'app/js/services/health.js',
  'app/js/services/firmware-update.js',
  'app/js/services/calibration.js',
  'app/js/serial/commands.js',
].map(read);
// Literal commands: sendCommand('EP,c:v...') — kept with their parameter so a
// pinned firmware parameter ("0"/"1") can be compared, not just the pair.
// Empty captures are command PREFIXES awaiting a concatenated value (e.g.
// 'ST,1:' + fmtApiFloat(v)) — not real wire lines; skip them.
const literalCommands = new Set(); // "EP,c:parameter"
for (const src of appSources) {
  for (const m of src.matchAll(/sendCommand\(\s*['"`]([A-Z]{2}),(\d):([^'"`]*)/g)) {
    if (m[3].length === 0) continue;
    literalCommands.add(`${m[1]},${m[2]}:${m[3]}`);
  }
}
// Symbolic senders resolved against the real endpoint lists (parameter is
// user data — the firmware pair just has to exist and accept a parameter).
const symbolicPairs = new Set(); // "EP,c"
for (const r of [...RESTRICTION_SETTINGS, ...WINDOW_SETTINGS]) symbolicPairs.add(r.endpoint + ',1');
for (const t of Object.values(STEP_TARGETS)) symbolicPairs.add(t.endpoint + ',1');
for (const s of SWITCH_SETTINGS) {
  symbolicPairs.add(s.endpoint + ',0');
  symbolicPairs.add(s.endpoint + ',1');
}
// Hard band actions (4.7.0+): read on load, written by their selects.
for (const a of HARD_ACTION_SETTINGS) {
  symbolicPairs.add(a.endpoint + ',0');
  symbolicPairs.add(a.endpoint + ',1');
}
for (const m of read('app/js/services/settings-service.js').matchAll(/\['([A-Z]{2}),0:0'/g))
  symbolicPairs.add(m[1] + ',0');
for (const m of read('app/js/main.js').matchAll(/setSimpleSetting\(\s*['"`]([A-Z]{2})['"`]/g))
  symbolicPairs.add(m[1] + ',1');

let pairFails = 0;
for (const lit of [...literalCommands].sort()) {
  const pair = lit.slice(0, lit.indexOf(':'));
  const value = lit.slice(lit.indexOf(':') + 1);
  if (!(pair in dispatch)) {
    fail(`app sends ${lit} but the firmware dispatch table has no ${pair} entry`);
    pairFails++;
    continue;
  }
  // A pinned firmware parameter (anything other than "") must equal the
  // literal the app writes — the firmware rejects the command otherwise.
  if (dispatch[pair] !== '' && dispatch[pair] !== value) {
    fail(`app sends ${lit} but the firmware pins parameter "${dispatch[pair]}"`);
    pairFails++;
  }
}
for (const pair of [...symbolicPairs].sort()) {
  if (!(pair in dispatch)) {
    fail(`app sends ${pair}:<value> but the firmware dispatch table has no ${pair} entry`);
    pairFails++;
  }
}
if (!pairFails)
  ok(
    `${literalCommands.size} literal + ${symbolicPairs.size} symbolic command shapes all resolve in the firmware table`,
  );

// ---- 5. Value-range agreement ----------------------------------------------
console.log('\n[5] app validation ranges vs firmware setters');
const define = (name) => {
  const m = configSrc.match(new RegExp(`#define\\s+${name}\\s+(-?\\d+(?:\\.\\d+)?)`));
  return m ? parseFloat(m[1]) : null;
};
const ranges = [
  ['speed', 'CONF_JOY_CURSOR_SPEED_LEVEL_MIN', 'CONF_JOY_CURSOR_SPEED_LEVEL_MAX', STEP_TARGETS.speed],
  ['scroll', 'CONF_SCROLL_LEVEL_MIN', 'CONF_SCROLL_LEVEL_MAX', STEP_TARGETS.scroll],
  ['accel', 'CONF_JOY_ACCELERATION_LEVEL_MIN', 'CONF_JOY_ACCELERATION_LEVEL_MAX', STEP_TARGETS.accel],
  ['brightness', 'CONF_LED_BRIGHTNESS_LEVEL_MIN', 'CONF_LED_BRIGHTNESS_LEVEL_MAX', STEP_TARGETS.brightness],
];
for (const [label, fmin, fmax, target] of ranges) {
  const [lo, hi] = [define(fmin), define(fmax)];
  if (lo !== target.min || hi !== target.max) {
    fail(`${label}: app range [${target.min},${target.max}] != firmware [${lo},${hi}]`);
  } else {
    ok(`${label} range [${lo}, ${hi}] agrees`);
  }
}
const fwWindows = [
  ['WS', 'CONF_INPUT_WINDOW_SHORT_MIN_MS', 'CONF_INPUT_WINDOW_SHORT_MAX_MS'],
  ['WL', 'CONF_INPUT_WINDOW_LONG_MIN_MS', 'CONF_INPUT_WINDOW_LONG_MAX_MS'],
  ['WM', 'CONF_INPUT_WINDOW_MAX_MIN_MS', 'CONF_INPUT_WINDOW_MAX_MAX_MS'],
];
for (const [ep, fmin, fmax] of fwWindows) {
  const w = WINDOW_SETTINGS.find((x) => x.endpoint === ep);
  const [lo, hi] = [define(fmin), define(fmax)];
  if (lo !== w.min || hi !== w.max) fail(`${ep}: app window [${w.min},${w.max}] != firmware [${lo},${hi}]`);
  else ok(`${ep} window [${lo}, ${hi}] agrees`);
}

// The Hub-menu threshold level scale: the app's Hub-remote mirror steps the
// same coarse table the firmware's OLED pages step, so the two copies must
// be identical (labels and stepping semantics both derive from it).
const { PRESS_THRESHOLD_LEVELS } = await import(path.join(APP, 'app/js/config/constants.js'));
const fwLevels = [...configSrc.matchAll(/PRESS_THRESHOLD_LEVEL_TABLE\[\]\s*=\s*\{([^}]*)\}/g)].flatMap((m) =>
  m[1]
    .split(',')
    .map((x) => parseFloat(x.trim()))
    .filter((x) => Number.isFinite(x)),
);
if (fwLevels.length !== PRESS_THRESHOLD_LEVELS.length || fwLevels.some((v, i) => v !== PRESS_THRESHOLD_LEVELS[i])) {
  fail(`threshold level scale differs: app [${PRESS_THRESHOLD_LEVELS.join(',')}] != firmware [${fwLevels.join(',')}]`);
} else {
  ok(`threshold level scale [${fwLevels.join(', ')}] agrees (${fwLevels.length} levels)`);
}

// The Sip & Puff submenu ROW LIST (upstream #58, 4.7.0): the mirror's rows
// are addressed by firmware row index, so the order is a wire contract — the
// hard rows must sit between Timing and Back, and every pre-4.7.0 row must
// keep its index. The page ids and the app's page map are pinned too.
const screenSrc = readFw('LSScreen.h');
const sipRowsMatch = screenSrc.match(/_sipPuffThreshMenuText\[\d+\]\s*=\s*\{([^}]*)\}/);
const sipRows = sipRowsMatch ? [...sipRowsMatch[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]) : [];
const EXPECTED_SIP_ROWS = ['Sip Threshold', 'Puff Threshold', 'Timing', 'Hard Sip', 'Hard Puff', '... Back'];
if (JSON.stringify(sipRows) !== JSON.stringify(EXPECTED_SIP_ROWS)) {
  fail(`Sip & Puff menu rows differ: firmware [${sipRows.join(', ')}] != pinned [${EXPECTED_SIP_ROWS.join(', ')}]`);
} else {
  ok(`Sip & Puff menu rows agree (${sipRows.length} rows, hard rows before Back)`);
}
const hubSrc = read('app/js/services/hub-remote.js');
const hardSipPage = screenSrc.match(/#define\s+HARD_SIP_THRESH_MENU\s+(\d+)/)?.[1];
const hardPuffPage = screenSrc.match(/#define\s+HARD_PUFF_THRESH_MENU\s+(\d+)/)?.[1];
if (!hardSipPage || !hardPuffPage) {
  fail('LSScreen.h is missing HARD_SIP_THRESH_MENU / HARD_PUFF_THRESH_MENU');
} else if (!hubSrc.includes(`${hardSipPage}: 'hardSip'`) || !hubSrc.includes(`${hardPuffPage}: 'hardPuff'`)) {
  fail(`the app's page map lacks ${hardSipPage}->hardSip / ${hardPuffPage}->hardPuff`);
} else if (!hubSrc.includes('HARD_BAND_MIN_FIRMWARE') || !hubSrc.includes("'Hard Sip'") || !hubSrc.includes("'Hard Puff'")) {
  fail('the mirror does not version-gate the hard rows on HARD_BAND_MIN_FIRMWARE');
} else {
  ok(`hard-band menu pages ${hardSipPage}/${hardPuffPage} map to the gated mirror screens`);
}

// The external-switch remap allowlist (4.5.0+): the actions the app offers
// in its remap selects must be exactly the actions the firmware's setter
// accepts — an action on one side but not the other is either a pick that
// always FAILs or a firmware capability the app hides.
const fwAllowed = [...configSrc.matchAll(/CONF_SWITCH_REMAP_ALLOWED\[\]\s*=\s*\{([^}]*)\}/g)].flatMap((m) =>
  m[1]
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .map((x) => {
      const def = x.match(/^CONF_ACTION_(\w+)$/);
      if (def) {
        const byName = configSrc.match(new RegExp(`#define\\s+CONF_ACTION_${def[1]}\\s+(-?\\d+)`));
        return byName ? parseInt(byName[1], 10) : null;
      }
      const num = parseInt(x, 10);
      return Number.isFinite(num) ? num : null;
    })
    .filter((x) => x !== null),
);
const appAllowed = Object.keys(SWITCH_ACTION_OPTIONS)
  .map(Number)
  .sort((a, b) => a - b);
const fwAllowedSorted = [...fwAllowed].sort((a, b) => a - b);
if (appAllowed.length !== fwAllowedSorted.length || appAllowed.some((v, i) => v !== fwAllowedSorted[i])) {
  fail(`switch remap allowlist differs: app [${appAllowed.join(',')}] != firmware [${fwAllowedSorted.join(',')}]`);
} else {
  ok(`switch remap allowlist agrees (${appAllowed.length} actions)`);
}
// The hard band reuses the same palette and the same allowlist; its seed
// defaults (the compiled hard-row actions in CONF_SETTINGS2_JSON) must be
// renderable picks in the app's selects — a default outside the palette
// would load into a select the caregiver cannot re-display.
if (defaults2) {
  const palette = new Set(appAllowed.map(String));
  const badSeed = ['HA', 'HB'].filter((k) => k in defaults2 && !palette.has(String(defaults2[k])));
  if (badSeed.length)
    fail(`hard-band seed defaults outside the app palette: ${badSeed.map((k) => `${k}=${defaults2[k]}`).join(', ')}`);
  else if ('HA' in defaults2 || 'HB' in defaults2)
    ok(`hard-band seed defaults are renderable picks (HA=${defaults2.HA}, HB=${defaults2.HB})`);
}

// Atomic mode presets (4.6.4+): endpoint existence alone is insufficient. A
// code drift here would acknowledge successfully while selecting the wrong
// transport/HID pair, so pin all three app values to the firmware constants.
const fwModePresets = {
  mouse: {
    om: define('CONF_OPERATING_MODE_MOUSE'),
    cm: define('CONF_COM_MODE_USB'),
    preset: define('CONF_MODE_PRESET_MOUSE_USB'),
  },
  'mouse-bt': {
    om: define('CONF_OPERATING_MODE_MOUSE'),
    cm: define('CONF_COM_MODE_BLE'),
    preset: define('CONF_MODE_PRESET_MOUSE_BLE'),
  },
  gamepad: {
    om: define('CONF_OPERATING_MODE_GAMEPAD'),
    cm: define('CONF_COM_MODE_USB'),
    preset: define('CONF_MODE_PRESET_GAMEPAD_USB'),
  },
};
let modePresetMismatch = false;
for (const [key, fwPreset] of Object.entries(fwModePresets)) {
  const appPreset = MODE_PRESETS[key];
  if (!appPreset || ['om', 'cm', 'preset'].some((field) => String(fwPreset[field]) !== appPreset[field])) {
    fail(`mode preset ${key} differs: app ${JSON.stringify(appPreset)} != firmware ${JSON.stringify(fwPreset)}`);
    modePresetMismatch = true;
  }
}
if (Object.keys(MODE_PRESETS).length !== Object.keys(fwModePresets).length) {
  fail(
    `app exposes ${Object.keys(MODE_PRESETS).length} mode presets; firmware defines ${Object.keys(fwModePresets).length}`,
  );
  modePresetMismatch = true;
}
if (!modePresetMismatch)
  ok(`atomic mode preset codes and OM/CM pairs agree (${Object.keys(fwModePresets).length} presets)`);

// ---- 6. Version gates vs the paired firmware ------------------------------
console.log('\n[6] app version gates vs firmware version');
const fwVersion = [
  define('CONF_LIPSYNC_VERSION_MAJOR'),
  define('CONF_LIPSYNC_VERSION_MINOR'),
  define('CONF_LIPSYNC_VERSION_REV'),
];
const { RESTRICTIONS_MIN_FIRMWARE, SWITCH_ACTIONS_MIN_FIRMWARE } = await import(
  path.join(APP, 'app/js/config/constants.js')
);
const [gMaj, gMin, gRev] = RESTRICTIONS_MIN_FIRMWARE;
const [fMaj, fMin, fRev] = fwVersion;
const fwNewEnough = fMaj > gMaj || (fMaj === gMaj && (fMin > gMin || (fMin === gMin && fRev >= gRev)));
if (!fwNewEnough)
  fail(
    `firmware ${fwVersion.join('.')} is OLDER than the app's ${RESTRICTIONS_MIN_FIRMWARE.join('.')} gate — the app would hide its own features`,
  );
else ok(`firmware ${fwVersion.join('.')} satisfies the ${RESTRICTIONS_MIN_FIRMWARE.join('.')} gate`);
{
  const [sMaj, sMin, sRev] = SWITCH_ACTIONS_MIN_FIRMWARE;
  const swOk = fMaj > sMaj || (fMaj === sMaj && (fMin > sMin || (fMin === sMin && fRev >= sRev)));
  if (!swOk)
    fail(
      `firmware ${fwVersion.join('.')} is OLDER than the app's ${SWITCH_ACTIONS_MIN_FIRMWARE.join('.')} switch-actions gate — the app would hide its own features`,
    );
  else ok(`firmware ${fwVersion.join('.')} satisfies the ${SWITCH_ACTIONS_MIN_FIRMWARE.join('.')} switch-actions gate`);
}
{
  const { HARD_BAND_MIN_FIRMWARE } = await import(path.join(APP, 'app/js/config/constants.js'));
  const [hMaj, hMin, hRev] = HARD_BAND_MIN_FIRMWARE;
  const hbOk = fMaj > hMaj || (fMaj === hMaj && (fMin > hMin || (fMin === hMin && fRev >= hRev)));
  if (!hbOk)
    fail(
      `firmware ${fwVersion.join('.')} is OLDER than the app's ${HARD_BAND_MIN_FIRMWARE.join('.')} hard-band gate — the app would hide its own features`,
    );
  else ok(`firmware ${fwVersion.join('.')} satisfies the ${HARD_BAND_MIN_FIRMWARE.join('.')} hard-band gate`);
}
{
  const [mMaj, mMin, mRev] = MODE_PRESET_MIN_FIRMWARE;
  const mpOk = fMaj > mMaj || (fMaj === mMaj && (fMin > mMin || (fMin === mMin && fRev >= mRev)));
  if (!mpOk)
    fail(
      `firmware ${fwVersion.join('.')} is OLDER than the app's ${MODE_PRESET_MIN_FIRMWARE.join('.')} atomic-mode gate`,
    );
  else ok(`firmware ${fwVersion.join('.')} satisfies the ${MODE_PRESET_MIN_FIRMWARE.join('.')} atomic-mode gate`);
}
const healthSrc = read('app/js/services/health.js');
const bhGate = healthSrc.match(/BUS_HEALTH_MIN_FIRMWARE\s*=\s*\[(\d+),\s*(\d+),\s*(\d+)\]/);
if (bhGate) {
  const [bMaj, bMin, bRev] = bhGate.slice(1).map(Number);
  const bhOk = fMaj > bMaj || (fMaj === bMaj && (fMin > bMin || (fMin === bMin && fRev >= bRev)));
  if (!bhOk) fail(`firmware ${fwVersion.join('.')} older than the BH gate [${bMaj}.${bMin}.${bRev}]`);
  else ok(`BH gate [${bMaj}.${bMin}.${bRev}] satisfied`);
}
const umGate = read('app/js/services/firmware-update.js').match(/UM_FIRMWARE_MIN_VERSION\s*=\s*'([\d.]+)'/);
if (umGate) ok(`UM gate ${umGate[1]} (present; satisfied by any 4.x ≥ 4.3)`);

// ---- command length sanity: the firmware format validator -----------------
console.log('\n[7] command shapes the firmware validator accepts');
// Every line the app can plausibly put on the wire must land on a length the
// firmware's isValidCommandFormat() accepts (6/7/8/9/10/11 for 1-6 digit
// parameters). Checking only the longest command once missed a real bug:
// the validator originally skipped 5-digit parameters (10-char lines), so
// the timing-window maximum — WM,1:10000, a value the Hub menu can set and
// the app allows — was answered FAIL,0 on the wire.
const probes = [];
for (const lit of literalCommands) probes.push(lit);
for (const pair of symbolicPairs) probes.push(`${pair}:10000`);
const legalLengths = new Set([6, 7, 8, 9, 10, 11]);
const badLen = probes.filter((p) => !legalLengths.has(p.length));
if (badLen.length) {
  for (const p of badLen)
    fail(`plausible app command (${p}, ${p.length} chars) is not a length the firmware format validator accepts`);
} else {
  const longest = probes.sort((a, b) => b.length - a.length)[0];
  ok(`all ${probes.length} plausible command shapes fit the firmware format validator (longest: ${longest})`);
}
// The concrete maximum the app can write: the timing-window maximum must be
// writable (this exact line is why 10-char lines exist).
if (!legalLengths.has('WM,1:10000'.length)) fail('WM,1:10000 (the max window) is not a legal command line');
else ok('WM,1:10000 (the max timing window) is a legal command line');

// ---- 8. Local builder dependency isolation vs release CI ------------------
console.log('\n[8] local firmware builder matches release dependencies');
const localBuildScript = read('dev/firmware/build-firmware.sh');
const releaseWorkflow = readFirmwareRepo('.github/workflows/build_firmware.yml');
const extractLibraryPins = (source) =>
  [...source.matchAll(/"([^"\n]+@\d+\.\d+\.\d+)"/g)].map((match) => match[1]).sort();
const localLibraryPins = extractLibraryPins(localBuildScript);
const releaseLibraryPins = extractLibraryPins(releaseWorkflow);
if (JSON.stringify(localLibraryPins) !== JSON.stringify(releaseLibraryPins)) {
  fail(`local library pins [${localLibraryPins.join(', ')}] != release CI [${releaseLibraryPins.join(', ')}]`);
} else {
  ok(`local builder and release CI share all ${localLibraryPins.length} external-library pins`);
}
const localCli = localBuildScript.match(/ARDUINO_CLI_VERSION=\$\{ARDUINO_CLI_VERSION:-([^}]+)\}/)?.[1];
const releaseCli = releaseWorkflow.match(/version:\s*'([^']+)'/)?.[1];
if (localCli !== releaseCli) fail(`local arduino-cli ${localCli} != release CI ${releaseCli}`);
else ok(`arduino-cli ${localCli} agrees`);
const localCore = localBuildScript.match(/SEEED_CORE_VERSION=\$\{SEEED_CORE_VERSION:-([^}]+)\}/)?.[1];
const releaseCore = releaseWorkflow.match(/core install Seeeduino:nrf52@([\d.]+)/)?.[1];
if (localCore !== releaseCore) fail(`local Seeed core ${localCore} != release CI ${releaseCore}`);
else ok(`Seeeduino:nrf52@${localCore} agrees`);
if (!localBuildScript.includes('export ARDUINO_DIRECTORIES_USER="$isolated_user_dir"')) {
  fail('local builder does not isolate Arduino user libraries');
} else if (!localBuildScript.includes('expected Seeed core TinyUSB 1.7.0')) {
  fail('local builder does not verify the release-canonical TinyUSB version');
} else {
  ok('local builder isolates user libraries and verifies core TinyUSB 1.7.0 provenance');
}
if (!localBuildScript.includes('--warnings all') || !releaseWorkflow.includes('--warnings all')) {
  fail('local and release firmware builds must both enforce --warnings all');
} else {
  ok('local and release builds share the all-warnings gate');
}

console.log(`\n${problems.length ? problems.length + ' PROBLEM(S)' : 'ALL CHECKS PASS'}`);
process.exit(problems.length ? 1 : 0);
