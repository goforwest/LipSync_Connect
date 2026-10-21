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
doc's "why does fresh CDC drop its first writes" investigation closed at the
root (the USB-HID report paths no longer block the main loop; see the
update doc's item 2). Open with the most value next: item 15 (input timing
& accessibility) and the docs backlog.

**2026-10-15 fresh-eye round (app + firmware 4.5.0):** an independent
re-read of the list attacked what remained actionable and closed two
findings plus the #20 feature family. (1) The Hub-menu remote mirror
(`services/hub-remote.js`) still modeled the pre-4.3.0 OLED menu, so
driving a 4.4.0 device through the app's own Hub remote would desync every
Next/Select after the new rows; it now mirrors the 4.4.0 tree exactly —
More ▸ Acceleration (4.3.0+), More ▸ Restrictions with its state-bearing
toggle lines, Sip & Puff ▸ Timing with the 250 ms adjust pages (range and
short < long < max refusals included), the coarse 10-level threshold scale
with the firmware's exact level/label semantics (older firmware keeps its
real plain ±1 hPa steps — the mirror previously stepped ±0.25, which no
firmware ever did), and the Info page's display-only Version/ID rows — all
version-gated on the session's firmware. The level table now lives in the
app's constants and the protocol-cross-check verifies app ↔ firmware
equality (the checklist's C4 example was corrected to the code's real
semantics: from 3.50, up steps to 4.00/L3, down to 3.00/L2). (2) The
serial format validator accepted 1-4-digit and 6-digit parameters but not
5-digit, so `WM,1:10000` — the timing-window MAXIMUM the Hub menu can set —
was answered FAIL,0 on the wire; fixed in 4.5.0 and the cross-check now
verifies every plausible command line's length. (3) **Upstream #20, the
switch-remap table, shipped as firmware 4.5.0 + the app's Switches card**
(see item 11's note) — the fresh-eye judgment was that the ledger's
"feel-design decision before code" classification fit #58's new-gesture
question but not #20: the clinician's ask IS remappability, a settings
surface over the existing action vocabulary with byte-identical defaults,
so nothing ships that any user must relearn. (4) The load summary now counts
attempted settings, and the app's load grew to 31 tasks (18 base + 7
gated 4.4.0 + 6 gated 4.5.0).

**2026-10-20 housekeeping:** this file is the master ledger, renamed from
`firmware-4.2.0-future-improvements.md` (nothing referenced the old name).
The one-screen live state now lives in `docs/STATUS.md`, the folder index
in `docs/README.md`, and the 2023 scope/feature-list documents moved to
`docs/history/` — provenance, not current scope (their two "Not
Implemented" rows, rotation angle and tolerance values, are moot: no 4.x
serial endpoint exists for either; "tolerance" survives only as internal
firmware constants, one already flagged "no longer used?"). Firmware
state this pass: the branch holds untagged **4.5.4** (`0e393c1`, the
`CH,5` menu-state push — the remote's last one-way gap, shipped app-first
and already consumed by the app), built on 4.5.3's dual-channel LED
indicator (`424f3e9`), whose commit explicitly supersedes V4.5.2 as the
publish target; the newest tag remains V4.5.2, never published.

## Upstream issue map — open issues (43)

Dispositions reflect the 2026-10-20 state: the firmware branch holds
untagged 4.5.4 (V4.5.2 is the newest tag but was never published —
superseded as publish target per the 4.5.3 commit; see
`docs/STATUS.md`), and the 2026-10-16/17/18/19 bench sessions validated
checklist parts A-F. Items marked ✅ are shipped and (unless the row says
otherwise) hardware-verified; the closeable ones wait only on posting the
paste-ready drafts in `docs/upstream-issue-comments.md`.

