# docs/ index

Read `STATUS.md` first — it is the one-screen live state and the only
file that must change whenever the state does. Everything else is a
dated log or ledger: accurate as of its date, extended with dated
updates rather than rewritten. Reading order:

1. `STATUS.md` — where things stand right now (firmware line, human
   steps, open items and why).
2. `roadmap.md` — the master ledger: every upstream issue → disposition
   → numbered roadmap item → dated Done note; the full 4.2.0 → 4.5.x
   improvement plan (originally `firmware-4.2.0-future-improvements.md`,
   renamed 2026-10-20 when it outgrew the name).
3. `4.5.x-followups.md` — the five follow-ups from the 4.5.0 validation
   cycle (all shipped, bench-confirmed) plus the zero-typing profile
   save.
4. `upstream-issue-comments.md` — paste-ready drafts for a maintainer to
   post on the upstream issues from the org account (what is fixed,
   what is not, and what each close waits on).
5. `bench-session-2026-10-16.md` — the raw bench log behind the
   4.5.0–4.5.2 cycle (findings, root causes, build/flash reference).
6. `4.4.0-hardware-validation-checklist.md` — the hardware validation
   checklist with per-part bench results (parts A–F passed; G and H
   still open).
7. `xensiv-migration-bench-protocol.md` — the
   do-not-merge-before-passing protocol for the XENSIV TLx493D
   migration (passed 2026-10-18/19; kept as the audit trail).
8. `firmware-update-future-improvements.md` — the firmware-update
   feature's follow-ups and its CI/release-pipeline validation record.
9. `history/` — the 2023 LipSync Connect scope and feature-list
   documents (`.docx` + `.pdf`). Provenance only, not current scope:
   the app long outgrew them, including most of what they marked
   "out of scope"; their two "Not Implemented" rows (rotation angle,
   tolerance values) are moot — no 4.x serial endpoint exists for
   either.
