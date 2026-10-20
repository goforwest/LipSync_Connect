// Health-check history: every run's outcome (passed / attention / error)
// plus its five step states persists as a bounded list in localStorage, and
// the Diagnostics card shows the trend — a device that passed for weeks and
// started warning is a degrading unit; the trend makes that visible before
// anyone feels it in the cursor. Per-run dots carry timestamps on hover.
import { $ } from '../ui/dom.js';
import { log } from './log.js';

const HISTORY_KEY = 'lipsync-health-history';
const HISTORY_MAX = 20;

/**
 * Called by health.js at each run's outcome. `steps` is the live per-cell
 * state map (id -> ok/warn/err) so a single failing step is visible in the
 * record, not just the aggregate.
 * @param {'passed'|'attention'|'error'} outcome
 * @param {Record<string, string>} steps
 */
export function recordHealthRun(outcome, steps) {
  const entry = {
    at: new Date().toISOString(),
    outcome,
    steps: { ...(steps || {}) },
    version: ($('version')?.textContent || '').trim(),
  };
  let list = [];
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    if (Array.isArray(raw)) list = raw;
  } catch {}
  list.push(entry);
  while (list.length > HISTORY_MAX) list.shift();
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {
    log('Health history could not be saved.', 'log-err');
  }
}

/** Renders the trend row (dots + a clear button). Indexed child access on
 *  both the real DOM and the test stub (the windows.js convention). */
export function renderHealthHistory() {
  const row = $('healthHistory');
  if (!row) return;
  let list = [];
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    if (Array.isArray(raw)) list = raw.filter((e) => e && e.at && e.outcome);
  } catch {}
  if (!list.length) {
    while (row.children?.length) row.removeChild(row.children[row.children.length - 1]);
    row.hidden = true;
    return;
  }
  while (row.children?.length) row.removeChild(row.children[row.children.length - 1]);
  const label = document.createElement('span');
  label.className = 'hint health-history-label';
  label.textContent = 'History (latest last):';
  row.appendChild(label);
  for (const entry of list) {
    const dot = document.createElement('span');
    dot.className =
      'health-dot health-dot--' + (entry.outcome === 'passed' ? 'ok' : entry.outcome === 'error' ? 'err' : 'warn');
    let when = '';
    try {
      when = new Date(entry.at).toLocaleString();
    } catch {}
    const stepNotes = Object.entries(entry.steps || {})
      .filter(([, st]) => st && st !== 'ok' && st !== 'running')
      .map(([id, st]) => id.replace(/^hc/, '') + ' ' + st)
      .join(', ');
    dot.title =
      (when ? when : entry.at) + (stepNotes ? ' — ' + stepNotes : '') + (entry.version ? ' — fw ' + entry.version : '');
    row.appendChild(dot);
  }
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'secondary health-history-clear';
  clear.textContent = 'Clear history';
  clear.addEventListener('click', resetHealthHistory);
  row.appendChild(clear);
  row.hidden = false;
}

/** Clears the stored history and hides the row. */
export function resetHealthHistory() {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {}
  const row = $('healthHistory');
  if (row) row.hidden = true;
}
