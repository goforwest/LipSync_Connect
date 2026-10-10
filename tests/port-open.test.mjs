// The bounded serial open (utils/port-open.js): a wedged macOS OS port can
// block open() indefinitely (observed repeatedly on hardware), so every
// user-waited open needs a stall bound. Covers the stall (with its late
// release), the happy path, and error propagation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openPortBounded, PORT_OPEN_TIMEOUT_MS } from '../app/js/utils/port-open.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a stalled open throws PortStallError with recovery guidance', async () => {
  const port = { open: () => new Promise(() => {}) };
  await assert.rejects(
    () => openPortBounded(port, { baudRate: 115200 }, 30),
    (e) => e.name === 'PortStallError' && /did not respond/.test(e.message) && /Unplug/.test(e.message),
  );
});

test('a stalled open that lands late releases the port quietly', async () => {
  let release = null;
  const closed = [];
  const port = {
    open: () => new Promise((resolve) => (release = resolve)),
    async close() {
      closed.push('close');
    },
  };
  await assert.rejects(() => openPortBounded(port, { baudRate: 115200 }, 20));
  assert.deepEqual(closed, []);
  release(); // the open finally lands after the stall was reported
  await sleep(20);
  assert.deepEqual(closed, ['close'], 'the late open was released');
});

test('a normal open resolves', async () => {
  const port = { open: async () => {} };
  await openPortBounded(port, { baudRate: 115200 }, 50);
});

test('an open failure propagates the original error', async () => {
  const original = new Error('NetworkError: Failed to open serial port.');
  const port = { open: async () => { throw original; } };
  await assert.rejects(() => openPortBounded(port, { baudRate: 115200 }, 50), (e) => e === original);
});

test('the default bound is generous (10 s)', () => {
  assert.equal(PORT_OPEN_TIMEOUT_MS, 10000);
});
