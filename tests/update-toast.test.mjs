// The app-update toast (ui/update-toast.js): stale-while-revalidate means a
// deploy takes over an OPEN page mid-session — the new worker's claim over a
// page it did not control at load is the update signal. The toast offers an
// explicit Reload (never auto-reload: the reader may be mid-tuning and a
// reload closes the device connection), and a fresh visit's first claim is
// not an update.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc } = installGatingDom();
const { bindUpdateToast } = await import('../app/js/ui/update-toast.js');

/** A minimal ServiceWorker double: controller + controllerchange listeners. */
const makeSw = (controller) => {
  const listeners = {};
  return {
    controller,
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    fireControllerChange() {
      for (const fn of listeners.controllerchange ?? []) fn();
    },
  };
};

const notif = () => doc.getElementById('notification');

test('a fresh visit first claim is not an update — no toast', () => {
  const sw = makeSw(null); // no controller at load: first visit
  bindUpdateToast(sw, { reload: () => {} });
  sw.fireControllerChange();
  // The toast is the only writer of the bar's 'update' tone — its absence is
  // the cleanest "nothing shown" signal in the stub DOM.
  assert.equal(notif().classList.contains('update'), false);
  // A later swap in the same session IS an update (the visit outlived a deploy).
  sw.fireControllerChange();
  assert.equal(notif().classList.contains('update'), true);
});

test('a deploy taking over an open page offers Reload and never auto-reloads', () => {
  const sw = makeSw({}); // page loaded already controlled: an established session
  let reloaded = 0;
  bindUpdateToast(sw, { reload: () => reloaded++ });
  sw.fireControllerChange();
  const action = notif().querySelector('.notif-action');
  assert.notEqual(action, null, 'the update toast appeared');
  assert.equal(action.textContent, 'Reload');
  assert.equal(reloaded, 0, 'nothing reloads without the user asking');
  action.onclick({ stopPropagation() {} });
  assert.equal(reloaded, 1, 'the button reloads');
  assert.equal(notif().hidden, true, 'acting on the toast dismisses it');
});

test('the dismiss button closes the toast without reloading', () => {
  const sw = makeSw({});
  let reloaded = 0;
  bindUpdateToast(sw, { reload: () => reloaded++ });
  sw.fireControllerChange();
  notif()
    .querySelector('.notif-close')
    .onclick({ stopPropagation() {} });
  assert.equal(notif().hidden, true);
  assert.equal(reloaded, 0);
});

test('binding is a no-op without a service worker (unsupported browsers)', () => {
  assert.doesNotThrow(() => bindUpdateToast(undefined, { reload: () => {} }));
});
