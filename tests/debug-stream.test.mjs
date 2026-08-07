// DEBUG,1 (joystick) and DEBUG,2 (pressure) streams — these are the two
// rAF-batched, high-frequency panels that a malformed or degenerate update
// could poison. Assert the state machine + DOM writes on:
//   - normal mid-session updates
//   - raw/out points moving sign conventions (orientation vote flips)
//   - gaming negative values that must NOT be truncated to '?'
//   - dip deltas large enough to paint the full gauge
// Same DOM stub pattern as debug-diag.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

installGatingDom();
const diag = await import('../app/js/plotting/diag.js');
const { plotState } = await import('../app/js/plotting/plot.js');

const doc = document;
const el = (id) => doc.getElementById(id);

test('DEBUG,1: joystick raw/out pairs populate joyRaw/joyOut and the plot', () => {
  diag.applyDebugData('1', '12.34|-5.67,0,500|-250,0');
  assert.equal(el('joyRaw').textContent, '12.34 | -5.67');
  assert.equal(el('joyOut').textContent, '500 | -250');
  assert.deepEqual(plotState.raw, { x: 12.34, y: -5.67 });
  assert.match(el('diagPlot').getAttribute('aria-label') ?? '', /raw 12\.3,-5\.7/);
});

test('DEBUG,1: strong output vote latches onto the sign of the raw-vs-neutral delta', () => {
  // Start with a known raw position, then feed flipped polarity.
  diag.applyDebugData('1', '0|0,0,1023|0,0'); // raw at +/- — strong out => vote
  assert.equal(plotState.orientLive.x, true);
  assert.equal(plotState.orient.x, 1);
  // The latch is sticky for x only until a read large enough to re-vote.
  diag.applyDebugData('1', '0|0,0,-1023|0,0');
  assert.equal(plotState.orient.x, 1);
});

test('DEBUG,2: pressure stream formats values and drives the gauge', () => {
  diag.applyDebugData('2', '1010.10,1011.20,-1.10');
  assert.equal(el('pvMouth').textContent, '1010.10');
  assert.equal(el('pvAmbient').textContent, '1011.20');
  assert.equal(el('pvDiff').textContent, '-1.10');
  assert.match(el('diagGauge').getAttribute('aria-label') ?? '', /1\.1 hPa sip/);
});

test('DEBUG,2: missing/NaN fields fall back to "?" markers, not crashes', () => {
  diag.applyDebugData('2', 'garbage,not-a-number,NaN');
  assert.equal(el('pvMouth').textContent, '?');
  assert.equal(el('pvAmbient').textContent, '?');
  assert.equal(el('pvDiff').textContent, '?');
});

test('partial updates leave orientation latch intact until told otherwise', () => {
  // With out magnitude < 100 the auto-orientation should not flip.
  plotState.orientLive.x = false;
  plotState.orient.x = 1;
  diag.applyDebugData('1', '10|10,0,50|0,0'); // under the orientation threshold
  assert.equal(plotState.orientLive.x, false);
  assert.equal(plotState.orient.x, 1);
});
