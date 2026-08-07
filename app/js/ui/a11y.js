// Screen-reader announcements routed through #srStatus, coalesced onto the
// animation frame so rapid updates can't deliver out of order.
import { $ } from './dom.js';
import { timers } from '../utils/timers.js';

export function announceStatus(message) {
  const el = $('srStatus');
  if (!el) return;
  // Cancel any stale pending write so rapid announcements can't coalesce or
  // deliver out of order; clear-then-set forces re-announcement of repeats.
  const fn = /** @type {{ _raf?: number }} */ (/** @type {any} */ (announceStatus));
  if (fn._raf !== undefined) timers.cancel(fn._raf);
  el.textContent = '';
  fn._raf = timers.afterFrame(() => {
    fn._raf = undefined;
    el.textContent = message;
  });
}
