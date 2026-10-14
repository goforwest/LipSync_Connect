// Android path: the bootloader's serial-DFU mode driven over its CDC
// interface through the WebUSB shim (serial/transport.js UsbSerialPort).
// A fake USBDevice replays the CDC control/bulk transfers; the same
// bootloader simulator answers DFU frames, proving flashSerialDfu works
// unchanged over the WebUSB pipe, and that requestDfuPort picks it up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBootloaderSim } from './harness/bootloader-sim.mjs';
import { UsbSerialPort } from '../app/js/serial/transport.js';
import { configureDfuPortSource, flashSerialDfu, requestDfuPort } from '../app/js/serial/dfu/dfu-serial.js';

const BOOT_VID = 0x2886;
const BOOT_PID = 0x0044;

function createFakeBootloaderUsbDevice(sim) {
  const writer = sim.port.writable.getWriter();
  const reader = sim.port.readable.getReader();
  const state = {
    opened: false,
    closed: false,
    claimed: [],
    lineCodings: [],
    lineStates: [],
    get lastLineCodingBaud() {
      return state.lineCodings.length ? state.lineCodings[state.lineCodings.length - 1] : null;
    },
  };
  const device = {
    vendorId: BOOT_VID,
    productId: BOOT_PID,
    configuration: {
      interfaces: [
        { interfaceNumber: 0, alternates: [{ interfaceClass: 2, endpoints: [] }] },
        {
          interfaceNumber: 1,
          alternates: [
            {
              interfaceClass: 10,
              endpoints: [
                { direction: 'in', endpointNumber: 1 },
                { direction: 'out', endpointNumber: 2 },
              ],
            },
          ],
        },
      ],
    },
    async open() {
      state.opened = true;
    },
    async close() {
      state.closed = true;
    },
    async selectConfiguration() {},
    async claimInterface(n) {
      state.claimed.push(n);
    },
    async releaseInterface(n) {
      state.claimed = state.claimed.filter((x) => x !== n);
    },
    async controlTransferOut(setup, data) {
      if (setup.request === 0x20) {
        // SET_LINE_CODING: baud is the first u32 of the 7-byte payload.
        state.lineCodings.push(new DataView(data).getUint32(0, true));
      } else if (setup.request === 0x22) {
        state.lineStates.push(setup.value);
      }
    },
    async transferIn() {
      const { value } = await reader.read();
      return { data: value };
    },
    async transferOut(_ep, chunk) {
      await writer.write(new Uint8Array(chunk.buffer ?? chunk));
    },
  };
  return { device, state };
}

test('the WebUSB shim carries the serial-DFU flash (Android path)', async () => {
  const sim = createBootloaderSim();
  const { device, state } = createFakeBootloaderUsbDevice(sim);
  configureDfuPortSource({
    usb: { getDevices: async () => [device], requestDevice: async () => device },
  });

  const port = await requestDfuPort();
  assert.ok(port instanceof UsbSerialPort, 'previously-granted device wraps into the CDC shim');

  const steps = [];
  const bin = new Uint8Array(700).fill(0x5a);
  await flashSerialDfu({
    port,
    bin,
    dat: new Uint8Array(14).fill(0x11),
    onProgress: (p) => steps.push(p.stage),
  });

  assert.deepEqual(
    sim.state.ops.map((o) => o.name).filter((n) => n !== 'DATA'),
    ['PROBE', 'START', 'INIT', 'STOP'],
  );
  assert.equal(sim.state.rejectedFrames, 0, 'no frame was transport-rejected');
  assert.deepEqual([...sim.state.dataBytes], [...bin]);
  assert.equal(state.lineCodings[0], 115200, 'shim sets the DFU baud rate first');
  assert.ok(steps.includes('transfer'));
  assert.ok(steps[steps.length - 1] === 'done');
});

test('the 1200-baud DFU touch works over the shim (line coding + DTR drop)', async () => {
  const sim = createBootloaderSim();
  const { device, state } = createFakeBootloaderUsbDevice(sim);
  const port = new UsbSerialPort(device);
  await port.open({ baudRate: 1200 });
  await port.setSignals({ dataTerminalReady: false });
  await port.close();
  assert.equal(state.lastLineCodingBaud, 1200, 'touch opens at 1200 baud');
  assert.deepEqual(state.lineStates, [0x03, 0x00], 'DTR asserted on open, dropped for the touch');
  assert.equal(state.claimed.length, 0, 'close releases the CDC interfaces');
});

test('requestDfuPort falls back to the picker for an unknown bootloader device', async () => {
  const sim = createBootloaderSim();
  const { device } = createFakeBootloaderUsbDevice(sim);
  let requested = null;
  configureDfuPortSource({
    usb: {
      getDevices: async () => [],
      requestDevice: async ({ filters }) => {
        requested = filters;
        return device;
      },
    },
  });
  const port = await requestDfuPort();
  assert.ok(port instanceof UsbSerialPort);
  assert.deepEqual(requested, [
    { vendorId: BOOT_VID, productId: BOOT_PID },
    { vendorId: BOOT_VID, productId: 0x0045 },
    { vendorId: BOOT_VID, productId: 0x8044 },
    { vendorId: BOOT_VID, productId: 0x8045 },
  ]);
});

