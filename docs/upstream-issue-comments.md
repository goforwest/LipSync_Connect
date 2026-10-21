# Upstream issue comments — paste-ready drafts (roadmap item 8)

The 4.2.0/4.3.0/4.4.0 field data the roadmap promised the upstream issues.
These are drafts for a maintainer to post from the org account; each is
self-contained, links the user back to the release that carries the fix,
and states plainly what is and is not fixed. Post closeable ones with a
note that they can be closed once the named release ships/validates.

---

## #73 — Wrong/reversed interface cable → error lights, stuck boot

We reproduced this failure class exactly while debugging a unit that
presented as "error lights and a hub stuck at boot": the RJ11 interface
cable between the Hub and the Joystick was plugged in reversed. Crossing
the I2C lines wedges the shared bus (a slave holding SDA low
mid-transaction), which produced held-bus hangs, a black display and
multi-second stalls across every function.

Firmware 4.2.0 (and later) is built to survive it: every I2C transaction
is bounded and a wedged bus is recovered in place (bounded STOP + the
I2C-spec 9-clock bus clear), the display and sensors back off while the
bus is unhealthy and re-probe on a backoff schedule instead of stalling
the main loop, and the device self-recovers when the cable is corrected.
A new `BH,0:0` diagnostic endpoint (4.3.0+) reports the recovery count and
per-device health state in one read.

This doesn't fix the connector itself — a keyed/polarized connector
(hardware roadmap item) removes the failure at the source — but a unit
running 4.2.0+ should no longer wedge or appear dead from a reversed
cable.

## #75 — Watchdog activates after factory reset, manual restart required

Root cause found: the old watchdog policy. A watchdog reset landed the
device in safe mode, and safe mode did not arm the watchdog — so a
factory reset (or any boot that tripped the watchdog into safe mode)
required the manual restart to clear the state.

Firmware 4.2.0 changed the policy: the watchdog arms on every boot
including safe mode, with a 3-strike boot-loop budget (after three
consecutive watchdog resets the device deliberately settles in safe mode
instead of resetting forever). The exact scenario in this issue —
watchdog trip → safe mode → manual restart needed — now self-recovers.

## #63 — USB connection error message persists after computer reboot

Two things were compounding here, both addressed:

1. The amplifier: the USB-retry loop redrew the full framebuffer on every
   retry tick (~2 s apart). Against unhealthy I2C hardware each redraw
   cost seconds of bounded timeouts, so the retry loop itself dragged the
   device down. Since 4.2.0 the error page draws at most once per error
   episode and only when the bus is answerable.
2. The residue: even after recovery, the "No USB" page stayed on screen.
   Firmware 4.3.0 clears it back to the ready screen the moment the host
   returns.

If you still see a persistent error page on 4.3.0+, that would be new
information — the `BH,0:0` bus-health endpoint would show whether the
display is being gated as unhealthy.

## #37 — TLV493D library deprecated

Actioned in two steps, both shipped. Firmware 4.4.0 vendored the deprecated
library as a bounded fork pinned into CI/local builds (the same pattern as
the patched Wire — a failed sensor wake-up no longer busy-waits, and the
measurement delay is clamped), which removed the library as an
unbounded-latency risk on the 20 ms joystick poll. Firmware 4.5.1 completed
the migration to the XENSIV TLx493D library — vendored unmodified upstream
v1.1.2, provenance in the copy — and it went through full hardware
validation before merge, exactly because it touches the live joystick read
path: raw-value parity against the old library confirmed on silicon (the
same 0.098 mT/LSB scale, corner magnitudes within hand-placement variance,
no axis or sign changes), a fresh four-corner calibration, the
magnet-direction latch stable across five restarts, and an unseated-cable
flaky-bus episode handled gracefully. One pleasant surprise from the
successor's gen-1 code: the A1B6 default is master-controlled continuous
measurement, so the 20 ms poll is a single bounded I2C read with no
wake/write/wait cycle at all — strictly cheaper per poll than the bounded
fork, with every transaction still under the patched Wire's 50 ms bound.

