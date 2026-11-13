# LipSync Connect + LipSync firmware — current state

The one-screen answer to "where are we". This is the only doc that
tracks *now*: update it in the same change that moves the state, and
date every claim. Everything else in this folder is a dated log/ledger —
accurate as of its date, superseded by later dated notes, never
rewritten silently. Index and reading order: `docs/README.md`.

**Last updated: 2026-11-13.**

## App

- Log-hygiene fix (2026-11-13, 4.9.6 final-verification finding I-2): the
  Bluetooth-host backstop poller used to poll `BT,0:0` once per second for
  the whole session with both directions echoed — 4 log lines/s that filled
  the 400-line panel in ~3 minutes and capped the exported support log
  (5000-entry history) at ~40 minutes of session regardless of session
  length, burying the diagnostic events the log exists to carry. The poll is
  now every 15 s (`BT_HOSTS_BACKSTOP_POLL_MS`, pinned by test) and runs as a
  QUIET exchange (new `sendCommand({ quiet })` + `quietExchangeActive()` in
  `serial/commands.js`): its TX echo and completion-line RX echo are
  suppressed, while MANUAL BT,4/BT,5 pushes, INFO/diagnostic lines, and every
  user-initiated command still log — the firmware's own change-detected pushes
  remain the primary sync. Three new tests pin the contract (quiet echo
  suppression, MANUAL-during-quiet still logged, the 15 s cadence with zero
  log lines on an unchanged table); suites 514/514, lint/typecheck clean.
- Handover polish pass (2026-11-13): every version-gated feature now states
  the lock with the shared note-and-Updates-link pattern (a new
  `ui/firmware-gate.js` helper) — input safeguards, hold timing (which had no
  note at all), external switch actions, and the hard band gained working
  links, and the 4.8.0+ Bluetooth host table says why it is absent on older
  firmware instead of silently hiding. The Input-state light option stays
  visible but disabled with "(needs firmware 4.4.0+)" rather than vanishing.
  The practice-peaks UI is retired: the measured maxima are internal data for
  Suggest thresholds now, surfaced only in a practice guide line ("Strongest
  so far: …"), Suggest unlocks from data instead of appearing hidden→shown,
  Start over replaces Clear peaks, and the gauge's dashed marks mean exactly
  one thing — the hard band (with a legend while shown). Auto-live keeps
  starting the gauge on section open, and the Hold timing group explains the
  device's one-stream-at-a-time limit (Watch holds pauses the gauge and vice
  versa). Export settings moved to Profiles & backup (beside profile
  import/export); Refresh all settings stays in Overview & modes. Test
  auto-restart moved from Self-tests to Restart & reset — its consequence is
  a restart, and Self-tests now offers only the non-disruptive LED/buzzer
  tests (also fixing a stray ">" text node that had been rendering in that
  row). Suites: 511/511 (three new practice-watch tests), lint/typecheck/
  format clean, service worker bumped to v54.
- The interface now keeps its established accessible visual system while
  grouping the feature inventory into four fixed, task-oriented areas: Home,
  Adjust controls, Device, and Help & support. Home is the first-run/default
  surface; multi-page areas use a compact secondary row, and all original
  `sec-*` deep links remain stable.
- Home's "More tasks" list and Help's "Advanced tools" disclosure now default
  to open (634f74b), and a plain-language copy pass removed protocol jargon
  from user-facing text: the browser-support banner and noscript note,
  communication-mode hint, connect/update failure messages, the DFU timeout
  message (its probe retry now keys off an `ackTimeout` flag instead of the
  message text), Bluetooth naming (no BLE/advertised/HID), joystick and
  pressure readouts (no "raw magnet"/Δ), the health grid's "Internal
  sensors (I2C)" label and findings, the auto-restart test naming, and the
  settings-dump button. Version-gate notes and exact-value disclosures are
  unchanged; the unit/integration suites (508/508) pin the new strings.
  `app/index.html` was also re-formatted to the project prettier config
  (pre-existing drift from the 2026-11-10 UX commits had left CI's format
  gate red).
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
- Browser audit: 85/85 connected-state flows, 20/20 viewport/accessibility checks, and
  11/11 first-run wizard checks pass (116 total) on the reorganized interface.
