// A simulated XIAO nRF52840 stock bootloader for tests — a behavioral model
// of the real thing, not just an ACK generator. It mirrors the transport in
// lib/sdk11 hci_transport.c and the DFU queue in dfu_transport_serial.c:
//
//  * sequence numbers start at 1; a frame with the expected seq is accepted,
//    the counter advances, and the ACK carries the NEXT expected number
//  * a frame with a wrong/duplicate seq is silently discarded at transport
//    level and re-ACKed with the current expected number (this exact mismatch
//    between host expectations and device ACKs once produced a "successful"
//    flash that wrote nothing — the sim now catches it)
//  * DFU ops: INIT(1) stores the init packet, START(3) records sizes and
//    erases, DATA(4) appends image bytes, STOP(5) completes the update —
//    validate + activate + reboot — but ONLY if the init packet was stored
//    and the received bytes equal the announced image size
//  * PROBE(2) and any other op are transport-ACKed and ignored by the queue
import { crc16, slipDecode, slipEncode } from '../../app/js/serial/dfu/dfu-protocol.js';

const OP_NAMES = { 1: 'INIT', 2: 'PROBE', 3: 'START', 4: 'DATA', 5: 'STOP' };

export function createBootloaderSim({ ackDelayMs = 2, respond = true, onActivated } = {}) {
  const state = {
    opened: false,
    closed: false,
    openedBaud: null,
    ops: [],
    dataBytes: new Uint8Array(0),
    initPacket: new Uint8Array(0),
    activated: false,
    startSizes: null,
    rejectedFrames: 0,
    lastError: null,
    // The transport's expected-sequence counter — 1 at session start.
    expectedSeq: 1,
  };

  const readQueue = [];
  const readWaiters = [];

  function enqueue(bytes) {
    const waiter = readWaiters.shift();
    if (waiter) waiter({ value: bytes, done: false });
    else readQueue.push(bytes);
  }

  function ackFrame() {
    // The device ACKs with the sequence number it expects NEXT.
    const b0 = (1 << 7) | (1 << 6) | ((state.expectedSeq & 0x07) << 3);
    const b1 = 14;
    const b2 = 0;
    const b3 = (~(b0 + b1 + b2) + 1) & 0xff;
    const head = new Uint8Array([b0, b1, b2, b3]);
    const crc = crc16(head);
    const frame = new Uint8Array([...head, crc & 0xff, (crc >> 8) & 0xff]);
    const enc = slipEncode(frame);
    return new Uint8Array([0xc0, ...enc, 0xc0]);
  }

  function parseFrame(bytes) {
    if (bytes[0] !== 0xc0 || bytes[bytes.length - 1] !== 0xc0) throw new Error('sim: frame not SLIP-bounded');
    const decoded = slipDecode(bytes.slice(1, -1));
    if (decoded.length < 6) throw new Error('sim: frame too short');
    const expectedCrc = decoded[decoded.length - 2] | (decoded[decoded.length - 1] << 8);
    const body = decoded.slice(0, decoded.length - 2);
    if (crc16(body) !== expectedCrc) throw new Error('sim: CRC mismatch');
    const [b0, b1, b2, b3] = body;
    // NB: parens required — `&` binds looser than `!==` in JS.
    if (((~(b0 + b1 + b2) + 1) & 0xff) !== b3) throw new Error('sim: header checksum mismatch');
    const seq = b0 & 0x07;
    const payload = body.slice(4);
    const op = payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24);
    return { seq, op, rest: payload.slice(4) };
  }

  function processOp(op, rest) {
    if (op === 3) {
      // START: [mode u8+pad][sd u32][bl u32][app u32] after the op word.
      const u32 = (i) => rest[i] | (rest[i + 1] << 8) | (rest[i + 2] << 16) | (rest[i + 3] << 24);
      state.startSizes = { softdevice: u32(4), bootloader: u32(8), application: u32(12) };
    }
    if (op === 1) {
      const merged = new Uint8Array(state.initPacket.length + rest.length);
      merged.set(state.initPacket);
      merged.set(rest, state.initPacket.length);
      state.initPacket = merged;
    }
    if (op === 4) {
      const merged = new Uint8Array(state.dataBytes.length + rest.length);
      merged.set(state.dataBytes);
      merged.set(rest, state.dataBytes.length);
      state.dataBytes = merged;
    }
    if (op === 5) {
      // dfu_image_validate + dfu_image_activate: complete only when the init
      // packet was stored and exactly the announced image size arrived.
      const complete =
        state.initPacket.length > 0 &&
        state.startSizes !== null &&
        state.dataBytes.length === state.startSizes.application;
      if (complete) {
        state.activated = true;
        onActivated?.();
        return false; // device reboots — no more transport
      }
      state.lastError = 'sim: STOP arrived without a complete image; update aborted';
      return false;
    }
    return true;
  }

  function onData(bytes) {
    try {
      const { seq, op, rest } = parseFrame(bytes);
      if (seq !== state.expectedSeq) {
        // Transport-level discard: re-ACK the current expected number.
        state.rejectedFrames++;
        if (respond) setTimeout(() => enqueue(ackFrame()), ackDelayMs);
        return;
      }
      state.expectedSeq = (state.expectedSeq + 1) % 8;
      state.ops.push({ op, name: OP_NAMES[op] ?? op, seq });
      // The transport ACKs at receipt — BEFORE the DFU queue processes the
      // packet (hci_transport.c acks in rx_vendor_specific_pkt_type_handle,
      // the queue runs afterwards from the scheduler). So even the STOP that
      // ends the update gets its ACK first; the "reboot" follows.
      if (respond) setTimeout(() => enqueue(ackFrame()), ackDelayMs);
      processOp(op, rest);
    } catch (e) {
      state.lastError = e.message;
    }
  }

  const port = {
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x0045 }),
    async open(options = {}) {
      state.opened = true;
      state.openedBaud = options.baudRate ?? null;
    },
    async close() {
      state.closed = true;
    },
    async setSignals() {},
    readable: {
      getReader: () => ({
        read: () =>
          readQueue.length ? Promise.resolve({ value: readQueue.shift(), done: false }) : new Promise((res) => readWaiters.push(res)),
        async cancel() {},
        releaseLock() {},
      }),
    },
    writable: {
      getWriter: () => ({
        async write(bytes) {
          onData(bytes);
        },
        releaseLock() {},
      }),
    },
  };

  return { port, state };
}
