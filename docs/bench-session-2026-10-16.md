# Bench session log — 2026-10-16

Companion to `docs/4.4.0-hardware-validation-checklist.md` (parts A–D passed).
Firmware branch: `firmware-release-pipeline` @ `184eebc`. All fixes below are committed and pushed.

## Findings closed today

1. **Post-flash stuck No-USB page — FIXED AND VERIFIED (bench 2026-10-17).**
   - Round 1 (`184eebc`): detach-until-descriptor-complete boot order (host could
     otherwise lock in a CDC-only enumeration during the LittleFS/settings window).
   - Round 2 (`f4082b5`): the fix was flashed and sha-verified, yet the wedge recurred
     once — host completed SET_CONFIGURATION (CDC serial alive; `tud_mounted()` is
     `cfg_num != 0` in this stack) while `hidReady` stayed 0 all boot. Fix:
     self-healing re-enumeration in `usbCheckConnection` (3 s not-ready → detach →
     100 ms → attach, max 3 per episode) plus `USB-EVT: configured/unconfigured`
     witness hooks. Note: those witness lines fire ~1 s post-boot, before the app
     opens the port, so they never appear in normal session logs — they remain armed
     for mid-session episodes.
   - Verified 2026-10-17: two 4.1.0→4.5.0 flash cycles plus a 4.5.0→4.1.0→4.5.0
     round trip — every 4.5.0 post-flash boot came up healthy with settings
     restore completing normally. CLOSED.

2. **Mode lock — CONFIRMED WORKING (bench 2026-10-16 19:54).** `LK,1:1` applied, Hub
   remote walk refused the locked mode rows. Remaining note: the app's remote hub
   control has no read-back of the Hub's menu position, so a refused select (LK on)
   desyncs the remote's assumed menu from the real one — "drift" is expected remote-model
   behavior, not a firmware defect. Possible future UX fix: a menu-state query or
   re-sync after refusal. Not a 4.5.0 blocker.

3. **S1 (Next) button — HARDWARE FAULT (bench 2026-10-17).** Dead on BOTH 4.1.0 and
   4.5.0 with the live view (DM,1:3) open: no mainState reaction to S1 presses on
   either firmware, while S2 works. Two independent firmwares sharing only the pin
   definition read the same deadness — the S1 switch circuit is open on this unit
   (switch, ribbon conductor, or solder joint), not a firmware defect. Stuck-PRESSED
   is ruled out (the S1+S2 combo would fire START_MENU; it doesn't). Bench next:
   reseat the hub-to-main ribbon cable, then continuity-test the S1 switch pads
   (pressed vs. released) and compare with S2's line; report to MMC as a unit-level
   hardware finding — exactly what this validation pass is for. 4.1.0's own
   debug-mode fragility (device lost during DM,1:3, recovered on replug — the
   known #75 cluster) is unrelated but worth avoiding on 4.1.0.

## Remaining work

1. ~~Post-flash stuck boot~~ CLOSED (verified 2026-10-17 across multiple flash cycles).
2. S1 hardware follow-up on the bench unit: ribbon reseat + continuity test; report to MMC.
3. Checklist: ~~E1–E5~~ PASSED 2026-10-17 (E3 via the new raw-command console, app 1c2b7bc —
   all 31 dump values matched the load, no identifier in the dump; WM,1:10000 exercised and
   restored). Remaining: E6 (BT + gamepad), E7 (4.1.0 app honesty), H (switch remapping,
   including the 4.5.0→4.5.0 re-flash), F (flaky-sensor repro), G (Android/OTG).
4. Release: tag V4.5.0, guide PDFs, post `docs/upstream-issue-comments.md`, include the
   S1 hardware finding and the enumeration self-heal in the release notes.

## Open follow-ups

- `ERROR: No free timers` (rapid health checks) and `ERROR: No timers are in use`
  (LSTimer prints colliding mid-response during LK remote walk) — LSTimer pool hygiene,
  cosmetic, unfixed.
- One `Pressure sensors not responding` transient after watchdog recovery — checklist Part F (flaky-bus repro) still pending.
- Checklist parts E (regression sweep) and G (Android/OTG) not yet run.
- `WM,1:10000` (5-digit window) never exercised on hardware.
- Settings file ~383 B vs 4.1.0's 512-byte reader — ~130 B headroom, future hazard.
- LK remote-control drift — app-side menu-state model, future UX (see finding 2).

## Open follow-ups

- `ERROR: No free timers` (LSTimer pool, rapid health checks) — likely benign, unfixed.
- One `Pressure sensors not responding` transient after watchdog recovery — checklist Part F (flaky-bus repro) still pending.
- Checklist parts E (regression sweep) and G (Android/OTG) not yet run.
- `WM,1:10000` (5-digit window) never exercised on hardware.
- Settings file ~383 B vs 4.1.0's 512-byte reader — ~130 B headroom, future hazard.

## Build/flash quick reference

- Build: `cd /Users/hamoudi/LipSync_Connect && FIRMWARE_REPO=/Users/hamoudi/LipSync sh dev/firmware/build-firmware.sh` → `dev/firmware/dist/` (UF2, hex, dfu zip + manifest).
- Flash from app: red Update button (local manifest) or "Flash local file…".
- Gates: `npm --prefix dev run lint / lint:css / lint:html / format:check / typecheck`; `npm --prefix dev test`; `E2E_PORT=4599 npm --prefix dev run test:e2e`; `node dev/firmware/protocol-cross-check.mjs` (all green at `184eebc`).
- Firmware 4.1.0 quirks (expected, not bugs): post-flash frozen "Restarting", unbounded HID spin → watchdog → safe mode (`#75`), `AV/LM` writes `FAIL,3`, no restrictions/windows endpoints.
