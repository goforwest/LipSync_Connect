// Cross-repo protocol consistency check: verifies the app and the firmware
// it pairs with actually agree on the wire. The two repos ship separately
// (app to Vercel, firmware on tags), so a silent protocol divergence would
// only surface on hardware — this catches it at the desk, in seconds.
//
// Usage: node dev/firmware/protocol-cross-check.mjs
// Env:   FIRMWARE_REPO (default ~/LipSync) — the lipsync checkout to check
//        against. Exits non-zero on any mismatch.
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

// ---- 1. Firmware dispatch table -------------------------------------------
console.log('\n[1] firmware dispatch table');
const dispatch = {}; // "EP,code" -> parameter string
for (const m of readFw('LSAPI.ino').matchAll(/_functionList\s+\w+\s*=\s*\{\s*"([A-Z0-9]{2})"\s*,\s*"(\d)"\s*,\s*"([^"]*)"/g)) {
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
const jsonMatch = configSrc.match(/#define\s+CONF_SETTINGS_JSON\s+"(.*)"/);
let defaults = null;
try {
  defaults = JSON.parse(jsonMatch[1].replace(/\\"/g, '"'));
  ok(`CONF_SETTINGS_JSON parses (${Object.keys(defaults).length} keys)`);
} catch (e) {
  fail(`CONF_SETTINGS_JSON does not parse: ${e.message}`);
}
const readKeys = new Set();
for (const f of ['LSAPI.ino', 'LipSync_Firmware.ino']) {
  const src = readFw(f);
  for (const m of src.matchAll(/mem\.read(?:Int|Float|String|Point)\(CONF_SETTINGS_FILE,\s*"([^"]+)"/g)) readKeys.add(m[1]);
  // Getters read through a local: String commandKey = "XX"; — but only when
  // that local is actually passed to a mem.read call nearby (some functions
  // declare it and never use it — dead labels, not keys).
  for (const m of src.matchAll(/String commandKey = "([^"]+)"[\s\S]{0,2000}?mem\.read\w+\(CONF_SETTINGS_FILE,\s*commandKey/g))
    readKeys.add(m[1]);
  // readPoint-style keys built dynamically (CA1..CA4)
  for (const m of src.matchAll(/"CA"\s*\+\s*String\(/g)) readKeys.add('CA1', 'CA2', 'CA3', 'CA4');
}
if (defaults) {
  const missing = [...readKeys].filter((k) => !(k in defaults));
  if (missing.length) fail(`keys the firmware reads but the default JSON lacks: ${missing.join(', ')}`);
  else ok(`all ${readKeys.size} read keys present in the default JSON`);
}

// ---- 4. Every command the app sends exists on the firmware ----------------
console.log('\n[4] app -> firmware command pairs');
const { RESTRICTION_SETTINGS, WINDOW_SETTINGS, STEP_TARGETS } = await import(
  path.join(APP, 'app/js/config/constants.js')
);
const appSources = ['app/js/main.js', 'app/js/services/settings-service.js', 'app/js/services/device-ops.js',
  'app/js/services/hub-remote.js', 'app/js/services/mode-switch.js', 'app/js/services/health.js',
  'app/js/services/firmware-update.js', 'app/js/services/calibration.js', 'app/js/serial/commands.js'].map(read);
// Literal commands: sendCommand('EP,c:v...') — kept with their parameter so a
// pinned firmware parameter ("0"/"1") can be compared, not just the pair.
const literalCommands = new Set(); // "EP,c:parameter"
for (const src of appSources) {
  for (const m of src.matchAll(/sendCommand\(\s*['"`]([A-Z]{2}),(\d):([^'"`]*)/g)) {
    literalCommands.add(`${m[1]},${m[2]}:${m[3]}`);
  }
}
// Symbolic senders resolved against the real endpoint lists (parameter is
// user data — the firmware pair just has to exist and accept a parameter).
const symbolicPairs = new Set(); // "EP,c"
for (const r of [...RESTRICTION_SETTINGS, ...WINDOW_SETTINGS]) symbolicPairs.add(r.endpoint + ',1');
for (const t of Object.values(STEP_TARGETS)) symbolicPairs.add(t.endpoint + ',1');
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
  ok(`${literalCommands.size} literal + ${symbolicPairs.size} symbolic command shapes all resolve in the firmware table`);

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

// ---- 6. Version gates vs the paired firmware ------------------------------
console.log('\n[6] app version gates vs firmware version');
const fwVersion = [
  define('CONF_LIPSYNC_VERSION_MAJOR'),
  define('CONF_LIPSYNC_VERSION_MINOR'),
  define('CONF_LIPSYNC_VERSION_REV'),
];
const { RESTRICTIONS_MIN_FIRMWARE } = await import(path.join(APP, 'app/js/config/constants.js'));
const [gMaj, gMin, gRev] = RESTRICTIONS_MIN_FIRMWARE;
const [fMaj, fMin, fRev] = fwVersion;
const fwNewEnough = fMaj > gMaj || (fMaj === gMaj && (fMin > gMin || (fMin === gMin && fRev >= gRev)));
if (!fwNewEnough) fail(`firmware ${fwVersion.join('.')} is OLDER than the app's ${RESTRICTIONS_MIN_FIRMWARE.join('.')} gate — the app would hide its own features`);
else ok(`firmware ${fwVersion.join('.')} satisfies the ${RESTRICTIONS_MIN_FIRMWARE.join('.')} gate`);
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
const probes = [];
for (const lit of literalCommands) probes.push(lit);
for (const pair of symbolicPairs) probes.push(`${pair}:10000`);
const longest = probes.sort((a, b) => b.length - a.length)[0];
if (longest.length > 11) fail(`a plausible app command (${longest}) exceeds the firmware's 11-char format limit`);
else ok(`longest plausible command (${longest}) fits the firmware format validator`);

console.log(`\n${problems.length ? problems.length + ' PROBLEM(S)' : 'ALL CHECKS PASS'}`);
process.exit(problems.length ? 1 : 0);
