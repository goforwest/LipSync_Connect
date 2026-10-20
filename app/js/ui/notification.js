// Transient top-of-screen notification bar (auto-dismiss after 8 s).
import { $ } from './dom.js';

let notifTimer = null;

export function showNotification(msg, isWarning = false) {
  clearTimeout(notifTimer);
  const el = $('notification');
  if (!el) return;
  el.classList.toggle('warning', !!isWarning);
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
    notifTimer = setTimeout(dismiss, 8000);
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
