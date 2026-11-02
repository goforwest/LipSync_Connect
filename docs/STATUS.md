# LipSync Connect + LipSync firmware — current state

The one-screen answer to "where are we". This is the only doc that
tracks *now*: update it in the same change that moves the state, and
date every claim. Everything else in this folder is a dated log/ledger —
accurate as of its date, superseded by later dated notes, never
rewritten silently. Index and reading order: `docs/README.md`.

**Last updated: 2026-11-01.**

## App

- The interface now keeps its established accessible visual system while
  grouping the feature inventory into four fixed, task-oriented areas: Home,
  Adjust controls, Device, and Help & support. Home is the first-run/default
  surface; multi-page areas use a compact secondary row, and all original
  `sec-*` deep links remain stable.
- Help & support now starts with seven symptom-based paths and direct links to
  the relevant adjustment or test. Health check and Test inputs remain normal
  pages; the Hub remote, detailed log, and raw commands sit behind one clearly
  labeled Advanced tools disclosure. One support-report action combines app and
  device versions, a connected settings dump, and redacted session logs.
- Every area can be browsed while disconnected; only actions that require the
  LipSync stay disabled. Reset/erase actions likewise sit behind a full-size
  Reset options disclosure instead of relying on hidden gestures or small targets.
- Narrow screens now use one large Sections menu instead of a clipped horizontal
  rail, and local page tabs scroll away rather than consuming a second sticky
  band. Home owns the prominent disconnected Connect action; normal actions use
  MMC blue while brand/destructive red stays semantically distinct. Header and
  menu geometry remain within a 390 px viewport at the built-in 150% UI scale.
- Cursor and Sip & Puff now share one grouped stepper language: the live value
  stays centered between explicit controls, fine changes are visually primary,
  and coarse changes remain one click away. Sip & Puff's threshold and timing
  workflows are linear page sections instead of cards nested inside a card;
  the pre-practice stats row now honors its hidden state as intended.
- Review hardening serializes the two Connect entry points, restores initial deep
  links without blocking disconnected reading, prevents 4.5.8–4.6.3 from half-applying direct
  Gamepad↔Bluetooth transitions, scopes offline-cache deletion to this app,
  and keeps stale-while-revalidate work alive until its cache write settles.
- Browser audit: 84/84 connected-state flows, 20/20 viewport/accessibility checks, and
  11/11 first-run wizard checks pass on the reorganized interface.
- Integration tests pass 471/471 and offline E2E passes 2/2. CI now runs the
  browser audit; the dev dependency audit is 0 vulnerabilities.

## Firmware

- Branch `firmware-release-pipeline` is based on `0cce6f3` = **4.6.5**,
  currently untagged; newest tag is **V4.6.4** (`d239f65`).
- 4.6.5 is the safety-hardening release: two-conversion sip/puff engagement,
  verified bounded pressure reads, neutral-only offset refresh, physical-input
  action witnesses, calibration persistence fixes, line-safe non-blocking CDC,
  HID disconnect/release hardening, and safe-boot/watchdog corrections.
- This review additionally requires P_DA on both pressure sensors before a
  sample reaches the engagement qualifier. Timer catch-up can no longer count
  one 25 Hz conversion twice. Production compiles clean with all warnings.
- The source ZIP and tracked 4.6.5 flash artifacts are rebuilt from the reviewed
  tree; release and local builders share the all-warnings/dependency gates.

## Human steps remaining (nothing else is code-blocked)

1. Bench-confirm 4.6.5 on untouched hardware: no spontaneous sip/puff actions;
   deliberate sip/puff still crosses each configured timing window; PV/debug
   streams do not alter behavior; cable-fault/recovery remains inert until a
   stable offset is established; update + settings restore completes.
2. Tag **V4.6.5** and publish the reviewed manifest/DFU/UF2/HEX artifacts to
   the update-check path only after that bench pass.
3. Post the paste-ready drafts in `upstream-issue-comments.md` from the
   org account — then #73/#75/#63/#74/#37, the closeable notes
   (#36/#67/#61/#86), and the bench-validated set
   (#21/#22/#43/#44/#62/#68/#77) can close; #20 after checklist part H.
4. MMC assembly QA note (their call): the bench unit's S1 button was an
   intermittent open (dead across two firmwares, then re-seated and
   working) — worth a line in the unit's history.
5. **#80** — delete the ~48 stale remote branches upstream.
6. Guide PDFs: Word re-export welcome, not blocking; fold the
   4.3.0–4.6.5 endpoints into the guides' command tables.

## Still open, and why (not human steps)

- **Bench windows needed:** checklist part G (Android/OTG flash session —
  needs a phone + OTG adapter; simulator-proven only) and part H
  (switch-jack feel pass — needs populated-switch hardware; storage,
  wire protocol and post-flash restore already bench-verified via the
  4.5.0→4.5.0 re-flash).
- **With-users passes:** #58 hard sip/puff (the action mapping is an
  accessibility decision to make WITH affected users); #43's
  dual-channel indicator with-users confirmation (bench-verified in
  4.5.3, fill re-tested on the 4.5.3 build).
- **An affected unit:** #54 mechanical drift (roadmap item 17 — the
  boot-re-center explanation closed one class; the hysteresis class
  needs the unit).
- **Hardware, not firmware:** roadmap items 7/10 (keyed connector,
  soldered sensor connections + ESD/TVS, PCB labels #26) and the
  mechanical backlog (#84/#70/#69/#24/#15).
- **Research calls (unchanged):** #85 ESP32 — do not schedule; #16
  multi-host Bluetooth — design spike first.

## Upstream issue list

43 open as of 2026-10-20 — every one mapped to a disposition in
`roadmap.md`; the closeable set waits only on step 2 above.
