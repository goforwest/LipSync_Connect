# LipSync improvement roadmap — upstream issue map

Grew out of the 4.2.0 serial & robustness work (2026-10-13). On
2026-10-13 all 70 issues of
[makersmakingchange/LipSync](https://github.com/makersmakingchange/LipSync/issues)
were scanned; every open issue now maps to a disposition below — fixed in
firmware 4.2.0, a numbered roadmap item, or an explicit backlog. This is
the working plan for closing the upstream list.

Context in one line: the original "~30 s settings load" was a 1000 ms
idle-framing timeout (fixed at the Wire/parser level, now ~92 ms full load);
the follow-on "everything times out" chaos was a reversed interface cable
dragging the shared I2C bus (upstream #73's failure class), which the
firmware now self-defends against on every consumer.

**2026-10-14 pass (firmware 4.3.0 + app):** the easy-mid items landed —
items 3, 4, 5, 6, 9, 13, 14 and the audio half of 16 are done (each carries
a Done note); upstream #36, #63, #67 and the audio half of #61 are
close-pending hardware validation.

**2026-10-14 round 2 (firmware 4.4.0 + app):** item 11 (the restrictions
family — #21/#44/#68/#77) is done pending its hardware session, the serial
`EX,0:0` settings dump closed item 13's residual, and the firmware-update
doc's "why does fresh CDC drop its first writes" investigation closed at
the root (the USB-HID report paths no longer block the main loop; see the
update doc's item 2). Open with the most value next: item 15 (input timing
& accessibility) and the docs backlog.

## Upstream issue map — open issues (42)

Dispositions reflect the 2026-10-14 pass (firmware 4.3.0 + app): items
marked ✅ are code-complete pending the 4.3.0 hardware validation session.

| # | Title (short) | Disposition |
|---|---|---|
| 87 | Easier mouthpiece replacement | docs backlog |
| 86 | Cursor acceleration | ✅ item 9 done in 4.3.0 (feel validation pending, then closeable) |
| 85 | ESP32 feasibility evaluation | research |
| 84 | Screw clearance hole diameter | mechanical |
| 83 | Static shock killed hub | **item 10** |
| 82 | Update error codes in User Guide | docs backlog |
| 80 | Clean up unused branches | docs backlog (chore; 48 remote branches counted 2026-10-14) |
| 79 | Maker Guide: programming issues | docs backlog |
| 78 | Space in file path breaks compile | docs backlog (upstream Seeed core limit; CI unaffected) |
| 77 | Sip-and-puff menu lockout | ✅ item 11 done in 4.4.0 (MA restriction; closeable after hardware validation) |
| 76 | Mouthpiece cleaning/replacement docs | docs backlog |
| 75 | Watchdog activates after factory reset | ✅ fixed in 4.2.0 (see community notes) |
| 74 | LipSync changing mode by itself | **item 12** (likely fixed by 4.2.0; verify on hardware) |
| 73 | Wrong/reversed interface cable → error lights, stuck boot | ✅ 4.2.0 survives it; **item 7** fixes at source |
| 72 | Mouse flipped — joystick orientation docs | docs backlog |
| 71 | Sip/puff swapped — host left-handed note | docs backlog |
| 70 | Print issues on middle-housing threads | mechanical |
| 69 | Mounting-part filename length | mechanical |
| 68 | Lock out unwanted mode changes | ✅ item 11 done in 4.4.0 (LK mode lock; closeable after hardware validation) |
| 67 | Easy way to share device settings | ✅ item 13 done in the app 2026-10-14 ("Export settings") + the serial EX,0:0 dump in the firmware — closeable |
| 65 | Magnetometer orientation in Maker Guide | docs backlog |
| 64 | Faulty-sensor troubleshooting in Maker Guide | docs backlog (pairs with ✅ **item 3** — the BH endpoint landed in 4.3.0) |
| 63 | USB error message persists after reboot | ✅ amplifier in 4.2.0 + residual (item 14b) in 4.3.0 — closeable |
| 62 | Adjustable input time thresholds | ✅ item 15 done in 4.4.0 (WS/WL/WM windows; closeable after hardware validation) |
| 61 | Audio cue for scroll/drag mode | ✅ item 16 audio half done in 4.3.0 ("All" tier; validate, then closeable) |
| 59 | Reversed RJ11 interface cable wiring | **item 10** (cable hardening) |
| 58 | Hard sip / hard puff inputs | **item 15** — blocked on feel validation with affected users (see item 15's note) |
| 56 | "Python not found" compile error | docs backlog (upstream core; workaround known) |
| 54 | Mechanical drift / center hysteresis | **item 17** |
| 44 | Toggle cursor movement during sip/puff | ✅ item 11 done in 4.4.0 (CF cursor hold; closeable after hardware validation) |
| 43 | LED feedback keyed to input state, not action | ✅ item 16 done: audio in 4.3.0, LED in 4.4.0 as the opt-in LM=3 tier (closeable after the hardware validation it ships for) |
| 37 | TLV493D library deprecated | ✅ item 1 done in 4.4.0 (bounded vendored fork; item 2's XENSIV migration is the deliberate follow-up) |
| 36 | Menu stays open after serial-API calibration | ✅ item 14a done in 4.3.0 — closeable |
| 33 | Debug mode documentation incomplete | docs backlog |
| 26 | Labels on bottom of Hub PCB | docs backlog (PCB rev) |
| 24 | Sled component print failure | mechanical |
| 22 | Sip/puff threshold levels UX | ✅ item 15 done in 4.4.0 (10-level Hub-menu scale; closeable after hardware validation) |
| 21 | Ability to disable sip and puff | ✅ item 11 done in 4.4.0 (SD; the Hub menu/API/app all expose it; closeable after hardware validation) |
| 20 | Switches as independent inputs | **item 11 residual** — the restrictions family landed; the remap table is the remaining half |
| 19 | Unreliable STEMMA-Dupont connection | **item 10** |
| 16 | Switch between multiple Bluetooth devices | research |
| 15 | Hub slides around (feet/velcro) | mechanical |
| 9 | Very long sips/puffs impossible for some users | ✅ mostly item 15: adjustable windows shrink every hold; hard inputs (#58) remain for the rest |

### Closed issues — verified history

The remaining 28 are closed; spot-checks against the release history hold
up: #46 (deadzone output jump) and #34 (calibration confirm page + error
checking) shipped in the 4.1.0 deadzone/calibration rework; #45 (scroll
level) is the 4.1.0 hub-menu scroll setting; #23 (unintended auto-Bluetooth)
was the 4.1.0 "no USB auto mode switch" fix; #40 is the LSTimer offset fix;
#35 (menu access API) is the `CH,1:n` endpoint the app's Hub-menu remote
uses; #41 is the both-hub-buttons-at-boot safe mode (note: 4.2.0 arms the
watchdog in safe mode too, but bootloader-based uploads are unaffected —
the WDT only starts at the end of app setup). #28's "detect joystick sensor
connection issues + meaningful error on screen" is effectively completed by
4.2.0's sensor-health gating and safe-mode pages. #13/#17/#18 (compiler
warnings) predate the pinned core; the build compiles clean but with the
core's warnings suppressed — a zero-warning pass with `-Wall` would be
cheap hygiene if ever desired.

## Roadmap items

Items 1–8 are the follow-ups from the 4.2.0 work itself; items 9–17 come
from the upstream scan. Ordered roughly by user-visible value within each
origin.

### Firmware & libraries (lipsync repo)

### 1. Vendor a bounded TLV493D library

**Problem.** The vendored (and upstream-deprecated, issue #37)
TLV493D-A1B6 library contains blocking constructs: `updateData()` in
POWERDOWNMODE does `setAccessMode(...)` followed by a `delay(getMeasurementDelay())`,
and its read paths contain register-ready waits with no bound. On a flaky
shared bus a single call can block for seconds — long enough that the JV
endpoint's on-demand `js.update()` reproducibly silenced the device past
the 30 s watchdog (fixed for JV by returning buffered values, but the
library itself remains a bounded-latency gap; today only the always-armed
watchdog catches it).

**Fix.** Follow the vendored-Wire pattern: fork
`TLV493D-A1B6-3DMagnetic-Sensor` into
`Build_Files/Firmware_Files/Libraries/`, bound the delay/waits (or make
`updateData()` return an error instead of blocking), pin it in the CI and
local builds via `--libraries`, and document the fork against the core
version as the Wire README does.

> **Done (2026-10-14).** `Libraries/TLV493D-A1B6/` is the vendored fork,
> pinned by the same `--libraries` flag as the patched Wire (the CI's
> zip-unpack step is gone with the zip — the build's dependency files
> confirm the vendored copy is the one compiled). The fork bounds the two
> blocking constructs on the 20 ms joystick-poll path: a failed wake-up
> write now returns `TLV493D_BUS_ERROR` immediately (the stock code
> delayed for a measurement that never started — the mechanism behind
> JV's old device-silencing freeze), and the measurement wait is clamped
> to `TLV493D_MAX_MEASUREMENT_DELAY_MS` (50 ms, ~5x the real ~10 ms
> master-controlled measurement, so healthy polling is unchanged; with
> the vendored Wire's transaction bound the whole call is worst-case
> bounded). The register model and API are untouched upstream, so item 2's
> XENSIV migration remains a port of `LSJoystick` with hardware
> validation, not of this fork.

### 2. Migrate to Infineon's XENSIV TLx493D library (upstream #37)

The maintained replacement for the deprecated library above. If undertaken,
it subsumes item 1: port `LSJoystick` to the XENSIV API and evaluate
whether its read path is non-blocking by construction (if not, the
vendoring rules from item 1 still apply).

### 3. Expose I2C bus health over the settings API

**Problem.** The 4.2.0 hunt produced exactly the telemetry that would have
diagnosed it in minutes — `Wire.busHealthy()`, `Wire.recoveryCount()`, the
pressure-sensor health flag, the display-health state — but none of it is
visible to the app; everything was diagnosed via behavior and custom
serial timing probes.

**Fix.** A read-only diagnostic endpoint (e.g. `BH,0:0` → bus recovery
count, per-device health, last recovery age) or extend the existing
pressure DEBUG stream with a bus-health mode. Mirror it in LipSync
Connect's Health check ("✗/✓ I2C bus"), which would have turned "screen is
black, is it the USB?" into a one-line answer. Pairs naturally with the
#64 Maker Guide troubleshooting item (see docs backlog).

> **Done (2026-10-14, firmware 4.3.0 + app):** `BH,0:0` answers
> `recoveries,busHealthy,display,pressure,joystick,ageSec` (per-device
> values: 0 = not detected, 1 = healthy, 2 = gated/backed-off; ageSec is
> −1 when the bus never wedged this boot). The app's health check grew a
> fifth "I2C bus" step, version-gated on 4.3.0 — older firmware reports
> the step as "needs firmware 4.3.0+" instead of failing. The #64 Maker
> Guide write-up is still open (docs backlog).

### 4. Restore `TwoWire::begin()`-style pin config after bus recovery

`wireRecoverBus()` reconfigures the SDA/SCL pins as GPIO for the NXP
9-clock bus-clear and re-attaches the TWIM, but leaves the SCL `PIN_CNF`
as GPIO-output rather than restoring the `begin()` configuration (input,
pull-up, open-drain). PSEL re-attachment gives the peripheral ownership so
this is functionally benign today, but restoring the `begin()`-equivalent
pin configuration after recovery is proper hygiene. Small, bounded change
in the vendored Wire.

> **Done (2026-10-14):** `wireRecoverBus()` now restores both PIN_CNF
> registers to the `begin()` configuration after the bus-clear; the vendored
> Wire README documents it.

### 5. Explicit API forward declarations in the headers

**Problem.** `LSScreen.h`, `LSJoystick.h` and `LSBuzzer.h` call functions
defined in `LSAPI.ino` (e.g. `getOperatingMode`) and rely on the Arduino
build's auto-generated prototypes for cross-tab resolution. That mechanism
is a shallow ctags parse of the merged `.ino` files and is fragile: a
`static` local variable inside any `.ino` function silently drops
prototype generation for the tabs that follow, failing the build with
"was not declared in this scope" errors inside the headers (diagnosed
empirically during 4.2.0; the comment on `LSJoystick::update()` documents
the dodge — put state in classes, not `.ino` statics).

**Fix.** A small `LSApiDeclarations.h` declaring the stable v4.x API
surface (`getOperatingMode`, `get/setCommunicationMode`, `get/setSoundMode`,
`setOperatingMode`, `softwareReset`, …), included by the headers that call
them (and early in the primary `.ino` for the boot-time calls). Removes
the auto-prototype dependency entirely; until then, the working rule is:
**no `static` locals in `.ino` functions — class members or plain locals
only.**

> **Done (2026-10-14, firmware 4.3.0):** `LSApiDeclarations.h` declares the
> whole serial API surface (both argument shapes of every endpoint), the
> cross-tab free functions the headers call (softwareReset, buzzerSoundOn/
> Off, the screen transition continuations) and the calibration timer
> callbacks; LSScreen.h, LSJoystick.h, LSBuzzer.h, LSAPI.ino and the
> primary .ino all include it. The `static`-local rule stays as folklore
> hygiene, but the build no longer depends on it.

### 9. Implement cursor acceleration (upstream #86)

**Problem.** Requested by multiple users: time- and/or deflection-based
cursor acceleration to manage the precision-vs-large-movement tradeoff —
host-side acceleration varies per device and affects other mice when
tuned for the LipSync.

**Fix.** The firmware already has the attachment points: the `AV,0`/`AV,1`
API endpoints exist as stubs (`getJoystickAcceleration` /
`setJoystickAcceleration` in `LSAPI.ino`, `initAcceleration()` commented
out in setup with "TODO Implement acceleration"). Implement a
deflection-or-time curve in the joystick output path, add a level setting
(hub menu + serial API + app card), and validate the feel with users.

> **Done (2026-10-14, firmware 4.3.0 + app) — feel validation still
> pending.** Deflection-based power curve in the mouse output path:
> `out = sign(v)·max·(|v|/max)^(1−level·0.1)`, level −10..10, default 0
> (bit-for-byte the old linear output); zero and full deflection are
> fixed points, so acceleration trades mid-range precision for speed,
> never top speed. Surfaces: Hub menu More → Acceleration, the AV
> endpoints (wired to the live global at last — the old
> `decreaseJoystickAcceleration` had an inverted comparison that made
> lowering the level a no-op), the app's Cursor card, and the update
> backup/restore set. Curve feel still needs validation with users on
> hardware before calling #86 closed.

### 12. Verify spontaneous mode changes are gone (upstream #74)

**Problem.** Two users reported hubs switching to gamepad mode by
themselves. Likely mechanism: phantom sip/puff actions from a flaky
pressure sensor navigating the hub menu (long puff opens the menu, further
phantoms move/select it).

**Fix/verify.** 4.2.0's sensor-health gating already prevents phantom
sip/puff from an unhealthy sensor (stale data can never fire actions), so
this may already be fixed in the field — but it should be verified
deliberately: reproduce with a flaky sensor against 4.2.0, and if it
recurs, add input diagnostics (log the sap buffer around mode changes —
item 3's telemetry makes this cheap). The item-11 restrictions feature
also mitigates the user impact directly.

### 14. Screen-state correctness after asynchronous flows (upstream #36, #63 residual)

**Problem.** Two UX state bugs of the same shape — the screen showing
something stale after an async flow: (a) after a serial-API-triggered full
calibration the hub menu stays open and cannot time out or be navigated
(#36); (b) after a USB reconnect the "No USB" error page lingers even
though the device works normally (#63 — 4.2.0 already fixed the amplifier,
the every-2-s full framebuffer redraw, but the page still isn't cleared on
recovery).

**Fix.** (a) App-triggered calibration should deactivate the menu when
the calibration flow finishes (the 4.2.0 scheduled-transition machinery
in `LSScreen` is the natural place). (b) The `usbCheckConnection` healthy
branch should redraw the default screen once when the latch resets
(`screen.resetUsbErrorPage()` already exists — add the redraw next to it).

> **Done (2026-10-14, firmware 4.3.0).** (a) `setJoystickCalibration`
> tells the screen when the run is API-originated
> (`calibrationEndsByClosingMenu(apiEnabled)`), and `returnToMenu()` —
> the scheduled end-of-calibration continuation — closes the menu instead
> of parking it on the main menu. (b) `resetUsbErrorPage()` now draws the
> ready screen once when an error episode actually painted something and
> no menu owns the display.

### 15. Input timing & accessibility cluster (upstream #9, #22, #58, #62)

The biggest user-value cluster: input timing is hardcoded and rigid.

- **Adjustable time thresholds** (#62): short/long/very-long input windows
  live as constants in `LSConfig.h` — make them settings (serial API +
  hub menu + app), e.g. a user wants drag mode at 500 ms instead of 1000 ms.
- **Hard sip / hard puff** (#58): additional short, sharp inputs — separate
  thresholds plus sap state-machine changes — giving users who cannot
  sustain 3 s sips (#9) an alternative route to the menu and actions.
- **Threshold levels UX** (#22): the hPa thresholds are adjustable in fine
  increments today; a coarse level scale (e.g. 10 levels) would make the
  hub-menu path practical.

> **Two-thirds done (2026-10-14, firmware 4.4.0 + app) — #62, #22 and so
> #9's shorter-route half.** The short/long/very-long window boundaries
> (0-1 s / 1-3 s / 3-8 s, hardcoded since v1) are now settings: `WS`, `WL`,
> `WM` over the serial API (stored 0 = the compiled default, which is what
> an older settings file reads for the missing keys, so an update keeps the
> factory feel), each validated to keep short < long < max, applied at the
> single seam every action row is matched against (`effectiveWindowMs()`
> maps a row's compiled boundary onto the user's windows). The Hub menu
> gets Sip & Puff → Timing (one page per window, 250 ms steps), and the
> sip/puff threshold pages now step a coarse 10-level scale
> (2/3/4/5/7/10/15/22/32/45 hPa) instead of ±1 hPa — closing the old
> "TODO: CHANGE THIS" stepping note — while the serial API and the app
> keep fine hPa granularity. The app's Sip & Puff card grows three
> window inputs (version-gated on 4.4.0+ like the restrictions; older
> firmware shows them as unavailable, never as failures) with
> client-side range + ordering validation, MANUAL sync from the Hub
> menu, snapshot/restore round-trip and export coverage.
>
> **Open: #58 hard sip / hard puff — blocked on feel validation, by
> design.** The mechanical half is clear (peak-pressure tracking per sap
> episode in `LSPressure::updateState`, a hard-sip/hard-puff threshold
> pair, and a post-release classification that can route to its own
> action rows), but *which actions* hard inputs trigger is an accessibility
> decision that must be made with affected users — the whole point (#9)
> is an alternative route to "the menu and actions", and inventing the
> mapping offline risks shipping the wrong gesture language to people who
> cannot relearn it. The 4.4.0 hardware session should trial candidate
> mappings (e.g. hard puff → menu, hard sip → drag exit) with a user
> before the state-machine change lands.

### 16. Feedback cues keyed to input state (upstream #43, #61)

- **LED**: indicate input-state transitions (long → very long) rather
  than the mapped output action, since actions are not one-to-one with
  inputs (#43).
- **Audio**: optional sounds when scroll mode / drag mode engage (#61) —
  the 4.2.0 non-blocking buzzer note queue makes this a small, safe
  addition.

> **Done (2026-10-14).** The audio half shipped in 4.3.0:
> `buzzer.modeEngageTone()` plays one short cue when scroll or drag
> engages (scroll chirps higher than drag so the two are distinguishable
> by ear), gated to the "All" sound tier so "Basic" users hear nothing
  new.
>
> **Done (2026-10-14, firmware 4.4.0) — the LED half, as an opt-in
  tier.** Re-keying the default would have changed semantics for every
  existing user, so the input-state feedback ships as light mode tier 3
  (LM=3): while any input is held the LEDs show the window — green in
  the short window, yellow after crossing into the long, red in the
  very-long — and on release they return to default instead of blinking
  the action; the window was the message. Existing tiers behave exactly
  as before, restricted inputs still show nothing, and the app's
  light-feedback select offers "Input state (4.4.0+)" so a caregiver
  can flip it on the bench. **Validation with affected users — the
  point of the deferral — belongs to the 4.4.0 hardware session; if it
  lands well, #43 closes with the tier documented in the User Guide.**

### 17. Mechanical drift investigation (upstream #54)

One-directional drift after small mouthpiece deflections with large
center-position hysteresis, not fixed by calibration or deadzone increases.
Primarily a mechanical inspection (gimbal, bearings, magnet seating —
see the issue's analysis), but firmware can mitigate: median-of-N center
sampling and a hysteresis-aware center acceptance during center reset
and full calibration. Needs a affected unit to iterate against.

### App (LipSync_Connect)

### 6. Protocol v2 — send newline-terminated commands (deferred deliberately)

Firmware 4.2.0+ frames newline-terminated messages instantly; legacy bare
writes keep the 50 ms idle-gap frame. The app deliberately still sends bare
writes so a single app build works against old LipSyncs in the field (stock
4.1 rejects trailing newlines on every comparison). When a "protocol v2"
release is opportune: append `'\n'` in `sendRaw()` (one line,
`app/js/serial/commands.js`), update the README's "hand-tuned against v4.1"
note, and exchanges drop from ~50 ms to ~2 ms (a full load lands under
200 ms). Backward compatibility can be preserved by feature-detecting —
or shipped version-gated, as the DFU protocol already is.

> **Done (2026-10-14) — shipped version-gated, exactly as the DFU protocol
> is.** `noteDeviceVersion()` (fed by the VN renderer) flips
> `sendRaw()` to newline-terminated writes once the connected device has
> identified as 4.2.0+; `connect()` resets the flag so a 4.2 device
> followed by a 4.1 device can never leak v2 framing, and unparsable
> versions stay bare. The first exchange or two of a session is bare
> (before VN lands), which every firmware accepts. README updated.
> A full load against 4.3.0 hardware should now land well under a
> second — worth confirming on the bench.

### 13. Settings snapshot export (upstream #67)

**Problem.** Sharing a device's configuration for troubleshooting today
means walking the Serial API endpoint by endpoint.

**Fix.** The app already loads all 17 settings on connect — add an
"Export settings" action (JSON or the app's share sheet) next to the
existing log export. Far simpler than the issue's USB-keyboard-output
idea, and it lands in the tool users already have open during support.
Optionally pair with a serial `EXPORT`-style dump command for
non-app contexts.

> **Done (2026-10-14).** "Export settings" in the Device Information card
> downloads a labeled JSON snapshot (`services/settings-export.js`):
> every loaded value under its human key, values that did not load listed
> under `notLoaded` (so "off" can never be confused with "never read"),
> and the device identifier left out entirely — the same privacy line the
> log export draws. The load now also reads AV, so the export covers all
> 18 endpoints.
>
> **Done (2026-10-14, firmware) — the serial `EXPORT` dump.** `EX,0:0`
> (LipSync repo, 4.4.0 line) replays every stored setting as the exact
> standard response lines the per-endpoint reads produce, framed by
> `SUCCESS,0:EX,0:BEGIN`/`END` — a maker with a serial monitor sends
> `SETTINGS` + `EX,0:0` and pastes the output into a support ticket; no
> app and no new format required. The device identifier is excluded
> (same privacy line); support asks for `ID,0:0` explicitly when needed.

### 11. Input & mode restriction settings (upstream #21, #44, #68, #77, #20)

**Problem.** Several users need the same thing from different angles:
guardrails against accidental input. Disabling sip-and-puff entirely (#21),
locking menu access to hub buttons only (#77), locking the operating mode
(#68 — accidental mode changes make the device "appear broken"), freezing
the cursor during sip/puff (#44), and independently mappable external
switches (#20).

**Fix.** One coherent settings family, exposed in all three surfaces
(hub menu, serial API, app cards): a "restrictions" block — sip/puff
enable, menu-access mode (all inputs / buttons only), mode lock,
cursor-during-sap toggle — plus a separate switch-mapping table for #20.
Firmware-side these are gates on the input evaluation path (the 4.2.0
health gating occupies the same seam), so one PR can carry the
plumbing and each toggle can land incrementally.

> **Done (2026-10-14, firmware 4.4.0 + app) — the restrictions family.**
> Four boolean settings, all defaulting to the unrestricted legacy
> behavior (a settings file written by older firmware reads 0 for the
> missing keys, so an update can never silently lock a device down):
> `SD` disables sip & puff entirely (the pressure state machine and its
> diagnostics keep running — a gated input produces no action, no LED,
> no cue, no trace), `MA` restricts menu open/close/navigation to the
> hub buttons, `LK` locks the operating mode against every input path —
> the Hub menu's Mode page refuses with a short error cue while the
> serial API stays open on purpose, so a caregiver can always adjust the
> device through LipSync Connect — and `CF` freezes the cursor while a
> mouthpiece input is in progress. The gates live at one seam every
> resolved input action passes through (`applyInputRestrictions`,
> called from `evaluateOutputAction`, which now knows which physical
> input a state came from), and a drag/scroll engaged before a
> restriction was applied still releases cleanly. Surfaces: the serial
> API (SD/MA/LK/CF get+set), the Hub menu (More → Restrictions, one
> state-bearing line per toggle), the EX,0:0 dump, factory-reset
> defaults, and the app's version-gated Input-restrictions card —
> pre-4.4.0 firmware reports the card as "needs firmware 4.4.0+"
> instead of failing four loads, the update snapshot/restore round-trips
> the toggles when the connected device has them, and the settings
> export carries them as booleans. **Open:** #20's independent
> switch-mapping table (the doc's deliberately separate follow-up —
> the three switch jacks already have distinct default mappings; what
> #20 wants is user-remappability, which is a mapping-table settings
> surface of its own). **Hardware validation:** the 4.4.0 session
> should confirm each toggle's feel on the bench (especially CF's
> freeze window) before closing #21/#44/#68/#77 upstream.

### Hardware (hub redesign / PCB backlog)

### 7. Polarized/keyed interface connector

The root cause of the entire flaky-bus saga was a reversible interface
cable plugged backwards — crossing I2C lines, wedging the bus, blacking
the screen and confusing sensor detection (upstream #73 documents the
class). A connector that cannot be reversed (keyed housing, different
connector families per end, or a silkscreen + asymmetric key) eliminates
the failure class at the source.

### 10. Interconnect & ESD hardening (upstream #19, #59, #83 + extends item 7)

The field data clusters around the physical link between hub and joystick:
reversed RJ11/6P*C wiring shipped or assembled backwards (#59, #73), the
STEMMA-Dupont junction failing and behaving intermittently (#19; #25's fix
recommendation was to solder the wires directly to the RJ11 breakout), and
a static shock bricking a hub outright (#83 — blank display, LEDs on,
power cycling useless). Consolidate into one hardware hardening pass:
soldered (not Dupont) sensor connections, the keyed connector from item 7,
and ESD protection (TVS diodes) on the interface lines plus a grounding
review for low-humidity environments.

### Research (need a feasibility call before scheduling)

- **ESP32 hub** (upstream #85): platform migration evaluation; would
  revisit the Wire/Bluefruit assumptions 4.2.0 was built against.
- **Multi-device Bluetooth switching** (upstream #16): Bluefruit HID is
  single-connection; switching paired hosts from the hub needs a
  connection-management design above stock BLE HID.

## Documentation backlog (docs items — no firmware change)

One pass over the guides closes eleven upstream issues; the highest-value
entries first:

- **#64** faulty-sensor troubleshooting using the debug modes — write it
  against firmware 4.2.0's diagnostics (and item 3's health endpoint when
  it lands): how to read the pressure/joystick debug streams, what
  "sensor unhealthy" means, and what the safe-mode pages tell you. This
  issue would have answered this entire flaky-bus saga for a maker.
- **#79 + #56 + #78**: Maker Guide programming/troubleshooting — the
  python→python3 platform.txt workaround, the space-in-path Seeed core
  limitation, and the adafruit-nrfutil chmod fix (all three already have
  known solutions documented only in issues).
- **#71** sip/puff swapped → host left-handed-mode note; **#72** mouse
  flipped → joystick orientation; **#65** magnetometer orientation —
  three orientation troubleshooting notes.
- **#82** correct the error-code table in the User Guide; **#33** fix the
  debug-mode packet description (raw, filtered *and* output values).
- **#76 + #87** mouthpiece cleaning/replacement and filter sourcing.
- **#26** PCB labels for the RJ11 jack, microcontroller pads and I2C
  header (next PCB rev, pairs with item 10); **#80** branch cleanup.

## Mechanical / 3D-print backlog (no firmware change)

**#84** screw clearance holes → 6.4–6.5 mm; **#70** middle-housing thread
printing; **#69** mounting-part filename length; **#24** sled failure near
the outer bearing; **#15** rubber feet / hook-and-loop for the hub stand.

## Community / upstream

### 8. Comment on upstream issues with the 4.2.0 field data

- **#73** (wrong/damaged cable → generic error lights, hub stuck in boot):
  reproduced exactly — a reversed interface cable produced held-bus wedges,
  black screens and multi-second stalls; 4.2.0 survives it (bounded I2C,
  bus-health backoffs, display/joystick health gating) and self-recovers.
- **#75** (watchdog activates after factory reset, manual restart required):
  explained by the old watchdog policy — a WDT reset landed in watchdog-less
  safe mode, requiring the manual restart. 4.2.0's always-armed policy with
  the 3-strike GPREGRET2 budget self-recovers exactly this scenario.
- **#63** (USB connection error message persists after computer reboot):
  the retry loop's full-framebuffer redraw per 2 s tick was the amplifier;
  4.2.0 draws the page at most once per episode and only on an answerable
  bus (residual stale-page cleanup is item 14).
- **#37** (TLV493D library deprecated): tracked as items 1–2 above.

## Deliberately not "fixed" (recorded so nobody "fixes" them by accident)

- `playShutdownSound()` and `softwareReset()`'s 3 s pre-restart window are
  intentional blocking sequences — queued notes would be cut by the reset
  that follows (comment in `LSBuzzer.h`).
- `LSTest.ino`'s per-sound pacing `delay(1000)`s are the RT self-test's
  narration timing, read line-by-line by the app; they run inside the
  self-test's own locked flow.
