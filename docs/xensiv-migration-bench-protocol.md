# XENSIV TLx493D migration — bench validation protocol

Companion to upstream issue #37 (the TLV493D library is deprecated; 4.4.0
vendored a *bounded fork*, and the successor migration was deliberately
deferred because it touches the live joystick read path). This is the
hand-off protocol for the `xensiv-tlx493d-migration` firmware branch — **do
not merge until every step below passes on hardware**.

## What changed (and what deliberately did not)

- Firmware branch: `xensiv-tlx493d-migration` (off `firmware-release-pipeline`
  @ `3e7cc88`, includes the 4.5.1 follow-ups).
- `LSJoystick` now reads the TLV493D-A1B6 through Infineon's XENSIV TLx493D
  library (vendored at `Build_Files/Firmware_Files/Libraries/xensiv-tlx493d`,
  unmodified upstream v1.1.2, provenance and the boundedness audit in its
  `LIPSYNC.md`).
- Read-path shape: the old fork's per-poll POWERDOWN cycle (wake write →
  bounded measurement wait → read → sleep write) is replaced by XENSIV's
  A1B6 default — **master-controlled continuous measurement**: one bounded
  I2C read per poll, no waits, no mode writes. Every transaction still flows
  through the vendored Wire (50 ms per-transaction bound, wedge recovery,
  busHealthy hold-off).
- Value scale verified identical in source (0.098 mT/LSB in both libraries,
  same 12-bit concat model) — the bench parity steps below confirm it on
  silicon.
- `getZ()` is preserved (the magnet-direction latch and the deferred-FAULT
  re-derivation now take Z from the same register snapshot as X/Y — same
  data, one transaction).
- The self-measuring bus-crawl backoff in `LSJoystick::update()` is
  untouched and must keep working.
- The old `TLV493D-A1B6` fork stays in the Libraries folder untouched (the
  sketch no longer includes it, so it is out of the build graph) until this
  protocol passes; the revert is then a one-line include flip.
- Build delta to know about: ~+29 KB flash / ~+3.5 KB RAM (the XENSIV core
  is the whole TLx493D family; its gen-2/3 tables link in through
  `tlx493d_init`'s switch). Headroom is fine (38% flash, 14% RAM).

## Protocol

### 0. Baseline (on `firmware-release-pipeline` @ `3e7cc88`, before flashing the branch)

1. Connect with LipSync Connect; run the health check (all five steps green).
2. Capture `JV,0:0` with the stick at rest — note raw x/y (the app's Joystick
   live view shows them). Repeat with the stick held in each of the four
   corners.
3. Run a full 4-corner calibration on the baseline firmware FIRST (so
   calibration data exists for the parity comparison).
4. BLE-mode current (if a bench meter is available): note idle current over
   60 s — the sensor's power mode changed (power-down between reads →
   continuous measurement), so this protocol must sign off the battery
   budget, not just the cursor.

### 1. Flash and boot

5. Flash the `xensiv-tlx493d-migration` build (manifest in
   `dev/firmware/dist/`, version 4.5.1, same version string as the baseline —
   distinguish by the build timestamp/sha, or flash via "Flash local file…").
6. Boot must be clean: no safe-mode page, no `Pressure sensors not responding`,
   health check green. A garbage-ACKing or dead sensor here means the XENSIV
   init/config writes disagreed with the part — stop and capture the log.

### 2. Raw-value parity

7. `JV,0:0` at rest: raw x/y must match the baseline capture within noise
   (±1–2 LSB quanta ≈ ±0.2 mT). A sign flip or axis swap here means the
   concat/scale model differs — stop.
8. Hold the stick in each corner and repeat: raw, filtered, and output values
   must track the baseline (the app's Joystick live view + JV). The cursor
   must move in the same directions for the same physical deflections.

### 3. Calibration and cursor feel

9. Re-run the full 4-corner calibration on the branch build. It must
   complete all five steps and store the corners (CA,0:0 re-read shows them).
10. Center reset (IN,1:1) then drive the cursor: the FEEL is the acceptance
    criterion the unit tests cannot be — same responsiveness at speed level 5,
    same deadzone behavior, no stutter or lag at the 20 ms cadence.

### 4. Magnet-direction latch

11. `IN,0:0` neutral and the JV orientation must agree with baseline (the
    X/Y direction mapping derives from the Z latch). Then power-cycle the
    device 3 times: the latch must land on the same direction every boot
    (this exercises both the boot-time 5-sample path and the deferred-FAULT
    re-derivation, which now reads Z from the update snapshot).

### 5. Flaky-bus backoff (the regression this must not lose)

12. With the branch build running, partially unseat the interface cable (the
    same bench maneuver as the 4.5.0 sessions): expect the familiar ~1 s
    crawl then the hard backoff — `BH,0:0` shows joystick=2 (poll backed
    off), the cursor pauses, and recovery is immediate on re-seating with a
    green health check. The XENSIV read has no internal wait to misbehave,
    but the backoff must still fire on dragged-bus timings.

### 6. Power sign-off

13. BLE-mode idle current over 60 s vs. the step-4 baseline. Expect a small
    increase (the sensor now measures continuously, ~mA-scale sensor current
    vs µA-scale power-down between reads). Judgment call for the release: if
    the delta is material for the battery-life claims, ask for a
    powerdown-mode follow-up on the branch (the trade: reintroducing a
    wake-wait cycle) before merging.

## Pass / fail

- **All steps pass** → merge `xensiv-tlx493d-migration` into
  `firmware-release-pipeline`, then remove the old `TLV493D-A1B6` fork in the
  merge commit (its README says so itself), and close upstream #37's
  follow-up note.
- **Any step fails** → capture the serial log + JV/BH lines, revert the bench
  device to the release branch build, and file the failure against the
  branch; the old fork remains a one-line revert away.
