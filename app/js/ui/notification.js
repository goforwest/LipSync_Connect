// Transient top-of-screen notification bar (auto-dismiss after 8 s).
import { $ } from './dom.js';

let notifTimer = null;

// Users who have requested reduced motion often rely on the toast to convey
// an important message and may not be able to react within 8 seconds —
// don't auto-dismiss for them. The × button is still available to close.
function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
}

export function showNotification(msg, isWarning = false) {
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
