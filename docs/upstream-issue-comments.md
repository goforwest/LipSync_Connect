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

Tracked and actioned in two steps: firmware 4.4.0 vendors the deprecated
library as a bounded fork pinned into CI/local builds (the same pattern
as the patched Wire — a failed sensor wake-up no longer busy-waits, and
the measurement delay is clamped), which removes the library as an
unbounded-latency risk on the 20 ms joystick poll. The migration to the
XENSIV TLx493D library remains the deliberate follow-up (it touches the
joystick read path, so it goes through hardware validation rather than a
blind swap).

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
  clinician's note asked for (gamepad mode is what an iPad's Switch
  Control sees). Closeable once 4.5.0 ships and the bench session
  (checklist part H) confirms the feel.
