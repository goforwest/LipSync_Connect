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
