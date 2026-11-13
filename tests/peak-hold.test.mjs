// Practice watch + suggest-from-practice (plotting/gauge.js): every pressure
// frame updates the largest sip/puff kept internally, the practice row's guide
// line is their user-facing surface (no gauge marks — dashed belongs to the
// hard band), the suggestion is 65% of each peak rounded to the 0.25 input
// granularity and clamped to the firmware range, Suggest stays disabled until
// BOTH sides reach the 2 hPa minimum (a suggestion clamped up from noise
// would be a lie), Start-over is live only while something is measured, and
// the session reset clears stale practice data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document } = installGatingDom();
const { gaugeDelta, recalcGaugeRange, resetPracticePeaks, suggestThresholds, syncPracticeControls, SUGGEST_FRACTION } =
  await import('../app/js/plotting/gauge.js');

const setThresholds = (sip, puff) => {
  document.getElementById('sipVal').textContent = sip;
  document.getElementById('puffVal').textContent = puff;
  recalcGaugeRange(); // derives gaugeRange and repositions every mark
};

const guide = () => document.getElementById('practiceGuide').textContent;
const suggestBtn = () => document.getElementById('btnSuggestThresholds');
const clearBtn = () => document.getElementById('btnClearPeaks');

test('peaks track the largest magnitude per side in the guide line', () => {
  setThresholds(4, 8); // range = 12
  gaugeDelta(-4.5);
  gaugeDelta(-3.0); // smaller: never lowers the peak
  gaugeDelta(12.25);
  assert.match(guide(), /Strongest so far: sip 4\.50 hPa · puff 12\.25 hPa/);
  // Ready state: Suggest unlocked, Start-over live.
  assert.equal(suggestBtn().disabled, false);
  assert.equal(clearBtn().disabled, false);
});

test('no gauge marks are pinned for practice — dashed belongs to the hard band', () => {
  setThresholds(4, 8);
  gaugeDelta(-9);
  gaugeDelta(9);
  // The hard marks are the only dashed pair the gauge owns (hidden here: no
  // hard values loaded), and the legend stays hidden with them.
  assert.equal(document.getElementById('gaugeHardSipMark').hidden, true);
  assert.equal(document.getElementById('gaugeHardPuffMark').hidden, true);
  assert.equal(document.getElementById('gaugeLegend').hidden, true);
});

test('sub-hPa noise changes nothing: the practice invitation stays up', () => {
  resetPracticePeaks();
  gaugeDelta(0.4);
  assert.match(guide(), /^Practice:/);
  // The 0.4 hPa peak is still tracked internally for the ≥2 readiness gate —
  // but it can never make a suggestion ready, so the row stays honest:
  // nothing worth showing, Suggest locked, Start-over pointless.
  assert.equal(suggestThresholds().ready, false);
  assert.equal(suggestBtn().disabled, true);
  assert.equal(clearBtn().disabled, true);
});

test('a one-sided practice asks for the other side and keeps Suggest locked', () => {
  resetPracticePeaks();
  gaugeDelta(-6.0);
  assert.match(guide(), /Strongest so far: sip 6\.00 hPa — practice the other side too\./);
  assert.equal(suggestBtn().disabled, true);
  gaugeDelta(9.0);
  assert.match(guide(), /Strongest so far: sip 6\.00 hPa · puff 9\.00 hPa/);
  assert.equal(suggestBtn().disabled, false);
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

test('resetPracticePeaks clears the guide, locks the buttons, and clears readiness', () => {
  resetPracticePeaks();
  gaugeDelta(-7.7);
  assert.match(guide(), /Strongest so far: sip 7\.70 hPa/);
  resetPracticePeaks();
  assert.match(guide(), /^Practice:/);
  assert.equal(suggestBtn().disabled, true);
  assert.equal(clearBtn().disabled, true);
  assert.equal(suggestThresholds().ready, false);
});

test('syncPracticeControls re-asserts readiness after setCmdButtons re-enabled the row', () => {
  resetPracticePeaks();
  suggestBtn().disabled = false; // as setCmdButtons(true) leaves every .cmd button
  clearBtn().disabled = false;
  syncPracticeControls();
  assert.equal(suggestBtn().disabled, true); // no practice data → locked again
  assert.equal(clearBtn().disabled, true);
  gaugeDelta(-4);
  gaugeDelta(4);
  syncPracticeControls();
  assert.equal(suggestBtn().disabled, false); // both sides ≥ 2 → unlocked
  assert.equal(clearBtn().disabled, false);
});