A note for anyone weighing the same migration: the continuous measurement
draws the sensor at mA-scale instead of µA-scale between reads. That would
matter to a battery-powered design; it is moot for the LipSync, which has
no internal cell (the device is host-powered via USB, or phone-powered over
USB-OTG for mobile use — the case our User Guide already steers to an
external power source). Worth checking your own power architecture before
choosing between the access modes.

## 4.5.0 USB robustness (relates to #63, #75)

The 2026-10 bench validation chased a rare but reproducible failure: after a
firmware flash, the host could lock the device into a configuration where
serial worked but the HID interface never came up — cursor dead, "No USB"
page truthful and stuck until a manual restart. Firmware 4.5.0 closes it in
layers: the bus stays dark at boot until the complete USB configuration
exists (so no host can half-enumerate it), a persistent HID outage now
forces a re-enumeration (up to 3, bounded), and if even that cannot recover
the host's state the device spends one automatic restart — the one cure that
has cleared every observed instance — guarded so it can never loop. A wedged
boot now self-heals within ~20 s instead of appearing bricked. Two witness
lines (`USB-EVT: configured/unconfigured`) plus the existing `BH,0:0` HID
telemetry make any future instance diagnosable from a session log alone.

A second, subtler fix from the same bench session: the watchdog's feed ran
on a soft timer that demonstrably stops firing in safe-mode boots while the
main loop stays alive — so an armed 30 s watchdog starved and reset the
device into safe mode, where the feed died again: a reset cycle the app
could never connect through. The feed now happens directly in the live loop,
independent of every timer, leaving the watchdog with its one true job —
catching a genuinely dead loop. Worst case for any degraded boot is now a
single reset into a stable, connectable safe mode.

## #74 — Flaky/loose sensor connection: spontaneous mode changes

