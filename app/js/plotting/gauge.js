// Sip/puff pressure gauge: fill position between the two threshold marks and
// the axis labels. Range derives from the largest threshold × 1.5. The gauge
// also watches practice: while any pressure data streams (live view, one-shot
// reads, the diagnostics panel), the largest sip and puff seen are kept —
// quietly, as data for suggestThresholds(), which turns them into trigger
// values at a fraction (the guesswork-killer for thresholds). The measured
// maxima surface only in the practice row's "Strongest so far" guide line;
// pinning them on the gauge as a second pair of dashed marks competed with
// the hard-band marks for the same "dashed thing beside the threshold" role.
import { METER_SEGMENTS } from '../config/constants.js';
import { $ } from '../ui/dom.js';
import { fmtPressure, onPressureUnitChange, renderPressureHints } from '../services/pressure-units.js';

let gaugeRange = null;
let gaugeLastDelta = null;
// Practice watch: the largest |Δ| reached on each side since the last
// Start-over (or session start). Zero = nothing seen yet. Internal data for
// suggestThresholds() — the practice row's guide line is the visible surface.
const practicePeaks = { sip: 0, puff: 0 };
// The suggest fraction: standard assistive-tech practice — a threshold far
// enough below a deliberate peak that a hold reliably crosses it, far enough
// above resting noise that breathing never triggers.
export const SUGGEST_FRACTION = 0.65;

export function updateCursorResponse(value) {
  const preview = $('cursorResponsePreview');
  const curve = $('cursorResponseCurve');
  const dot = $('cursorResponseDot');
  const text = $('cursorResponseText');
  const v = Number(value);
  if (!preview || !curve || !dot || !Number.isFinite(v)) {
    if (preview) preview.setAttribute('aria-label', 'Cursor response preview, waiting for acceleration setting');
    if (text) text.textContent = 'Load the device to preview its acceleration curve.';
    if (dot?.style) dot.style.opacity = '0';
    return;
  }

  // Positive acceleration lifts the curve above linear at gentle deflection;
  // negative acceleration bows it below linear for more fine control. Both
  // still meet at full output, matching the firmware's behavior.
  const clamped = Math.max(-10, Math.min(10, v));
  const exponent = Math.pow(2, -clamped / 10);
  const point = (t) => ({ x: 12 + t * 96, y: 88 - Math.pow(t, exponent) * 76 });
  const points = Array.from({ length: 17 }, (_, i) => point(i / 16));
  curve.setAttribute('d', points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' '));
  const marker = point(0.55);
  dot.setAttribute('cx', marker.x.toFixed(1));
  dot.setAttribute('cy', marker.y.toFixed(1));
  if (dot.style) dot.style.opacity = '1';

  const tone = clamped > 0 ? 'responsive' : clamped < 0 ? 'precision' : 'linear';
  const description =
    tone === 'responsive'
      ? 'Faster response from gentle joystick movement.'
      : tone === 'precision'
        ? 'More control at gentle joystick movement.'
        : 'Even, linear response across the joystick range.';
  if (preview.dataset && typeof preview.dataset === 'object') preview.dataset.response = tone;
  preview.setAttribute('aria-label', `Cursor response preview: acceleration ${clamped}; ${description}`);
  if (text) text.textContent = description;
}

export function updateMeter(id, value) {
  if (id === 'accelMeter') updateCursorResponse(value);
  const el = $(id);
  if (!el || !el.querySelectorAll) return;
  // The bipolar variant (cursor acceleration, -10..10) renders 20 segments
  // around a center zero instead of the plain left-anchored 0..10 fill.
  const bipolar = el.classList.contains('meter--bipolar');
  const total = bipolar ? METER_SEGMENTS * 2 : METER_SEGMENTS;
  let segments = el.querySelectorAll('span');
  while (segments.length < total) {
    el.appendChild(document.createElement('span'));
    segments = el.querySelectorAll('span');
  }
  while (segments.length > total) {
    el.removeChild(el.lastElementChild);
    segments = el.querySelectorAll('span');
  }
  if (!bipolar) {
    segments.forEach((seg, i) => seg.classList.toggle('on', i < Number(value)));
    return;
  }
  const v = Number(value);
  const mag = Number.isFinite(v) ? Math.min(Math.abs(v), METER_SEGMENTS) : 0;
  segments.forEach((seg, i) => {
    // The center zero sits between segments METER_SEGMENTS-1 and
    // METER_SEGMENTS; distance 1 is adjacent to it, growing outward.
    const dist = i < METER_SEGMENTS ? METER_SEGMENTS - i : i - METER_SEGMENTS + 1;
    const negativeSide = i < METER_SEGMENTS;
    seg.classList.toggle('on', dist <= mag && v < 0 === negativeSide);
  });
}

