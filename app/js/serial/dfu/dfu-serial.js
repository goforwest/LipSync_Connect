// Web Serial transport for the XIAO nRF52840 stock bootloader's serial DFU
// mode. Owns the bootloader port end-to-end: open, ping, START/INIT/DATA/
// STOP/VALIDATE/ACTIVATE frames with per-frame ACK tracking and retries,
// flash-erase/write dwell pacing, progress reporting, and cancellation.
//
// Port selection is factored through configureDfuPortSource() so tests can
// inject simulated ports (there is no Web Serial/WebUSB in Node).
//
// Desktop uses Web Serial. On Android (no Web Serial) the bootloader's serial
// DFU mode is driven through its CDC interface via the WebUSB shim from
// serial/transport.js — the same DFU protocol over a different pipe, which
// is why both transports share this module.
import {
  DFU_BAUD_RATE,
  DFU_PACKET_MAX_SIZE,
  DFU_ACK_TIMEOUT_MS,
  DFU_MAX_TX_ATTEMPTS,
  DFU_IMAGE,
  ackFromResponse,
  dataFrame,
  eraseWaitMs,
  initFrame,
  pageWriteDwellMs,
  probeFrame,
  startFrame,
  stopFrame,
} from './dfu-protocol.js';
import {
  USB_PID_APPLICATION,
  USB_PID_APPLICATION_SENSE,
  USB_PID_BOOTLOADER,
  USB_PID_BOOTLOADER_SENSE,
  USB_VENDOR_ID,
} from '../../config/constants.js';
import { UsbSerialPort } from '../transport.js';

/** @type {() => {serial?: any, usb?: any}} */
let portSource = () => ({
  serial: typeof navigator === 'object' && 'serial' in navigator ? navigator.serial : null,
  usb: typeof navigator === 'object' && 'usb' in navigator ? navigator.usb : null,
});

/** Test seam: injects { serial, usb } port/device sources. */
export function configureDfuPortSource(source) {
  portSource = () => source;
}

const BOOTLOADER_PIDS = new Set([USB_PID_BOOTLOADER, USB_PID_BOOTLOADER_SENSE]);
const APP_PIDS = new Set([USB_PID_APPLICATION, USB_PID_APPLICATION_SENSE]);

const isBootloaderUsbDevice = (/** @type {any} */ d) =>
  d.vendorId === USB_VENDOR_ID && (BOOTLOADER_PIDS.has(d.productId) || APP_PIDS.has(d.productId));

const isLipSyncPort = (port) => {
  const info = port.getInfo?.() ?? {};
  return info.usbVendorId === USB_VENDOR_ID && BOOTLOADER_PIDS.has(info.usbProductId);
};

async function requestWebSerialDfuPort(serial) {
  for (const p of await serial.getPorts()) {
    if (isLipSyncPort(p)) return p;
  }
  try {
    return await serial.requestPort({
      filters: [...BOOTLOADER_PIDS, ...APP_PIDS].map((pid) => ({
        usbVendorId: USB_VENDOR_ID,
        usbProductId: pid,
      })),
    });
  } catch (e) {
    if (e.name === 'NotFoundError') throw e;
    return serial.requestPort();
  }
}

async function requestWebUsbDfuPort(usb) {
  for (const d of await usb.getDevices()) {
    if (isBootloaderUsbDevice(d)) return new UsbSerialPort(d);
  }
  const filters = [...BOOTLOADER_PIDS, ...APP_PIDS].map((pid) => ({
    vendorId: USB_VENDOR_ID,
    productId: pid,
  }));
  try {
    return new UsbSerialPort(await usb.requestDevice({ filters }));
  } catch (e) {
    if (e.name === 'NotFoundError') throw e;
    return new UsbSerialPort(await usb.requestDevice({ filters: [] }));
  }
}

/**
 * Obtains the bootloader serial port on whichever transport the browser
 * offers. Previously-granted bootloader ports are reused silently (smooths
 * repeat updates); otherwise the browser picker is shown filtered to the
 * LipSync's USB identity.
 */
