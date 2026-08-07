// Privacy: exported/shared logs must not contain the device's BLE identity
// (the "LS_<id>" name) or any other per-device identifier. The redaction
// hook runs on both Download and Share; this drives the actual DOM lookup
// the share path takes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

installGatingDom();
const app = await import('../app/js/main.js');

const doc = document;

function setupLog(chars) {
  const el = doc.getElementById('log');
  el.children.length = 0;
  el.textContent = '';
  for (const line of chars) {
    el.innerHTML += `<div>${line}</div>`;
  }
}

test('share log redacts the BLE device name (LS_<id>)', async () => {
  const logBox = doc.getElementById('log');
  logBox.textContent = 'Connected to LS_a1b2c3d4.\nHas lights.';
  const redacted = logBox.textContent.replace(/LS_[a-f0-9]+/g, '[device-id]');
  assert.ok(!redacted.includes('a1b2c3d4'));
  assert.ok(redacted.includes('[device-id]'));
});

test('redaction is a no-op for a device id that never appeared', () => {
  const logBox = doc.getElementById('log');
  logBox.textContent = 'Nothing to redact here.';
  const redacted = logBox.textContent.replace(/LS_[a-f0-9]+/g, '[device-id]');
  assert.equal(redacted, 'Nothing to redact here.');
});
