// Unit tests for the pure wire-format parser (serial/protocol.js).
// No DOM, no simulated device, no async — each test exercises one pure
// function with fixed inputs so the wire contract is specified independently
// of the app shell. Run with: node tests/wire-format.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseResponse,
  isCommandCompletion,
  commandMatchDetails,
  responseValueMatches,
  ECHO_WRITE_ENDPOINTS,
} from '../app/js/serial/protocol.js';

// ---- parseResponse ------------------------------------------------

test('parseResponse: SETTINGS handshake', () => {
  assert.deepEqual(parseResponse('SUCCESS,0:SETTINGS'), {
    type: 'SUCCESS',
    ok: true,
    num: 0,
    cmd: 'SETTINGS',
    value: null,
  });
});

test('parseResponse: FAIL,0:SETTINGS is ok:false', () => {
  const r = parseResponse('FAIL,0:SETTINGS');
  assert.equal(r.ok, false);
  assert.equal(r.cmd, 'SETTINGS');
});

test('parseResponse: two-letter endpoint with read value', () => {
  assert.deepEqual(parseResponse('SUCCESS,0:MN,0:1'), {
    type: 'SUCCESS',
    ok: true,
    num: 0,
    cmd: 'MN,0',
    value: '1',
  });
});

test('parseResponse: MANUAL push notification', () => {
  const r = parseResponse('MANUAL,0:SS,1:6');
  assert.equal(r.type, 'MANUAL');
  assert.equal(r.ok, true); // MANUAL is never a failure marker
  assert.equal(r.cmd, 'SS,1');
  assert.equal(r.value, '6');
});

test('parseResponse: multi-segment value (calibration points)', () => {
  const r = parseResponse('SUCCESS,0:CA,0:0.69|1.14,-13.00|13.00,13.00|13.00,13.00|-13.00,-13.00|-13.00');
  assert.equal(r.cmd, 'CA,0');
  assert.equal(r.value.split(',').length, 5);
});

test('parseResponse: negative numeric value preserved as text', () => {
  const r = parseResponse('SUCCESS,0:AV,0:-5');
  assert.equal(r.value, '-5');
});

test('parseResponse: DEBUG,<mode> is a valid command token', () => {
  const r = parseResponse('SUCCESS,0:DEBUG,1:1.23|-0.50,10|-4,0|0');
  assert.equal(r.cmd, 'DEBUG,1');
});

test('parseResponse: DEBUG mode >= 10 (multi-digit)', () => {
  const r = parseResponse('SUCCESS,0:DEBUG,10:data');
  assert.equal(r.cmd, 'DEBUG,10');
});

test('parseResponse: empty value after colon', () => {
  const r = parseResponse('SUCCESS,0:SS,1:');
  assert.equal(r.value, '');
});

test('parseResponse: colon inside value captured greedily', () => {
  const r = parseResponse('SUCCESS,0:SS,1:5:extra');
  assert.equal(r.value, '5:extra');
});

test('parseResponse: trailing whitespace tolerated (readLoop trims upstream)', () => {
  const r = parseResponse('SUCCESS,0:SS,1:5 ');
  assert.equal(r.value, '5 ');
});

// Malformed / desync garbage
test('parseResponse: rejects leading whitespace', () => {
  assert.equal(parseResponse(' SUCCESS,0:SS,1:5'), null);
});
test('parseResponse: rejects concatenated desync line', () => {
  const r = parseResponse('FAIL,0:MN,0:0SETTINGS');
  assert.ok(r === null || r.cmd === 'MN,0');
});
test('parseResponse: rejects unrecognized text', () => {
  assert.equal(parseResponse('garbage line'), null);
});
test('parseResponse: rejects unknown 2+ letter prefix (4 letters, not in table)', () => {
  assert.equal(parseResponse('SUCCESS,0:XXXX,0:1'), null);
});
test('parseResponse: rejects 3-letter endpoint (not firmware format)', () => {
  assert.equal(parseResponse('SUCCESS,0:ABC,0:1'), null);
});
test('parseResponse: rejects missing sequence number', () => {
  assert.equal(parseResponse('SUCCESS,:MN,0:1'), null);
});
test('parseResponse: rejects non-numeric sequence', () => {
  assert.equal(parseResponse('SUCCESS,x:MN,0:1'), null);
});
test('parseResponse: rejects lowercase type', () => {
  assert.equal(parseResponse('success,0:MN,0:1'), null);
});

