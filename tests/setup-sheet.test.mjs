// The printable setup sheet (services/setup-sheet.js): one paper page for the
// handover — device facts, thresholds in the display unit, timing, safeguards,
// switch mappings as LABELS, and the session's practice stats. Holes print as
// "—" (visible, never invented), identifiers stay redacted, and the sheet is
// display-unit aware like the rest of the reading surfaces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc } = installGatingDom();
const { buildSetupSheetHtml } = await import('../app/js/services/setup-sheet.js');
const { setPressureUnit } = await import('../app/js/services/pressure-units.js');

function setLoadedValues(v = {}) {
  const defaults = {
    model: 'LipSync 4',
    version: '4.7.0',
    sipVal: '12.50',
    puffVal: '25.00',
    hardSipVal: '26.00',
    hardPuffVal: '40.00',
    speedVal: '5',
    scrollVal: '6',
    accelVal: '2',
    innerDeadzoneVal: '0.07',
    outerDeadzoneVal: '0.95',
    soundModeVal: 'Basic',
    lightModeVal: 'All',
    brightnessVal: '7',
    w1Val: '600',
    w2Val: '1200',
    w3Val: '3000',
    neutralVal: '0.00',
    corner1: '-13.00|13.00',
    corner2: '13.00|13.00',
    corner3: '13.00|-13.00',
    corner4: '-13.00|-13.00',
    // switch selects: swSA0..2 etc. hold the window cells
    swSA0: '1',
    swSA1: '4',
    swSA2: '19',
    swSB0: '3',
    swSB1: '0',
    swSB2: '14',
    hardSipAction: '5',
    hardPuffAction: '4',
  };
  const selectValueIds = new Set([
    'swSA0',
    'swSA1',
    'swSA2',
    'swSB0',
    'swSB1',
    'swSB2',
    'swSC0',
    'swSC1',
    'swSC2',
    'swGA0',
    'swGA1',
    'swGA2',
    'swGB0',
    'swGB1',
    'swGB2',
    'swGC0',
    'swGC1',
    'swGC2',
    'hardSipAction',
    'hardPuffAction',
  ]);
  for (const [id, value] of Object.entries({ ...defaults, ...v })) {
    const el = doc.getElementById(id);
    if (!el) continue;
    if (selectValueIds.has(id)) el.value = value;
    else el.textContent = value;
  }
}

test('the sheet carries the loaded setup as readable rows', () => {
  setLoadedValues();
  doc.getElementById('sapDisabled').disabled = false;
  doc.getElementById('sapDisabled').checked = true;
  const html = buildSetupSheetHtml();
  assert.match(html, /LipSync setup sheet/);
  assert.match(html, /Device identifier: redacted/);
  assert.match(html, /Model.*LipSync 4/s);
  assert.match(html, /Sip threshold.*12\.50 hPa/s, 'thresholds print in the display unit (hPa default)');
  assert.match(html, /Short window.*600 ms/s);
  assert.match(html, /Sip &amp; puff disabled.*On/s);
  assert.match(html, /Switch 1 \u00b7 mouse.*Left click \/ Drag \/ Open menu/s, 'mappings print as labels');
  assert.match(html, /Hard sip action.*Scroll/s);
  assert.match(html, /Neutral.*0\.00/s);
  assert.match(html, /Practice \(this session\)/);
  assert.ok(!html.includes('AA:BB'), 'no identifiers');
});

test('unloaded values print as an em dash, never invented', () => {
  setLoadedValues();
  doc.getElementById('sipVal').textContent = '\u2014'; // did not load
  const html = buildSetupSheetHtml();
  assert.match(html, /Sip threshold.*\u2014/s);
  assert.ok(!/Sip threshold.*12\.50/.test(html), 'the stale value is gone');
});

test('the sheet honors the cmH2O display preference', () => {
  setLoadedValues();
  setPressureUnit('cmh2o');
  const html = buildSetupSheetHtml();
  assert.match(html, /Sip threshold.*12\.26 cmH2O/s); // 12.50 × 0.980665
  setPressureUnit('hpa');
});