test('WebUSB: a failed port is avoided by device identity — the avoid-mark survives re-wrapping', async () => {
  // The wizard hands requestDfuPort the UsbSerialPort WRAPPER it failed on,
  // but getDevices() hands back raw USBDevices that get wrapped fresh on
  // every call. The avoid-mark must therefore key on the underlying device —
  // wrapper identity could never match, and the failed device would be
  // silently retried while the guidance promises a picker.
  const badSim = createBootloaderSim();
  const bad = createFakeBootloaderUsbDevice(badSim);
  const badTransfers = [];
  bad.device.transferOut = async (_ep, _chunk) => {
    badTransfers.push('write');
    throw new Error('The device is not responding on this port.');
  };
  const goodSim = createBootloaderSim();
  const good = createFakeBootloaderUsbDevice(goodSim);
  let pickerCalls = 0;
  configureDfuPortSource({
    usb: {
      getDevices: async () => [bad.device],
      requestDevice: async () => {
        pickerCalls++;
        return good.device;
      },
    },
  });

  const bin = new Uint8Array(700).fill(0x5a);
  const dat = new Uint8Array(14).fill(0x11);

  // First attempt: the granted bootloader answers its liveness probe (the
  // open works) but its bulk writes are dead — the flash fails on the probe.
  const firstPort = await requestDfuPort();
  assert.equal(firstPort.device, bad.device, 'sanity: the granted device was silently reused');
  await assert.rejects(
    () => flashSerialDfu({ port: firstPort, bin, dat }),
    /did not respond as an update loader/,
  );

  // Second attempt with the failed wrapper as the avoid-mark: the fresh
  // wrapper over the same device must NOT be silently returned.
  const secondPort = await requestDfuPort({ avoidPort: firstPort });
  assert.equal(secondPort.device, good.device, 'the failed device was skipped by identity');
  assert.equal(pickerCalls, 1, 'the picker actually appeared — the guidance is followable');
  assert.equal(badTransfers.length, 1, 'the failed device was never written to again');

  await flashSerialDfu({ port: secondPort, bin, dat });
  assert.equal(goodSim.state.activated, true, 'the flash completed on the freshly picked device');
});

test('WebUSB: a stale granted device is not silently reused without a live probe', async () => {
  // getDevices() can list authorized-but-departed devices: only a probe-proven
  // live bootloader is silently reused, exactly like the Web Serial path.
  const liveSim = createBootloaderSim();
  const live = createFakeBootloaderUsbDevice(liveSim);
  const stale = {
    vendorId: BOOT_VID,
    productId: BOOT_PID,
    async open() {
      const e = new Error('The device was disconnected.');
      e.name = 'NetworkError';
      throw e;
    },
    async close() {},
  };
  let pickerCalls = 0;
  configureDfuPortSource({
    usb: {
      getDevices: async () => [stale],
      requestDevice: async () => {
        pickerCalls++;
        return live.device;
      },
    },
  });
  const port = await requestDfuPort();
  assert.equal(port.device, live.device, 'the stale grant fell through to the picker');
  assert.equal(pickerCalls, 1);
});

test('WebUSB: shim opens serialize per device and a stalled open cannot race a newer one', async () => {
  // WebUSB (unlike Chrome Web Serial) does not serialize opens per device:
  // two wrappers around one USBDevice used to interleave their open/close
  // sequences. The shim now chains them per device.
  const events = [];
  let releaseFirstOpen = null;
  const device = {
    opened: false,
    configuration: {
      interfaces: [
        { interfaceNumber: 1, alternates: [{ interfaceClass: 10, endpoints: [
          { direction: 'in', endpointNumber: 1 },
          { direction: 'out', endpointNumber: 2 },
        ] }] },
      ],
    },
    async open() {
      events.push('device-open-start');
      if (!releaseFirstOpen) {
        await new Promise((resolve) => {
          releaseFirstOpen = resolve;
        });
      }
      this.opened = true;
      events.push('device-open-end');
    },
    async selectConfiguration() {},
    async claimInterface(n) {
      events.push('claim:' + n);
    },
    async releaseInterface(n) {
      events.push('release:' + n);
    },
    async close() {
      events.push('device-close');
    },
    async controlTransferOut() {},
    async transferIn() {
      return { data: null };
    },
    async transferOut() {},
  };

  const first = new UsbSerialPort(device);
  const second = new UsbSerialPort(device);
  const openedFirst = first.open({ baudRate: 115200 });
  await new Promise((r) => setTimeout(r, 20));
  const openedSecond = second.open({ baudRate: 115200 });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(events.filter((e) => e === 'device-open-start').length, 1, 'only the first open began');
  assert.equal(events.filter((e) => e.startsWith('claim:')).length, 0, 'the queued open has not claimed anything');

  releaseFirstOpen();
  await openedFirst;
  await openedSecond;
  assert.equal(events.filter((e) => e === 'device-open-start').length, 1, 'the second wrapper adopted the open device');
  assert.equal(events.filter((e) => e === 'claim:1').length, 2, 'each wrapper claimed its own interface, in order');

  // A stale close (a newer port attempt has started since it was requested)
  // is skipped inside the chain and never tears down the newer flow's claims.
  const { portGeneration } = await import('../app/js/serial/session.js');
  const staleClose = first.close(); // captures the current generation at call time
  portGeneration.current++; // a fresh attempt starts before the teardown body runs
  await staleClose;
  assert.equal(events.filter((e) => e.startsWith('release:')).length, 0, 'the stale close released nothing');
  assert.equal(events.filter((e) => e === 'device-close').length, 0, 'the stale close never closed the device');

  // The same-generation close still works.
  await second.close();
  assert.ok(events.includes('release:1'), 'a current close releases its claims');
  assert.ok(events.includes('device-close'), 'a current close closes the device');
});

