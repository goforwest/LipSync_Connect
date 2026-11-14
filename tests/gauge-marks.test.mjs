// Gauge marks + value labels (plotting/gauge.js): the threshold marks sit at
// value/range positions with permanent labels (the titles are hover-only —
// invisible on touch, and Android is a supported platform), hard-band marks
// appear only once their values load, and the label strip follows the
// display unit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document } = installGatingDom();
const { gaugeMarks, recalcGaugeRange } = await import('../app/js/plotting/gauge.js');
const { setPressureUnit } = await import('../app/js/services/pressure-units.js');

const setThresholds = (sip, puff) => {
  document.getElementById('sipVal').textContent = sip;
  document.getElementById('puffVal').textContent = puff;
  recalcGaugeRange(); // derives gaugeRange and repositions every mark
};

test('threshold marks sit at value positions with permanent value labels', () => {
  setThresholds(3, 6); // range 9
  const sip = document.getElementById('gaugeSipMark');
  assert.equal(sip.style.left, 50 - (3 / 9) * 50 + '%');
  assert.equal(sip.title, 'Sip triggers at \u22123 hPa');
  const sipLabel = document.getElementById('gaugeSipMarkLabel');
  assert.equal(sipLabel.hidden, false);
  assert.equal(sipLabel.textContent, '\u22123');
  assert.equal(sipLabel.style.left, sip.style.left);
  assert.equal(document.getElementById('gaugePuffMarkLabel').textContent, '+6');
});

test('hard-band marks and labels appear only once their values load', () => {
  setThresholds(3, 6);
  assert.equal(document.getElementById('gaugeHardSipMark').hidden, true);
  assert.equal(document.getElementById('gaugeHardSipMarkLabel').hidden, true);
  document.getElementById('hardSipVal').textContent = '10';
  document.getElementById('hardPuffVal').textContent = '20';
  gaugeMarks();
  assert.equal(document.getElementById('gaugeHardSipMark').hidden, false);
  assert.equal(document.getElementById('gaugeHardSipMarkLabel').hidden, false);
  assert.equal(document.getElementById('gaugeHardSipMarkLabel').textContent, '\u221210');
  assert.match(document.getElementById('gaugeLegend').textContent, /Dashed marks: the hard sip and hard puff triggers/);
});

test('the labels follow the cmH2O display preference', () => {
  document.getElementById('hardSipVal').textContent = '—';
  document.getElementById('hardPuffVal').textContent = '—';
  setThresholds(3, 6);
  setPressureUnit('cmh2o');
  assert.equal(document.getElementById('gaugeSipMarkLabel').textContent, '\u22122.94'); // 3 × 0.980665
  assert.equal(document.getElementById('gaugeSipLabel').textContent, '\u22128.8 cmH2O');
  setPressureUnit('hpa');
  assert.equal(document.getElementById('gaugeSipMarkLabel').textContent, '\u22123');
});
