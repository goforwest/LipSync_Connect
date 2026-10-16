# Bench session log — 2026-10-16

Companion to `docs/4.4.0-hardware-validation-checklist.md` (parts A–D passed).
Firmware branch: `firmware-release-pipeline` @ `184eebc`. All fixes below are committed and pushed.

## Findings closed today

1. **Post-flash stuck No-USB page — ROOT CAUSE FOUND AND FIXED (`184eebc`).**
   The 4.1.0→4.5.0 flash left the host hunting for the port; the host enumerated the
   device mid-boot, between `Serial.begin()` (CDC registered) and `usbmouse.begin()`
   (HID registered, ~100+ ms later after LittleFS/settings load). It locked in a
   CDC-only device and never re-enumerated: serial worked, HID never mounted.
   Stuck-boot BH proof: `usbMounted=1, hidReady=0, hidTimedOut=1, attempts
   1454→2384, successes=0` while `lastInputX/Y` tracked real stick motion — the page
   was truthful. Fix: `setup()` calls `USBDevice.detach()` before anything
   registers; `beginComOpMode()` attaches once the composite descriptor is complete.
   Safe mode intentionally comes up CDC-only (serial recovery is the point).

2. **"Mode lock failed" — test error, not a bug.** The bench log shows `MA,1:1`
   (menu restricted to hub buttons) and `LK,0:0` throughout: the wrong restriction
   was toggled. **LK** ("Lock operating mode" in the app Restrictions card) is the
   mode lock. Re-test: set LK only → Hub Mode page → select a mode → expect the
   "Mode is locked" page with Back live → unset LK.

3. **"S1 dead" — explained by the stuck boot, needs one clean re-test.** S1's
   mouse-mode action (right-click) is a mouse HID report: with the HID interface
   down (finding 1) it was silently dropped, while sip navigation and S2 menu
   Select are display actions and kept working. Re-test on a healthy boot with all
   restrictions off: S1 short = right-click in mouse mode; S1 = Next in menus;
   S1+S2 held together ~1 s = open menu. If S1 is still dead with HID healthy,
   run `DM,1:3` (button live view) and check the S1 stream — then it's a pin/path
   issue, not this.

## Verify fix (next bench session)

1. Flash 4.1.0 (dfu zip from repo history) → connect → update to 4.5.0 `184eebc`
   via the red Update button.
2. Expect: brief No-USB page (truthful, host still enumerating) self-clears within
   ~10 s; `BH,0:0` then shows `usbReady=1, hidRetrying=0, timedOut=0`, attempts and
   successes climbing together.
3. Then the finding-2 and finding-3 re-tests above.

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
