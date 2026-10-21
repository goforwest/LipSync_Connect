// Practice metrics: the hold stream's completed holds, aggregated per side —
// count, average duration, spread (std dev), max — surfaced live in the Sip &
// Puff card and copyable as a compact block for clinical notes. For an OT,
// "sip consistency went from ±400 ms to ±150 ms across sessions" is therapy-
// progress evidence; the live ladder shows one hold at a time, the log line
// shows one hold after the fact, and nothing before this kept the session's
// shape. Session-scoped: reset with the port, never persisted — practice
// history is clinical record, and where it lives is the clinician's call.
import { $ } from '../ui/dom.js';
import { log } from './log.js';

/** @type {{ sip: number[], puff: number[] }} */
const holds = { sip: [], puff: [] };

/** Called by diag.js's hold tracker on each completed hold (release or
 *  hold-ended frame), with the device-measured duration. */
export function notePracticeHold(side, ms) {
  const key = side === 'puff' ? 'puff' : 'sip';
  if (!Number.isFinite(ms) || ms <= 0) return;
  holds[key].push(ms);
  renderPracticeStats();
}

/** Per-side aggregate. spread is the population std deviation, rounded to
 *  the nearest 10 ms — clinical display granularity, not false precision. */
export function practiceStats() {
  const one = (list) => {
    if (!list.length) return { count: 0, avg: 0, spread: 0, max: 0 };
    const avg = list.reduce((a, b) => a + b, 0) / list.length;
    const variance = list.reduce((a, b) => a + (b - avg) * (b - avg), 0) / list.length;
    return {
      count: list.length,
      avg: Math.round(avg),
      spread: Math.round(Math.sqrt(variance) / 10) * 10,
      max: Math.round(Math.max(...list)),
    };
  };
  return { sip: one(holds.sip), puff: one(holds.puff) };
}

const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : ms + ' ms');
const fmtSide = (label, s) =>
  s.count
    ? `${label}: ${s.count} hold${s.count === 1 ? '' : 's'} · avg ${fmtMs(s.avg)} · spread ±${s.spread} ms · max ${fmtMs(s.max)}`
    : null;

/** The live stats line (both sides, only those with holds). */
export function practiceStatsLine() {
  const s = practiceStats();
  return [fmtSide('Sip', s.sip), fmtSide('Puff', s.puff)].filter(Boolean).join(' &middot; ');
}

/** The copy-paste block for clinical notes: dated, versioned, plain text. */
export function formatPracticeStats() {
  const s = practiceStats();
  const date = new Date();
  const lines = [
    `LipSync practice — ${date.toLocaleDateString()}`,
    `Firmware ${($('version')?.textContent || '').trim() || 'unknown'}`,
  ];
  if (s.sip.count) lines.push(fmtSide('Sip', s.sip));
  if (s.puff.count) lines.push(fmtSide('Puff', s.puff));
  if (lines.length === 2) lines.push('No completed holds recorded.');
  return lines.join('\n');
}

/** Renders the stats row; visible once any hold completed. */
export function renderPracticeStats() {
  const row = $('practiceStatsRow');
  if (!row) return;
  const s = practiceStats();
  const any = s.sip.count > 0 || s.puff.count > 0;
  row.hidden = !any;
  if (!any) return;
  const text = $('practiceStatsText');
  if (text) text.textContent = practiceStatsLine().replace(/&middot;/g, '\u00b7');
}

/** Session reset (disconnect / fresh load): practice stats die with the port. */
export function resetPracticeStats() {
  holds.sip.length = 0;
  holds.puff.length = 0;
  const row = $('practiceStatsRow');
  if (row) row.hidden = true;
}

/** Copy wiring (main.js): the block goes to the clipboard for clinical notes. */
export async function copyPracticeStats() {
  const text = formatPracticeStats();
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(text);
    log('Practice stats copied to the clipboard.', 'log-info');
  } catch (e) {
    log('Practice stats could not be copied \u2014 ' + e.message + ' The block is in the session log.', 'log-err');
    log(text.split('\n').join(' | '), 'log-info');
  }
}
