// The "a newer version is ready" toast. The service worker updates assets
// with stale-while-revalidate, so a browser can hold the previous build for
// exactly one session after a deploy: the new service worker installs and
// claims clients while the old page is still open. That controller handover
// is the moment the user learns about the update — announced here, with an
// explicit Reload button. NEVER auto-reload: the reader may be mid-tuning,
// and a reload closes the device connection.
import { showUpdateNotification } from './notification.js';

const UPDATE_MESSAGE =
  'A newer version of LipSync Connect is ready. Reload to switch to it — the device connection closes and you reconnect afterwards.';

/**
 * Watches for the service worker taking over a page it did not control at
 * load (the first-claim on a fresh visit is not an update). `serviceWorker`
 * is injectable for tests; `reload` too, so the button is testable.
 * @param {{ controller: any, addEventListener: Function }} [serviceWorker]
 * @param {{ reload?: Function }} [options]
 */
export function bindUpdateToast(serviceWorker, options = {}) {
  const sw = serviceWorker ?? (typeof navigator !== 'undefined' ? navigator.serviceWorker : null);
  if (!sw || typeof sw.addEventListener !== 'function') return;
  let hadController = !!sw.controller;
  sw.addEventListener('controllerchange', () => {
    if (!hadController) {
      // Fresh visit: the just-installed worker's first claim — this page
      // already IS the newest build.
      hadController = true;
      return;
    }
    showUpdateNotification(UPDATE_MESSAGE, 'Reload', () => {
      if (typeof options.reload === 'function') options.reload();
      else window.location.reload();
    });
  });
}
