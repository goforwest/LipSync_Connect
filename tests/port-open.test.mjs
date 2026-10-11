// The bounded serial open (utils/port-open.js): a wedged macOS OS port can
// block open() indefinitely (observed repeatedly on hardware), so every
// user-waited open needs a stall bound. Covers the stall (with its late
// release), the happy path, error propagation, the onLateOpen hook, and the
// generation guard that keeps a zombie late release from closing a port a
// newer connect attempt has claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openPortBounded,
  closePortBounded,
  PORT_OPEN_TIMEOUT_MS,
  PORT_CLOSE_TIMEOUT_MS,
} from '../app/js/utils/port-open.js';
import { portGeneration } from '../app/js/serial/session.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a stalled open throws PortStallError with recovery guidance', async () => {
  const port = { open: () => new Promise(() => {}) };
  await assert.rejects(
    () => openPortBounded(port, { baudRate: 115200 }, { timeoutMs: 30 }),
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
  await assert.rejects(() => openPortBounded(port, { baudRate: 115200 }, { timeoutMs: 20 }));
  assert.deepEqual(closed, []);
  release(); // the open finally lands after the stall was reported
  await sleep(20);
  assert.deepEqual(closed, ['close'], 'the late open was released');
});

test('onLateOpen runs after a stalled open was released, and not when it failed', async () => {
  let lateHook = 0;
  let release = null;
  const port = {
    open: () => new Promise((resolve) => (release = resolve)),
    async close() {},
  };
  await assert.rejects(() =>
    openPortBounded(port, { baudRate: 1200 }, { timeoutMs: 20, onLateOpen: () => lateHook++ }),
  );
  release();
  await sleep(20);
  assert.equal(lateHook, 1, 'the late-release hook fired once');

  // An open that ultimately FAILED (not landed) must not run the hook.
  let reject = null;
  const failing = {
    open: () => new Promise((_, rej) => (reject = rej)),
    async close() {},
  };
  await assert.rejects(() =>
    openPortBounded(failing, { baudRate: 1200 }, { timeoutMs: 20, onLateOpen: () => lateHook++ }),
  );
  reject(new Error('device no longer available'));
  await sleep(20);
  assert.equal(lateHook, 1, 'no hook for a failed late open');
});

test('a late release is skipped once a newer port attempt has started', async () => {
  let release = null;
  const closed = [];
  const port = {
    open: () => new Promise((resolve) => (release = resolve)),
    async close() {
      closed.push('close');
    },
  };
  const genBefore = portGeneration.current;
  await assert.rejects(() => openPortBounded(port, { baudRate: 115200 }, { timeoutMs: 20 }));
  // A fresh connect attempt starts while the stalled open is still pending.
  portGeneration.current++;
  release(); // the zombie open lands only now
  await sleep(20);
  assert.deepEqual(closed, [], 'the zombie release must not close the port a newer attempt claimed');
  assert.ok(portGeneration.current > genBefore, 'sanity: the generation moved');
  // The held port is recoverable: the next attempt's cleanup close works.
  await closePortBounded(port, 30);
  assert.deepEqual(closed, ['close'], 'the newer attempt can still free the port');
});

test('a normal open resolves', async () => {
  const port = { open: async () => {} };
  await openPortBounded(port, { baudRate: 115200 }, { timeoutMs: 50 });
});

test('an open failure propagates the original error', async () => {
  const original = new Error('NetworkError: Failed to open serial port.');
  const port = {
    open: async () => {
      throw original;
    },
  };
  await assert.rejects(
    () => openPortBounded(port, { baudRate: 115200 }, { timeoutMs: 50 }),
    (e) => e === original,
  );
});

test('the default bounds are generous for real hardware', () => {
  assert.equal(PORT_OPEN_TIMEOUT_MS, 10000);
  // Hardware observation: a macOS close right after a full settings load
  // resolves anywhere in 5–20 s. A 5 s bound declared those healthy closes
  // "stalled", left the port open, and every later open failed with "The
  // port is already open". The bound defeats the hang-forever wedged close
  // — it must cover the slow-but-alive range too.
  assert.equal(PORT_CLOSE_TIMEOUT_MS, 20000);
});
