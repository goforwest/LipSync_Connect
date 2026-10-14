# Firmware update — future improvements

Follow-ups identified during the hardware validation of the firmware-update
feature (2026-10-11). None are required for correctness today; they are
ordered by user-visible value. The motivating item is #1 — the Hub's screen
freezing on "Restarting" for the whole time the device sits in update mode.

**2026-10-14 pass:** items 1 (UM,1:1 + the app's UM-first wizard flow),
2 (the post-flash settle mitigation), 3 (stranded-marker persistence) and
5 (the one-shot probe retry) are done — each carries a Done note below.
Open: item 6 (the Android/OTG hardware session, which now also validates
the UM path) and the firmware-side half of item 2 (why fresh CDC drops its
first writes).

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

> **Done (2026-10-14, firmware 4.3.0 + app).** The 1200-baud handler turned
> out to live in the pinned core (Adafruit_TinyUSB's
> `tud_cdc_line_state_cb`), not the sketch — so the app firmware got its
> own deliberate entry instead: `UM,1:1` acks, draws the "Update mode —
> use the LipSync Connect app" splash as the final frame, then calls the
> core's `enterSerialDfu()` (the exact destination the touch lands in).
> The wizard now sends `UM,1:1` over the live session in place of the
> whole SR + 1200-baud touch choreography when the connected firmware is
> ≥ 4.3.0 — same shape as the proven `SR,1:1` flow (ack, then the device
> goes; the port departs fast) — and falls back to the established
> SR-first + touch path on any failure. The picker hint is now
> conditional: on 4.3.0+ it names the deliberate splash; older firmware
> keeps the "dark or frozen — that is normal" truth. A maker with a
> serial monitor can also enter update mode with `SETTINGS` + `UM,1:1`
> instead of the double-reset dance. Hardware validation of the UM path
> belongs to the 4.3.0 release session (item 6 covers the same surface).

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

> **Done (2026-10-14) — the mitigation shipped.**
> `finishPendingUpdate` now settles `RESTORE_SETTLE_MS` (1.5 s) after the
> load completes before the first restore write (a test seam shrinks it
> for scenarios; the settle-before-write contract is pinned by a
> test). The firmware-side "why does fresh CDC drop its first writes"
> investigation remains open if the settle ever proves insufficient.

## App (LipSync_Connect)

### 3. Persist the "stranded in update mode" hint across page reloads

The Recover button is revealed by the connect guard (and by the wizard's
own post-START failure/cancel paths). A page reload loses the marker, so a
user who reloads must Connect (and pick the bootloader port) once before
Recover reappears. Persisting a "device likely stranded" flag in
sessionStorage — cleared on the next successful settings load — would keep
Recover reachable immediately after a reload.

> **Round-2 note (2026-10-12):** Recover (and Flash local file) now live
> outside `#fwActionsRow`, so the button is clickable while a wizard panel —
> including a restore-pending sentinel — is on screen whenever the marker
> is set (e.g. a Connect that picked the update loader while the panel was
> up). The marker itself still dies with the page reload — this item
> remains open.

> **Done (2026-10-14).** The marker now mirrors into sessionStorage
> (`lipsync-fw-stranded`, written by the connect guard and by
> `setBootloaderStranded`); `bindFirmwareUpdate` restores it at startup so
> Recover is reachable immediately after a reload, and it clears on the
> next successful settings load exactly as specified. The
> restore-pending entry and this flag are the two halves of "a reload
> must not strand the stranded" — both now hold.

### 4. Quiet the 30 s idle watchdog while the wizard is showing

"No data received for 30s… this is normal when the device is idle" fires
while the user is reading the update prompt mid-wizard. Harmless, but it
interrupts the flow's own messaging. Suppress the advisory while a firmware
wizard panel is active.

> **Done (2026-10-12, UI/UX polish round):** the advisory now stays silent
> while any wizard panel (including sentinels and failed panels) is on
> screen — `firmwareWizardPanelActive()` in serial/commands.js, pinned by a
> caller-level test with a shrinkable watchdog seam.

### 5. One-shot probe retry in the picker path

Rare (pre-SR-flow logs): the first DFU probe against a freshly entered
bootloader sometimes goes unanswered and the flow reports "did not respond
as an update loader". The avoid-port fix now routes retries through the
real picker, which self-heals — but a single probe re-send before declaring
failure would smooth the first-ever-update experience. With SR-first now
handling the common path, this only affects recovery / manual-double-reset
flows.

> Round-2 note (2026-10-12): silent reuse of a granted bootloader port is
> now gated on a bounded liveness probe (`serialDfuPortIsLive` — an extra
> open/close at 115200 per Continue on repeat updates), so a stale grant
> can no longer masquerade as the live loader. A live-but-flaky first
> probe still benefits from the one-shot retry this item proposes.

> **Done (2026-10-14).** The probe now gets exactly one extra round
> before "did not respond as an update loader" is declared: a settle
> (~1 s, test seam) plus a re-send, and only for the silent
> ACK-timeout shape — a loader that answers with wrong sequence numbers
> is the stale-session pathology and is classified immediately (a
> re-send can never re-sync it), and a failed write is a dead link.
> Pinned by tests for both shapes.

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

> **Validated (2026-10-12)** on a disposable repo
> (`goforwest/LipSync-ci-scratch`), seven runs, all against the hardened
> workflow:
>
> - The dry run earned its keep before any release existed: the hardened
>   guard's shape-checking python was a multiline single-quoted string
>   whose continuation lines start at column 1 — that ends the step's
>   `run: |` block scalar, invalidating the whole workflow (every run
>   failed in 0 s with "workflow file issue"). A local stub harness had
>   validated the bash but never the YAML wrapper. Fixed as a one-liner;
>   YAML parse + all eight stub cases re-verified.
> - workflow_dispatch end-to-end: green (compile + staged artifacts).
> - First release (V4.1.9): branch born through the `git ls-remote`
>   first-release path, manifest stamped, release with all four assets.
> - Guard discrimination: V4.2.1 published first, then the older V4.2.0
>   build read the branch and logged "already holds 4.2.1 — newer than
>   this build (4.2.0); leaving it untouched" — green, branch preserved.
> - Near-simultaneous tags (V4.3.0 + V4.3.1 in one push): the two publish
>   steps ran ~16 s apart, so the guard discriminated again (branch =
>   4.3.1, the newer). The RELEASE side, which has no guard, raced the
>   other way: `releases/latest` = V4.3.0 while the branch holds 4.3.1 —
>   and the app's tag↔manifest cross-check was verified live against that
>   exact state (it refuses with the "does not match its release" error).
>   The backstop is load-bearing, not theoretical.
> - Fail-closed: a planted unparsable branch manifest ("4.2.0-beta") made
>   the V4.2.2 build FAIL with "refusing to publish… over it", branch
>   untouched — the pre-hardening behavior was a silent exit-0 skip with
>   no branch artifacts.
>
> The read-then-push TOCTOU residual stands as documented (it needs both
> publish steps inside a few seconds of each other); with the branch
> guarded and the app refusing mismatches, its worst case remains a clear
> error until the next release. The release-side ordering (which
> `releases/latest` wins a same-minute double-tag) is unguarded by design.

### 8. uf2conv pin maintenance

The workflow fetches `uf2conv.py`/`uf2families.json` at the exact
microsoft/uf2 revision the app repo vendored byte-identical
(`90e9741…`). If either side is ever refreshed, refresh both in the same
change (the workflow comment says so; this note is the reminder with
teeth).

> Round-2 verification (2026-10-12): both vendored files were hashed
> against the pinned revision — byte-identical. The race guard in the same
> workflow was hardened to fail closed on an unparsable/unreadable branch
> manifest (a malformed `firmwareVersion` previously skipped publishing
> silently); its residual read-then-push TOCTOU is documented in the
> workflow and covered on the app side by the tag↔manifest cross-check.

### 9. Signed release manifests — implemented, then removed by maintainer decision

An Ed25519 signature rail was fully implemented and merged on 2026-10-12
(the pipeline signs `firmware-manifest.json`, the app verifies against a
public key pinned in app code), then removed on 2026-10-13 after
reconsidering the project's open-source posture. The reasoning, for
posterity:

- **The scenario signatures cover is not breakage** — a broken release is
  properly signed anyway (signatures prove authenticity, not quality), and
  breakage is already bounded by design: app-only DFU packages cannot
  touch the bootloader, so any failed update is recoverable through the
  Recover flow, and the org's RMA covers the rest.
- **What signatures actually buy** is against the silent-compromise case: a
  compromised upstream repo publishing backdoored firmware as an official
  update, which the sha256 cannot catch because the checksum rides in the
  same repo it vouches for.
- **Why it was nonetheless declined:** the project deliberately keeps every
  flashing path open (self-compiled builds via drag-drop/nrfutil, and the
  in-app "Flash local file", both intentionally ungated); the ceremony cost
  is real for a volunteer org (a CI secret, rotation, a lose-the-key
  failure mode, cross-repo flag coordination); and the residual threat —
  repo compromise of a small assistive-tech org — was judged unlikely
  enough to accept. This is an accepted-risk decision, not an oversight;
  revisit if the threat picture changes (the README security note states
  the residual honestly).

The removal was clean: nothing ever shipped to users, so no release ever
carried a signature and no compatibility surface exists. The pinned-key
keypair was destroyed with the feature.

## Hardware-round finding (2026-10-12): the loader's stale session

An interrupted post-START flash leaves the bootloader RUNNING with its
transport sequence counter mid-session. A second flash started without
re-enumerating the device is answered by fast wrong-number re-ACKs
(hardware: ~370 ms per attempt, three re-ACKs — a live, answering loader,
not silence) and can never re-sync: the loader's DFU queue state is
unknown to a new session (the erase may have been accepted and may even
still be running), so re-using it risks a second erase. The probe failure
is now classified as a stale loader with the one working remedy — unplug
and replug (or double-press reset), then Continue — instead of the
"pick the update loader again" loop that cannot work until the loader
re-enumerates. An in-app transport re-sync (adopting the re-ACKed
expected number and replaying START) was considered and rejected: the
real bootloader's behavior on a duplicate START mid-session is
unverifiable offline and the payoff is only one saved replug on a
failure path that already ends with the user at the device.
