// Transport selection: Web Serial when available, otherwise a minimal
// CDC/ACM WebUSB shim (Android Chrome), otherwise null (unsupported browser).
// The shim class is exported because the firmware-update wizard reuses it to
// flash the device bootloader over WebUSB (the bootloader's serial-DFU mode
// speaks on its CDC interface, which the shim can drive like a serial port).
import { log } from '../services/log.js';
import { portGeneration } from './session.js';
import {
  USB_VENDOR_ID,
  USB_PID_APPLICATION,
  USB_PID_APPLICATION_SENSE,
  USB_PID_BOOTLOADER,
  USB_PID_BOOTLOADER_SENSE,
} from '../config/constants.js';

// Chrome Web Serial serializes opens per port; WebUSB does NOT — two
// UsbSerialPort wrappers around the same USBDevice could otherwise interleave
// their open/close sequences, and a stalled open's late release could tear
// down a newer flow's claimed interfaces. Every open/close on a device runs
// through one per-device chain, and closes check the session's port
// generation so a zombie teardown never closes what a newer attempt owns.
const deviceOpChains = new WeakMap();

/**
 * Runs `run` on `device`, serialized against every other shim open/close on
 * the same underlying USBDevice.
 * @param {any} device
 * @param {() => Promise<any>} run
 */
async function withSerializedDeviceOps(device, run) {
  let entry = deviceOpChains.get(device);
  if (!entry) {
    entry = { chain: Promise.resolve() };
    deviceOpChains.set(device, entry);
  }
  const attempt = entry.chain.then(run, run);
  entry.chain = attempt.then(
    () => undefined,
    () => undefined,
  );
  return attempt;
}

export class UsbSerialPort {
  constructor(device) {
    this.device = device;
    this.readable = null;
    this.writable = null;
    this.claimedInterfaces = [];
    this.ctrlIndex = null;
    this.epIn = null;
    this.epOut = null;
  }
  /** Web Serial-compatible identity, so bootloader detection works on Android too. */
  getInfo() {
    return { usbVendorId: this.device.vendorId, usbProductId: this.device.productId };
  }
  async open({ baudRate }) {
    const d = this.device;
    await withSerializedDeviceOps(d, async () => {
      if (!d.opened) await d.open();
      if (d.configuration === null) await d.selectConfiguration(1);
      let ctrl = null,
        data = null;
      for (const iface of d.configuration.interfaces) {
        const alt = iface.alternates[0];
        if (!alt) continue;
        if (alt.interfaceClass === 2 && !ctrl) ctrl = iface;
        if (alt.interfaceClass === 10 && !data) data = iface;
      }
      if (!data) throw new Error('No USB serial (CDC) interface found on this device');
      if (ctrl) {
        try {
          await d.claimInterface(ctrl.interfaceNumber);
          this.claimedInterfaces.push(ctrl.interfaceNumber);
        } catch (e) {
          log('Could not claim USB control interface (non-fatal): ' + e.message, 'log-info');
        }
      }
      await d.claimInterface(data.interfaceNumber);
      this.claimedInterfaces.push(data.interfaceNumber);
      const endpoints = data.alternates[0].endpoints;
      const epIn = endpoints.find((e) => e.direction === 'in').endpointNumber;
      const epOut = endpoints.find((e) => e.direction === 'out').endpointNumber;
      this.epIn = epIn;
      this.epOut = epOut;
      const ctrlIndex = (ctrl ?? data).interfaceNumber;
      this.ctrlIndex = ctrlIndex;
      await this.setLineCoding(baudRate);
      await this.setControlLineState(true);
      this.readable = new ReadableStream({
        pull: async (controller) => {
          const result = await d.transferIn(epIn, 64);
          if (result.data && result.data.byteLength)
            controller.enqueue(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength));
        },
      });
      this.writable = new WritableStream({ write: (chunk) => d.transferOut(epOut, chunk) });
    });
  }
  async setLineCoding(baudRate) {
    const lineCoding = new DataView(new ArrayBuffer(7));
    lineCoding.setUint32(0, baudRate, true);
    lineCoding.setUint8(4, 0);
    lineCoding.setUint8(5, 0);
    lineCoding.setUint8(6, 8);
    await this.device.controlTransferOut(
      { requestType: 'class', recipient: 'interface', request: 0x20, value: 0, index: this.ctrlIndex },
      lineCoding.buffer,
    );
  }
  async setControlLineState(dtr) {
    await this.device.controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request: 0x22,
      value: dtr ? 0x03 : 0x00,
      index: this.ctrlIndex,
    });
  }
  /** Web Serial-compatible DTR signalling (used for the 1200-baud DFU touch). */
  async setSignals({ dataTerminalReady = true } = {}) {
    await this.setControlLineState(!!dataTerminalReady);
  }
  async close() {
    // Release claimed interfaces first: leaving them claimed can wedge a
    // re-connect attempt in the same page session (Android Chrome). Both
    // release and close are best-effort — the browser also cleans up on
    // device.close(), so a failed release must not abort the close. The
    // whole teardown runs serialized against other opens/closes on the same
    // USBDevice, and a stale close (a newer port attempt has started since
    // it was requested) is skipped: it must never tear down interfaces a
    // newer flow has claimed.
    const gen = portGeneration.current;
    const d = this.device;
    await withSerializedDeviceOps(d, async () => {
      if (gen !== portGeneration.current) return;
      for (const n of this.claimedInterfaces) {
        try {
          await d.releaseInterface(n);
        } catch {}
      }
      try {
        await d.close();
      } catch {}
    });
  }
}

function usbSerialShim() {
  return {
    async requestPort() {
      // The LipSync's current USB identity (Seeed XIAO nRF52840, app or
      // bootloader PIDs — bootloader picks are handled by the connect guard's
      // recovery guidance). The old V3-era 0x1209:0x4c53 filter left the
      // current hardware ungrantable on Android.
      const KNOWN_FILTERS = [
        USB_PID_APPLICATION,
        USB_PID_APPLICATION_SENSE,
        USB_PID_BOOTLOADER,
        USB_PID_BOOTLOADER_SENSE,
      ].map((productId) => ({ vendorId: USB_VENDOR_ID, productId }));
      try {
        const device = await /** @type {any} */ (navigator).usb.requestDevice({ filters: KNOWN_FILTERS });
        return new UsbSerialPort(device);
      } catch (e) {
        if (e.name === 'NotFoundError') throw e;
        log('USB request with known filters failed; trying all USB devices…', 'log-info');
        const device = await /** @type {any} */ (navigator).usb.requestDevice({ filters: [] });
        return new UsbSerialPort(device);
      }
    },
  };
}

export const serialApi =
  typeof navigator === 'object' && 'serial' in navigator
    ? navigator.serial
    : typeof navigator === 'object' && 'usb' in navigator
      ? usbSerialShim()
      : null;

// Test seam (the connect-flow sibling of configureDfuPortSource): injects
// the { requestPort } source connect() uses, so the Connect path — including
// the bootloader-stranded guard — is testable in Node (no Web Serial).
let serialPortSource = null;
export function configureSerialPortSource(source) {
  serialPortSource = source;
}

/**
 * The port-request entry point used by the Connect flow. Production uses
 * the selected transport (Web Serial or the WebUSB shim); tests inject
 * simulated ports through configureSerialPortSource.
 */
export async function requestSerialPort() {
  const api = serialPortSource ?? serialApi;
  if (!api) throw new Error('No serial support in this browser.');
  return /** @type {any} */ (api).requestPort();
}
