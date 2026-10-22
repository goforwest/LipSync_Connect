// Inline write confirmation + undo: every simple settings write confirms in
// place ("✓ Cursor speed level 5 → 6 · Undo") instead of only in the Log
// card, and the previous value is one click away — the app already holds it
// (it was the readout an instant before the write). The interception is
// central: device.js snapshots the pre-write control state before the
// endpoint renderers replace it and commits it here after they land, so
// every write path — buttons, steppers, suggested thresholds, the Hub-menu
// MANUAL pushes' inverse — gets the same treatment without per-handler work.
//
// Excluded by design: reads (cmd ,0), MANUAL pushes (the device changed a
// setting, not the user's click — those already have their own sync), and
// the non-settings flows (SR/FR/UM/OM/CM/IN/CA/RT/CH) that already carry
// their own confirmations and where "undo" is meaningless (you cannot undo a
// reboot). Undo of an undo is a feature, not a bug: the restore write is
// itself a write, so its chip offers the way back — effectively redo.
import { $ } from '../ui/dom.js';
import { sendCommand } from '../serial/commands.js';
import { log } from './log.js';
import {
  STEP_TARGETS,
  WINDOW_SETTINGS,
  RESTRICTION_SETTINGS,
  SWITCH_SETTINGS,
  VALUE_LABELS,
  SWITCH_ACTION_PACK_BASE,
  FEEDBACK_MODES,
  DEBUG_MODES,
} from '../config/constants.js';
import { fmtApiFloat, fmtHpa } from '../utils/format.js';

const CHIP_VISIBLE_MS = 4000;

let suppressed = false; // batch restores must not spam a chip per write
let hideTimer = 0;
let undoCmd = null;
/** Endpoint -> pending writes that must not confirm (app-driven, not user edits). */
const quietWrites = new Map();

/** @param {boolean} on — while true, noteSettingWrite is a no-op. */
export function setWriteConfirmSuppressed(on) {
  suppressed = !!on;
}

/**
 * Silences the confirmation chip for the next successful write to one
 * endpoint. Auto-live starts/stops the diagnostic stream on section changes;
 * that is app housekeeping, not a user edit, so it must not raise a toast
 * (or an Undo that would silently kill the stream). Targeted rather than the
 * global batch suppression so a user write in flight is never swallowed.
 * @param {string} endpoint two-letter endpoint code
 */
export function suppressNextWriteConfirm(endpoint) {
  quietWrites.set(endpoint, (quietWrites.get(endpoint) ?? 0) + 1);
}

/** Drops a pending quiet marker after the app-driven write failed (no ack
 *  will ever arrive to consume it). */
export function clearWriteConfirmSuppression(endpoint) {
  quietWrites.delete(endpoint);
}

// ---- The endpoint table: what to confirm, where the old value lives -------
// Built from the same constants the renderers use, so labels and controls
// cannot drift. kind decides how the old display value is read and how the
// undo wire value is reconstructed:
//   int    — readout span, wire = its text (speed/scroll/accel/windows)
//   hpa    — readout span, wire = fmtApiFloat (thresholds' 2-decimal form)
//   float  — readout span, wire = fmtApiFloat (deadzones)
//   mode   — readout span for display, the select holds the wire value
//   bool   — restriction checkbox, wire 1/0
//   switch — the three selects hold the old triple; undo re-packs it
/** @type {Record<string, {label: string, kind: string, valueId?: string, selectId?: string, checkboxId?: string, selectPrefix?: string, modes?: Record<string, string>}>} */
const ENDPOINTS = (() => {
  const t = {};
  for (const cfg of Object.values(STEP_TARGETS))
    t[cfg.endpoint] = { label: VALUE_LABELS[cfg.valueId], kind: 'int', valueId: cfg.valueId };
  t.ST = { label: VALUE_LABELS.sipVal, kind: 'hpa', valueId: 'sipVal' };
  t.PT = { label: VALUE_LABELS.puffVal, kind: 'hpa', valueId: 'puffVal' };
  t.IZ = { label: VALUE_LABELS.innerDeadzoneVal, kind: 'float', valueId: 'innerDeadzoneVal' };
  t.OZ = { label: VALUE_LABELS.outerDeadzoneVal, kind: 'float', valueId: 'outerDeadzoneVal' };
  t.SM = {
    label: VALUE_LABELS.soundModeVal,
    kind: 'mode',
    valueId: 'soundModeVal',
    selectId: 'soundMode',
    modes: FEEDBACK_MODES,
  };
  t.LM = {
    label: VALUE_LABELS.lightModeVal,
    kind: 'mode',
    valueId: 'lightModeVal',
    selectId: 'lightMode',
    modes: FEEDBACK_MODES,
  };
  t.DM = {
    label: VALUE_LABELS.debugModeVal,
    kind: 'mode',
    valueId: 'debugModeVal',
    selectId: 'debugMode',
    modes: DEBUG_MODES,
  };
  for (const w of WINDOW_SETTINGS) t[w.endpoint] = { label: VALUE_LABELS[w.valueId], kind: 'int', valueId: w.valueId };
  for (const r of RESTRICTION_SETTINGS) t[r.endpoint] = { label: r.label, kind: 'bool', checkboxId: r.checkboxId };
  for (const s of SWITCH_SETTINGS)
    t[s.endpoint] = { label: `${s.jack} ${s.mode} mapping`, kind: 'switch', selectPrefix: s.selectPrefix };
  return t;
})();

