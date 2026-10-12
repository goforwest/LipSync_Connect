// Web Serial transport for the XIAO nRF52840 stock bootloader's serial DFU
// mode. Owns the bootloader port end-to-end: open, ping, START/INIT/DATA/
// STOP frames with per-frame ACK tracking and retries, flash-erase/write
// dwell pacing, progress reporting, and cancellation. The STOP frame is the
// last protocol exchange: the bootloader validates, activates, and reboots
// on its receipt — there is no separate validate/activate step to drive.
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
  closePortBounded,
  openPortBounded,
  closePortWithOutcome,
  PORT_OPEN_TIMEOUT_MS,
  isPortOpenWedged,
} from '../../utils/port-open.js';
import { sleep } from '../../utils/timers.js';
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
// Web Serial and WebUSB spell their filter keys differently.
const LIPSYNC_USB_FILTERS = [...BOOTLOADER_PIDS, ...APP_PIDS].map((pid) => ({
  usbVendorId: USB_VENDOR_ID,
  usbProductId: pid,
}));
const LIPSYNC_WEBUSB_FILTERS = [...BOOTLOADER_PIDS, ...APP_PIDS].map((pid) => ({
  vendorId: USB_VENDOR_ID,
  productId: pid,
}));

// Liveness probes against a granted bootloader port must not stall a wizard
// step for long: a live bootloader's open settles in milliseconds, so a short
// bound is plenty; a wedged/stalled probe falls through to the picker (the
// safe direction) instead of grinding the user.
const DFU_LIVENESS_PROBE_MS = 3000;

/**
 * Proves the device behind a granted bootloader port is actually present by
 * opening the port at the DFU baud rate and closing it again (harmless to the
 * bootloader — only the 1200-baud touch signals anything). Native SerialPort
 * objects expose NO connected/liveness property (the Web Serial API only
 * offers connect/disconnect events, which say nothing about ports already
 * departed when the page loaded), and WebUSB's getDevices() is no better —
 * so the only honest liveness test is to touch the port.
 * @param {any} port a SerialPort or UsbSerialPort shim
 * @returns {Promise<boolean>} true only when the probe open settled cleanly
 */
export async function serialDfuPortIsLive(port) {
  if (!port) return false;
  try {
    await openPortBounded(port, { baudRate: DFU_BAUD_RATE }, { timeoutMs: DFU_LIVENESS_PROBE_MS });
  } catch {
    // Gone-style error, OS wedge, or any other settled failure: not provably
    // live. The open's own late-release path frees a stall that lands later.
    return false;
  }
  await closePortBounded(port);
  return true;
}

// Silent reuse only for the bootloader identity: an app-mode grant is the
// still-running LipSync, and silently flashing at it (instead of showing the
// picker, whose pick then triggers the self-heal restart) skips the only
// path that recovers the mispick on the WebUSB transport.
const isBootloaderUsbDevice = (/** @type {any} */ d) =>
  d.vendorId === USB_VENDOR_ID && BOOTLOADER_PIDS.has(d.productId);

/**
 * True when the port is the LipSync bootloader's serial-DFU interface —
 * also used by the regular Connect flow so a device stranded in update
 * mode is recognized immediately instead of grinding through command
 * timeouts (the bootloader cannot answer the settings protocol).
 */
export function isBootloaderPort(port) {
  const info = port?.getInfo?.() ?? {};
  return info.usbVendorId === USB_VENDOR_ID && BOOTLOADER_PIDS.has(info.usbProductId);
}

/**
 * @param {any} serial
 * @param {{ avoidPort?: any }} [options] avoidPort: a port the last flash
 * attempt failed on — it must not be silently reused from getPorts(); the
 * picker must be shown instead, or the wizard's "pick the update loader
 * again" guidance can never actually be followed.
 */
async function requestWebSerialDfuPort(serial, options = {}) {
  const { avoidPort } = options;
  for (const p of await serial.getPorts()) {
    // getPorts() lists previously-granted ports INCLUDING departed ones,
    // whose getInfo() still reports the cached VID/PID — and native
    // SerialPort objects expose no liveness property to tell them apart.
    // Only a probe-proven-live port may be reused silently; a stale entry
    // must fall through to the picker instead of dead-ending the flow in
    // an open-reject loop. The avoid-mark is checked first so the port the
    // last flash failed on is never even probed.
    if (isBootloaderPort(p) && p !== avoidPort && (await serialDfuPortIsLive(p))) return p;
  }
  try {
    return await serial.requestPort({ filters: LIPSYNC_USB_FILTERS });
  } catch (e) {
    if (e.name === 'NotFoundError') throw e;
    // Retry, but keep the LipSync filter: an unfiltered picker would let the
    // user select foreign hardware, and the probe below would push inert
    // HCI frames into it. A second failure is surfaced, not widened.
    return serial.requestPort({ filters: LIPSYNC_USB_FILTERS });
  }
}

/**
 * @param {any} usb
 * @param {{ avoidPort?: any }} [options]
 */
