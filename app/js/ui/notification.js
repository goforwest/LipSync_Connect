// Transient top-of-screen notification bar (auto-dismiss after 8 s).
import { $ } from './dom.js';

let notifTimer = null;

export function showNotification(msg, isWarning = false) {
  clearTimeout(notifTimer);
  const el = $('notification');
  if (!el) return;
  el.classList.toggle('warning', !!isWarning);
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
  el.onclick = (e) => {
    if (e.target === el) dismiss();
  };
  notifTimer = setTimeout(dismiss, 8000);
}
