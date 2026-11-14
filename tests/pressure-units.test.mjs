// Pressure display units (services/pressure-units.js): the cmH2O preference
// converts the READING surfaces — gauge titles/scale/current-delta, the mark
// labels, and the ≈-annotations — while the wire values and every EDITABLE
// control stay hPa-native. The hPa default keeps the pre-preference strings
// byte-identical.
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
const { recalcGaugeRange, gaugeDelta } = await import('../app/js/plotting/gauge.js');

const setThresholds = (sip, puff) => {
  document.getElementById('sipVal').textContent = sip;
  document.getElementById('puffVal').textContent = puff;
  recalcGaugeRange(); // derives gaugeRange and repositions every mark
};

test('the default unit is hPa and the gauge strings are byte-identical to the pre-preference app', () => {
  setPressureUnit('hpa');
  setThresholds(3, 6); // range = 6 × 1.5 = 9
  assert.equal(getPressureUnit(), 'hpa');
  assert.equal(document.getElementById('gaugeSipLabel').textContent, '\u22129.0 hPa');
  assert.equal(document.getElementById('gaugePuffLabel').textContent, '+9.0 hPa');
  assert.equal(document.getElementById('gaugeSipMark').title, 'Sip triggers at \u22123 hPa');
  assert.equal(document.getElementById('gaugePuffMark').title, 'Puff triggers at +6 hPa');
  gaugeDelta(-4.5);
  assert.match(document.getElementById('mainGauge').getAttribute('aria-label'), /Current delta: 4\.5 hPa \(sip\)/);
});

test('cmH2O converts the reading surfaces; the wire values never move', () => {
  setThresholds(3, 6);
  setPressureUnit('cmh2o');
  // 9 hPa × 0.980665 = 8.825985 → '−8.8 cmH2O' on the scale.
  assert.equal(document.getElementById('gaugeSipLabel').textContent, '\u22128.8 cmH2O');
  assert.equal(document.getElementById('gaugePuffLabel').textContent, '+8.8 cmH2O');
  assert.equal(document.getElementById('gaugeSipMark').title, 'Sip triggers at \u22122.94 cmH2O');
  assert.equal(document.getElementById('gaugePuffMark').title, 'Puff triggers at +5.88 cmH2O');
  assert.equal(document.getElementById('gaugeSipMarkLabel').textContent, '\u22122.94');
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
  setPressureUnit('cmh2o');
  setPressureUnit('hpa');
  assert.equal(document.getElementById('gaugeSipLabel').textContent, '\u22129.0 hPa');
  assert.equal(document.getElementById('gaugeSipMark').title, 'Sip triggers at \u22123 hPa');
  assert.equal(document.getElementById('gaugeSipMarkLabel').textContent, '\u22123');
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
