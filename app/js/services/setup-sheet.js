// The printable device setup sheet: a paper one-pager for the handover that
// actually happens — a device moving between people, classrooms, or care
// homes. The support report is shaped for triage (log, redactions); this is
// shaped for a ring binder: thresholds, timing, safeguards, mappings, and
// the session's practice stats, with blank lines for the human details.
// Printing runs through a print-only block in the app page (no popup, so the
// CSP's style-src stays honest and it works offline the same).
import { $ } from '../ui/dom.js';
import { log } from './log.js';
import {
  APP_BUILD_ID,
  RESTRICTION_SETTINGS,
  SWITCH_SETTINGS,
  HARD_ACTION_SETTINGS,
  SWITCH_ACTION_OPTIONS,
} from '../config/constants.js';
import { collectSettingsExport } from './settings-export.js';
import { fmtPressure } from './pressure-units.js';
import { formatPracticeStats } from './practice-stats.js';

const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The action palette's label for a wire action number (unknown → honest "#n"). */
const actionLabel = (n) => (Number.isFinite(n) ? (SWITCH_ACTION_OPTIONS[n] ?? `Action #${n}`) : '—');

/**
 * Builds the sheet's inner HTML from the loaded settings. Holes (values that
 * did not load) print as "—" — visible, never invented.
 * @returns {string}
 */
export function buildSetupSheetHtml() {
  const data = collectSettingsExport();
  const s = data.settings;
  const holes = new Set(data.notLoaded);
  const has = (key) => key in s && !holes.has(key);
  const plain = (key) => (has(key) ? esc(String(s[key])) : '\u2014');
  const pressure = (key) => (has(key) ? esc(fmtPressure(Number(s[key]), { decimals: 2, withUnit: true })) : '\u2014');
  const ms = (key) => (has(key) ? esc(String(s[key]) + ' ms') : '\u2014');
  const rows = (pairs) =>
    pairs.map(([label, valueHtml]) => `<tr><th scope="row">${esc(label)}</th><td>${valueHtml}</td></tr>`).join('');
  const restrictionRows = RESTRICTION_SETTINGS.map((r) => {
    const state = has(r.jsonKey)
      ? s[r.jsonKey] === true
        ? 'On'
        : s[r.jsonKey] === false
          ? 'Off'
          : '\u2014'
      : '\u2014';
    return `<tr><th scope="row">${esc(r.label)}</th><td>${esc(state)}</td></tr>`;
  }).join('');
  const switchRows = SWITCH_SETTINGS.map((sw) => {
    const cells = has(sw.jsonKey) ? s[sw.jsonKey] : null;
    const text = Array.isArray(cells) ? cells.map((c) => actionLabel(Number(c))).join(' / ') : '\u2014';
    return `<tr><th scope="row">${esc(sw.jack + ' \u00b7 ' + sw.mode)}</th><td>${esc(text)}</td></tr>`;
  }).join('');
  const hardActionRows = HARD_ACTION_SETTINGS.map((a) => {
    const label = has(a.jsonKey) ? actionLabel(Number(s[a.jsonKey])) : '\u2014';
    return `<tr><th scope="row">${esc(a.label)}</th><td>${esc(label)}</td></tr>`;
  }).join('');
  const practice = formatPracticeStats().split('\n').map(esc).join('<br>');
  return `
    <h1>LipSync setup sheet</h1>
    <p class="sheet-meta">
      Printed ${esc(new Date().toLocaleDateString())} \u00b7 LipSync Connect ${esc(APP_BUILD_ID)}<br />
      Device identifier: redacted \u2014 record it here if needed: <span class="sheet-blank"></span>
    </p>
    <h2>Device</h2>
    <table><tbody>${rows([
      ['Model', plain('model')],
      ['Firmware', plain('firmwareVersion')],
    ])}</tbody></table>
    <h2>Pointer &amp; feedback</h2>
    <table><tbody>${rows([
      ['Cursor speed', plain('cursorSpeedLevel')],
      ['Cursor acceleration', plain('cursorAcceleration')],
      ['Scroll level', plain('scrollLevel')],
      ['Sound feedback', plain('soundFeedback')],
      ['Light feedback', plain('lightFeedback')],
      ['LED brightness', plain('ledBrightness')],
    ])}</tbody></table>
    <h2>Sip &amp; puff</h2>
    <table><tbody>${rows([
      ['Sip threshold', pressure('sipThresholdhPa')],
      ['Puff threshold', pressure('puffThresholdhPa')],
      ['Hard sip threshold', pressure('hardSipThresholdhPa')],
      ['Hard puff threshold', pressure('hardPuffThresholdhPa')],
    ])}${hardActionRows}</tbody></table>
    <h2>Hold timing</h2>
    <table><tbody>${rows([
      ['Short window', ms('inputWindowShortMs')],
      ['Long window', ms('inputWindowLongMs')],
      ['Max window', ms('inputWindowMaxMs')],
    ])}</tbody></table>
    <h2>Input safeguards</h2>
    <table><tbody>${restrictionRows}</tbody></table>
    <h2>External switch mappings</h2>
    <table><tbody>${switchRows}</tbody></table>
    <h2>Calibration (recorded values)</h2>
    <table><tbody>${rows([
      ['Neutral', plain('neutralPosition')],
      ['Corner 1', plain('calibrationCorner1')],
      ['Corner 2', plain('calibrationCorner2')],
      ['Corner 3', plain('calibrationCorner3')],
      ['Corner 4', plain('calibrationCorner4')],
    ])}</tbody></table>
    <h2>Practice (this session)</h2>
    <p>${practice}</p>
    <p class="sheet-foot">
      Values marked \u201c\u2014\u201d were not loaded from the device when this sheet was printed. Generated by
      LipSync Connect; not shared automatically. Notes: <span class="sheet-blank"></span>
    </p>
  `;
}

/** Generates the sheet into its print-only host and opens the print dialog. */
export function openSetupSheet() {
  const host = $('setupSheet');
  if (!host) return;
  host.innerHTML = buildSetupSheetHtml();
  window.print();
  log('Setup sheet generated for printing.', 'log-info');
}