function setGaugeFill(el, delta) {
  if (!el || !el.style || !Number.isFinite(delta) || gaugeRange === null) return;
  const half = Math.min(Math.abs(delta) / gaugeRange, 1) * 50;
  el.style.left = (delta < 0 ? 50 - half : 50) + '%';
  el.style.width = half + '%';
}
export function gaugeDelta(delta) {
  // Peak tracking runs before the range guard: practice data can arrive
  // while thresholds are still loading (range not yet derived).
  if (Number.isFinite(delta)) notePracticeDelta(delta);
  if (!Number.isFinite(delta) || gaugeRange === null) return;
  gaugeLastDelta = delta;
  setGaugeFill($('gaugeFill'), delta);
  setGaugeFill($('diagGaugeFill'), delta);
  const gaugeEl = $('mainGauge');
  if (gaugeEl)
    gaugeEl.setAttribute(
      'aria-label',
      `Pressure gauge: sip fills left, puff fills right, thresholds marked in red. Current delta: ${fmtPressure(Math.abs(delta), { decimals: 1, withUnit: true })} ${delta < 0 ? '(sip)' : '(puff)'}.`,
    );
}

// ---- Practice watch ----------------------------------------------------------
// Every pressure frame flows through gaugeDelta (live stream frames and
// one-shot reads alike), so this single hook sees all practice data. The
// maxima stay internal (suggestThresholds' input); the practice row's guide
// line is their only user-facing surface, and Clear (and every fresh session)
// resets them.

function notePracticeDelta(delta) {
  if (delta < 0 && -delta > practicePeaks.sip) practicePeaks.sip = -delta;
  else if (delta > 0 && delta > practicePeaks.puff) practicePeaks.puff = delta;
  updatePracticeUi();
}

/**
 * Syncs the practice row with the measured maxima: the guide line narrates
 * the flow (practice → strongest-so-far → suggest), Suggest unlocks only
 * when both sides reached the 2 hPa minimum threshold, and Clear (Start
 * over) is live only while something is measured. Called by every peak
 * change AND after connects/loads — setCmdButtons re-enables every .cmd
 * button, so the readiness state must be re-asserted from data, not assumed.
 */
function updatePracticeUi() {
  const suggest = $('btnSuggestThresholds');
  const clear = $('btnClearPeaks');
  const ready = practicePeaks.sip >= 2 && practicePeaks.puff >= 2;
  const seen = practicePeaks.sip >= 1 || practicePeaks.puff >= 1;
  // The practice flow's only always-visible surface is this button pair:
  // Suggest stays locked until both sides are measured, Start-over until
  // something is. The how-to lives in the card's inline help.
  if (suggest) suggest.disabled = !ready;
  if (clear) clear.disabled = !seen;
}
export { updatePracticeUi as syncPracticeControls };

/** Session reset (fresh connect) and the Start-over button: no stale peak may
 *  survive into a new practice. */
export function resetPracticePeaks() {
  practicePeaks.sip = 0;
  practicePeaks.puff = 0;
  updatePracticeUi();
}

/**
 * The measured-maximum suggestion: 65% of each practice peak, rounded to the
 * threshold input's 0.25 granularity and clamped to the firmware's range.
 * ready is false until both peaks reach the 2 hPa minimum threshold — a
 * suggestion clamped up from noise would be a lie.
 */
