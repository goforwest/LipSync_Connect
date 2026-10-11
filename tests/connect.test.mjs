// The Connect flow (serial/connection.js) against injected ports — the
// path every other test bypasses by wiring serialSession.port directly.
// Covers the bootloader-stranded guard (a device stuck in update mode picked
// at Connect), the cancelled picker, and the cleanup-retry for a port the
// last session left open. The device-load step is stubbed via the public
// configureConnection seam so these tests stay fast.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEl, installGatingDom } from './harness/dom-stub.mjs';

const els = new Map();
const init = (id, cls) => {
  const el = makeEl(cls && cls.includes('button') ? 'button' : 'div');
  el.id = id;
  if (cls) el.classList.add(...cls.split(' ').filter(Boolean));
  els.set(id, el);
  return el;
};
init('btnConnect').disabled = false;
init('btnDisconnect', 'cmd').disabled = true;
for (const id of ['confirmDialog', 'confirmTitle', 'confirmBody', 'confirmOk', 'confirmCancel']) init(id);

const { document: doc, windowListeners } = installGatingDom(els);
await import('../app/js/main.js');
(windowListeners['DOMContentLoaded'] || []).forEach((fn) => fn());
const { testHooks } = await import('./harness/test-hooks.mjs');
const { connect, disconnect, configureConnection } = await import('../app/js/serial/connection.js');
const { configureSerialPortSource } = await import('../app/js/serial/transport.js');
const { serialSession } = await import('../app/js/serial/session.js');
const { getLogHistory } = await import('../app/js/services/log.js');

// Keep the connect flow fast: no 17-endpoint load against simulated ports.
configureConnection({ loadDeviceInfo: async () => {}, clearHealthResults: () => {} });

const byId = (id) => doc.getElementById(id);
const historyFrom = (n) => getLogHistory().slice(n).join('\n');

function portStubs() {
  const opens = [];
  const closes = [];
  const make = (getInfo) => ({
    getInfo,
    async open(opts) {
      opens.push(opts?.baudRate ?? null);
    },
    async close() {
      closes.push('close');
    },
    async setSignals() {},
    readable: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {}, releaseLock() {} }) },
    writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
  });
  return { opens, closes, make };
}

test('connect: picking the update loader triggers the stranded guard, not a timeout grind', async () => {
  const { opens, closes, make } = portStubs();
  const bootPort = make(() => ({ usbVendorId: 0x2886, usbProductId: 0x0045 }));
  configureSerialPortSource({ requestPort: async () => bootPort });
  const histStart = getLogHistory().length;

  await connect();

  assert.deepEqual(opens, [115200], 'the port was opened before the identity check');
  assert.deepEqual(closes, ['close'], 'the bootloader port was closed again');
  assert.equal(serialSession.port, null, 'no session was created against the bootloader');
  const history = historyFrom(histStart);
  assert.match(history, /update loader, not the LipSync itself/, 'the guard names what was picked');
  assert.match(history, /Recover a device stuck in update mode/, 'the in-app repair path is offered');
  assert.equal(byId('sec-firmware').getAttribute('data-recover'), 'true', 'the firmware card stays reachable');
  assert.equal(byId('btnRecoverDevice').hidden, false, 'the Recover button is revealed while disconnected');
  assert.equal(byId('btnConnect').disabled, false, 'Connect re-enables for another attempt');
});

test('connect: a dismissed picker is a quiet cancel, not an error', async () => {
  configureSerialPortSource({
    requestPort: async () => {
      const e = new Error('The user did not select a port.');
      e.name = 'NotFoundError';
      throw e;
    },
  });
  const histStart = getLogHistory().length;
  await connect();
  assert.match(historyFrom(histStart), /Connection cancelled: no serial port selected/);
  assert.equal(serialSession.port, null);
  assert.equal(byId('btnConnect').disabled, false, 'Connect re-enables');
});

test('connect: a port left open by the last session is cleaned up and retried once', async () => {
  const { make } = portStubs();
  let opens = 0;
  const appPort = make(() => ({ usbVendorId: 0x2886, usbProductId: 0x8045 }));
  const originalOpen = appPort.open;
  appPort.open = async (opts) => {
    opens++;
    if (opens === 1) {
      throw new Error('The port (cu.usbmodemXXXX) is already open.');
    }
    return originalOpen(opts);
  };
  configureSerialPortSource({ requestPort: async () => appPort });
  const histStart = getLogHistory().length;

  await connect();
  assert.equal(opens, 2, 'the cleanup close + retry re-opened the port');
  assert.match(historyFrom(histStart), /left open by the last session/, 'the diagnosis is logged');
  assert.equal(serialSession.port, appPort, 'the session came up on the retry');
  await disconnect({ quiet: true });
  testHooks.detach();
});
