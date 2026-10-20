// Inline write confirmation + undo (services/confirm.js via the central
// device.js interception): every successful settings write shows the chip
// with the previous value, writes never confirm (reads) or over-confirm
// (MANUAL device pushes), Undo re-sends the pre-write value through the
// queue, switch-mapping undo re-packs the old triple, and the restore burst
// suppresses chips entirely.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc, windowListeners } = installGatingDom();
const app = await import('../app/js/main.js');
(windowListeners['DOMContentLoaded'] || []).forEach((fn) => fn());
const { setWriteConfirmSuppressed } = await import('../app/js/services/confirm.js');
const { applySwitchActionValue } = await import('../app/js/services/settings-service.js');
const { testHooks } = await import('./harness/test-hooks.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chip = () => doc.getElementById('writeConfirm');
const chipText = () => doc.getElementById('writeConfirmText').textContent;
const undoVisible = () => !doc.getElementById('btnWriteUndo').hidden;

const launch = (replies = {}) => {
  const sent = [];
  replies = { SETTINGS: 'SUCCESS,0:SETTINGS', ...replies };
  const writer = {
    write(bytes) {
      const text = Buffer.from(bytes)
        .toString('utf8')
        .replace(/\r?\n$/, '');
      sent.push(text);
      const reply = replies[text];
      if (reply) setTimeout(() => app.handleLine(reply), 3);
    },
  };
  testHooks.attach({ simulated: true }, writer);
  return sent;
};

test('a settings write confirms inline with the previous value and an undo', () => {
  doc.getElementById('writeConfirm').hidden = true;
  const sent = launch({
    SETTINGS: 'SUCCESS,0:SETTINGS',
    'SS,1:5': 'SUCCESS,0:SS,1:5',
    'SS,1:6': 'SUCCESS,0:SS,1:6',
  });
  doc.getElementById('speedVal').textContent = '6';
  app.handleLine('SUCCESS,0:SS,1:5');
  assert.equal(chip().hidden, false);
  assert.equal(chipText(), '\u2713 Cursor speed level 6 \u2192 5');
  assert.equal(undoVisible(), true);
  // Undo re-sends the pre-write value through the queue.
  doc.getElementById('btnWriteUndo').dispatch('click');
  return waitFor(() => sent.includes('SS,1:6')).then(() => testHooks.detach());
});

test('threshold writes undo with the wire float format', () => {
  doc.getElementById('writeConfirm').hidden = true;
  const sent = launch({ 'ST,1:18.000': 'SUCCESS,0:ST,1:18.000', 'ST,1:20.000': 'SUCCESS,0:ST,1:20.000' });
  doc.getElementById('sipVal').textContent = '20.00';
  app.handleLine('SUCCESS,0:ST,1:18.000');
  assert.equal(chipText(), '\u2713 Sip threshold 20.00 \u2192 18.00');
  doc.getElementById('btnWriteUndo').dispatch('click');
  return waitFor(() => sent.includes('ST,1:20.000')).then(() => testHooks.detach());
});

test('restriction writes confirm On/Off and undo with the previous state', () => {
  doc.getElementById('writeConfirm').hidden = true;
  const sent = launch({ 'SD,1:1': 'SUCCESS,0:SD,1:1', 'SD,1:0': 'SUCCESS,0:SD,1:0' });
  doc.getElementById('sapDisabled').checked = false;
  app.handleLine('SUCCESS,0:SD,1:1');
  assert.equal(chipText(), '\u2713 Sip & puff disabled Off \u2192 On');
  doc.getElementById('btnWriteUndo').dispatch('click');
  return waitFor(() => sent.includes('SD,1:0')).then(() => testHooks.detach());
});

test('switch-mapping writes confirm without values and undo re-packs the old triple', () => {
  doc.getElementById('writeConfirm').hidden = true;
  const sent = launch({ 'SA,1:110419': 'SUCCESS,0:SA,1:110419' });
  applySwitchActionValue('SA', '1,4,19'); // the in-force mapping before the write
  app.handleLine('SUCCESS,0:SA,1:110419');
  assert.equal(chipText(), '\u2713 Switch 1 mouse mapping updated');
  doc.getElementById('btnWriteUndo').dispatch('click');
  // PACK_BASE + 1*10000 + 4*100 + 19 = 110419 — the pre-write triple back.
  return waitFor(() => sent.includes('SA,1:110419')).then(() => testHooks.detach());
});

test('reads and MANUAL pushes never confirm', () => {
  doc.getElementById('writeConfirm').hidden = true;
  launch();
  doc.getElementById('speedVal').textContent = '6';
  app.handleLine('SUCCESS,0:SS,0:6');
  assert.equal(chip().hidden, true);
  app.handleLine('MANUAL,0:SS,0:8');
  assert.equal(chip().hidden, true);
  testHooks.detach();
});

test('suppression silences the chip for the restore burst', () => {
  doc.getElementById('writeConfirm').hidden = true;
  launch();
  setWriteConfirmSuppressed(true);
  app.handleLine('SUCCESS,0:SS,1:5');
  assert.equal(chip().hidden, true);
  setWriteConfirmSuppressed(false);
  app.handleLine('SUCCESS,0:SS,1:5');
  assert.equal(chip().hidden, false);
  testHooks.detach();
});

test('an unloaded readout confirms without an undo (nothing to go back to)', () => {
  doc.getElementById('writeConfirm').hidden = true;
  launch();
  doc.getElementById('speedVal').textContent = '\u2014';
  app.handleLine('SUCCESS,0:SS,1:5');
  assert.equal(chip().hidden, false);
  assert.equal(undoVisible(), false);
  testHooks.detach();
});

function waitFor(predicate, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timed out'));
      sleep(5).then(check);
    };
    check();
  });
}
