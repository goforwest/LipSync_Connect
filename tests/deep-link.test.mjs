// Initial deep links are evaluated only after disconnected navigation gating.
// A serial-only URL must explain the requirement and leave a usable Home page,
// not open a dimmed device page before the gate has initialized.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc, windowListeners } = installGatingDom();
window.location.hash = '#sec-device';

await import('../app/js/main.js');
(windowListeners.DOMContentLoaded || []).forEach((fn) => fn());

test('a disconnected serial deep link is gated and falls back to Home', () => {
  const home = doc.getElementById('sec-home');
  const device = doc.getElementById('sec-device');
  assert.equal(home.classList.contains('open'), true);
  assert.equal(home.hasAttribute('inert'), false);
  assert.equal(device.classList.contains('open'), false);
  assert.equal(device.classList.contains('card-off'), true);
});
