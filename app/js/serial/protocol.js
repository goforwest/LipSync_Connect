// Pure protocol parsing/matching for the LipSync serial wire format.
// `SUCCESS|MANUAL|FAIL`,<n>:<CMD>,<n>[:<value>] — no imports, no state.

export function parseResponse(line) {
  const m = line.match(/^(SUCCESS|MANUAL|FAIL),(\d+):(SETTINGS|DEBUG,\d+|[A-Z]{1,4},\d+)(?::(.*))?$/);
  if (!m) return null;
  return { type: m[1], ok: m[1] !== 'FAIL', num: parseInt(m[2], 10), cmd: m[3], value: m[4] ?? null };
}

// Plain-text firmware diagnostics are intentional out-of-band witnesses, not
// serial corruption. They stay visible as received log lines but must not feed
// the noisy "undecodable / possible corruption" counter.
export function isDeviceDiagnosticLine(line) {
  return /^(?:HB:|BOOT:|ERROR:|WARNING:|FAULT\b|SDFAULT\b|USB-EVT:|USB\s)/.test(line);
}

// Write endpoints whose SUCCESS ack echoes the written value verbatim —
// the SET of each of these is value-checked against its echo (a firmware
// that accepted-but-canonicalized would fail the command). Endpoints whose
// writes echo a DIFFERENT shape (e.g. WS/WL/WM answer the stored window,
// SD/MA/LK/CF answer the stored flag) are deliberately absent.
export const ECHO_WRITE_ENDPOINTS = new Set([
  'SS',
  'SL',
  'ST',
  'PT',
  'IZ',
  'OZ',
  'SM',
  'LM',
  'LL',
  'DM',
  'OM',
  'CM',
  'MP',
  // External switch actions (4.5.0+): the SET ack echoes the packed value
  // exactly as sent (0 on reset).
  'SA',
  'SB',
  'SC',
  'GA',
  'GB',
  'GC',
]);

export function commandMatchDetails(cmd) {
  const m = cmd.match(/^([A-Z]{1,4}),(\d+)(?::(.*))?$/);
  if (!m) return { expectedCommand: cmd.slice(0, 4), expectedValue: null, shouldEchoValue: false };
  return {
    expectedCommand: `${m[1]},${m[2]}`,
    expectedValue: m[3] ?? null,
    shouldEchoValue: m[2] === '1' && ECHO_WRITE_ENDPOINTS.has(m[1]) && m[3] != null,
  };
}

export function responseValueMatches(expectedValue, responseValue) {
  if (expectedValue == null) return true;
  if (responseValue == null) return false;
  const expectedNumber = Number(expectedValue);
  const responseNumber = Number(responseValue);
  if (Number.isFinite(expectedNumber) && Number.isFinite(responseNumber)) return expectedNumber === responseNumber;
  return String(responseValue) === String(expectedValue);
}

export function isCommandCompletion(response) {
  return response && response.type !== 'MANUAL';
}
