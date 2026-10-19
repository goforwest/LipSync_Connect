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
  el.innerHTML =
    '<span class="notif-msg"></span><button class="notif-close" aria-label="Dismiss notification">&times;</button>';
  el.querySelector('.notif-msg').textContent = msg;
  el.hidden = false;
  const dismiss = () => {
    el.hidden = true;
    el.onclick = null;
  };
  el.querySelector('.notif-close').onclick = (e) => {
    e.stopPropagation();
    dismiss();
  };
  // No body-click dismissal: the toast is pointer-transparent so it never
  // steals a click aimed at the content it floats over (its × still closes,
  // and the auto-dismiss timer runs regardless).
  notifTimer = setTimeout(dismiss, 8000);
}