async function requestWebUsbDfuPort(usb, options = {}) {
  const { avoidPort } = options;
  // WebUSB wrappers are created fresh per call, so avoid-marks must key on the
  // underlying USBDevice — comparing wrapper identities could never match a
  // previous call's wrapper, and the failed device would be silently retried.
  const avoidDevice = avoidPort?.device ?? null;
  for (const d of await usb.getDevices()) {
    // getDevices() can list authorized-but-departed devices: only a
    // probe-proven-live bootloader is silently reused, exactly like the Web
    // Serial path above.
    if (!isBootloaderUsbDevice(d)) continue;
    if (avoidDevice && d === avoidDevice) continue;
    const wrapped = new UsbSerialPort(d);
    if (await serialDfuPortIsLive(wrapped)) return wrapped;
  }
  try {
    return new UsbSerialPort(await usb.requestDevice({ filters: LIPSYNC_WEBUSB_FILTERS }));
  } catch (e) {
    if (e.name === 'NotFoundError') throw e;
    return new UsbSerialPort(await usb.requestDevice({ filters: LIPSYNC_WEBUSB_FILTERS }));
  }
}

/**
 * Obtains the bootloader serial port on whichever transport the browser
 * offers. Previously-granted bootloader ports are reused silently (smooths
 * repeat updates); otherwise the browser picker is shown filtered to the
 * LipSync's USB identity. `avoidPort` (a port the last flash attempt failed
 * on) forces the picker instead of a silent reuse.
 * @param {{ avoidPort?: any }} [options]
 */
export async function requestDfuPort(options = {}) {
  const { serial, usb } = portSource();
  if (serial) return requestWebSerialDfuPort(serial, options);
  if (usb) return requestWebUsbDfuPort(usb, options);
  throw new Error('Neither Web Serial nor WebUSB is available in this browser.');
}

/**
 * The serial port source's currently-known ports (or null when no Web
 * Serial). Used by the wizard to verify that a 1200-baud restart actually
 * landed: a previously-granted bootloader port with a live connection is
 * the only bus-side proof of update mode.
 */
export async function getKnownSerialPorts() {
  const { serial } = portSource();
  return serial ? serial.getPorts() : null;
}

/**
 * Flashes `bin` (with `dat` as the init packet) to an already-selected
 * bootloader port. Resolves when the ACTIVATE frame has been sent and the
 * bootloader has reset into the new firmware.
 *
 * @param {{port: any, bin: Uint8Array, dat: Uint8Array,
 *          onProgress?: (p: {stage: string, percent?: number, message: string}) => void,
 *          onStartAccepted?: () => void,
 *          signal?: AbortSignal, ackTimeoutMs?: number}} options
 */
