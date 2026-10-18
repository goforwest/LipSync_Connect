// LSTimer host-test gate: compiles the firmware's header-only timer pool
// against a controllable millis() shim and runs the semantic + regression
// suite (dev/firmware/lstimer-test/). The pool is the firmware's
// cooperative scheduling backbone — nine boot loops live on it — and the
// 2026-10-18 bench session proved its failures are not hypothetical (pool
// exhaustion prints, mid-response ERROR lines, and the unexplained
// safe-mode interval death the heartbeat capture witnessed). This gate
// keeps every fixed defect fixed, at desk speed, on every `npm test` run.
//
// Self-skips (loudly) when the paired firmware checkout or a C++ compiler
// is unavailable — the same convention as protocol-cross-check.mjs and
// tests/settings-size.test.mjs: a runner that cannot run the gate must not
// fail the build, but must say why it skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FW = process.env.FIRMWARE_REPO
  ? path.resolve(process.env.FIRMWARE_REPO.replace(/^~(?=\/)/, homedir()))
  : path.join(homedir(), 'LipSync');
const HEADER = path.join(FW, 'Build_Files/Firmware_Files/LipSync_Firmware/LSTimer.h');
const RUNNER = path.resolve(here, '../dev/firmware/lstimer-test/run.sh');

const skip =
  !existsSync(HEADER)
    ? 'firmware checkout not found — set FIRMWARE_REPO to run this gate'
    : !existsSync(RUNNER)
      ? 'lstimer runner missing'
      : undefined;

test(
  'LSTimer host suite: cadence, disable/enable, pool exhaustion, stopwatch, method timers, safe-mode soak',
  { skip },
  () => {
    // The runner prints the suite's own check/failure tally and exits
    // non-zero on any failure; the sanitizer build turns an
    // out-of-bounds timer-id regression into a hard failure too.
    let output = '';
    try {
      output = execFileSync('sh', [RUNNER], {
        env: { ...process.env, FIRMWARE_REPO: FW },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000,
      }).toString();
    } catch (e) {
      const detail = (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
      assert.fail(`LSTimer host suite failed:\n${detail}`);
    }
    assert.match(output, /0 failures/, `suite must report zero failures:\n${output}`);
    console.log('  ' + output.trim().split('\n').pop());
  },
);