- A dedicated firmware compatibility matrix (`tests/firmware-compat.test.mjs`)
  now pins the whole 4.1.0 ↔ 4.6.5 span in one place: the deviceFirmwareAtLeast
  tier map, the wire-framing generation switch, which endpoints the load may
  send, the locked-with-reason vs. live card states, the input-state light
  option, and the backup/restore downgrade-safety. The 4.6.5 update path is
  verified end to end — a field 4.1.0 device detects/offers 4.6.5, and the
  built manifest's declared sizes and sha256 checksums match the real
  DFU/UF2/HEX artifacts (guarding the wizard's download-time checksum gate).
- Acceleration (`AV`) is now gated on firmware 4.3.0+: older firmware's getter
  answers, but its setter is a v4.0-era dispatch stub that refuses every
  `AV,1:N` with `FAIL,3` (fixed in firmware commit `52471f4`). The control
  loads as not-applicable with a "needs newer firmware" note whose Updates
  link opens that card, snapshots omit it on old firmware, and downgrade
  restores skip it on the connected device.
- The hard sip/puff band (upstream #58) is configurable on firmware 4.7.0+:
  new HS/HP steppers and exact-value Sets (the hard >= regular + 1 hPa margin
  rule is pre-checked against the live regular readouts, then re-validated by
  the firmware), HA/HB action selects sharing the caregiver-safe switch
  palette, dashed hard-threshold markers on the pressure gauge, snapshot/
  restore, and settings-export coverage — all version-gated off on older
  firmware with an honest reason note (the protocol cross-check verifies the
  4.7.0 gate, the second settings file's read keys, and that the seed defaults
  are renderable picks).
- The Hub menu's own hard pages are mirrored by the Hub remote: on 4.7.0 the
  Sip & Puff submenu gains Hard Sip/Hard Puff rows (firmware pages 543/544,
  appended in front of Back so earlier rows keep their indices), each a
  coarse-level adjust page whose Decrease clamps at the device's regular +
  margin floor and whose entry heals a stranded value — the mirror implements
  the same clamp/heal, and the device's menu-state push/re-read (CH,0:0 /
  CH,5) drives the pages like every other screen. The cross-check pins the
  submenu row order and the 543/544 page mapping.
- Integration tests pass 511/511, the browser audit passes 116/116, and offline
  E2E passes 2/2. CI now runs the browser audit; the dev dependency audit is 0
  vulnerabilities. The full CI job is green on main as of 9f32869 (it had been
  stopping at the format check since the 2026-11-10 UX commits).

## Firmware

- Branch `firmware-release-pipeline`: **V4.6.6** is tagged and released
  (review-round fix set: stuck-drag on a mid-hold sensor fault, the SD-flag
  race, fabricated calibration corners, and the minor batch); the branch
  head additionally carries **4.7.0** (hard sip/puff, upstream #58 —
  committed locally, not yet pushed/tagged).
- 4.7.0 adds the hard band: new main states with hard-sticky classification
  (a hard hold that decays stays hard; a regular hold pushed hard stays
  regular), HS/HP/HA/HB serial endpoints, Hub-menu Hard Sip/Hard Puff adjust
  pages (the pair heals after regular-threshold steps so the band never goes
  silently inert), and a second settings file (`/settings2.dat`, its own
  256-byte budget) so the main file's 480-byte 4.1.0-downgrade cliff is
  untouched. Factory reset re-seeds both files.
- This review additionally requires P_DA on both pressure sensors before a
  sample reaches the engagement qualifier. Timer catch-up can no longer count
  one 25 Hz conversion twice. Production compiles clean with all warnings;
  host suites: 165/165 timer + 105/105 core checks under ASan/UBSan.
- The source ZIP is rebuilt from the reviewed tree; release and local builders
  share the all-warnings/dependency gates.

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
   4.3.0–4.7.0 endpoints into the guides' command tables.

## Still open, and why (not human steps)

- **Bench windows needed:** checklist part G (Android/OTG flash session —
  needs a phone + OTG adapter; simulator-proven only) and part H
  (switch-jack feel pass — needs populated-switch hardware; storage,
  wire protocol and post-flash restore already bench-verified via the
  4.5.0→4.5.0 re-flash).
- **With-users passes:** #58 hard sip/puff (implemented and app-configurable
  as of 4.7.0 / this app change, but the action-mapping DEFAULTS — Drag on
  hard puff, Scroll on hard sip — remain an accessibility decision to confirm
  WITH affected users; the defaults are safe to change per-device from the
  app in the meantime); #43's dual-channel indicator with-users confirmation
  (bench-verified in 4.5.3, fill re-tested on the 4.5.3 build).
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