| #   | Title (short)                                             | Disposition                                                                                                                                                                                                                                                                            |
| --- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 87  | Easier mouthpiece replacement                             | ✅ docs pass 2026-10-14 (replacement steps + consumable sourcing; mechanical redesign not asked)                                                                                                                                                                                       |
| 86  | Cursor acceleration                                       | ✅ done in 4.3.0; E1 feel verified on hardware (bench 2026-10-17) — closeable                                                                                                                                                                                                          |
| 85  | ESP32 feasibility evaluation                              | ✅ feasibility call written 2026-10-14 (roadmap Research section): feasible but a full platform migration — defer; three-spike gate if forced                                                                                                                                          |
| 84  | Screw clearance hole diameter                             | mechanical                                                                                                                                                                                                                                                                             |
| 83  | Static shock killed hub                                   | **item 10**                                                                                                                                                                                                                                                                            |
| 82  | Update error codes in User Guide                          | ✅ docs pass 2026-10-14 (bitfield rows corrected + explained)                                                                                                                                                                                                                          |
| 80  | Clean up unused branches                                  | docs backlog (chore; 48 remote branches counted 2026-10-14)                                                                                                                                                                                                                            |
| 79  | Maker Guide: programming issues                           | ✅ docs pass 2026-10-14                                                                                                                                                                                                                                                                |
| 78  | Space in file path breaks compile                         | ✅ docs pass 2026-10-14 (Seeed core limitation + remedy documented)                                                                                                                                                                                                                    |
| 77  | Sip-and-puff menu lockout                                 | ✅ item 11 done in 4.4.0; B2 verified on hardware — closeable                                                                                                                                                                                                                          |
| 76  | Mouthpiece cleaning/replacement docs                      | ✅ docs pass 2026-10-14 (hygiene, cleaning, BOM sourcing)                                                                                                                                                                                                                              |
| 75  | Watchdog activates after factory reset                    | ✅ fixed in 4.2.0; the 4.5.0 feed-from-live-loop fix broke the bench-reproduced safe-mode starved-feeder 30 s reset cycle — closeable                                                                                                                                                  |
| 74  | LipSync changing mode by itself                           | ✅ item 12 verified on hardware 2026-10-18 (checklist F: no spontaneous mode changes or menu walks through the flaky window; the boot-with-unseated-cable wedge is a documented known limitation, not a mode change) — closeable                                                       |
| 73  | Wrong/reversed interface cable → error lights, stuck boot | ✅ 4.2.0 survives it; degraded-boot behavior bench-verified on 4.5.0 (safe-mode page, no reset loop, full recovery); **item 7** (keyed connector) fixes at source — closeable                                                                                                          |
| 72  | Mouse flipped — joystick orientation docs                 | ✅ docs pass 2026-10-14 (User Guide troubleshooting + Maker Guide magnet step)                                                                                                                                                                                                         |
| 71  | Sip/puff swapped — host left-handed note                  | ✅ docs pass 2026-10-14 (troubleshooting entry)                                                                                                                                                                                                                                        |
| 70  | Print issues on middle-housing threads                    | mechanical                                                                                                                                                                                                                                                                             |
| 69  | Mounting-part filename length                             | mechanical                                                                                                                                                                                                                                                                             |
| 68  | Lock out unwanted mode changes                            | ✅ item 11 done in 4.4.0; B3 verified on hardware (bench 2026-10-16) and the LK remote-drift follow-up fixed + bench-confirmed in 4.5.1 (CH,0:0) — closeable                                                                                                                           |
| 67  | Easy way to share device settings                         | ✅ item 13 done in the app 2026-10-14 ("Export settings") + the serial EX,0:0 dump in the firmware — closeable                                                                                                                                                                         |
| 65  | Magnetometer orientation in Maker Guide                   | ✅ docs pass 2026-10-14 (step qualified; calibration's limits named)                                                                                                                                                                                                                   |
| 64  | Faulty-sensor troubleshooting in Maker Guide              | ✅ docs pass 2026-10-14 (PV/JV/DM/BH/EX write-up against 4.2.0+ diagnostics)                                                                                                                                                                                                           |
| 63  | USB error message persists after reboot                   | ✅ amplifier in 4.2.0 + stale-page in 4.3.0 + the bench-chased 4.5.0 USB-robustness round (dark bus at boot, bounded re-enumeration, one guarded auto-restart) — closeable                                                                                                             |
| 62  | Adjustable input time thresholds                          | ✅ item 15 done in 4.4.0; C1–C3 feel + validation verified on hardware — closeable                                                                                                                                                                                                     |
| 61  | Audio cue for scroll/drag mode                            | ✅ item 16 audio half done in 4.3.0; E-sweep verified on hardware — closeable                                                                                                                                                                                                          |
| 59  | Reversed RJ11 interface cable wiring                      | **item 10** (cable hardening)                                                                                                                                                                                                                                                          |
| 58  | Hard sip / hard puff inputs                               | **item 15** — blocked on feel validation with affected users (see item 15's note)                                                                                                                                                                                                      |
| 56  | "Python not found" compile error                          | docs backlog (upstream core; workaround known)                                                                                                                                                                                                                                         |
| 54  | Mechanical drift / center hysteresis                      | **item 17**                                                                                                                                                                                                                                                                            |
| 44  | Toggle cursor movement during sip/puff                    | ✅ item 11 done in 4.4.0 (CF cursor hold); B4 verified on hardware — closeable                                                                                                                                                                                                         |
| 43  | LED feedback keyed to input state, not action             | ✅ item 16 done: audio in 4.3.0, LED in 4.4.0 as the opt-in LM=3 tier, redesigned 4.5.3 as a dual-channel indicator (face-LED progress fill 1/2/3 + micro-LED window color) after the 2026-10-19 bench finding; D1/D3 verified, fill re-tested with the 4.5.3 build, with-users feel pass pending — closeable after that pass |
| 37  | TLV493D library deprecated                                | ✅ fully closed: the XENSIV TLx493D migration merged (firmware 9b947cc, 2026-10-18/19) and BENCH-VALIDATED — JV parity, four-corner calibration, z-latch, cursor feel, flaky-bus, battery trade closed as moot (no internal battery); the old TLV493D-A1B6 fork is removed — closeable |
| 36  | Menu stays open after serial-API calibration              | ✅ item 14a done in 4.3.0 — closeable                                                                                                                                                                                                                                                  |
| 33  | Debug mode documentation incomplete                       | ✅ docs pass 2026-10-14 (packets corrected; DEBUG,2's 4th value is the sensor offset)                                                                                                                                                                                                  |
| 26  | Labels on bottom of Hub PCB                               | docs backlog (PCB rev)                                                                                                                                                                                                                                                                 |
| 24  | Sled component print failure                              | mechanical                                                                                                                                                                                                                                                                             |
| 22  | Sip/puff threshold levels UX                              | ✅ item 15 done in 4.4.0 (10-level Hub-menu scale); C4 verified on hardware — closeable                                                                                                                                                                                                |
| 21  | Ability to disable sip and puff                           | ✅ item 11 done in 4.4.0 (SD; the Hub menu/API/app all expose it); B1 verified on hardware — closeable                                                                                                                                                                                 |
| 20  | Switches as independent inputs                            | ✅ done in 4.5.0 (item 11's remap follow-up); storage/wire/post-flash-restore bench-verified via the 4.5.0→4.5.0 flash; the physical-jack feel pass (checklist H) deferred for lack of populated-switch hardware — close after H or ship noting it                                     |
| 19  | Unreliable STEMMA-Dupont connection                       | **item 10**                                                                                                                                                                                                                                                                            |
| 16  | Switch between multiple Bluetooth devices                 | ✅ feasibility call written 2026-10-14 (roadmap Research section): buildable above Bluefruit; needs a multi-host bench spike                                                                                                                                                           |
| 15  | Hub slides around (feet/velcro)                           | mechanical                                                                                                                                                                                                                                                                             |
| 9   | Very long sips/puffs impossible for some users            | ✅ mostly item 15: adjustable windows shrink every hold (C1 feel verified on hardware); hard inputs (#58) remain for the rest                                                                                                                                                          |

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
> action rows), but _which actions_ hard inputs trigger is an accessibility
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
> new.
>
> **Done (2026-10-14, firmware 4.4.0) — the LED half, as an opt-in
> tier.** Re-keying the default would have changed semantics for every
> existing user, so the input-state feedback ships as light mode tier 3
> (LM=3): while any input is held the LEDs show the window — green in
> the short window, yellow after crossing into the long, red in the
> very-long — and on release they return to default instead of blinking
> the action; the window was the message. Existing tiers behave exactly
> as before, restricted inputs still show nothing, and the app's
> light-feedback select offers "Input state (4.4.0+)" so a caregiver
> can flip it on the bench.
>
> **Bench-verified (2026-10-19, checklist D1/D3) — and the bench finding
> redesigned the indicator (4.5.3).** The traffic light works live and
> follows the user's windows — but the colors render only on the micro
> LED next to the USB-C port, the Hub's single RGB LED; the three face
> LEDs are physically single-color, so LSOutput drives them by
> brightness alone and they glowed steady red through every window. The
> first bench user's honest read was "the LEDs are always red" — the
> window signal lived on the smallest LED on the device while the big
> face strip buried it. Their design call (2026-10-19): the face LEDs
> now FILL left → middle → right as the hold crosses each window
> boundary — 1 in the short window, 2 in the long, 3 in the very-long —
> a count being the one message single-color LEDs can carry
> unambiguously ("more lights = further into the hold"), while the micro
> LED keeps the window's color: two redundant channels — count for
> anyone who cannot distinguish colors or see the tiny LED, color for
> anyone who can. Shipped in 4.5.3; the app hint describes both channels.
> The with-users pass confirms the feel; #43 closes with the tier
> documented in the User Guide.

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
> export carries them as booleans. **Hardware validation:** the 4.4.0
> session should confirm each toggle's feel on the bench (especially CF's
> freeze window) before closing #21/#44/#68/#77 upstream.
>
> **Done (2026-10-15, firmware 4.5.0 + app) — #20's switch-remap table,
> the deliberate follow-up this doc named.** The mouse- and gamepad-mode
> action cells of the three switch jacks are now settings: `SA/SB/SC` =
> jacks 1/2/3 mouse mode, `GA/GB/GC` = gamepad mode, each endpoint
> covering its jack's three hold windows. The GET answers
> "short,long,max"; the SET takes 0 (compiled factory mapping) or
> 100000 + short*10000 + long*100 + max (the base keeps every non-reset
> value a 6-digit number, the only magnitude the serial format
> validator accepts), with every cell pinned to a caregiver-safe
> allowlist — calibration, menu navigation, software reset and factory
> reset excluded, so one accidental press of a remapped switch can never
> erase settings or restart the device. Menu/safe-mode columns and the
> S1+S3 combination row stay compiled (menu navigation is a fixed
> language), the 4.4.0 windows remain the routing, the 4.4.0
> restriction gates still apply to remapped actions, and stored 0 =
> compiled default (a settings file from older firmware keeps the
> factory mapping on update). Surfaces: the six endpoints (EX dump and
> factory-reset defaults included) and the app's 4.5.0-gated Switches
> card — the caregiver surface the clinician's issue asked for; the Hub
> menu deliberately does not grow a remap grid. The 2026-10-15
> fresh-eye round re-judged the ledger's "feel-design decision before
> code" block on this item: that classification fits #58 (inventing a
> new gesture language users must relearn) but not #20, whose ask is
> remappability itself over the existing vocabulary with
> byte-identical defaults. **Hardware validation:** a 4.5.0 session
> should confirm a remapped jack's feel per mode and window before
> closing #20 upstream (checklist part H).

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

### Research (feasibility calls, written 2026-10-14)

- **ESP32 hub** (upstream #85) — **feasible, but a full platform
  migration; defer until supply-chain pressure demands it.** What
  actually moves: every hardware-adjacent subsystem the 4.x line is
  built against. (1) The bounded vendored Wire is nRF52-TWIM-specific —
  an ESP32 port needs a new bounded driver (the ESP32's I2C timeout
  registers make bounding easier than the nRF52 event waits were).
  (2) USB: the XIAO's composite CDC+HID (settings API + mouse/gamepad
  over one cable) is Adafruit TinyUSB turnkey; on ESP32 only the S2/S3
  have native USB, and composite CDC+HID is possible through TinyUSB
  but not a turnkey core feature — it would need bring-up work.
  (3) The in-browser update flow is the highest-risk item: the whole
  app-side wizard (DFU zip packages, sha256-manifest pipeline, the
  1200-baud/UM bootloader entry, the stranded-recovery path) assumes the
  nRF52 serial-DFU bootloader. ESP Web Tools proves browser flashing of
  ESP32s over Web Serial is possible, but the wizard, artifact pipeline
  and recovery story would all be rebuilt. (4) Bluefruit HID → NimBLE
  HID; watchdog/GPREGRET boot-budget → Task-WDT + RTC memory semantics;
  LittleFS InternalFS → esp_littlefs (mechanical). Current headroom
  gives no pushing reason: 4.4.0 uses 33% of program flash and 11% of
  RAM. **Recommendation: do not schedule.** If it is ever forced (e.g.
  nRF52840 supply), start with a bring-up spike that validates exactly
  three things before any commitment: composite CDC+HID on S3,
  browser-based flashing with a recovery story, and a bounded I2C
  recovery driver.
- **Multi-device Bluetooth switching** (upstream #16) — **feasible
  above the Bluefruit layer; the hard part is host behavior, not BLE.**
  Stock Bluefruit HID keeps one bond and one connection. A switching
  design means: multiple stored bonds, a "disconnect and advertise"
  action surfaced in the Hub menu, and accepting whichever known host
  connects — all buildable with the existing Bluefruit bond API on the
  nRF52. The risk is host-side: central devices reconnect aggressively
  and differ in how they handle a peripheral that drops them (macOS,
  Windows, iOS and Android each have quirks), so the switching UX can
  only be validated with a bench of real hosts. **Recommendation:
  schedule as a hardware-validated design spike (firmware branch +
  multi-host bench session), not as a firmware release feature; estimate
  the Hub-menu host-switch flow at a week of code plus a week of bench
  validation.**

## Documentation backlog (docs items — no firmware change)

> **Mostly done (2026-10-14, both guides' working documents).** One pass
> over the .docx guides landed #64, #79, #56, #78, #65, #71, #72, #82,
> #33, #76 and #87: both error-code tables now match the firmware's
> bitfield (with the sum explained in prose), the debug-mode packets are
> described as the firmware prints them, the Maker Guide gained the
> faulty-sensor diagnostics write-up (PV/JV, the DM streams, BH, the EX
> dump) and the three programming workarounds that lived only in issues,
> the magnet-orientation step is honest about what calibration does and
> does not fix, and the User Guide gained the swapped-clicks
> (host left-handed setting) and flipped-cursor troubleshooting entries
> plus mouthpiece hygiene/cleaning/sourcing guidance. **PDF regeneration
> is the maintainer's Word export pass; the two User/Maker-Guide command
> tables should also absorb the 4.3.0/4.4.0 API additions (UM, BH, AV,
> EX, SD/MA/LK/CF, WS/WL/WM) when 4.4.0 releases.** Still open in this
> backlog: **#26** PCB labels (next PCB rev, pairs with item 10) and
> **#80** branch cleanup (upstream repo maintenance).

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
- **#37** (TLV493D library deprecated): tracked as items 1–2 above; the
  vendored bounded fork landed in 4.4.0 (item 1 done).

> **Drafted (2026-10-14):** paste-ready comment text for #73, #75, #63,
> #37 and the closeable-now notes (#36/#67/#61/#86) lives in
> `docs/upstream-issue-comments.md` — posting them from the org account
> is the maintainer action that closes this item.

## Blocked / maintainer action (2026-10-20 state of the leftovers)

Everything above is done or carries its own Done/deferral note. The
2026-10-16/17/18/19 bench sessions validated checklist parts A-F
(restrictions, timing windows + level scale, LED tier, regression sweep,
flaky-sensor repro, update path) and closed the 4.5.x follow-up backlog
(`docs/4.5.x-followups.md` — all five items shipped, bench-confirmed,
V4.5.1/V4.5.2 tagged; since then the branch has grown untagged 4.5.3 —
the dual-channel LED redesign — and 4.5.4, the `CH,5` push; see
`docs/STATUS.md`). What remains, and exactly why:

- **One more bench window, two deferred parts.** Checklist part G
  (Android/OTG flash session) needs an Android phone + OTG adapter —
  simulator-proven only. Checklist part H (the switch-remap physical-jack
  feel pass) needs populated-switch hardware; the mapping storage, wire
  protocol and post-flash restore ARE bench-verified via the 4.5.0→4.5.0
  re-flash, so #20 closes after H or ships noting it (the upstream draft
  says exactly that).
- **Feel-design decision before code: #58 hard sip/puff** (which actions
  hard inputs trigger is an accessibility decision to make WITH affected
  users — see item 15's note).
- **An affected unit: item 17 (#54 mechanical drift).** The firmware
  mitigation (median-of-N center sampling, hysteresis-aware center
  acceptance) is sketched in the item but iterating it blind against a
  mechanical problem would be guessing. New evidence from the 4.5.x
  cycle: the firmware re-centers the joystick on every boot by design,
  which explains one class of "boot-to-boot neutral drift" reports — but
  the hysteresis class still needs the unit.
- **Hardware redesign, not firmware: items 7 and 10** (keyed/polarized
  interface connector; soldered sensor connections + ESD/TVS protection
  on the interface lines) — these remove the reversed-cable and
  static-shock failure classes at the source; **#26** (PCB labels)
  rides the same next PCB rev.
- **Maintainer/community action (the only human steps left):** bench-
  confirm the one `CH,5` line the 4.5.4 commit names (physical Next →
  `MANUAL,0:CH,5:1,0,1`; close/timeout → `MANUAL,0:CH,5:0,<page>,<row>`;
  no CH,5 line during value-screen adjusts or long-text scrolls; the
  app's mirror follows physical navigation), then tag **V4.5.4** and
  publish its `dev/firmware/dist/` artifacts (manifest 4.5.4, rebuilt
  from the 4.5.4 tree) to the update-check path (4.5.1/4.5.2/4.5.3 were
  never published and are superseded — 4.5.3's commit says so explicitly,
  4.5.4 carries the CH,5 push on top); post the drafts in
  `docs/upstream-issue-comments.md` from the org account (then
  #73/#75/#63/#74/#37 and the closeable notes — #36/#67/#61/#86, plus
  the bench-validated #21/#22/#43/#44/#62/#68/#77 — can close); pass the
  S1 intermittent-button finding to MMC assembly QA; **#80** — delete
  the ~48 stale remote branches upstream. A Word re-export of the guide
  PDFs (LibreOffice exports shipped with V4.5.0) remains welcome for
  fidelity, not blocking.
- **Deliberate deferrals, unchanged:** item 6's protocol-v3 (nothing to
  do; v2 shipped) and the two research calls (ESP32: do not schedule;
  multi-BT: spike-first). The XENSIV migration is no longer a deferral —
  it shipped and bench-validated (see #37's row).

## Deliberately not "fixed" (recorded so nobody "fixes" them by accident)

- `playShutdownSound()` and `softwareReset()`'s 3 s pre-restart window are
  intentional blocking sequences — queued notes would be cut by the reset
  that follows (comment in `LSBuzzer.h`).
- `LSTest.ino`'s per-sound pacing `delay(1000)`s are the RT self-test's
  narration timing, read line-by-line by the app; they run inside the
  self-test's own locked flow.
