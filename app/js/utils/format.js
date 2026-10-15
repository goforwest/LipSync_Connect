// Pure formatting/parsing helpers with no DOM or app-state coupling.

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function parsePoint(pair) {
  const p = String(pair || '')
    .split('|')
    .map(Number);
  return Number.isFinite(p[0]) && Number.isFinite(p[1]) ? { x: p[0], y: p[1] } : null;
}

export function validFiniteList(value, count) {
  const items = (value || '').split(',');
  return items.length >= count && items.slice(0, count).every((item) => Number.isFinite(Number(item)));
}

// Format to 2 decimal places consistently (e.g. 10.25, 2.00, 149.99).
// Firmware's isValidCommandFormat() (LSAPI.ino) validates the TOTAL command
// line length, accepting 6-11 chars ("XX,d:" + a 1-6 char param) — 5-digit
// int parameters (10-char lines, e.g. WM,1:10000) were a missing shape until
// firmware 4.5.0. fmtApiFloat's trailing-zero padding predates that fix and
// stays: it is semantically neutral for floats ("10.25" → "10.250") and
// every padded line remains legal, so nothing depends on the firmware
// version connected. A 6-char param like "149.99" is legal (11-char line),
// which is why the sip/puff ceiling is 149.99 rather than 150.
export function fmtApiFloat(v) {
  const s = Number(v).toFixed(2);
  return s.length === 5 ? s + '0' : s;
}
