# Bench session log — 2026-10-16

Companion to `docs/4.4.0-hardware-validation-checklist.md` (parts A–D passed).
Firmware branch: `firmware-release-pipeline` @ `184eebc`. All fixes below are committed and pushed.

## Findings closed today

1. **Post-flash stuck No-USB page — two rounds, now with self-healing (`f4082b5`).**
   - Round 1 (`184eebc`, flashed + sha-verified): boot-order race — host could enumerate
     during the LittleFS/settings window when only CDC was registered, locking in a
     CDC-only device. Fix: `setup()` detaches the bus before anything registers;
     `beginComOpMode()` attaches once the composite descriptor is complete.
   - Round 2 (second stuck capture, same build): STILL wedged. Decoded stack semantics:
     in this core `tud_mounted()` is `cfg_num != 0` — the host had genuinely completed
     SET_CONFIGURATION (CDC serial worked all boot) while `hidReady` stayed 0, attempts
     ~50/s, successes 0, until restart. Whatever the host's exact misstep (HID-less
     config or wedged interrupt endpoint), it never self-corrects.
   - Current fix (`f4082b5`): `usbCheckConnection` tracks the not-ready stretch and
     after 3 s forces a re-enumeration (detach → 100 ms → attach), max 3 per episode.
     A fresh enumeration rebuilds the host's config and TinyUSB's endpoint state, so a
     wedged boot should clear itself in ~8 s. Witness lines added: `USB-EVT:
     configured/unconfigured at <millis>` (`tud_mount_cb`/`tud_umount_cb`) plus a print
     per forced cycle and on recovery — the next exported log carries the host timeline.

2. **Mode lock — CONFIRMED WORKING (bench 2026-10-16 19:54).** `LK,1:1` applied, Hub
   remote walk refused the locked mode rows. Remaining note: the app's remote hub
   control has no read-back of the Hub's menu position, so a refused select (LK on)
   desyncs the remote's assumed menu from the real one — "drift" is expected remote-model
   behavior, not a firmware defect. Possible future UX fix: a menu-state query or
   re-sync after refusal. Not a 4.5.0 blocker.

3. **S1 (Next) button — under test, likely electrical.** DEBUG,3 live-view lines are
   consumed by the app's plotting panel and never appear in exported logs, so the
   log's silence during the DM,1:3 window proves nothing. The user reports no response
   to S1 in the live view. Discriminating test pending (below). Note: a stuck-PRESSED
   S1 is ruled out (S1+S2 combo would fire START_MENU; it doesn't).

## Verify fix (next bench session)

1. Flash 4.5.0 `f4082b5` (red Update button; dist rebuilt 13:45).
2. Post-flash boot: expect at most a brief No-USB page; the log should show
   `USB-EVT: configured at ~<early ms>` and, if the wedge recurs,
   `USB forced re-enumeration #N at <ms>` → `USB-EVT: configured at <ms>` →
   `USB recovered after forced re-enumeration #N`, with BH attempts=successes climbing.
   If the page STILL sticks with all three re-enumerations spent, export the log —
   the USB-EVT lines + BH tell the mechanism.
3. S1 discrimination (healthy boot, all restrictions off):
   - Open live view (DM,1:3), press S2 (Select) 3× as control — mainState must toggle
     in the panel. Then S1 3×. If S2 shows and S1 doesn't: electrical — check the hub
     ribbon cable seating and the switch itself; optionally flash 4.1.0 and repeat
     (dead S1 there too = hardware for certain).
   - If S1 DOES show in the panel but no right-click fires in mouse mode, it's the
     action path — send the log.
4. LK drift (finding 2): known remote-model limitation, no action for 4.5.0.

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