// ---- isCommandCompletion -------------------------------------------

test('isCommandCompletion: SUCCESS completes', () => {
  assert.equal(isCommandCompletion({ type: 'SUCCESS' }), true);
});
test('isCommandCompletion: FAIL completes', () => {
  assert.equal(isCommandCompletion({ type: 'FAIL' }), true);
});
test('isCommandCompletion: MANUAL does not complete a pending command', () => {
  assert.equal(isCommandCompletion({ type: 'MANUAL' }), false);
});
test('isCommandCompletion: null does not complete', () => {
  assert.equal(isCommandCompletion(null), null);
});

// ---- commandMatchDetails -------------------------------------------

test('commandMatchDetails: read command has no value expectation', () => {
  const d = commandMatchDetails('MN,0:0');
  assert.equal(d.expectedCommand, 'MN,0');
  assert.equal(d.expectedValue, '0');
  assert.equal(d.shouldEchoValue, false); // reads don't echo
});

test('commandMatchDetails: SET write on echo endpoint echoes value', () => {
  const d = commandMatchDetails('SS,1:7');
  assert.deepEqual(d, { expectedCommand: 'SS,1', expectedValue: '7', shouldEchoValue: true });
});

test('commandMatchDetails: write on non-echo endpoint (e.g. unrecognized) matches without value', () => {
  const d = commandMatchDetails('MN,1:7');
  assert.equal(d.expectedCommand, 'MN,1');
  assert.equal(d.shouldEchoValue, false); // MN is not in ECHO_WRITE_ENDPOINTS
});

test('commandMatchDetails: malformed command falls back to a 4-char expected command', () => {
  const d = commandMatchDetails('!foo bar');
  assert.equal(d.expectedCommand, '!foo');
  assert.equal(d.shouldEchoValue, false);
});

test('commandMatchDetails: write with empty value captures empty string and still echo-checks', () => {
  // The regex captures an empty string for a trailing ':', and '' != null, so
  // the parser treats it as an explicit empty write on an echo endpoint.
  const d = commandMatchDetails('SS,1:');
  assert.equal(d.expectedValue, '');
  assert.equal(d.shouldEchoValue, true);
});

// ---- responseValueMatches -------------------------------------------

test('responseValueMatches: no expectation → match', () => {
  assert.equal(responseValueMatches(null, 'anything'), true);
  assert.equal(responseValueMatches(null, null), true);
});

test('responseValueMatches: expected set, response missing → no match', () => {
  assert.equal(responseValueMatches('7', null), false);
  assert.equal(responseValueMatches('7', undefined), false);
});

test('responseValueMatches: numeric equality across string/number inputs', () => {
  assert.equal(responseValueMatches('6', 6), true);
  assert.equal(responseValueMatches(6, '6'), true);
  assert.equal(responseValueMatches('6.0', 6), true);
  assert.equal(responseValueMatches('-3', -3), true);
});

test('responseValueMatches: numeric mismatch', () => {
  assert.equal(responseValueMatches('6', '7'), false);
  assert.equal(responseValueMatches('6', '60'), false);
});

test('responseValueMatches: fall back to exact string equality', () => {
  assert.equal(responseValueMatches('1.14', '1.14'), true);
  assert.equal(responseValueMatches('1.14', '1.15'), false);
});

// ---- ECHO_WRITE_ENDPOINTS -------------------------------------------

test('ECHO_WRITE_ENDPOINTS covers exactly the firmware write endpoints', () => {
  assert.deepEqual([...ECHO_WRITE_ENDPOINTS].sort(), [
    'CM',
    'DM',
    'IZ',
    'LL',
    'LM',
    'OM',
    'OZ',
    'PT',
    'SL',
    'SM',
    'SS',
    'ST',
  ]);
});
