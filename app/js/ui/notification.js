// Transient top-of-screen notification bar (auto-dismiss after 8 s).
import { $ } from './dom.js';

let notifTimer = null;
// Minimum-on-screen grace: a message that just appeared stays readable for a
// moment before a successor may replace it — two events landing together
// (e.g. "LipSync connected" + a load error) must not erase the first unread.
const MIN_VISIBLE_MS = 1500;
let shownAt = 0; // when the current message became visible
let pendingRun = null; // deferred successor; the latest one wins
let pendingTimer = null;

// Users who have requested reduced motion often rely on the toast to convey
// an important message and may not be able to react within 8 seconds —
// don't auto-dismiss for them. The × button is still available to close.
function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
}

/** Returns true when `run` was deferred because the current message is still
 *  inside its readable window; false when it may render immediately. Only the
 *  latest deferred call survives — earlier queued messages are superseded. */
function deferForGrace(run) {
  const el = $('notification');
  const remaining = MIN_VISIBLE_MS - (Date.now() - shownAt);
  if (!el || el.hidden || remaining <= 0) return false;
  pendingRun = run;
  if (!pendingTimer) {
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      const run2 = pendingRun;
      pendingRun = null;
      if (run2) run2();
    }, remaining);
  }
  return true;
}

/** A direct render supersedes anything queued behind the grace period. */
function cancelPending() {
  clearTimeout(pendingTimer);
  pendingTimer = null;
  pendingRun = null;
}

/** Test seam: synchronously run any grace-deferred successor so tests that
 *  assert on the second of two colliding messages stay deterministic instead
 *  of waiting out the real 1.5 s window. No-op when nothing is deferred. */
export function flushNotificationForTest() {
  if (!pendingTimer) return;
  clearTimeout(pendingTimer);
  pendingTimer = null;
  const run = pendingRun;
  pendingRun = null;
  if (run) {
    // Close the current message's grace window first: the deferred render
    // re-enters showNotification, which would otherwise re-defer (the window
    // is still open on the wall clock) and nothing would ever render.
    shownAt = 0;
    run();
  }
}

export function showNotification(msg, isWarning = false) {
  if (deferForGrace(() => showNotification(msg, isWarning))) return;
  cancelPending();
  clearTimeout(notifTimer);
  const el = $('notification');
  if (!el) return;
  el.classList.toggle('warning', !!isWarning);
  el.classList.remove('update');
  // Errors interrupt (assertive); advisory notes (the contrast warning) are
  // polite — the container's static role="alert" is swapped per message.
  el.setAttribute('role', isWarning ? 'status' : 'alert');
  el.setAttribute('aria-live', isWarning ? 'polite' : 'assertive');
  // Reveal the live region BEFORE replacing its contents: text inserted while
  // the container is hidden is not announced by screen readers, and the first
  // message (the contrast warning at startup) was exactly that case.
  el.hidden = false;
  el.innerHTML =
    '<span class="notif-msg"></span><button class="notif-close" aria-label="Dismiss notification">&times;</button>';
  el.querySelector('.notif-msg').textContent = msg;
  shownAt = Date.now();
  const dismiss = () => {
    clearTimeout(notifTimer);
    notifTimer = null;
    el.hidden = true;
  };
  const armTimer = () => {
    clearTimeout(notifTimer);
    if (!prefersReducedMotion()) {
      notifTimer = setTimeout(dismiss, 8000);
    }
  };
  // Reading or keyboard-navigating the toast pauses its 8 s countdown; the
  // timer restarts when the pointer/focus leaves, so it cannot vanish while
  // the user is on the dismiss button.
  el.onmouseenter = () => clearTimeout(notifTimer);
  el.onmouseleave = () => {
    if (!el.hidden) armTimer();
  };
  el.onfocusin = () => clearTimeout(notifTimer);
  el.onfocusout = (e) => {
    if (!el.hidden && !el.contains?.(e.relatedTarget)) armTimer();
  };
  el.querySelector('.notif-close').onclick = (e) => {
    e.stopPropagation();
    dismiss();
  };
  // No body-click dismissal: the toast is pointer-transparent so it never
  // steals a click aimed at the content it floats over (its × still closes,
  // and the auto-dismiss timer runs regardless).
  armTimer();
}

/** Sticky advisory with one action (the app-update toast): no auto-dismiss —
 *  the reader may be mid-session and the news stays true until they act or
 *  dismiss it. The action runs once and closes the bar. */
export function showUpdateNotification(msg, actionLabel, onAction) {
  if (deferForGrace(() => showUpdateNotification(msg, actionLabel, onAction))) return;
  cancelPending();
  clearTimeout(notifTimer);
  notifTimer = null;
  const el = $('notification');
  if (!el) return;
  el.classList.remove('warning');
  el.classList.add('update');
  // Advisory: polite, never interrupting (an update can wait its turn).
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.hidden = false;
  el.innerHTML =
    '<span class="notif-msg"></span><button class="notif-action"></button><button class="notif-close" aria-label="Dismiss notification">&times;</button>';
  el.querySelector('.notif-msg').textContent = msg;
  shownAt = Date.now();
  const action = el.querySelector('.notif-action');
  action.textContent = actionLabel;
  action.onclick = (e) => {
    e.stopPropagation();
    el.hidden = true;
    onAction();
  };
  el.querySelector('.notif-close').onclick = (e) => {
    e.stopPropagation();
    el.hidden = true;
  };
}
