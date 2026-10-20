// Practice peaks + suggest-from-practice (plotting/gauge.js): every pressure
// frame pins the largest sip/puff as gauge marks and readout values, the
// suggestion is 65% of each peak rounded to the 0.25 input granularity and
// clamped to the firmware range, readiness gates on the 2 hPa minimum
// (a suggestion clamped up from noise would be a lie), and the session reset
// clears stale peaks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document } = installGatingDom();
const { gaugeDelta, recalcGaugeRange, resetPracticePeaks, suggestThresholds, SUGGEST_FRACTION } =
  await import('../app/js/plotting/gauge.js');

const setThresholds = (sip, puff) => {
  document.getElementById('sipVal').textContent = sip;
  document.getElementById('puffVal').textContent = puff;
  recalcGaugeRange(); // derives gaugeRange and repositions every mark
};

test('peaks track the largest magnitude per side and pin as gauge marks', () => {
  setThresholds(4, 8); // range = 12
  gaugeDelta(-4.5);
  gaugeDelta(-3.0); // smaller: never lowers the peak
  gaugeDelta(12.25);
  assert.equal(document.getElementById('peakSipVal').textContent, '4.50');
  assert.equal(document.getElementById('peakPuffVal').textContent, '12.25');
  const sipPeak = document.getElementById('gaugeSipPeak');
  const puffPeak = document.getElementById('gaugePuffPeak');
  assert.equal(sipPeak.hidden, false);
  assert.equal(puffPeak.hidden, false);
  assert.equal(sipPeak.style.left, 50 - (4.5 / 12) * 50 + '%');
  assert.equal(puffPeak.style.left, '100%'); // 12.25 > range 12 → clamped at the edge
  assert.match(sipPeak.title, /Practice peak sip: 4\.50 hPa/);
});

test('sub-hPa noise never pins a mark or a readout', () => {
  resetPracticePeaks();
  gaugeDelta(0.4);
  assert.equal(document.getElementById('peakPuffVal').textContent, '\u2014');
  assert.equal(document.getElementById('gaugePuffPeak').hidden, true);
  // The peak is still tracked internally for the ≥2 readiness gate — but a
  // 0.4 hPa peak can never make a suggestion ready, so the readout stays
  // honest: "nothing worth showing".
  assert.equal(suggestThresholds().ready, false);
});

test('suggest computes 65% of each peak at 0.25 granularity, clamped to range', () => {
  assert.equal(SUGGEST_FRACTION, 0.65);
  resetPracticePeaks();
  gaugeDelta(-6.0);
  gaugeDelta(9.0);
  const s = suggestThresholds();
  assert.equal(s.ready, true);
  assert.equal(s.sip, 4); // 6.0 × 0.65 = 3.90 → nearest 0.25 step is 4.00
  assert.equal(s.puff, 5.75); // 9.0 × 0.65 = 5.85 → nearest 0.25 step is 5.75
});

test('suggestions round to the 0.25 input step and clamp at both ends', () => {
  resetPracticePeaks();
  gaugeDelta(-5.0); // 5 × 0.65 = 3.25 exactly
  gaugeDelta(149.99); // beyond the ceiling suggestion-wise: 97.49 → 97.5 is 0.25-granular
  const s = suggestThresholds();
  assert.equal(s.sip, 3.25);
  assert.equal(s.puff, 97.5);
});

test('readiness requires both peaks to reach the 2 hPa minimum', () => {
  resetPracticePeaks();
  gaugeDelta(-8);
  assert.equal(suggestThresholds().ready, false); // puff side missing
  gaugeDelta(1.9);
  assert.equal(suggestThresholds().ready, false); // puff under the minimum
  gaugeDelta(2.5);
  const s = suggestThresholds();
  assert.equal(s.ready, true);
  assert.equal(s.puff, 2); // 2.5 × 0.65 = 1.625 → rounds to 1.75 → clamped up to the 2 hPa minimum
});

test('resetPracticePeaks clears marks, readouts, and readiness', () => {
  resetPracticePeaks();
  gaugeDelta(-7.7);
  assert.equal(document.getElementById('peakSipVal').textContent, '7.70');
  resetPracticePeaks();
  assert.equal(document.getElementById('peakSipVal').textContent, '\u2014');
  assert.equal(document.getElementById('gaugeSipPeak').hidden, true);
  assert.equal(suggestThresholds().ready, false);
});
