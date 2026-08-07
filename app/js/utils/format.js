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
// Firmware's isValidCommandFormat() (LSAPI.ino:238-248) validates the TOTAL
// command line length, accepting only 6/7/8/9/11 chars ("XX,d:" + param of
// length 1/2/3/4/6) — so param lengths 5, 7, or >=12 are all rejected.
// .toFixed(2) yields 5-char params like "10.25" (which would give a 10-char
// line, rejected); pad those to 6 with a trailing '0' so the line lands on
// 11. A 6-char param like "149.99" is already legal (11-char line), which is
// why the sip/puff ceiling is 149.99 rather than 150.
export function fmtApiFloat(v) {
  const s = Number(v).toFixed(2);
  return s.length === 5 ? s + '0' : s;
}