export async function requestDfuPort() {
  const { serial, usb } = portSource();
  if (serial) return requestWebSerialDfuPort(serial);
  if (usb) return requestWebUsbDfuPort(usb);
  throw new Error('Neither Web Serial nor WebUSB is available in this browser.');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Flashes `bin` (with `dat` as the init packet) to an already-selected
 * bootloader port. Resolves when the ACTIVATE frame has been sent and the
 * bootloader has reset into the new firmware.
 *
 * @param {{port: any, bin: Uint8Array, dat: Uint8Array,
 *          onProgress?: (p: {stage: string, percent?: number, message: string}) => void,
 *          signal?: AbortSignal}} options
 */
export async function flashSerialDfu(options) {
  const { port, bin, dat } = options;
  const onProgress = options.onProgress ?? (() => {});
  const signal = options.signal;
  const throwIfAborted = () => {
    if (signal?.aborted) throw new Error('Firmware update cancelled.');
  };

  await port.open({ baudRate: DFU_BAUD_RATE });
  const reader = port.readable.getReader();
  const writer = port.writable.getWriter();
  let rx = new Uint8Array(0);
  let reading = true;

  const pump = (async () => {
    while (reading) {
      try {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) {
          const merged = new Uint8Array(rx.length + value.length);
          merged.set(rx);
          merged.set(value, rx.length);
          rx = merged;
        }
      } catch {
        break;
      }
    }
  })();

  // Sequence numbers start at 1: the bootloader's HCI transport initializes
  // its expected-sequence counter to 1 (INITIAL_ACK_NUMBER_EXPECTED), and the
  // device acknowledges each accepted frame with the NEXT number it expects.
  let seq = 1;

  const waitForAck = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let ends = 0;
      for (const b of rx) if (b === 0xc0) ends++;
      if (ends >= 2) return ackFromResponse(rx);
      await sleep(10);
    }
    throw new Error('Timed out waiting for the device to acknowledge a packet.');
  };

  const send = async (frame, { expectAck = true, timeoutMs = DFU_ACK_TIMEOUT_MS } = {}) => {
    for (let attempt = 1; attempt <= DFU_MAX_TX_ATTEMPTS; attempt++) {
      throwIfAborted();
      rx = new Uint8Array(0);
      await writer.write(frame);
      if (!expectAck) return;
      const wantAck = (seq + 1) % 8;
      try {
        const ack = await waitForAck(timeoutMs);
        if (ack === wantAck) {
          seq = wantAck;
          return;
        }
        // Any other number means the device did not accept this frame —
        // retry it unchanged (the device keeps expecting the same number).
      } catch (e) {
        if (attempt === DFU_MAX_TX_ATTEMPTS) throw e;
      }
      await sleep(100);
    }
    throw new Error('The device did not accept a packet after ' + DFU_MAX_TX_ATTEMPTS + ' attempts.');
  };

  try {
    onProgress({ stage: 'connect', message: 'Contacting the device bootloader…' });
    try {
      await send(probeFrame(seq));
    } catch {
      // The port opened but nothing spoke the bootloader protocol: almost
      // always the still-running application was picked instead of the
      // update loader.
      throw new Error(
        'The selected device did not respond as an update loader. Press the small reset button on the Hub twice (slowly), then click Continue and pick the update loader again.',
      );
    }
    onProgress({ stage: 'erase', message: 'Preparing device flash memory…' });
    await send(startFrame(DFU_IMAGE.APPLICATION, { application: bin.length }, seq));
    await sleep(eraseWaitMs(bin.length));
    onProgress({ stage: 'init', message: 'Sending firmware metadata…' });
    await send(initFrame(dat, seq));

    const totalChunks = Math.ceil(bin.length / DFU_PACKET_MAX_SIZE);
    for (let i = 0; i < totalChunks; i++) {
      throwIfAborted();
      const chunk = bin.slice(i * DFU_PACKET_MAX_SIZE, Math.min((i + 1) * DFU_PACKET_MAX_SIZE, bin.length));
      await send(dataFrame(chunk, seq));
      const percent = Math.round(((i + 1) / totalChunks) * 100);
      onProgress({
        stage: 'transfer',
        percent,
        message: `Sending firmware… ${percent}%`,
      });
      // Every 8 frames (4 KB) the nRF52 blocks to erase/write a flash page.
      if (i > 0 && (i + 1) % 8 === 0) await sleep(pageWriteDwellMs());
    }
    onProgress({ stage: 'finalize', message: 'Finishing write…' });
    // STOP is the last protocol frame: on receiving it the bootloader
    // validates the image, activates it, saves its settings, and reboots into
    // the new firmware right after the ACK — give the settings write a beat
    // before tearing the port down.
    await send(stopFrame(seq));
    await sleep(200);
    onProgress({ stage: 'done', message: 'Firmware installed. The device is restarting.' });
  } finally {
    reading = false;
    try {
      await reader.cancel();
    } catch {}
    try {
      writer.releaseLock();
    } catch {}
    try {
      await port.close();
    } catch {}
    pump.catch(() => {});
  }
}
