// Health-check history: every run's outcome (passed / attention / error)
// plus its five step states persists as a bounded list in localStorage, and
// the Diagnostics card shows the trend — a device that passed for weeks and
// started warning is a degrading unit; the trend makes that visible before
// anyone feels it in the cursor. Per-run dots carry timestamps on hover.
import { $ } from '../ui/dom.js';
import { log } from './log.js';

const HISTORY_KEY = 'lipsync-health-history';
const HISTORY_MAX = 20;
const OUTCOMES = new Set(['passed', 'attention', 'error']);
const STEP_STATES = new Set(['ok', 'warn', 'err', 'running', 'idle']);

/**
 * localStorage is user-writable and can outlive app upgrades. Only records
 * with a real outcome, a parseable timestamp, and scalar step states are
 * rendered; anything else would poison the trend row (invalid dates throw,
 * object steps stringify to "[object Object]" in the tooltip).
 * @param {any} raw
 */
function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const outcome = typeof raw.outcome === 'string' ? raw.outcome.trim() : '';
  if (!OUTCOMES.has(outcome)) return null;
  const at = typeof raw.at === 'string' && Number.isFinite(Date.parse(raw.at)) ? raw.at : '';
  if (!at) return null;
  const steps = {};
  if (raw.steps && typeof raw.steps === 'object' && !Array.isArray(raw.steps)) {
    for (const [id, state] of Object.entries(raw.steps)) {
      if (!/^hc[A-Za-z0-9]+$/.test(id) || !STEP_STATES.has(String(state))) continue;
      steps[id] = String(state);
    }
  }
  const version = typeof raw.version === 'string' ? raw.version.trim().slice(0, 20) : '';
  // Value-level drift metrics (neutral offset, weakest corner, bus recovery
  // count): finite, non-negative numbers on a fixed key whitelist — the same
  // treatment every other field gets.
  const metrics = {};
  if (raw.metrics && typeof raw.metrics === 'object' && !Array.isArray(raw.metrics)) {
    for (const key of ['neutral', 'cornerMin', 'busRecoveries']) {
      const v = Number(raw.metrics[key]);
      if (Number.isFinite(v) && v >= 0) metrics[key] = v;
    }
  }
  return Object.keys(metrics).length ? { at, outcome, steps, version, metrics } : { at, outcome, steps, version };
}

/** @returns {{at: string, outcome: string, steps: Record<string, string>, version: string}[]} */
function readHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.map(sanitizeEntry).filter(Boolean).slice(-HISTORY_MAX);
  } catch {
    return [];
  }
}

/**
 * Called by health.js at each run's outcome. `steps` is the live per-cell
 * state map (id -> ok/warn/err) so a single failing step is visible in the
 * record, not just the aggregate.
 * @param {'passed'|'attention'|'error'} outcome
 * @param {Record<string, string>} steps
 * @param {{neutral?: number, cornerMin?: number, busRecoveries?: number}} [metrics]
 */
export function recordHealthRun(outcome, steps, metrics) {
  const entry = {
    at: new Date().toISOString(),
    outcome,
    steps: { ...(steps || {}) },
    version: ($('version')?.textContent || '').trim(),
  };
  if (metrics && typeof metrics === 'object') {
    // Only finite numbers survive — a refused/malformed read records
    // nothing rather than a lie.
    const clean = {};
    for (const key of ['neutral', 'cornerMin', 'busRecoveries']) {
      const v = Number(metrics[key]);
      if (Number.isFinite(v)) clean[key] = v;
    }
    if (Object.keys(clean).length) entry.metrics = clean;
  }
  const list = readHistory();
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
  const list = readHistory();
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
    const when = new Date(entry.at).toLocaleString();
    const stepNotes = Object.entries(entry.steps)
      .filter(([, st]) => st !== 'ok' && st !== 'running')
      .map(([id, st]) => id.replace(/^hc/, '') + ' ' + st)
      .join(', ');
    const detail = when + (stepNotes ? ' — ' + stepNotes : '') + (entry.version ? ' — fw ' + entry.version : '');
    dot.title = detail;
    // A bare colored dot is invisible to keyboard and screen-reader users.
    // Expose each result as an image with the same text the sighted user gets
    // on hover, without adding pointer-only affordances.
    dot.tabIndex = 0;
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', 'Health check ' + entry.outcome + ' — ' + detail);
    row.appendChild(dot);
  }
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'secondary health-history-clear';
  clear.textContent = 'Clear history';
  clear.addEventListener('click', resetHealthHistory);
  row.appendChild(clear);
  // The drift line — value-level trend, with restraint: ONE line comparing
  // the latest metrics to the first recorded run, not a chart (the card is
  // dense; direction is the signal, precision lives in the support export).
  const drift = driftLine(list);
  if (drift) {
    const note = document.createElement('span');
    note.className = 'hint health-drift';
    note.textContent = drift;
    row.appendChild(note);
  }
  row.hidden = false;
}

