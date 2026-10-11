# Firmware update — future improvements

Follow-ups identified during the hardware validation of the firmware-update
feature (2026-10-11). None are required for correctness today; they are
ordered by user-visible value. The motivating item is #1 — the Hub's screen
freezing on "Restarting" for the whole time the device sits in update mode.

## Firmware (lipsync repo)

### 1. Show a deliberate "Update mode" screen (or blank the OLED) before entering the bootloader

**Problem.** The stock XIAO bootloader never drives the Hub's OLED, so the
panel freezes on whatever the app firmware drew last. Via the SR-first
restart the frozen content is the SR/touch "Restarting" message, which then
stays on-screen until the flash completes and the app reboots — the device
looks stuck mid-restart while it is actually fine and waiting for the
flash.

**Fix.** In the app firmware's update-mode entry (the 1200-baud line-coding
handler that jumps to the bootloader — and, for symmetry, the path the
SR handler takes if it draws "Restarting"), draw a final frame before the
jump. Best: a static "Update mode — use the LipSync Connect app" splash
(the OLED keeps it unpowered-fresh until the next app boot). Minimal
alternative: send the display an OFF/clear command so the screen goes
truly dark.

**Afterwards (app side).** The wizard's hint copy currently says the screen
"goes dark **or stays frozen on its last message (you may still see
'Restarting')** — that is normal". Once the firmware ships this, tighten
the copy in `app/js/services/firmware-update.js` (three hint strings plus
the cancel-while-restarting message) back to the simple truth.

### 2. Post-flash serial silence on the first restore writes

**Problem.** Immediately after a flash, the first one or two settings
writes over the restored session can time out on hardware (observed: SS
and SL "Timed out waiting for device response" right after reconnect,
succeeding only on the re-armed retry pass).

**Fix.** Either investigate in firmware why the first CDC writes after a
settings-save reboot are dropped, or — as a cheap app-side mitigation —
settle ~1–2 s after the settings load completes before starting the
restore writes in `finishPendingUpdate`. Today the re-arm machinery makes
this self-healing but slow (one extra reconnect).

## App (LipSync_Connect)

### 3. Persist the "stranded in update mode" hint across page reloads

The Recover button is revealed by the connect guard (and by the wizard's
own post-START failure/cancel paths). A page reload loses the marker, so a
user who reloads must Connect (and pick the bootloader port) once before
Recover reappears. Persisting a "device likely stranded" flag in
sessionStorage — cleared on the next successful settings load — would keep
Recover reachable immediately after a reload.

### 4. Quiet the 30 s idle watchdog while the wizard is showing

"No data received for 30s… this is normal when the device is idle" fires
while the user is reading the update prompt mid-wizard. Harmless, but it
interrupts the flow's own messaging. Suppress the advisory while a firmware
wizard panel is active.

### 5. One-shot probe retry in the picker path

Rare (pre-SR-flow logs): the first DFU probe against a freshly entered
bootloader sometimes goes unanswered and the flow reports "did not respond
as an update loader". The avoid-port fix now routes retries through the
real picker, which self-heals — but a single probe re-send before declaring
failure would smooth the first-ever-update experience. With SR-first now
handling the common path, this only affects recovery / manual-double-reset
flows.

### 6. Android/OTG hardware validation

The WebUSB CDC shim path (Connect + the full flash) is simulator-proven
only. One hardware session with a V4 XIAO over OTG remains the last
unvalidated surface of the feature (the connect-shim filter fix #F8 and the
per-device open serialization #F6 in particular).

## CI (lipsync repo)

### 7. Dry-run the release pipeline before trusting it

`firmware-release-pipeline` has never run on upstream infrastructure. In a
scratch fork: run `workflow_dispatch` once end-to-end, then push two rapid
`V*` tags to exercise the new firmware-binaries race guard (an older build
finishing last must leave the newer artifacts intact).

### 8. uf2conv pin maintenance

The workflow fetches `uf2conv.py`/`uf2families.json` at the exact
microsoft/uf2 revision the app repo vendored byte-identical
(`90e9741…`). If either side is ever refreshed, refresh both in the same
change (the workflow comment says so; this note is the reminder with
teeth).
