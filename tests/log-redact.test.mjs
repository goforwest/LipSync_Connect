// Privacy: exported/shared logs must not contain the device's BLE identity
// (the "LS_<id>" name) or any other per-device identifier. This drives the
// REAL redactLogIdentifiers function that both Download and Share run, not a
// re-implementation of a regex.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';
import { redactLogIdentifiers } from '../app/js/services/log-export.js';

const { document: doc } = installGatingDom();
const deviceIdEl = doc.getElementById('deviceId');

function setLiveId(value) {
  deviceIdEl.textContent = value;
}

test('redacts the raw device id in ID response lines', () => {
  setLiveId('a1b2c3d4');
  const out = redactLogIdentifiers('SUCCESS,1:ID,1:a1b2c3d4\nConnected.');
  assert.ok(!out.includes('a1b2c3d4'));
  assert.ok(out.includes('[device-id]'));
});

test('redacts the BLE name form LS_<id>', () => {
  setLiveId('a1b2c3d4');
  const out = redactLogIdentifiers('Connected to LS_a1b2c3d4.\nHas lights.');
  assert.ok(!out.includes('LS_a1b2c3d4'));
  assert.ok(out.includes('LS_[device-id]'));
});

test('falls back to the log-harvested id when the live field is a placeholder', () => {
  setLiveId('—');
  const out = redactLogIdentifiers('Paired as LS_a1b2c3d4.\nSUCCESS,1:ID,1:a1b2c3d4');
  assert.ok(!out.includes('a1b2c3d4'));
  assert.ok(out.includes('LS_[device-id]'));
});

test('redaction is a no-op when no identifier ever appeared', () => {
  setLiveId('');
  const text = 'Nothing to redact here.\nSUCCESS,0:MN,0:1';
  assert.equal(redactLogIdentifiers(text), text);
});

test('does not over-replace hex tokens that merely contain the id', () => {
  setLiveId('000000');
  const out = redactLogIdentifiers('SUCCESS,1:ID,1:000000\npressure 1000000 reading');
  assert.ok(out.includes('SUCCESS,1:ID,1:[device-id]'));
  assert.ok(out.includes('1000000'));
  assert.equal(out.match(/000000/g).length, 1); // only the one inside 1000000
});
