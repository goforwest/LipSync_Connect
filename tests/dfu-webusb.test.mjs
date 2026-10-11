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
