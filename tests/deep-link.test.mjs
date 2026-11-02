// Every stable section deep link remains readable while disconnected; only the
// hardware actions inside the destination stay disabled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc, windowListeners } = installGatingDom();
window.location.hash = '#sec-device';

await import('../app/js/main.js');
(windowListeners.DOMContentLoaded || []).forEach((fn) => fn());

test('a disconnected serial deep link opens its readable destination', () => {
  const home = doc.getElementById('sec-home');
  const device = doc.getElementById('sec-device');
  assert.equal(home.classList.contains('open'), false);
  assert.equal(home.hasAttribute('inert'), true);
  assert.equal(device.classList.contains('open'), true);
  assert.equal(device.classList.contains('card-off'), false);
});