export async function flashSerialDfu(options) {
  const { port, bin, dat } = options;
  const onProgress = options.onProgress ?? (() => {});
  const onStartAccepted = options.onStartAccepted ?? (() => {});
  const signal = options.signal;
  const ackTimeoutMs = options.ackTimeoutMs ?? DFU_ACK_TIMEOUT_MS;
  const throwIfAborted = () => {
    if (signal?.aborted) throw new Error('Firmware update cancelled.');
  };

  // The flash's open is as exposed to the wedged-port hang as the touch and
  // Connect opens are (observed on hardware) — bound the same way (10 s, the
  // same bound Connect uses), with flash-appropriate guidance, and recover
  // from the two leftover-state failures the same way Connect does: a port a
  // stalled close left "already open", and an earlier open still "in
  // progress" (fast-failing when the OS-level wedge was already proven —
  // the wait would be futile).
  const openDfuPortWithRecovery = async () => {
    const bounds = {
      timeoutMs: PORT_OPEN_TIMEOUT_MS,
      stallMessage:
        'The update loader\u2019s serial port did not respond. Unplug the LipSync, plug it back in, then click Continue and pick it again.',
    };
    try {
      await openPortBounded(port, { baudRate: DFU_BAUD_RATE }, bounds);
    } catch (e) {
      const msg = e?.message ?? '';
      if (/already in progress/i.test(msg)) {
        if (isPortOpenWedged()) throw e;
        await sleep(PORT_OPEN_TIMEOUT_MS + 500);
        await openPortBounded(port, { baudRate: DFU_BAUD_RATE }, bounds);
        return;
      }
      if (!/already open/i.test(msg)) throw e;
      const close = await closePortWithOutcome(port, 3000);
      if (close.outcome !== 'closed') throw e;
      await sleep(300);
      await openPortBounded(port, { baudRate: DFU_BAUD_RATE }, bounds);
    }
  };
  await openDfuPortWithRecovery();
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
      // Observe a cancel the moment it lands, not at the next frame exchange:
      // a cancelled wizard must not sit on a silent device for a full ACK
      // window while its teardown is being settled. The STOP exchange
      // classifies this throw through the same retry loop (an abort after the
      // STOP was written still lands in the ambiguous hedge).
      if (signal?.aborted) throw new Error('Firmware update cancelled.');
      let ends = 0;
      for (const b of rx) if (b === 0xc0) ends++;
      if (ends >= 2) return ackFromResponse(rx);
      await sleep(10);
    }
    throw new Error('Timed out waiting for the device to acknowledge a packet.');
  };

  /**
   * Writes one frame and waits for its ACK, retrying unchanged while the
   * device re-ACKs a wrong number (it keeps expecting the same sequence).
   * `onWritten` fires the moment the frame's bytes are handed to the port —
   * the STOP exchange uses it to separate "was never sent" from "was sent
   * and then the link went quiet". A write that itself fails tags the error
   * with frameWriteFailed: delivery is indeterminate (the bytes may already
   * be buffered in a departing port), which is exactly the STOP window's
   * ambiguity.
   * @param {Uint8Array} frame
   * @param {{ timeoutMs?: number, onWritten?: () => void }} [options]
   */
  const send = async (frame, { timeoutMs = ackTimeoutMs, onWritten } = {}) => {
    for (let attempt = 1; attempt <= DFU_MAX_TX_ATTEMPTS; attempt++) {
      throwIfAborted();
      rx = new Uint8Array(0);
      try {
        await writer.write(frame);
      } catch (e) {
        e.frameWriteFailed = true;
        throw e;
      }
      onWritten?.();
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
    } catch (e) {
      // Two very different failures collapse at the probe, and only one of
      // them can be fixed by picking the port again:
      //  - the port is silent (the still-running app was picked, a dead
      //    link): a re-pick can fix it;
      //  - the device ANSWERED but re-ACKed a wrong number until the
      //    attempts ran out: a live bootloader still holding the sequence
      //    counter of an interrupted attempt (observed on hardware: a
      //    recovery started right after a cancelled post-START flash is
      //    rejected in ~370 ms — three fast re-ACKs, not a 15 s silence).
      //    No frame a new session sends can re-sync it: its DFU queue state
      //    is unknown (START may have been accepted, the erase may be mid-
      //    flight), so re-using that loader risks a second erase or worse.
      //    Only a fresh enumeration (replug, or double reset) clears it —
      //    say exactly that instead of the "pick again" loop that cannot
      //    work while the loader is stale.
      if (/did not accept a packet after/i.test(e?.message ?? '')) {
        const stale = /** @type {Error & { staleLoaderSession?: boolean }} */ (
          new Error(
            'The update loader is still holding the interrupted attempt — it needs a fresh start before a new update can begin. Unplug the LipSync and plug it back in (or press its reset button twice, slowly), then click Continue and pick the update loader again.',
          )
        );
        stale.staleLoaderSession = true;
        throw stale;
      }
      throw new Error(
        'The selected device did not respond as an update loader. Press the small reset button on the Hub twice (slowly), then click Continue and pick the update loader again.',
      );
    }
    onProgress({ stage: 'erase', message: 'Preparing device flash memory…' });
    await send(startFrame(DFU_IMAGE.APPLICATION, { application: bin.length }, seq));
    // The START exchange is the point of no return: once the bootloader has
    // accepted it, the old application is (being) erased and only a complete
    // flash repairs the device. The wizard uses this to keep its messaging
    // honest about what an interruption leaves behind.
    onStartAccepted();
    await sleep(eraseWaitMs(bin.length));
    // The erase dwell is the longest un-interactive window in the transfer —
    // observe a cancel the moment it is over instead of at the next frame
    // exchange, so the wizard's wind-down settle is never raced by a zombie
    // that still believes it is mid-erase.
    throwIfAborted();
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
    // the new firmware right after its ACK — the port departs within ~1 s of
    // that ACK (hardware). The exchange needs its own failure semantics:
    //  - the device still ANSWERING (re-ACKing a wrong number after all
    //    attempts) genuinely did not accept the STOP — the flash did not
    //    finish;
    //  - a cancel that lands BEFORE the STOP bytes were written stopped a
    //    flash that certainly did not finish;
    //  - everything else once the bytes left the host is ambiguous: a
    //    pending read that the detach rejects can drop the already-delivered
    //    ACK bytes, so even a pure ACK timeout is NOT proof of failure — the
    //    device may have accepted STOP and be rebooting with the new
    //    firmware. Timeouts, link drops, and aborts in that window are
    //    tagged for the wizard to hedge ("may have completed — reconnect to
    //    verify") instead of declaring an interruption that may not have
    //    happened.
    let stopWritten = false;
    try {
      await send(stopFrame(seq), { onWritten: () => (stopWritten = true) });
    } catch (e) {
      const deviceStillAnswering = /did not accept/i.test(e?.message ?? '');
      const stopNeverAttempted = !stopWritten && !e?.frameWriteFailed;
      if (deviceStillAnswering || stopNeverAttempted) throw e;
      const tagged = new Error('The connection dropped while the update was finishing.');
      tagged.name = 'StopWindowError';
      tagged.cause = e;
      throw tagged;
    }
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
    await closePortBounded(port);
    pump.catch(() => {});
  }
}