The ask in this issue — that a flaky sensor connection must never cause
spontaneous mode changes or menu walks — now has a bench-verified answer in
4.5.0: with the device running and the interface cable partially unseated,
serial stays alive, "Pressure sensors not responding" prints once, sip and
puff disable themselves until the sensor answers again, the `BH,0:0` health
read marks the sensor degraded, and no mode changes or menu walks occur
during the flaky window; re-seating recovers without a restart. One known
limitation is documented rather than hidden: booting with the cable
deliberately unseated can wedge the serial path a few seconds into an app
connection (the sensors still ACK at boot, so the device does not know to
back off); the device still shows its safe-mode/error page, no longer reset
loops (see the watchdog note above), and fully recovers once the cable is
re-seated. A keyed connector remains the source fix (see #73).

## Two-way Hub remote — the `CH,5` menu-state push (shipped: app first, firmware 4.5.4)

The LipSync Connect remote Hub mirror was one-way in exactly one place
until 4.5.4: app-driven presses reconcile from device truth (4.5.1+'s
`CH,0:0` read after every press), but *physical* navigation — Next/
Select on the Hub, joystick-driven menu steps, the inactivity timeout —
redraws the OLED with no serial traffic, so a mirror left open drifted
until the next app press or a manual Open-resync. Settings changes made
on the Hub already push as `MANUAL` lines; the menu *position* was the
one state that never rode the wire unprompted.

Shipped: the app half first (push and poll share one code path), then
firmware 4.5.4 (`0e393c1`, untagged at this writing — one bench line
before the V4.5.4 tag, see below) emits

    MANUAL,0:CH,5:<active>,<pageId>,<row>

whenever that triple changes — the exact values `CH,0:0` already answers
with (active flag, the LSScreen.h page id, the selectable-row cursor),
in a `MANUAL` frame with sequence 0. Everything about the wire safety is
proven in the tree:

- `MANUAL` + device-initiated is the 4.5.2 initiator contract — the
  same shape as the boot re-center's `MANUAL,0:IN,1` — so a push can
  never falsely resolve a pending command waiter (the app gates
  SUCCESS-gated flows on the ack type and treats MANUAL pushes as
  readouts; its straggler-ack contract test pins the boot case).
- The value is human-paced by construction — the shipped rate limiter is
  the change-detect itself: emission is hooked at the `flushDisplay`
  choke point (every menu redraw ends there), and value screens that
  re-render on every adjust step or the long-text scroll that flushes
  every 100 ms do not change the triple, so neither prints; the boot
  member state {0,0,0} means the closed-menu triple never prints by
  itself.
- The app side is deliberately trivial because the reconciliation
  already exists: `applyMenuState()` — the same function the press
  polls feed — consumes the push unchanged, so the mirror follows
  device presses, opens when the physical menu opens, and closes on
  the inactivity timeout. Both halves are now shipped and the remote is
  both-ways on a 4.5.4 device with zero further app changes.
- Older firmware simply never sends the line — the app's own
  press-then-poll behavior stands unchanged (and `CH,0:0` itself stays
  version-gated at 4.5.1).

As shipped: a `VN`-independent emission rule — hosts that do not know
`CH,5` ignore it as an unrecognized MANUAL readout (the reference app
logs nothing and reconciles) — printed unconditionally like every
unsolicited line this firmware emits (the CDC stack drops writes with
no host listening). A wedged/demoted display pauses pushes (nothing is
shown to drift from) while the `CH,0:0` poll keeps answering the same
truth; pushes resume from the latest state on recovery. The one bench
line the 4.5.4 commit names gates the V4.5.4 tag: with a serial session
open, a physical Next must arrive as `MANUAL,0:CH,5:1,0,1`; a physical
close or timeout as `MANUAL,0:CH,5:0,<page>,<row>`; no CH,5 line may
appear during a value-screen adjust or a long-text scroll; and
LipSync Connect's mirror must follow physical navigation with no app
press.

## Optional: closeable-now notes

- **#36** (menu stays open after serial-API calibration): fixed in 4.3.0 —
  an API-triggered calibration now closes the Hub menu at its end instead
  of parking it.
- **#67** (easy way to share device settings): the LipSync Connect web app
  ships a one-click labeled settings export, and firmware 4.4.0 adds
  `EX,0:0`, a one-command dump of every stored setting for support
  contexts without the app. The device identifier is deliberately
  excluded in both.
- **#61** (audio cue for scroll/drag): shipped in 4.3.0 ("All" sound tier —
  scroll and drag each chirp once on engage, distinguishable by pitch).
- **#86** (cursor acceleration): shipped in 4.3.0 as a stored −10..10
  level bending the deflection-to-speed curve; level 0 is the old linear
  behavior.
- **#20** (switches as additional inputs): firmware 4.5.0 makes the three
  assistive-switch jacks independently remappable — per jack, per hold
  window, separately for mouse and gamepad mode — from a caregiver-safe
  action palette (the clicks, drag, scroll, gamepad buttons B1-B8, cursor
  centering, speed steps, mode change, menu open; calibration/reset actions
  are deliberately excluded so one accidental press can never erase
  settings). The compiled defaults are unchanged, so nothing changes for
  existing users until a caregiver opts in; LipSync Connect exposes it as
  its "External switch actions" card — the per-host mappability the
  clinician's note asked for (gamepad mode is what an iPad's Switch Control
  sees). The settings storage, wire protocol, and post-flash restore of all
  six mappings are bench-verified on 4.5.0; the physical-switch feel pass
  (bench checklist part H) is still pending on hardware with the jacks
  populated, so hold the close until that pass or ship noting it.

## For MMC (not upstream posts)

- **Bench-unit hardware finding:** the Next (S1) hub button on our
  validation unit is electrically dead — no GPIO reaction with two
  different firmwares (4.1.0 and 4.5.0) while Select (S2) works, ruling out
  firmware and a stuck-pressed switch (the S1+S2 menu combo would still
  fire). Suspect the switch itself, its ribbon conductor, or a solder
  joint; needs continuity testing against the S2 line. Worth a QA check
  across the assembly batch.
- **Release mechanics:** the guide `.docx` passes are complete and
  committed; the PDF regeneration is the maintainer's Word export pass
  (headers-as-bookmarks, per the repo's existing PDF convention).
