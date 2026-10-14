# Firmware 4.2.0 serial & robustness work — future improvements

Follow-ups identified during the serial-latency fix and the flaky-I2C-bus
hunt it turned into (2026-10-13). None are required for correctness today —
firmware 4.2.0 survives every failure mode below and the app stays
compatible with stock 4.1 devices in the field. Ordered by value.

Context in one line: the original "~30 s settings load" was a 1000 ms
idle-framing timeout (fixed at the Wire/parser level, now ~92 ms full load);
the follow-on "everything times out" chaos was a reversed interface cable
dragging the shared I2C bus (upstream #73's failure class), which the
firmnow now self-defends against on every consumer.

## Firmware (lipsync repo)

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
version as the Wire README does. The bounds in `Wire_nRF52.cpp` already
cap each underlying transaction; this item is about the library-level
sequencing on top.

### 2. Migrate to Infineon's XENSIV TLx493D library (upstream #37)

The maintained replacement for the deprecated library above. If undertaken,
it subsumes item 1: port `LSJoystick` to the XENSIV API and gain maintained
upstream, then evaluate whether its read path is non-blocking by
construction (if not, vendoring rules from item 1 still apply).

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
black, is it the USB?" into a one-line answer.

### 4. Restore `TwoWire::begin()`-style pin config after bus recovery

`wireRecoverBus()` reconfigures the SDA/SCL pins as GPIO for the NXP
9-clock bus-clear and re-attaches the TWIM, but leaves the SCL `PIN_CNF`
as GPIO-output rather than restoring the `begin()` configuration
(input, pull-up, open-drain). PSEL re-attachment gives the peripheral
ownership so this is functionally benign today, but restoring the
`begin()`-equivalent pin configuration after recovery is proper hygiene
and removes a dependence on undocumented pin-mux precedence. Small,
bounded change in the vendored Wire.

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

## App (LipSync_Connect)

### 6. Protocol v2 — send newline-terminated commands (deferred deliberately)

Firmware 4.2.0+ frames newline-terminated messages instantly; legacy bare
writes keep the 50 ms idle-gap frame. The app deliberately still sends
bare writes so a single app build works against old LipSyncs in the field
(stock 4.1 rejects trailing newlines on every comparison). When a "protocol
v2" release is opportune: append `'\n'` in `sendRaw()` (one line,
`app/js/serial/commands.js`), update the README's "hand-tuned against v4.1"
note, and exchanges drop from ~50 ms to ~2 ms (a full load lands under
200 ms). Backward compatibility can be preserved by feature-detecting
(negotiate once, or accept the mixed population during a transition
window) — or shipped version-gated, as the DFU protocol already is.

## Hardware (hub redesign backlog)

### 7. Polarized/keyed interface connector

The root cause of the entire flaky-bus saga was a reversible interface
cable plugged backwards — crossing I2C lines, wedging the bus, blacking
the screen and confusing sensor detection (upstream #73 documents the
class). A connector that cannot be reversed (keyed housing, different
connector families per end, or a silkscreen + asymmetric key) eliminates
the failure class at the source.

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
  bus.
- **#37** (TLV493D library deprecated): tracked as items 1–2 above.

## Deliberately not "fixed" (recorded so nobody "fixes" them by accident)

- `playShutdownSound()` and `softwareReset()`'s 3 s pre-restart window are
  intentional blocking sequences — queued notes would be cut by the reset
  that follows (comment in `LSBuzzer.h`).
- `LSTest.ino`'s per-sound pacing `delay(1000)`s are the RT self-test's
  narration timing, read line-by-line by the app; they run inside the
  self-test's own locked flow.
