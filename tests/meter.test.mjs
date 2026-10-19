// Meter rendering (plotting/gauge.js updateMeter): the plain 0..10 segmented
// meter lights `value` segments from the left; the bipolar variant (cursor
// acceleration, -10..10) lights |value| segments from the center outward with
// the sign picking the side — and 0 or an unloaded value lights nothing, so
// "0 = off" and a not-yet-loaded setting both read as empty.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const ctx = installGatingDom();
const { updateMeter } = await import('../app/js/plotting/gauge.js');
const { document } = ctx;

// The plain/bipolar branch is chosen per call from the element's class, so
// the class must be in place before the first updateMeter call.
document.getElementById('accelMeter').classList.add('meter--bipolar');

const litIndexes = (id, value) => {
  updateMeter(id, value);
  return document
    .getElementById(id)
    .children.map((seg, i) => (seg.classList.contains('on') ? i : null))
    .filter((i) => i !== null);
};

test('plain meter lights `value` segments from the left', () => {
  assert.deepEqual(litIndexes('speedMeter', 7), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(document.getElementById('speedMeter').children.length, 10);
});

test('plain meter lights nothing for 0 or an unloaded value', () => {
  assert.deepEqual(litIndexes('speedMeter', 0), []);
  // The em-dash placeholder shown before the first load reads as NaN.
  assert.deepEqual(litIndexes('speedMeter', '\u2014'), []);
});

test('bipolar meter fills from the center outward, sign picks the side', () => {
  assert.deepEqual(litIndexes('accelMeter', 3), [10, 11, 12]);
  assert.deepEqual(litIndexes('accelMeter', -5), [5, 6, 7, 8, 9]);
});

test('bipolar meter at full scale lights its whole side only', () => {
  assert.deepEqual(litIndexes('accelMeter', 10), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.deepEqual(litIndexes('accelMeter', -10), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('bipolar meter lights nothing for 0 or an unloaded value', () => {
  assert.deepEqual(litIndexes('accelMeter', 0), []);
  assert.deepEqual(litIndexes('accelMeter', '\u2014'), []);
  assert.equal(document.getElementById('accelMeter').children.length, 20);
});