/** @returns {string|null} e.g. "Drift since first run: neutral +0.4 · corners −1.2" */
function driftLine(list) {
  const withMetrics = list.filter((e) => e.metrics && e.metrics.neutral !== undefined);
  if (withMetrics.length < 2) return null;
  const first = withMetrics[0].metrics;
  const last = withMetrics[withMetrics.length - 1].metrics;
  const parts = [];
  const dNeutral = Math.round((last.neutral - first.neutral) * 100) / 100;
  if (dNeutral) parts.push(`neutral ${dNeutral > 0 ? '+' : ''}${dNeutral}`);
  if (first.cornerMin !== undefined && last.cornerMin !== undefined) {
    const dCorner = Math.round((last.cornerMin - first.cornerMin) * 100) / 100;
    if (dCorner) parts.push(`corners ${dCorner > 0 ? '+' : ''}${dCorner}`);
  }
  if (!parts.length) return 'Drift since first run: none measured.';
  return `Drift since first run: ${parts.join(' \u00b7 ')}.`;
}

/** Clears the stored history and hides the row. */
export function resetHealthHistory() {
  // The Clear button disappears with the row; without moving focus the
  // keyboard user is dropped on <body>. The Run button is the nearest action.
  const hadFocus = !!document.activeElement?.classList?.contains?.('health-history-clear');
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {}
  const row = $('healthHistory');
  if (row) {
    while (row.children?.length) row.removeChild(row.children[row.children.length - 1]);
    row.hidden = true;
  }
  if (hadFocus) $('btnRunDiagnostics')?.focus?.();
}

/**
 * The drift line's raw material: distance of the stored neutral from the
 * electrical center, and the weakest calibration corner's magnitude — both
 * parsed from the values the health check already read (IN and CA). The bus
 * recovery count rides along when BH answered. Pure; null fields on malformed
 * input.
 * @param {string} neutralValue IN's answer ("x|y")
 * @param {string} calValue CA's answer ("center,corner1..corner4", x|y pairs)
 * @param {string} [busValue] BH's answer (recoveries first)
 */
export function parseHealthMetrics(neutralValue, calValue, busValue) {
  const point = (pair) => {
    const [x, y] = String(pair || '')
      .split('|')
      .map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return Math.hypot(x, y);
  };
  const metrics = /** @type {{neutral?: number, cornerMin?: number, busRecoveries?: number}} */ ({});
  const neutral = point(neutralValue);
  if (neutral !== null) metrics.neutral = Math.round(neutral * 100) / 100;
  const parts = String(calValue || '').split(',');
  if (parts.length === 5) {
    const corners = parts
      .slice(1)
      .map(point)
      .filter((m) => m !== null);
    if (corners.length === 4) metrics.cornerMin = Math.round(Math.min(...corners) * 100) / 100;
  }
  if (busValue !== undefined) {
    const recoveries = Number(String(busValue || '').split(',')[0]);
    if (Number.isFinite(recoveries)) metrics.busRecoveries = recoveries;
  }
  return metrics;
}
