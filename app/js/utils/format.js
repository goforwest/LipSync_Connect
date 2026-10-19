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

// hPa thresholds display at 2 decimals everywhere (matches the input step
// 0.25 and the device's GET format). A SET's echo carries fmtApiFloat's
// line-length padding ("20.00" → "20.000") — a wire artifact, not a
// display format; this normalizes it so the readout doesn't flip between
// "20.00" (loaded) and "20.000" (just set) for the same value.
export function fmtHpa(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : String(v);
}
