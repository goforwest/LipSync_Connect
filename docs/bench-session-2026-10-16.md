# Bench session log — 2026-10-16

Companion to `docs/4.4.0-hardware-validation-checklist.md` (parts A–D passed).
Firmware branch: `firmware-release-pipeline` @ `184eebc`. All fixes below are committed and pushed.

## Findings closed today

1. **Post-flash stuck No-USB page — fixed in three rounds, now with auto-restart (`438643c`).**
   - Round 1 (`184eebc`): detach-until-descriptor-complete boot order.
   - Round 2 (`f4082b5`): self-healing re-enumeration (3 × detach/attach) — healed two full
     round trips on 2026-10-17, E1–E7 all passed on it.
   - Round 3 (2026-10-17 evening, E7 round trip): a wedge survived all three forced
     re-enumerations — bus cycling alone cannot clear this host state, while a device
     restart has healed every instance. `438643c` grows the re-enum dark window to 500 ms
     and, when the budget is spent still HID-dead, performs ONE automatic NVIC restart
     (once-per-power-cycle guard in a `.noinit` magic word; healthy boots re-arm it).
     Post-flash worst case: ~20 s to a working device. **Verify on the next flash.**

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
3. Checklist: ~~Part E (E1–E7)~~ PASSED 2026-10-17 in full — E3 via the new
   raw-command console (app 1c2b7bc), E6 gamepad verified end-to-end through a Web
   Gamepad tester (OM,0:2; USB-serial alive alongside; macOS's Game Controllers
   pane doesn't list generic pads — host cosmetic) and BT mouse pairing/tracking,
   E7 old-firmware honesty on a 4.1.0 round trip; WM,1:10000 exercised and
   restored. Remaining: H (switch remapping, including the 4.5.0→4.5.0 re-flash),
   F (flaky-sensor repro), G (Android/OTG).
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
