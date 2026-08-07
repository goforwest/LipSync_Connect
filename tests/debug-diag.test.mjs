// The DEBUG,3 / DEBUG,4 / DEBUG,5 stream modes drive the button/switch/sip-puff
// panels. Each line is a 3-field tuple { mainState, subState, elapsedMs } —
// this test pins how the diag state machine maps those tuples onto the DOM.
// Runs against the real plotting/diag.js with the permissive protocol DOM stub.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

installGatingDom();
const diag = await import('../app/js/plotting/diag.js');

// Permissive stub returns elements-on-demand, so seeding is enough.
const doc = document;
const el = (id) => doc.getElementById(id);

// DEBUG,3: hub button state (bitmask 1/2/3 = S1/S2 pressed, subState 0/1/2 =
// waiting/started/released). The subState text renderer is the contract; the
// buttons light 'on' by bitmask.
test('DEBUG,3: subState text renders and button bitmask toggles', () => {
  diag.applyDebugData('3', '2,1,150'); // S2 pressed, started, 150 ms
  assert.ok(el('diagBtn1') && !el('diagBtn1').classList.contains('on'));
  assert.ok(el('diagBtn2').classList.contains('on'));
  assert.match(el('diagBtnTime').textContent, /150 ms · started/);
  diag.applyDebugData('3', '0,0,0'); // release
  assert.ok(!el('diagBtn2').classList.contains('on'));
  assert.match(el('diagBtnTime').textContent, /0 ms · waiting/);
  diag.applyDebugData('3', '3,2,42'); // both pressed, released
  assert.ok(el('diagBtn1').classList.contains('on'));
  assert.ok(el('diagBtn2').classList.contains('on'));
  assert.match(el('diagBtnTime').textContent, /42 ms · released/);
});

// DEBUG,4: external switches 1..3 by bit.
test('DEBUG,4: external switch bitmask drives diagSw1..3', () => {
  diag.applyDebugData('4', '5,1,300'); // switches 1 and 3 on, started
  assert.ok(el('diagSw1').classList.contains('on'));
  assert.ok(!el('diagSw2').classList.contains('on'));
  assert.ok(el('diagSw3').classList.contains('on'));
  assert.match(el('diagSwTime').textContent, /300 ms · started/);
});

// DEBUG,5: sip/puff contact — subState 1 = sip held, 2 = puff held.
test('DEBUG,5: sip/puff state drives the two indicator chips', () => {
  diag.applyDebugData('5', '1,1,250'); // sip held
  assert.ok(el('diagSip').classList.contains('on'));
  assert.ok(!el('diagPuff').classList.contains('on'));
  assert.match(el('diagSapTime').textContent, /250 ms · started/);
  diag.applyDebugData('5', '2,2,90'); // puff held
  assert.ok(!el('diagSip').classList.contains('on'));
  assert.ok(el('diagPuff').classList.contains('on'));
  assert.match(el('diagSapTime').textContent, /90 ms · released/);
});
