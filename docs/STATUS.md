# LipSync Connect + LipSync firmware — current state

The one-screen answer to "where are we". This is the only doc that
tracks *now*: update it in the same change that moves the state, and
date every claim. Everything else in this folder is a dated log/ledger —
accurate as of its date, superseded by later dated notes, never
rewritten silently. Index and reading order: `docs/README.md`.

**Last updated: 2026-10-20.**

## Firmware

- Branch `firmware-release-pipeline` @ `0e393c1` = **4.5.4**, untagged:
  the `CH,5` menu-state push (Hub remote control becomes two-way —
  physical navigation reaches the app). `dev/firmware/dist/` already
  holds the rebuilt 4.5.4 hex/uf2/dfu + manifest.
- 4.5.4 builds on **4.5.3** (`424f3e9`, the dual-channel input-state LED
  indicator — face-LED window fill 1/2/3 + micro-LED color), whose
  commit explicitly **supersedes V4.5.2 as the publish target**.
- Newest tag: **V4.5.2** (`ab74272`, 2026-10-19) — artifacts never
  published; superseded by the 4.5.3/4.5.4 line (4.5.1 likewise).
- One bench line gates the V4.5.4 tag (from the 4.5.4 commit): with a
  serial session open, a physical Next arrives as `MANUAL,0:CH,5:1,0,1`;
  a physical close or timeout as `MANUAL,0:CH,5:0,<page>,<row>`; no
  CH,5 line during a value-screen adjust or a long-text scroll; and the
  app's mirror follows physical navigation with no app press.

## Human steps remaining (nothing else is code-blocked)

1. Bench-confirm the CH,5 line above, tag **V4.5.4**, publish its
   `dev/firmware/dist/` artifacts (manifest 4.5.4) to the update-check
   path.
2. Post the paste-ready drafts in `upstream-issue-comments.md` from the
   org account — then #73/#75/#63/#74/#37, the closeable notes
   (#36/#67/#61/#86), and the bench-validated set
   (#21/#22/#43/#44/#62/#68/#77) can close; #20 after checklist part H.
3. MMC assembly QA note (their call): the bench unit's S1 button was an
   intermittent open (dead across two firmwares, then re-seated and
   working) — worth a line in the unit's history.
4. **#80** — delete the ~48 stale remote branches upstream.
5. Guide PDFs: Word re-export welcome, not blocking; fold the
   4.3.0–4.5.x endpoints into the guides' command tables.

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
