// Session log core: the visible log box, the full in-memory history used by
// export/share, and the rate-limited corrupt-drop path.
import { LOG_HISTORY_MAX, LOG_MAX_LINES } from '../config/constants.js';
import { $ } from '../ui/dom.js';

const logHistory = [];

export function getLogHistory() {
  return logHistory;
}

export function log(msg, cls) {
  const timestamp = new Date().toISOString();
  logHistory.push(timestamp + '  ' + msg);
  if (logHistory.length > LOG_HISTORY_MAX) logHistory.shift();
  const el = document.createElement('div');
  if (cls) el.className = cls;
  el.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  const box = $('log');
  const shouldScroll = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
  box.appendChild(el);
  while (box.children.length > LOG_MAX_LINES) box.removeChild(box.firstElementChild);
  if (shouldScroll) box.scrollTop = box.scrollHeight;
}

// Rate-limited logger for out-of-band serial data that *isn't* self-test
// narration (reserved-mode text — LED/Buzzer/Watchdog narration is handled
// separately). Any other unparsed line is a real desync/corruption indicator
// and should never be swallowed.
export const noisyLineLog = (() => {
  let count = 0;
  let lastAt = 0;
  return (line) => {
    const now = Date.now();
    if (now - lastAt >= 5000) {
      if (count > 0)
        log(
          `(${count} more undecodable line${count === 1 ? '' : 's'} dropped — possible serial corruption)`,
          'log-err',
        );
      log('Undecodable line dropped: ' + line, 'log-err');
      lastAt = now;
      count = 0;
    } else {
      count++;
    }
  };
})();
