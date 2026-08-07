// Async-button wrapper: disables the button while the handler runs, surfaces
// errors in the log + notification bar, and restores enabled state after.
// RT self-test buttons manage their own lockout for the duration of firmware
// narration and must not be re-enabled here (observed: SETTINGS timeout +
// FAIL desync on a second Test-LEDs click mid-test).
//
// Options:
//  * `quiet`   suppress the notification bar only — the handler surfaced the
//              error inline (e.g. #sapError/#formError); the log line stays.
//  * `swallow` suppress BOTH the log line and the notification — the handler
//              already surfaced and logged the failure (e.g. hub-remote).
import { serialSession } from '../serial/session.js';
import { isSelfTestLocked } from '../services/selftest.js';
import { $ } from './dom.js';
import { log } from '../services/log.js';
import { showNotification } from './notification.js';

export function guard(fn, opts = {}) {
  return async (event) => {
    const btn = event.currentTarget;
    const isCmd = btn.classList.contains('cmd');
    if (isCmd) {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.classList.add('btn--loading');
    }
    try {
      await fn();
    } catch (e) {
      if (!opts.swallow) {
        log(e.message, 'log-err');
        if (!opts.quiet) showNotification(e.message);
      }
    } finally {
      if (isCmd) {
        btn.classList.remove('btn--loading');
        const isSelfTestBtn = btn === $('btnTestLeds') || btn === $('btnTestBuzzer');
        if (isSelfTestBtn && isSelfTestLocked()) {
          btn.disabled = true;
        } else {
          btn.disabled = !serialSession.port;
        }
      }
    }
  };
}
