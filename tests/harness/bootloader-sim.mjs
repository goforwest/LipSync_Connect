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
//  * staleAckOnce makes the FIRST ACK carry a stale number (expected-1) —
//    like a delayed duplicate ACK from the previous frame crossing the
//    wire — so the host's retry-on-wrong-ACK contract is testable
//  * departOnActivate: after STOP activates the image, the USB port actually
//    departs like real hardware (pending reads reject, buffered bytes are
//    lost, open() throws gone-style, close() rejects fast) — the stock
//    bootloader reboots within ~1 s of the STOP ACK
//  * loseStopAck: the STOP frame's ACK is never delivered (it was lost in
//    the detach) — the host cannot know whether STOP was accepted, the
//    ambiguity the wizard's STOP-window hedge exists for
//  * stopAckDelayMs: extra delay before the STOP frame's ACK only — lets
//    tests land cancels inside the final ACK wait
import { crc16, slipDecode, slipEncode } from '../../app/js/serial/dfu/dfu-protocol.js';

const OP_NAMES = { 1: 'INIT', 2: 'PROBE', 3: 'START', 4: 'DATA', 5: 'STOP' };

export function createBootloaderSim({
  ackDelayMs = 2,
  respond = true,
  staleAckOnce = false,
  departOnActivate = false,
  loseStopAck = false,
  departedWritesResolve = false,
  stopAckDelayMs = 0,
  onActivated,
} = {}) {
  const state = {
    opened: false,
    closed: false,
    openedBaud: null,
    ops: [],
    dataBytes: new Uint8Array(0),
    initPacket: new Uint8Array(0),
    activated: false,
    departed: false,
    startSizes: null,
    rejectedFrames: 0,
    lastError: null,
    // The transport's expected-sequence counter — 1 at session start.
    expectedSeq: 1,
    // When set, the next ACK carries a stale number (expected-1, like a
    // delayed duplicate ACK from the previous frame crossing the wire) — the
    // host must retry the frame unchanged, never treat it as success.
    staleAckPending: staleAckOnce,
  };

  const readQueue = [];
  const readWaiters = [];

  const departedError = () => {
    const e = new Error('Failed to execute "open" on "SerialPort": Failed to open serial port.');
    e.name = 'NetworkError';
    e.simDeparted = true;
    return e;
  };

  // Real detach semantics: the pending read rejects (buffered bytes are lost),
  // the queued bytes die with the connection, and every later open/close on
  // the port fails fast.
  function depart() {
    if (state.departed) return;
    state.departed = true;
    const waiters = readWaiters.splice(0);
    for (const w of waiters) w.rej(departedError());
    readQueue.length = 0;
  }

  function enqueue(bytes) {
    if (state.departed) return;
    const waiter = readWaiters.shift();
    if (waiter) waiter.res({ value: bytes, done: false });
    else readQueue.push(bytes);
  }

  function ackFrame() {
    // The device ACKs with the sequence number it expects NEXT.
    const stale = state.staleAckPending;
    state.staleAckPending = false;
    const ackNumber = stale ? (state.expectedSeq + 7) & 0x07 : state.expectedSeq;
    const b0 = (1 << 7) | (1 << 6) | ((ackNumber & 0x07) << 3);
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
        if (departOnActivate || loseStopAck) setTimeout(() => depart(), 0);
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
      if (respond && !(op === 5 && loseStopAck)) {
        const delay = op === 5 ? ackDelayMs + stopAckDelayMs : ackDelayMs;
        setTimeout(() => enqueue(ackFrame()), delay);
      }
      processOp(op, rest);
    } catch (e) {
      state.lastError = e.message;
    }
  }

  const port = {
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x0045 }),
    async open(options = {}) {
      if (state.departed) throw departedError();
      state.opened = true;
      state.openedBaud = options.baudRate ?? null;
    },
    async close() {
      if (state.departed) throw departedError();
      state.closed = true;
    },
    async setSignals() {},
    readable: {
      getReader: () => ({
        read: () => {
          if (state.departed) return Promise.reject(departedError());
          return readQueue.length
            ? Promise.resolve({ value: readQueue.shift(), done: false })
            : new Promise((res, rej) => readWaiters.push({ res, rej }));
        },
        async cancel() {
          // A parked read holds no timer — if the host's event loop drains
          // while a read is parked, everything after it dead-locks (flaky
          // suite-wide cancellations). flashSerialDfu cancels its reader in
          // the finally; the parked pump must be released, not parked forever.
          const waiters = readWaiters.splice(0);
          for (const w of waiters) w.res({ value: undefined, done: true });
        },
        releaseLock() {},
      }),
    },
    writable: {
      getWriter: () => ({
        async write(bytes) {
          if (state.departed) {
            // Two real detach behaviors: the OS fails the write outright, or
            // the write resolves into a buffer whose bytes die with the
            // connection (departedWritesResolve) — the second is the host's
            // WORST case: every retransmit "succeeds" and nothing is ever
            // acked, a pure ACK timeout.
            if (!departedWritesResolve) throw departedError();
            return;
          }
          onData(bytes);
        },
        releaseLock() {},
      }),
    },
  };

  return { port, state, depart };
}
