// Practice metrics (services/practice-stats.js): completed holds aggregate
// per side (count/avg/spread/max), the stats line renders once any hold
// lands, the copy block is dated + versioned plain text for clinical notes,
// junk durations never record, and the session reset clears everything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc } = installGatingDom();
const {
  notePracticeHold,
  practiceStats,
  practiceStatsLine,
  formatPracticeStats,
  renderPracticeStats,
  resetPracticeStats,
} = await import('../app/js/services/practice-stats.js');

test('holds aggregate per side with rounded avg/spread/max', () => {
  resetPracticeStats();
  for (const ms of [800, 1000, 1200]) notePracticeHold('sip', ms);
  notePracticeHold('puff', 640);
  const s = practiceStats();
  assert.equal(s.sip.count, 3);
  assert.equal(s.sip.avg, 1000);
  assert.equal(s.sip.spread, 160); // std dev ≈163 → nearest 10
  assert.equal(s.sip.max, 1200);
  assert.equal(s.puff.count, 1);
  assert.equal(s.puff.spread, 0); // a single hold has no spread
});

test('junk durations never record', () => {
  resetPracticeStats();
  notePracticeHold('sip', Number.NaN);
  notePracticeHold('sip', 0);
  notePracticeHold('sip', -5);
  assert.equal(practiceStats().sip.count, 0);
});

test('the stats line and copy block carry clinical-usable text', () => {
  resetPracticeStats();
  doc.getElementById('version').textContent = '4.5.4';
  notePracticeHold('sip', 800);
  notePracticeHold('sip', 1200);
  notePracticeHold('puff', 2000);
  const line = practiceStatsLine();
  assert.match(line, /Sip: 2 holds/);
  assert.match(line, /avg 1\.0 s/);
  assert.match(line, /Puff: 1 hold \u00b7 avg 2\.0 s/);
  const block = formatPracticeStats();
  assert.match(block, /^LipSync practice \u2014 /m);
  assert.match(block, /Firmware 4\.5\.4/);
  assert.match(block, /Sip: 2 holds \u00b7 avg 1\.0 s \u00b7 spread \u00b1200 ms \u00b7 max 1\.2 s/);
  assert.match(block, /Puff: 1 hold \u00b7 avg 2\.0 s \u00b7 spread \u00b10 ms \u00b7 max 2\.0 s/);
});

test('an empty session formats honestly', () => {
  resetPracticeStats();
  assert.match(formatPracticeStats(), /No completed holds recorded\./);
  assert.equal(practiceStatsLine(), '');
});

test('renderPracticeStats toggles the row with the data', () => {
  resetPracticeStats();
  renderPracticeStats();
  assert.equal(doc.getElementById('practiceStatsRow').hidden, true);
  notePracticeHold('sip', 900);
  renderPracticeStats();
  assert.equal(doc.getElementById('practiceStatsRow').hidden, false);
  assert.match(doc.getElementById('practiceStatsText').textContent, /Sip: 1 hold/);
  resetPracticeStats();
  assert.equal(doc.getElementById('practiceStatsRow').hidden, true);
});
