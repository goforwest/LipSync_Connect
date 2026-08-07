// Covers the deadzone ring lifecycle in plotting/plot.js: the inner/outer
// deadzone radii are derived from DEVICE state (IZ/OZ endpoints or the
// calibration read-back), so any stale ring values left across a connect/
// disconnect boundary would paint a ghost of the previous device's profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

installGatingDom();
const plot = await import('../app/js/plotting/plot.js');
const doc = document;

test('ring state resets with resetPlotState (no stale deadzone values)', () => {
  // Drive some deadzone state in via the same path the real device uses.
  plot.plotRing('ringInner', 0.25);
  plot.plotRing('ringOuter', 0.75);
  assert.equal(plot.plotState.innerDz, 0.25);
  assert.equal(plot.plotState.outerDz, 0.75);
  plot.resetPlotState();
  assert.equal(plot.plotState.innerDz, null);
  assert.equal(plot.plotState.outerDz, null);
});

test('renderPlot gates ring drawing on non-null state', () => {
  // After reset, neither ring is drawn (aria-label must not claim deadzones).
  plot.resetPlotState();
  // dotPoints needs a neutral point to paint both branches — set one.
  plot.plotNeutral('5.0|5.0');
  // Render once: with null innerDz/outerDz the rings stay off.
  assert.equal(doc.getElementById('ringInner').hidden, true);
  assert.equal(doc.getElementById('ringOuter').hidden, true);
  // And after new values land (e.g. a fresh IZ push), they come back.
  plot.plotRing('ringInner', 0.25);
  assert.equal(doc.getElementById('ringInner').hidden, false);
});
