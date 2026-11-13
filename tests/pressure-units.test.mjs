// Pressure display units (services/pressure-units.js): the cmH2O preference
// converts the READING surfaces — gauge titles/scale, practice guide line,
// suggestion copy, and the ≈-annotations — while the wire values, the
// suggest/apply path, and every EDITABLE control stay hPa-native. The hPa
// default must keep the pre-preference strings byte-identical.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document } = installGatingDom();
const {
  fmtPressure,
  pressureHintText,
  getPressureUnit,
  setPressureUnit,
  initPressureUnits,
  toDisplayPressure,
  PRESSURE_UNIT_STORAGE_KEY,
  HPA_PER_CMH2O,
} = await import('../app/js/services/pressure-units.js');
const { recalcGaugeRange, gaugeDelta, suggestThresholds, formatSuggestion, resetPracticePeaks } =
  await import('../app/js/plotting/gauge.js');

const setThresholds = (sip, puff) => {
  document.getElementById('sipVal').textContent = sip;
  document.getElementById('puffVal').textContent = puff;
  recalcGaugeRange(); // derives gaugeRange and repositions every mark
};

const guide = () => document.getElementById('practiceGuide').textContent;

test('the default unit is hPa and the gauge strings are byte-identical to the pre-preference app', () => {
  setPressureUnit('hpa');
  setThresholds(3, 6); // range = 6 × 1.5 = 9
  assert.equal(getPressureUnit(), 'hpa');
  assert.equal(document.getElementById('gaugeSipLabel').textContent, '\u22129.0 hPa');
  assert.equal(document.getElementById('gaugePuffLabel').textContent, '+9.0 hPa');
  assert.equal(document.getElementById('gaugeSipMark').title, 'Sip triggers at \u22123 hPa');
  assert.equal(document.getElementById('gaugePuffMark').title, 'Puff triggers at +6 hPa');
  resetPracticePeaks();
  gaugeDelta(-4.5);
  gaugeDelta(12.25);
  assert.match(guide(), /Strongest so far: sip 4\.50 hPa \u00b7 puff 12\.25 hPa/);
  assert.equal(
    formatSuggestion({ sip: 4, puff: 5.75 }),
    'Suggested: sip 4.00 hPa, puff 5.75 hPa \u2014 65% of the measured strongest. A deliberate hold crosses them; breathing noise should not.',
  );
});

test('cmH2O converts the reading surfaces; the wire values never move', () => {
  setThresholds(3, 6);
  resetPracticePeaks();
  gaugeDelta(-6);
  gaugeDelta(9); // both sides ≥ 2 → the suggestion is ready
  const before = suggestThresholds();
  setPressureUnit('cmh2o');
  // 9 hPa × 0.980665 = 8.825985 → '−8.8 cmH2O' on the scale.
  assert.equal(document.getElementById('gaugeSipLabel').textContent, '\u22128.8 cmH2O');
  assert.equal(document.getElementById('gaugePuffLabel').textContent, '+8.8 cmH2O');
  assert.equal(document.getElementById('gaugeSipMark').title, 'Sip triggers at \u22122.94 cmH2O');
  assert.equal(document.getElementById('gaugePuffMark').title, 'Puff triggers at +5.88 cmH2O');
  assert.match(guide(), /Strongest so far: sip 5\.88 cmH2O \u00b7 puff 8\.83 cmH2O/);
  assert.match(formatSuggestion({ sip: 4, puff: 5.75 }), /Suggested: sip 3\.92 cmH2O, puff 5\.64 cmH2O/);
  // The suggestion's WIRE values are the same numbers the Apply button writes.
  const after = suggestThresholds();
  assert.deepEqual(after, before, 'suggest returns hPa wire values in both display modes');
  // A live pressure frame converts in the gauge's aria too.
  gaugeDelta(5);
  assert.match(document.getElementById('mainGauge').getAttribute('aria-label'), /Current delta: 4\.9 cmH2O \(puff\)/);
});

test('the ≈-annotation bridges the wire unit and the display unit', () => {
  setPressureUnit('hpa');
  assert.equal(pressureHintText(12.5), 'hPa');
  setPressureUnit('cmh2o');
  assert.equal(pressureHintText(12.5), 'hPa \u2248 12.26 cmH2O'); // 12.5 × 0.980665
  // Unloaded/invalid readouts stay plain: nothing to convert.
  assert.equal(pressureHintText(0), 'hPa');
  assert.equal(pressureHintText(-3), 'hPa');
  assert.equal(pressureHintText(Number.NaN), 'hPa');
});

test('the preference persists and initPressureUnits restores it', () => {
  setPressureUnit('cmh2o');
  assert.equal(localStorage.getItem(PRESSURE_UNIT_STORAGE_KEY), 'cmh2o');
  setPressureUnit('hpa');
  localStorage.setItem(PRESSURE_UNIT_STORAGE_KEY, 'cmh2o');
  initPressureUnits();
  assert.equal(getPressureUnit(), 'cmh2o');
  // Cleanup for the remaining tests in this file.
  localStorage.removeItem(PRESSURE_UNIT_STORAGE_KEY);
  initPressureUnits();
  setPressureUnit('hpa');
  assert.equal(getPressureUnit(), 'hpa');
});

test('switching back to hPa restores the legacy strings byte-for-byte', () => {
  setThresholds(3, 6);
  resetPracticePeaks();
  gaugeDelta(-4.5);
  gaugeDelta(12.25);
  setPressureUnit('cmh2o');
  setPressureUnit('hpa');
  assert.equal(document.getElementById('gaugeSipLabel').textContent, '\u22129.0 hPa');
  assert.equal(document.getElementById('gaugeSipMark').title, 'Sip triggers at \u22123 hPa');
  assert.match(guide(), /Strongest so far: sip 4\.50 hPa \u00b7 puff 12\.25 hPa/);
});

test('the conversion constant and helpers are exact', async () => {
  assert.equal(HPA_PER_CMH2O, 0.980665);
  setPressureUnit('cmh2o');
  assert.equal(toDisplayPressure(10), 9.80665);
  assert.equal(fmtPressure(10, { decimals: 3, withUnit: true }), '9.807 cmH2O');
  setPressureUnit('hpa');
  assert.equal(fmtPressure(10, { decimals: 3, withUnit: true }), '10.000 hPa');
  // Same-unit setPressureUnit is a no-op (no subscriber churn).
  let calls = 0;
  const { onPressureUnitChange } = await import('../app/js/services/pressure-units.js');
  onPressureUnitChange(() => calls++);
  setPressureUnit('hpa');
  assert.equal(calls, 0, 'no re-render for a same-unit set');
});
