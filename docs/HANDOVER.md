# Handover — owning LipSync Connect

For the next maintainer. `STATUS.md` answers "where are we"; this answers
"what do you need to know to own this". Written 2026-11-13.

## What this is

A browser-based configuration and monitoring tool for the LipSync (an
assistive sip/puff joystick mouse): a static site with no backend — Web
Serial on desktop Chromium, a WebUSB fallback on Android, offline-capable
through a service worker. Part of the OpenAT Joystick Project by Makers
Making Change (a program of Neil Squire). The firmware it talks to lives in
the org's `LipSync` repo; this app tracks its wire protocol from 4.1.0 to
current.

## First hour

- Root `README.md` has dev setup, the quality-check commands, and deploy.
- Verify a checkout with the gates (from `dev/`): `npm run lint`,
  `lint:css`, `lint:html`, `format:check`, `typecheck`, `npm test`,
  `npm run test:e2e`, `npm run test:browser-audit` (needs Playwright
  Chromium: `npm --prefix dev exec playwright-core install chromium`).
- The full suite takes ~3.5 minutes; `tests/dfu-wizard.test.mjs` alone is
  most of that (it drives a complete simulated flash). That file is the
  long pole — a slow suite is not a hang.
- CI (`.github/workflows/ci.yml`) runs all of it on every push. Node 22.22+
  (or 24.8+) for the dev tooling; the deployed app has no Node runtime.

## The five rules that keep this codebase honest

1. **`app/js/config/constants.js` is the single source of truth.** Version
   gates, action palettes, live-stream modes, timeouts — everything reads
   the one copy, and the firmware↔app protocol cross-check reads it too. A
   second local constant can silently drift from the gate.
2. **The module graph stays acyclic.** `serial/` never imports `plotting/`
   or UI layout code; endpoint renderers register into
   `services/registry.js`; `main.js` is the composition root that wires
   cross-module hooks.
3. **The device is the truth.** Every write re-syncs from the device's
   answer; a rejected write reverts the control to the last confirmed value
   (the selects' `dataset.applied` pattern). New controls inherit this —
   a control that shows a value the device refused is a bug.
4. **User-facing strings are pinned by tests.** A copy change and its test
   updates land in the same commit; grep `tests/` for the string first.
5. **Markup, styles, controller, and cache ship together.** Bump the
   service worker `CACHE` constant (`lipsync-connect-vNN`) whenever
   `index.html`, `styles.css`, or the worker itself change in a user-visible
   way; stale-while-revalidate keeps returning users current, and the
   update toast (ui/update-toast.js) tells a mid-session user when a deploy
   landed.

## Conventions worth copying

- **Version-gated features** use the shared note contract in
  `app/js/ui/firmware-gate.js`: locked readout, an honest reason, and a
  working link straight into Updates. Don't hand-roll the sentence.
- **Settings selects write on change** with revert; selects are enabled only
  by a device answer and disabled with the session. The explicit-button
  exception is the operating-mode control (a mode change restarts the
  device — the button is the deliberate speed bump).
- **The detailed log is a support artifact.** High-frequency polls must use
  the quiet-exchange machinery in `serial/commands.js`; per-frame logging
  flooded the panel and capped the exported log once already.
- **Accessibility is load-bearing, not polish:** 150% UI-scale geometry is
  checked at a 390 px viewport in the browser audit; live regions announce
  once per action and never per stream frame; every export redacts the
  device identifier (`services/log-export.js`).

## Verified vs simulator-proven

The live lists live in `STATUS.md` ("Human steps remaining" and "Still
open, and why"). The standing shape as of this writing:

- Bench-verified: settings storage/restore, the wire protocol, the update +
  settings-restore cycle, the Hub mirror, calibration, the hard-band clamp/
  heal, the 4.5.0→4.5.0 re-flash.
- Simulator-proven, needs hardware: the Android/OTG flash session (bench
  window G) and the switch-jack feel pass (H) — see
  `4.4.0-hardware-validation-checklist.md`.
- Decisions that need users, not code: the hard-band action DEFAULTS
  (upstream #58 — safe to change per-device from the app meanwhile) and
  #43's dual-channel indicator.
- An affected unit is still wanted for #54 mechanical drift.

## When something breaks

- **Settings incomplete / failed:** Refresh all settings; two consecutive
  handshake failures from a fresh session are classified as a dead link
  with recovery guidance automatically.
- **Update interrupted:** the recovery flow in Updates; the stranded marker
  persists across page reloads (sessionStorage), and its history — including
  the accepted-risk signing decision — is in
  `firmware-update-future-improvements.md`.
- **A version gate fires wrongly:** check `tests/firmware-compat.test.mjs`
  first — it pins the whole span in one place and its failures usually name
  the tier map entry.

## People

Upstream issue posts go out from the org account; paste-ready drafts sit in
`upstream-issue-comments.md`. Makers Making Change / Neil Squire own the
device side and the user relationships; this repo's issues mirror the
upstream list in `roadmap.md`.
