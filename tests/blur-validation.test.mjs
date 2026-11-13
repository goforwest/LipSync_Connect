// Exact-value blur validation (main.js): the moment a field loses focus, a
// valid entry clears its inline error and an out-of-range one states the
// expected range — without waiting for a Set click. Regression guards for the
// 2026-11-13 inversion fix: the old handler only fired when an error was
// ALREADY showing (so a fresh out-of-range value stayed silent on blur) and
// re-showed a range message for values that had been corrected to valid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc, windowListeners } = installGatingDom();
await import('../app/js/main.js'); // DOMContentLoaded wiring
(windowListeners['DOMContentLoaded'] || []).forEach((fn) => fn());

const blur = (id, value) => {
  const el = doc.getElementById(id);
  el.value = value;
  el.dispatch('blur');
};

test('an out-of-range window shows its range on blur, before any Set click', () => {
  blur('w1Input', '180');
  assert.equal(doc.getElementById('sapError').textContent, 'Expected 200–2500 ms.');
  blur('w3Input', '20000');
  assert.equal(doc.getElementById('sapError').textContent, 'Expected 1000–10000 ms.');
});

test('a valid window value clears the error on blur', () => {
  blur('w1Input', '180');
  assert.equal(doc.getElementById('sapError').textContent, 'Expected 200–2500 ms.');
  blur('w1Input', '600');
  assert.equal(doc.getElementById('sapError').textContent, '');
});

test('a corrected threshold no longer re-shows the range message on blur', () => {
  // A failed Set leaves the error up; the user fixes the value; blur must
  // clear it (the old handler replaced it with the same range message).
  doc.getElementById('sapError').textContent = 'Sip threshold must be between 2 and 149.99 hPa.';
  blur('sipInput', '5');
  assert.equal(doc.getElementById('sapError').textContent, '');
  // And a genuinely out-of-range blur still states the range — in the Sip &
  // Puff card's own error element, never the joystick card's (the old
  // id-prefix routing sent it there).
  blur('puffInput', '500');
  assert.equal(doc.getElementById('sapError').textContent, 'Expected 2–149.99 hPa.');
  assert.equal(doc.getElementById('formError').textContent, '');
  blur('puffInput', '25');
  assert.equal(doc.getElementById('sapError').textContent, '');
});

test('hard-threshold blurs report into the same sip & puff error element', () => {
  blur('hardSipInput', '1');
  assert.equal(doc.getElementById('sapError').textContent, 'Expected 2–149.99 hPa.');
  blur('hardPuffInput', '12.5');
  assert.equal(doc.getElementById('sapError').textContent, '');
});

test('deadzone blurs report into the joystick form error', () => {
  blur('innerDeadzone', '1.5');
  assert.equal(doc.getElementById('formError').textContent, 'Expected 0.01–0.99.');
  blur('outerDeadzone', '0.5');
  assert.equal(doc.getElementById('formError').textContent, '');
});

test('a comma decimal parses like a dot (locale keyboards)', () => {
  blur('sipInput', '12,5');
  assert.equal(doc.getElementById('sapError').textContent, '', '12,5 is valid and clears the error');
  blur('w1Input', '1,5'); // 1.5 → out of the window range
  assert.equal(doc.getElementById('sapError').textContent, 'Expected 200–2500 ms.');
  blur('w1Input', '600');
  assert.equal(doc.getElementById('sapError').textContent, '');
});

test('deadzone blur enforces the pair ordering, not just the range', () => {
  doc.getElementById('innerDeadzoneVal').textContent = '0.30';
  doc.getElementById('outerDeadzoneVal').textContent = '0.60';
  blur('innerDeadzone', '0.65'); // in range, but >= the outer readout
  assert.equal(doc.getElementById('formError').textContent, 'Inner deadzone must stay below the outer one.');
  blur('outerDeadzone', '0.20'); // in range, but <= the inner readout
  assert.equal(doc.getElementById('formError').textContent, 'Outer deadzone must stay above the inner one.');
  blur('innerDeadzone', '0,30'); // comma form, valid ordering
  assert.equal(doc.getElementById('formError').textContent, '');
});

test('deadzone blur stays quiet about ordering while the sibling is unloaded', () => {
  doc.getElementById('outerDeadzoneVal').textContent = '—';
  blur('innerDeadzone', '0.30');
  assert.equal(doc.getElementById('formError').textContent, '');
});
