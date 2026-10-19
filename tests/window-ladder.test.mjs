// Input-window ladder (plotting/windows.js): the three timing windows drawn
// as one proportional timeline — zone widths and scale marks derive from the
// w1/w2/w3 readouts, the unloaded state collapses to a waiting placeholder,
// and the diagnostics sweep fills with the live DEBUG,5 hold, reporting the
// window count the same way the face LEDs do (1 short, 2 long, 3 very-long).
// Unloaded readouts must fall back to the pre-4.4.0 compiled-in windows so
// sweeps and log lines never carry invented boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document } = installGatingDom();
const { initWindowLadders, refreshWindowLadders, paintWindowSweep, windowBoundaries, LEGACY_SAP_WINDOWS } =
  await import('../app/js/plotting/windows.js');

const setWindows = (w1, w2, w3) => {
  document.getElementById('w1Val').textContent = String(w1);
  document.getElementById('w2Val').textContent = String(w2);
  document.getElementById('w3Val').textContent = String(w3);
  refreshWindowLadders();
};

test('init builds zones, sweep, and scale marks per instance', () => {
  initWindowLadders();
  assert.equal(document.getElementById('winLadder').children.length, 3);
  assert.equal(document.getElementById('winLadderDiag').children.length, 4); // 3 zones + sweep
  assert.equal(document.getElementById('winScale').children.length, 4);
  assert.equal(document.getElementById('winScaleDiag').children.length, 4);
  // Unloaded readouts (empty stubs) must read as the waiting placeholder.
  const ladder = document.getElementById('winLadder');
  assert.ok(ladder.classList.contains('win-ladder--empty'));
  assert.match(ladder.getAttribute('aria-label'), /waiting for the timing windows/);
});

test('loaded windows size the zones and scale marks to scale', () => {
  setWindows(750, 2500, 6000);
  const ladder = document.getElementById('winLadder');
  assert.deepEqual(
    ladder.children.map((z) => z.style.flexBasis),
    ['12.50%', '29.17%', '58.33%'],
  );
  assert.ok(!ladder.classList.contains('win-ladder--empty'));
  const marks = document.getElementById('winScale').children;
  assert.deepEqual(
    marks.map((s) => s.textContent),
    ['0 ms', '750', '2500', '6000 ms'],
  );
  assert.deepEqual(
    marks.map((s) => s.style.left),
    ['0%', '12.50%', '41.67%', '100%'],
  );
  assert.match(ladder.getAttribute('aria-label'), /short holds to 750 ms/);
  assert.match(ladder.getAttribute('aria-label'), /very-long to 6000 ms/);
});

test('sweep fills with the hold and reports the window count', () => {
  setWindows(750, 2500, 6000);
  paintWindowSweep(2000, true); // 2000 ms: past short, inside long
  const diag = document.getElementById('winLadderDiag');
  assert.equal(diag.children[3].style.width, '33.33%');
  assert.ok(diag.children[1].classList.contains('active')); // long zone
  assert.match(diag.getAttribute('aria-label'), /Hold at 2000 ms — in the long window \(2 of 3\)/);

  paintWindowSweep(0, false); // release resets fill and highlight
  assert.equal(diag.children[3].style.width, '0.00%');
  assert.ok(!diag.children.some((c) => c.classList.contains('active')));
  assert.doesNotMatch(diag.getAttribute('aria-label'), /Hold at/);
});

test('sweep clamps at the very-long window and the ladder end', () => {
  setWindows(750, 2500, 6000);
  paintWindowSweep(99999, true);
  const diag = document.getElementById('winLadderDiag');
  assert.equal(diag.children[3].style.width, '100.00%');
  assert.ok(diag.children[2].classList.contains('active')); // very-long zone
  assert.match(diag.getAttribute('aria-label'), /very-long window \(3 of 3\)/);
});

test('unloaded readouts fall back to the legacy compiled-in windows', () => {
  setWindows('\u2014', '\u2014', '\u2014');
  assert.deepEqual(windowBoundaries(), LEGACY_SAP_WINDOWS);
  assert.deepEqual(LEGACY_SAP_WINDOWS, [1000, 3000, 8000]);
  paintWindowSweep(1500, true); // legacy: past short (1000), inside long (3000)
  const diag = document.getElementById('winLadderDiag');
  assert.equal(diag.children[3].style.width, '18.75%');
  assert.ok(diag.children[1].classList.contains('active'));
  assert.match(diag.getAttribute('aria-label'), /in the long window \(2 of 3\)/);
});

test('windowBoundaries returns the configured windows once loaded', () => {
  setWindows(400, 1200, 5000);
  assert.deepEqual(windowBoundaries(), [400, 1200, 5000]);
});