/**
 * device.js's pre-render snapshot: reads whatever the control holds NOW —
 * the renderers overwrite it a moment later. Returns null for endpoints
 * that carry no confirmation (reads, mode flows, diagnostics, calibrations).
 * @param {string} endpoint two-letter endpoint code
 * @param {string} cmd full response cmd ("SS,1") — write responses only
 * @returns {{commit: (value: string) => void}|null}
 */
export function captureWriteConfirm(endpoint, cmd) {
  if (suppressed) return null;
  const cfg = ENDPOINTS[endpoint];
  if (!cfg || !cmd.endsWith(',1')) return null;
  const quiet = quietWrites.get(endpoint) ?? 0;
  if (quiet > 0) {
    if (quiet === 1) quietWrites.delete(endpoint);
    else quietWrites.set(endpoint, quiet - 1);
    return null;
  }
  let oldDisplay = null;
  let oldWire = null;
  if (cfg.kind === 'int' || cfg.kind === 'hpa' || cfg.kind === 'float') {
    const text = String($(cfg.valueId)?.textContent ?? '').trim();
    const n = Number(text);
    if (Number.isFinite(n)) {
      oldDisplay = text;
      oldWire = cfg.kind === 'int' ? text : fmtApiFloat(n);
    }
  } else if (cfg.kind === 'mode') {
    oldDisplay = String($(cfg.valueId)?.textContent ?? '').trim();
    oldWire = String($(cfg.selectId)?.value ?? '').trim() || null;
  } else if (cfg.kind === 'bool') {
    const checked = !!$(cfg.checkboxId)?.checked;
    oldDisplay = checked ? 'On' : 'Off';
    oldWire = checked ? '1' : '0';
  } else if (cfg.kind === 'switch') {
    const cells = [0, 1, 2].map((i) => parseInt($(cfg.selectPrefix + i)?.value, 10));
    if (cells.every((c) => Number.isFinite(c))) {
      oldWire = String(SWITCH_ACTION_PACK_BASE + cells[0] * 10000 + cells[1] * 100 + cells[2]);
    }
  }
  return {
    /** After the renderers landed the new device truth, show the chip. */
    commit(value) {
      showChip(cfg, value, oldDisplay, oldWire == null ? null : `${endpoint},1:${oldWire}`);
    },
  };
}

function newDisplay(cfg, value) {
  if (cfg.kind === 'hpa') return fmtHpa(value);
  if (cfg.kind === 'mode') return String(cfg.modes?.[value] ?? value);
  if (cfg.kind === 'bool') return value === '1' ? 'On' : 'Off';
  if (cfg.kind === 'switch') return null; // a triple has no honest one-line form — "updated"
  return String(value); // int / float echo their own display
}

function hideChip() {
  const chip = $('writeConfirm');
  const undoBtn = $('btnWriteUndo');
  clearTimeout(hideTimer);
  hideTimer = 0;
  if (chip) chip.hidden = true;
  if (undoBtn) undoBtn.hidden = true;
}

function armChipHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideChip, CHIP_VISIBLE_MS);
}

/** Hover/focus pauses the 4 s countdown: a keyboard user tabbing to Undo must
 *  not have the control vanish underneath them, and a reader pausing on the
 *  confirmation should be able to finish reading it. */
function pauseChipHide() {
  clearTimeout(hideTimer);
  hideTimer = 0;
}

function resumeChipHide() {
  if ($('writeConfirm')?.hidden === false) armChipHide();
}

function showChip(cfg, value, oldDisplay, cmd) {
  const chip = $('writeConfirm');
  const textEl = $('writeConfirmText');
  const undoBtn = $('btnWriteUndo');
  if (!chip || !textEl) return;
  const shown = newDisplay(cfg, value);
  const detail = shown ? (oldDisplay ? ` ${oldDisplay} \u2192 ${shown}` : ` \u2192 ${shown}`) : ' updated';
  textEl.textContent = `\u2713 ${cfg.label}${detail}`;
  undoCmd = cmd;
  if (undoBtn) undoBtn.hidden = !cmd;
  chip.hidden = false;
  armChipHide();
}

/** Session reset (disconnect / fresh load): a stale undo must never survive
 *  into a new session — the device it pointed at is gone. */
export function hideWriteConfirm() {
  const chip = $('writeConfirm');
  const undoBtn = $('btnWriteUndo');
  clearTimeout(hideTimer);
  hideTimer = 0;
  undoCmd = null;
  if (chip) chip.hidden = true;
  if (undoBtn) undoBtn.hidden = true;
}

/** Bound once from main.js — the chip's single Undo button. */
export function bindWriteConfirm() {
  const chip = $('writeConfirm');
  if (chip) {
    chip.addEventListener('mouseenter', pauseChipHide);
    chip.addEventListener('mouseleave', resumeChipHide);
    chip.addEventListener('focusin', pauseChipHide);
    chip.addEventListener('focusout', (e) => {
      if (!chip.contains?.(e.relatedTarget)) resumeChipHide();
    });
  }
  const undoBtn = $('btnWriteUndo');
  if (!undoBtn) return;
  undoBtn.addEventListener('click', () => {
    if (!undoCmd) return;
    const cmd = undoCmd;
    undoCmd = null;
    sendCommand(cmd).catch((e) => {
      const textEl = $('writeConfirmText');
      if (textEl) textEl.textContent = `Undo failed \u2014 ${e.message}`;
      log('Undo of ' + cmd + ' failed \u2014 ' + e.message, 'log-err');
    });
  });
}