export function suggestThresholds() {
  const round = (v) => Math.round(v * 4) / 4; // 0.25 granularity
  const one = (peak) => Math.min(149.99, Math.max(2, round(peak * SUGGEST_FRACTION)));
  const ready = practicePeaks.sip >= 2 && practicePeaks.puff >= 2;
  return {
    ready,
    sip: ready ? one(practicePeaks.sip) : 0,
    puff: ready ? one(practicePeaks.puff) : 0,
  };
}
export function recalcGaugeRange() {
  const sip = Number($('sipVal').textContent),
    puff = Number($('puffVal').textContent);
  // The hard thresholds (upstream #58) live beyond the regular ones; whenever
  // they have loaded, the gauge must be wide enough to show them.
  const hardSip = Number($('hardSipVal')?.textContent ?? ''),
    hardPuff = Number($('hardPuffVal')?.textContent ?? '');
  if (Number.isFinite(sip) && sip > 0 && Number.isFinite(puff) && puff > 0) {
    const span = [
      sip,
      puff,
      Number.isFinite(hardSip) && hardSip > 0 ? hardSip : 0,
      Number.isFinite(hardPuff) && hardPuff > 0 ? hardPuff : 0,
    ];
    gaugeRange = Math.max(...span) * 1.5;
  }
  gaugeMarks();
}
export function gaugeMarks() {
  if (gaugeRange === null) return;
  const sipEl = $('gaugeSipMark'),
    puffEl = $('gaugePuffMark');
  const sip = Number($('sipVal').textContent),
    puff = Number($('puffVal').textContent);
  if (sipEl && sipEl.style && Number.isFinite(sip) && sip > 0) {
    sipEl.style.left = 50 - Math.min(sip / gaugeRange, 1) * 50 + '%';
    sipEl.title = 'Sip triggers at \u2212' + fmtPressure(sip, { withUnit: true });
  }
  if (puffEl && puffEl.style && Number.isFinite(puff) && puff > 0) {
    puffEl.style.left = 50 + Math.min(puff / gaugeRange, 1) * 50 + '%';
    puffEl.title = 'Puff triggers at +' + fmtPressure(puff, { withUnit: true });
  }
  // Hard band markers (upstream #58): shown only once their values loaded
  // (hidden on older firmware, where the readouts stay at the placeholder).
  const markHard = (id, value, negative) => {
    const el = $(id);
    if (!el || !el.style) return;
    if (Number.isFinite(value) && value > 0) {
      el.hidden = false;
      el.style.left =
        (negative ? 50 - Math.min(value / gaugeRange, 1) * 50 : 50 + Math.min(value / gaugeRange, 1) * 50) + '%';
      el.title =
        'Hard ' +
        (negative ? 'sip' : 'puff') +
        ' triggers at ' +
        (negative ? '\u2212' : '+') +
        fmtPressure(value, { withUnit: true });
    } else {
      el.hidden = true;
    }
  };
  markHard('gaugeHardSipMark', Number($('hardSipVal')?.textContent ?? ''), true);
  markHard('gaugeHardPuffMark', Number($('hardPuffVal')?.textContent ?? ''), false);
  // With the practice marks gone, dashed means exactly one thing on this
  // gauge: the hard band. Say so beside the scale while its marks are shown
  // (hidden on older firmware, where the readouts stay at the placeholder).
  const legend = $('gaugeLegend');
  if (legend) {
    const sipMark = $('gaugeHardSipMark');
    const puffMark = $('gaugeHardPuffMark');
    const ghostsShown = suggestionGhosts !== null;
    const hardShown = !!(sipMark && !sipMark.hidden) || !!(puffMark && !puffMark.hidden);
    const parts = [];
    if (hardShown) parts.push('Dashed marks: the hard sip and hard puff triggers.');
    if (ghostsShown) parts.push('Translucent marks: the suggested values \u2014 Apply both writes them.');
    legend.hidden = parts.length === 0;
    if (parts.length) legend.textContent = parts.join(' ');
  }
  $('gaugeSipLabel').textContent = '\u2212' + fmtPressure(gaugeRange, { decimals: 1, withUnit: true });
  $('gaugePuffLabel').textContent = '+' + fmtPressure(gaugeRange, { decimals: 1, withUnit: true });
  // Permanent value labels beside the marks: the titles are hover-only, and
  // touch users (Android) have no hover. Sip/puff label the strip above the
  // gauge, hard thresholds the strip below.
  const label = (id, value, negative, shown) => {
    const el = $(id);
    if (!el) return;
    if (!shown || !Number.isFinite(value) || !(value > 0)) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.style.left =
      (negative ? 50 - Math.min(value / gaugeRange, 1) * 50 : 50 + Math.min(value / gaugeRange, 1) * 50) + '%';
    el.textContent = (negative ? '\u2212' : '+') + fmtPressure(value);
  };
  label('gaugeSipMarkLabel', sip, true, Number.isFinite(sip) && sip > 0);
  label('gaugePuffMarkLabel', puff, false, Number.isFinite(puff) && puff > 0);
  label('gaugeHardSipMarkLabel', Number($('hardSipVal')?.textContent ?? ''), true, !$('gaugeHardSipMark')?.hidden);
  label('gaugeHardPuffMarkLabel', Number($('hardPuffVal')?.textContent ?? ''), false, !$('gaugeHardPuffMark')?.hidden);
  // The ≈-annotations beside the hPa readouts follow the same values.
  renderPressureHints();
  // A range change moves the peak marks with the threshold marks.
  updatePracticeUi();
  positionSuggestionGhosts();
  if (gaugeLastDelta !== null) gaugeDelta(gaugeLastDelta);
}

