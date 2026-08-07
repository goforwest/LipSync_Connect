// Pure protocol parsing/matching for the LipSync serial wire format.
// `SUCCESS|MANUAL|FAIL`,<n>:<CMD>,<n>[:<value>] — no imports, no state.

export function parseResponse(line) {
  const m = line.match(/^(SUCCESS|MANUAL|FAIL),(\d+):(SETTINGS|DEBUG,\d+|[A-Z]{1,4},\d+)(?::(.*))?$/);
  if (!m) return null;
  return { type: m[1], ok: m[1] !== 'FAIL', num: parseInt(m[2], 10), cmd: m[3], value: m[4] ?? null };
}

export const ECHO_WRITE_ENDPOINTS = new Set(['SS', 'SL', 'ST', 'PT', 'IZ', 'OZ', 'SM', 'LM', 'LL', 'DM', 'OM', 'CM']);

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
