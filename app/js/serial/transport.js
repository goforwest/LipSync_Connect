// Transport selection: Web Serial when available, otherwise a minimal
// CDC/ACM WebUSB shim (Android Chrome), otherwise null (unsupported browser).
import { log } from '../services/log.js';

function usbSerialShim() {
  class UsbSerialPort {
    constructor(device) {
      this.device = device;
      this.readable = null;
      this.writable = null;
      this.claimedInterfaces = [];
    }
    async open({ baudRate }) {
      const d = this.device;
      await d.open();
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
      const ctrlIndex = (ctrl ?? data).interfaceNumber;
      const lineCoding = new DataView(new ArrayBuffer(7));
      lineCoding.setUint32(0, baudRate, true);
      lineCoding.setUint8(4, 0);
      lineCoding.setUint8(5, 0);
      lineCoding.setUint8(6, 8);
      await d.controlTransferOut(
        { requestType: 'class', recipient: 'interface', request: 0x20, value: 0, index: ctrlIndex },
        lineCoding.buffer,
      );
      await d.controlTransferOut({
        requestType: 'class',
        recipient: 'interface',
        request: 0x22,
        value: 0x03,
        index: ctrlIndex,
      });
      this.readable = new ReadableStream({
        pull: async (controller) => {
          const result = await d.transferIn(epIn, 64);
          if (result.data && result.data.byteLength)
            controller.enqueue(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength));
        },
      });
      this.writable = new WritableStream({ write: (chunk) => d.transferOut(epOut, chunk) });
    }
    async close() {
      // Release claimed interfaces first: leaving them claimed can wedge a
      // re-connect attempt in the same page session (Android Chrome). Both
      // release and close are best-effort — the browser also cleans up on
      // device.close(), so a failed release must not abort the close.
      for (const n of this.claimedInterfaces) {
        try {
          await this.device.releaseInterface(n);
        } catch {}
      }
      try {
        await this.device.close();
      } catch {}
    }
  }
  return {
    async requestPort() {
      const KNOWN_FILTERS = [{ vendorId: 0x1209, productId: 0x4c53 }];
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
