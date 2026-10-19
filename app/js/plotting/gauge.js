// Sip/puff pressure gauge: fill position between the two threshold marks and
// the axis labels. Range derives from the largest threshold × 1.5.
import { METER_SEGMENTS } from '../config/constants.js';
import { $ } from '../ui/dom.js';

let gaugeRange = null;
let gaugeLastDelta = null;

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
  if (gaugeLastDelta !== null) gaugeDelta(gaugeLastDelta);
}
