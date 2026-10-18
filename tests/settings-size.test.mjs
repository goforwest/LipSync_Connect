// Settings-file size budget (firmware follow-up, bench 2026-10-18): the
// serialized settings file is the one artifact firmware 4.1.0 — the oldest
// firmware the app can downgrade a device to — reads with a fixed 512-byte
// buffer, truncating anything longer on its next write. The file sat at
// ~383 B through 4.4.x, which is why every 4.1.0 downgrade round-trip kept
// working; 4.5.0's six switch mappings (SA/SB/SC/GA/GB/GC) ate most of that
// headroom, and one more feature of that size would make a downgrade
// silently eat the tail of the file. The firmware now enforces
// CONF_SETTINGS_FILE_BUDGET at write time (LSMemory refuses, the API layer
// answers FAIL,3) and reports the live size in the EX dump; this test is the
// desk-side tripwire that a NEW settings key trips here — in the build, on
// every dev machine with a paired firmware checkout — instead of in the
// field on someone's device.
//
// It reads the paired firmware checkout (FIRMWARE_REPO env, default
// ~/LipSync — the same convention as dev/firmware/protocol-cross-check.mjs)
// and self-skips with a loud note when the checkout is absent, so a
// CI runner without the firmware does not fail on a gate it cannot run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const FW = process.env.FIRMWARE_REPO
  ? path.resolve(process.env.FIRMWARE_REPO.replace(/^~(?=\/)/, homedir()))
  : path.join(homedir(), 'LipSync');
const CONFIG = path.join(FW, 'Build_Files/Firmware_Files/LipSync_Firmware/LSConfig.h');

// 4.1.0's reader buffer — the cliff every guard and test exists to stay
// away from. Not parsed from the firmware (4.1.0's source is not this
// checkout); pinned here as the contract this whole test protects.
const READER_BUFFER_4_1_0 = 512;

test('settings file stays inside the 4.1.0 downgrade budget', { skip: !existsSync(CONFIG) ? 'firmware checkout not found — set FIRMWARE_REPO to run this gate' : false }, () => {
  const configSrc = readFileSync(CONFIG, 'utf8');

  const jsonMatch = configSrc.match(/#define\s+CONF_SETTINGS_JSON\s+"(.*)"/);
  assert.ok(jsonMatch, 'CONF_SETTINGS_JSON must exist in LSConfig.h');
  const defaults = JSON.parse(jsonMatch[1].replace(/\\"/g, '"'));

  const budgetMatch = configSrc.match(/#define\s+CONF_SETTINGS_FILE_BUDGET\s+(\d+)/);
  assert.ok(budgetMatch, 'CONF_SETTINGS_FILE_BUDGET must exist in LSConfig.h — the write-time guard depends on it');
  const budget = parseInt(budgetMatch[1], 10);

  // The budget itself must stay a safe margin under the 4.1.0 cliff: a
  // budget set at (or above) 512 would make the guard meaningless.
  assert.ok(budget <= READER_BUFFER_4_1_0 - 16, `budget ${budget} leaves no margin under 4.1.0's ${READER_BUFFER_4_1_0}-byte reader`);

  // Ground truth for the DEFAULT key set, serialized compactly exactly the
  // way the firmware's serializeJson() writes it (no whitespace).
  const defaultSize = JSON.stringify(defaults).length;
  assert.ok(defaultSize < budget, `default settings JSON alone is ${defaultSize} bytes — within ${budget} bytes of the budget`);

  // Worst-case value growth from the default set: every key at the widest
  // representation the firmware's setters can legally store. This is the
  // number the write-time guard compares against (a stored file with all
  // values at max), so the model must mirror the setters' ranges:
  //   - thresholds (ST/PT) at 150.0 (the max the setter accepts)
  //   - deadzones (IZ/OZ) at 4-decimal floats
  //   - calibration points (CA0..CA4) at signed 2-decimal pairs
  //   - a realistic device ID string (LS_<hex FICR>, ~13 chars)
  //   - all six switch remaps at 7-digit packed wire values
  //   - timing windows (WS/WL/WM) at 5 digits
  // Everything else is a small int that cannot meaningfully grow.
  const worst = { ...defaults };
  worst.ST = 150.0;
  worst.PT = 150.0;
  worst.IZ = 0.0712;
  worst.OZ = 0.9512;
  worst.ID = 'LS_1234567890AB';
  for (let c = 0; c <= 4; c++) worst['CA' + c] = [-19.99, -19.99];
  for (const k of ['SA', 'SB', 'SC', 'GA', 'GB', 'GC']) worst[k] = 1234567;
  for (const k of ['WS', 'WL', 'WM']) worst[k] = 10000;
  const worstSize = JSON.stringify(worst).length;
  assert.ok(
    worstSize < budget,
    `fully-populated settings (${worstSize} bytes, every key at its widest legal value) exceed the ${budget}-byte budget — a fully-configured device would refuse further writes and a 4.1.0 downgrade would truncate`,
  );

  // And the honest headroom report, so a growing file is visible in the
  // test output long before the assert fires.
  console.log(
    `  settings size: default ${defaultSize} B, fully-populated worst case ${worstSize} B, budget ${budget} B, 4.1.0 cliff ${READER_BUFFER_4_1_0} B`,
  );
});
