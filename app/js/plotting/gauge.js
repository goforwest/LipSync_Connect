// Sip/puff pressure gauge: fill position between the two threshold marks and
// the axis labels. Range derives from the largest threshold × 1.5. The gauge
// also carries the practice-peak hold: while any pressure data streams (live
// view, one-shot reads, the diagnostics panel), the largest sip and puff seen
// pin as a second pair of marks — the needle passes, the peak stays — and
// suggestThresholds() turns those measured peaks into trigger values at a
// fraction of them (the guesswork-killer for thresholds).
import { METER_SEGMENTS } from '../config/constants.js';
import { fmtHpa } from '../utils/format.js';
import { $ } from '../ui/dom.js';

let gaugeRange = null;
let gaugeLastDelta = null;
// Practice peaks: the largest |Δ| reached on each side since the last Clear
// (or session start). Zero = nothing seen yet.
const practicePeaks = { sip: 0, puff: 0 };
// The suggest fraction: standard assistive-tech practice — a threshold far
// enough below a deliberate peak that a hold reliably crosses it, far enough
// above resting noise that breathing never triggers.
export const SUGGEST_FRACTION = 0.65;

export function updateMeter(id, value) {
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
      `Pressure gauge: sip fills left, puff fills right, thresholds marked in red. Current delta: ${Math.abs(delta).toFixed(1)} hPa ${delta < 0 ? '(sip)' : '(puff)'}.`,
    );
}

// ---- Practice peaks ----------------------------------------------------------
// Every pressure frame flows through gaugeDelta (live stream frames and
// one-shot reads alike), so this single hook sees all practice data. Peaks
// pin on the gauge as dashed marks beside the solid threshold marks and
// surface in the card's readout; Clear (and every fresh session) resets them.

function notePracticeDelta(delta) {
  if (delta < 0 && -delta > practicePeaks.sip) practicePeaks.sip = -delta;
  else if (delta > 0 && delta > practicePeaks.puff) practicePeaks.puff = delta;
  updatePracticeUi();
}

function renderPeakMark(id, peak, side) {
  const el = $(id);
  if (!el || !el.style) return;
  if (gaugeRange === null || !(peak >= 1)) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const clamped = Math.min(peak / gaugeRange, 1) * 50;
  el.style.left = (side === 'sip' ? 50 - clamped : 50 + clamped) + '%';
  el.title = `Practice peak ${side}: ${fmtHpa(peak)} hPa`;
}

function updatePracticeUi() {
  renderPeakMark('gaugeSipPeak', practicePeaks.sip, 'sip');
  renderPeakMark('gaugePuffPeak', practicePeaks.puff, 'puff');
  const sipOut = $('peakSipVal');
  const puffOut = $('peakPuffVal');
  if (sipOut) sipOut.textContent = practicePeaks.sip >= 1 ? fmtHpa(practicePeaks.sip) : '\u2014';
  if (puffOut) puffOut.textContent = practicePeaks.puff >= 1 ? fmtHpa(practicePeaks.puff) : '\u2014';
  const suggest = $('btnSuggestThresholds');
  if (suggest) suggest.hidden = !(practicePeaks.sip >= 2 && practicePeaks.puff >= 2);
}

/** Session reset (fresh connect) and the Clear button: no stale peak may
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
  return { ready, sip: ready ? one(practicePeaks.sip) : 0, puff: ready ? one(practicePeaks.puff) : 0 };
}
export function recalcGaugeRange() {
  const sip = Number($('sipVal').textContent),
    puff = Number($('puffVal').textContent);
  if (Number.isFinite(sip) && sip > 0 && Number.isFinite(puff) && puff > 0) gaugeRange = Math.max(sip, puff) * 1.5;
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
    sipEl.title = 'Sip triggers at \u2212' + sip + ' hPa';
  }
  if (puffEl && puffEl.style && Number.isFinite(puff) && puff > 0) {
    puffEl.style.left = 50 + Math.min(puff / gaugeRange, 1) * 50 + '%';
    puffEl.title = 'Puff triggers at +' + puff + ' hPa';
  }
  $('gaugeSipLabel').textContent = '\u2212' + gaugeRange.toFixed(1) + ' hPa';
  $('gaugePuffLabel').textContent = '+' + gaugeRange.toFixed(1) + ' hPa';
  // A range change moves the peak marks with the threshold marks.
  updatePracticeUi();
  if (gaugeLastDelta !== null) gaugeDelta(gaugeLastDelta);
}
