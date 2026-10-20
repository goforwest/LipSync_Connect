// Input-window ladder (plotting/windows.js): the three timing windows drawn
// as one proportional timeline — zone widths and scale marks derive from the
// w1/w2/w3 readouts, the unloaded state collapses to a waiting placeholder,
// and the live DEBUG,5 hold sweep drives BOTH instances (the Sip & Puff
// card's Watch holds button and the Diagnostics panel — one picture, two
// doors), reporting the window count the same way the face LEDs do (1 short,
// 2 long, 3 very-long). Unloaded readouts must fall back to the pre-4.4.0
// compiled-in windows so sweeps and log lines never carry invented
// boundaries, and a released hold must restore the static legend exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document } = installGatingDom();
const { initWindowLadders, refreshWindowLadders, paintWindowSweep, windowBoundaries, LEGACY_SAP_WINDOWS } =
  await import('../app/js/plotting/windows.js');
const { applyDebugData } = await import('../app/js/plotting/diag.js');

const setWindows = (w1, w2, w3) => {
  document.getElementById('w1Val').textContent = String(w1);
  document.getElementById('w2Val').textContent = String(w2);
  document.getElementById('w3Val').textContent = String(w3);
  refreshWindowLadders();
};

// Both instances must always agree — wherever the user watches from, the
// sweep, the active zone, and the label are the same picture.
const assertInstancesAgree = (predicate) => {
  for (const id of ['winLadder', 'winLadderDiag']) {
    const ladder = document.getElementById(id);
    assert.ok(predicate(ladder), `${id}: ${ladder.getAttribute('aria-label')}`);
  }
};

test('init builds zones, sweep, and scale marks per instance', () => {
  initWindowLadders();
  assert.equal(document.getElementById('winLadder').children.length, 4); // 3 zones + sweep
  assert.equal(document.getElementById('winLadderDiag').children.length, 4);
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
    ladder.children.slice(0, 3).map((z) => z.style.flexBasis),
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

test('sweep fills with the hold and reports the window count on both instances', () => {
  setWindows(750, 2500, 6000);
  paintWindowSweep(2000, true); // 2000 ms: past short, inside long
  assertInstancesAgree((l) => l.children[3].style.width === '33.33%');
  assertInstancesAgree((l) => l.children[1].classList.contains('active')); // long zone
  assertInstancesAgree((l) => /Hold at 2000 ms — in the long window \(2 of 3\)/.test(l.getAttribute('aria-label')));

  paintWindowSweep(0, false); // release resets fill, highlight — and restores the legend
  assertInstancesAgree((l) => l.children[3].style.width === '0.00%');
  assertInstancesAgree((l) => !l.children.some((c) => c.classList.contains('active')));
  assertInstancesAgree((l) =>
    /short holds to 750 ms \(green\), long to 2500 ms \(yellow\), very-long to 6000 ms \(red\)/.test(
      l.getAttribute('aria-label'),
    ),
  );
});

test('sweep clamps at the very-long window and the ladder end', () => {
  setWindows(750, 2500, 6000);
  paintWindowSweep(99999, true);
  assertInstancesAgree((l) => l.children[3].style.width === '100.00%');
  assertInstancesAgree((l) => l.children[2].classList.contains('active')); // very-long zone
  assertInstancesAgree((l) => /very-long window \(3 of 3\)/.test(l.getAttribute('aria-label')));
});

test('unloaded readouts fall back to the legacy compiled-in windows', () => {
  setWindows('\u2014', '\u2014', '\u2014');
  assert.deepEqual(windowBoundaries(), LEGACY_SAP_WINDOWS);
  assert.deepEqual(LEGACY_SAP_WINDOWS, [1000, 3000, 8000]);
  paintWindowSweep(1500, true); // legacy: past short (1000), inside long (3000)
  assertInstancesAgree((l) => l.children[3].style.width === '18.75%');
  assertInstancesAgree((l) => l.children[1].classList.contains('active'));
  assertInstancesAgree((l) => /in the long window \(2 of 3\)/.test(l.getAttribute('aria-label')));
  // Release on an unloaded bar must NOT stamp the legacy numbers as if they
  // were configured — the waiting placeholder comes back.
  paintWindowSweep(0, false);
  assertInstancesAgree((l) => /waiting for the timing windows/.test(l.getAttribute('aria-label')));
});

test('windowBoundaries returns the configured windows once loaded', () => {
  setWindows(400, 1200, 5000);
  assert.deepEqual(windowBoundaries(), [400, 1200, 5000]);
});

// The Watch-holds door: the DEBUG,5 stream must drive both ladders AND both
// hold readouts (the Diagnostics panel's and the Sip & Puff card's).
test('the DEBUG,5 stream sweeps both ladders and writes both hold readouts', () => {
  setWindows(750, 2500, 6000);
  // mainState=2 (puff), subState=1 (started), elapsed=600 ms → short window.
  applyDebugData('5', '2,1,600');
  assertInstancesAgree((l) => l.children[3].style.width === '10.00%');
  assertInstancesAgree((l) => l.children[0].classList.contains('active')); // short zone
  assertInstancesAgree((l) => /Hold at 600 ms — in the short window \(1 of 3\)/.test(l.getAttribute('aria-label')));
  assert.equal(document.getElementById('sapHoldVal').textContent, '600 ms · started');
  assert.equal(document.getElementById('diagSapTime').textContent, '600 ms · started');

  // Release frame (subState=2): readouts show the release, the sweep resets.
  applyDebugData('5', '2,2,600');
  assertInstancesAgree((l) => l.children[3].style.width === '0.00%');
  assert.equal(document.getElementById('sapHoldVal').textContent, '600 ms · released');
});