/**
 * The suggestion notice's copy, in the display unit (the Apply button writes
 * the wire hPa values unchanged — s.sip/s.puff are wire values either way).
 * @param {{ sip: number, puff: number }} s
 */
export function formatSuggestion(s) {
  return (
    'Suggested: sip ' +
    fmtPressure(s.sip, { decimals: 2, withUnit: true }) +
    ', puff ' +
    fmtPressure(s.puff, { decimals: 2, withUnit: true }) +
    ' \u2014 65% of the measured strongest. A deliberate hold crosses them; breathing noise should not.'
  );
}

// ---- Suggestion ghosts -------------------------------------------------------
// The suggestion notice proposes thresholds in text; the ghost marks show
// the proposal ON the gauge — translucent, clearly not yet applied — so
// Apply both confirms something seen, not a leap of faith.
let suggestionGhosts = null; // { sip, puff } in wire hPa, or null

export function showSuggestionGhosts(sip, puff) {
  suggestionGhosts = { sip: Number(sip), puff: Number(puff) };
  if (gaugeRange !== null) gaugeMarks();
  else positionSuggestionGhosts();
}

export function hideSuggestionGhosts() {
  suggestionGhosts = null;
  for (const id of ['gaugeSipGhost', 'gaugePuffGhost']) {
    const el = $(id);
    if (el) el.hidden = true;
  }
  // The legend's ghost sentence dies with the ghosts.
  if (gaugeRange !== null) gaugeMarks();
}

function positionSuggestionGhosts() {
  const ids = [
    { id: 'gaugeSipGhost', side: 'sip', negative: true },
    { id: 'gaugePuffGhost', side: 'puff', negative: false },
  ];
  for (const { id, side, negative } of ids) {
    const el = $(id);
    if (!el) continue;
    const value = suggestionGhosts?.[side];
    if (suggestionGhosts === null || gaugeRange === null || !Number.isFinite(value) || !(value > 0)) {
      el.hidden = true;
      continue;
    }
    el.hidden = false;
    el.style.left =
      (negative ? 50 - Math.min(value / gaugeRange, 1) * 50 : 50 + Math.min(value / gaugeRange, 1) * 50) + '%';
  }
}

// A unit switch re-renders every converted surface from the same wire data:
// the gauge marks/scale/legend (annotations included) and the practice guide.
onPressureUnitChange(() => {
  if (gaugeRange !== null) gaugeMarks();
  else updatePracticeUi();
});