// ---- One-shot probe retry (update-doc item 5) ---------------------------
// A freshly entered bootloader sometimes misses the very first probe (the
// bytes were written, the CDC interface just was not answering yet). The
// silent ACK-timeout shape gets exactly one extra round; a stale loader
// (wrong-number re-ACKs) must NOT be retried — only a replug re-syncs it.

import { setProbeRetrySettleForTests } from '../app/js/serial/dfu/dfu-serial.js';
import { slipDecode } from '../app/js/serial/dfu/dfu-protocol.js';

function opOfFrame(bytes) {
  const decoded = slipDecode(bytes.slice(1, -1));
  const body = decoded.slice(0, -2);
  const payload = body.slice(4);
  return payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24);
}

test('probe retry: a silent first round gets one re-send and the flash proceeds', async () => {
  setProbeRetrySettleForTests(10);
  const sim = createBootloaderSim();
  const realWriter = sim.port.writable.getWriter();
  let probeWrites = 0;
  const silentThenAlive = {
    getInfo: sim.port.getInfo,
    async open(o) {
      return sim.port.open(o);
    },
    async close() {
      return sim.port.close();
    },
    async setSignals() {},
    readable: sim.port.readable,
    writable: {
      getWriter: () => ({
        async write(bytes) {
          if (opOfFrame(new Uint8Array(bytes)) === 2) {
            probeWrites++;
            if (probeWrites <= 3) return; // the whole first send() round goes unanswered
          }
          return realWriter.write(bytes);
        },
        releaseLock() {},
      }),
    },
  };

  const bin = new Uint8Array(700).fill(0x5a);
  await flashSerialDfu({
    port: silentThenAlive,
    bin,
    dat: new Uint8Array(14).fill(0x11),
    ackTimeoutMs: 60,
  });
  assert.equal(probeWrites, 4, 'three silent probes, then the retry round answered');
  assert.equal(sim.state.activated, true, 'the flash completed after the retry');
  assert.deepEqual(
    sim.state.ops.map((o) => o.name).filter((n) => n !== 'DATA'),
    ['PROBE', 'START', 'INIT', 'STOP'],
  );
});

test('probe retry: a stale loader session is never re-probed', async () => {
  setProbeRetrySettleForTests(10);
  // A live loader that re-ACKs wrong numbers: every frame is answered, but
  // the sequence never advances (staleAckOnce models the first mismatch;
  // forcing expectedSeq to a mismatched value models the persistent case).
  const sim = createBootloaderSim({ ackDelayMs: 1 });
  sim.state.expectedSeq = 3; // a session mid-flight: every probe (seq 1) is wrong
  let probeWrites = 0;
  const stalePort = {
    getInfo: sim.port.getInfo,
    async open(o) {
      return sim.port.open(o);
    },
    async close() {
      return sim.port.close();
    },
    async setSignals() {},
    readable: sim.port.readable,
    writable: {
      getWriter: () => ({
        async write(bytes) {
          if (opOfFrame(new Uint8Array(bytes)) === 2) probeWrites++;
          return sim.port.writable.getWriter().write(bytes);
        },
        releaseLock() {},
      }),
    },
  };

  const bin = new Uint8Array(700).fill(0x5a);
  await assert.rejects(
    flashSerialDfu({ port: stalePort, bin, dat: new Uint8Array(14).fill(0x11), ackTimeoutMs: 60 }),
    /still holding the interrupted attempt/,
  );
  assert.equal(probeWrites, 3, 'one round only — a stale loader is classified immediately, never re-probed');
});
