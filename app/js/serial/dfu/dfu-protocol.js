// Pure primitives for the Nordic/Adafruit classic serial DFU protocol spoken
// by the XIAO nRF52840's stock bootloader at 115200 baud. Wire format:
// an HCI-ish frame [4B header][payload][CRC16 LE] is SLIP-encoded and bounded
// with 0xC0 bytes; the bootloader answers each frame with a SLIP-framed ACK
// whose header carries the acknowledged sequence number (0-7).
//
// Adapted from Nordic's nrfutil (BSD-3-Clause, Copyright (c) 2015 Nordic
// Semiconductor) as ported to JavaScript by Keyboardio (nrfutil-js, 2025).
// https://github.com/keyboardio/nrfutil-js

export const DFU_BAUD_RATE = 115200;
export const DFU_PACKET_MAX_SIZE = 512;
export const DFU_ACK_TIMEOUT_MS = 5000;
export const DFU_MAX_TX_ATTEMPTS = 3;
export const FLASH_PAGE_SIZE = 4096;
export const FLASH_PAGE_ERASE_TIME_MS = 89.7;
export const FLASH_PAGE_WRITE_TIME_MS = 102.4;

// Frame op codes placed at the head of each payload. Only these exist in the
// bootloader's serial-DFU state machine (dfu_transport_serial.c /
// dfu_single_bank.c); the STOP packet itself triggers validate + activate +
// reboot, so there is no separate activate op. Op 2 (STOP_INIT_PACKET) is
// accepted-and-ignored by the queue and serves as a transport liveness probe.
export const DFU_OP = Object.freeze({
  INIT: 1,
  PROBE: 2,
  START: 3,
  DATA: 4,
  STOP: 5,
});

// START frame image types (HexType in the reference).
export const DFU_IMAGE = Object.freeze({
  SOFTDEVICE: 1,
  BOOTLOADER: 2,
  SD_BL: 3,
  APPLICATION: 4,
});

const SLIP_END = 0xc0;
const SLIP_ESC = 0xdb;
const SLIP_ESC_END = 0xdc;
const SLIP_ESC_ESC = 0xdd;

const HCI_PACKET_TYPE = 14;
const DATA_INTEGRITY = 1;
const RELIABLE = 1;

/** @param {Uint8Array} bytes */
export function slipEncode(bytes) {
  let n = bytes.length;
  for (const b of bytes) if (b === SLIP_END || b === SLIP_ESC) n++;
  const out = new Uint8Array(n);
  let i = 0;
  for (const b of bytes) {
    if (b === SLIP_END) {
      out[i++] = SLIP_ESC;
      out[i++] = SLIP_ESC_END;
    } else if (b === SLIP_ESC) {
      out[i++] = SLIP_ESC;
      out[i++] = SLIP_ESC_ESC;
    } else {
      out[i++] = b;
    }
  }
  return out;
}

/** @param {Uint8Array} bytes */
export function slipDecode(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === SLIP_ESC) {
      const next = bytes[++i];
      if (next === SLIP_ESC_END) out.push(SLIP_END);
      else if (next === SLIP_ESC_ESC) out.push(SLIP_ESC);
      else throw new Error('SLIP decode: invalid escape sequence');
    } else {
      out.push(b);
    }
  }
  return new Uint8Array(out);
}

/**
 * Nordic CRC16 (CRC-16/XMODEM-family variant used by the DFU bootloader).
 * @param {Uint8Array} bytes
 * @param {number} [crc]
 */
export function crc16(bytes, crc = 0xffff) {
  for (const b of bytes) {
    crc = ((crc >> 8) & 0x00ff) | ((crc << 8) & 0xff00);
    crc ^= b;
    crc ^= (crc & 0x00ff) >> 4;
    crc ^= (crc << 8) << 4;
    crc ^= ((crc & 0x00ff) << 4) << 1;
  }
  return crc & 0xffff;
}

function u16le(v) {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
}

function u32le(v) {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}

function merge(...arrays) {
  const n = arrays.reduce((a, x) => a + x.length, 0);
  const out = new Uint8Array(n);
  let i = 0;
  for (const a of arrays) {
    out.set(a, i);
    i += a.length;
  }
  return out;
}

/**
 * Builds the 4-byte HCI header. Note the reference layout quirk: the packet
 * type sits in the LOW nibble of byte 1 and the low length nibble in the HIGH.
 * Byte 0 carries the frame's own sequence (bits 0-2), the ack number the peer
 * expects next ((seq+1)%8, bits 3-5 — nrfutil does the same), and the
 * integrity/reliable bits. The device only validates the sequence bits, but
 * the ack field is set for fidelity with the reference tools.
 * @param {number} seq 1..7 then wrapping to 0 (the transport expects 1 first)
 * @param {number} payloadLength
 */
export function hciHeader(seq, payloadLength) {
  const b0 = (RELIABLE << 7) | (DATA_INTEGRITY << 6) | (((seq + 1) % 8) << 3) | (seq & 0x07);
  const b1 = (HCI_PACKET_TYPE & 0x0f) | ((payloadLength & 0x0f) << 4);
  const b2 = (payloadLength >> 4) & 0xff;
  const b3 = (~(b0 + b1 + b2) + 1) & 0xff;
  return new Uint8Array([b0, b1, b2, b3]);
}

/**
 * Full wire frame for `payload`: header + payload + CRC16(LE), SLIP-encoded
 * and bounded with SLIP_END markers.
 * @param {Uint8Array} payload
 * @param {number} seq
 */
export function hciFrame(payload, seq) {
  const head = merge(hciHeader(seq, payload.length), payload);
  const withCrc = merge(head, u16le(crc16(head)));
  const encoded = slipEncode(withCrc);
  return merge(new Uint8Array([SLIP_END]), encoded, new Uint8Array([SLIP_END]));
}

/**
 * Extracts the acknowledged sequence number (0..7) from a SLIP-framed ACK.
 * The device ACKs with the next sequence number it EXPECTS (received seq + 1
 * after incrementing its counter), not the received number itself.
 * @param {Uint8Array} bytes raw bytes received from the bootloader
 */
export function ackFromResponse(bytes) {
  let start = -1;
  let end = -1;
  for (let i = 0; i < bytes.length; i++)
    if (bytes[i] === SLIP_END) {
      start = i;
      break;
    }
  for (let i = bytes.length - 1; i >= 0; i--)
    if (bytes[i] === SLIP_END) {
      end = i;
      break;
    }
  if (start < 0 || end <= start) throw new Error('DFU ACK: no SLIP frame received');
  const decoded = slipDecode(bytes.slice(start + 1, end));
  if (decoded.length < 1) throw new Error('DFU ACK: empty response frame');
  return (decoded[0] >> 3) & 0x07;
}

function opFrame(op, seq, ...payloadParts) {
  return hciFrame(merge(u32le(op), ...payloadParts), seq);
}

/**
 * Transport-liveness probe: an op the bootloader's DFU queue ignores, but the
 * HCI transport answers with an ACK — proving a bootloader is on the port
 * (the running application has no HCI transport and stays silent).
 * @param {number} seq
 */
export function probeFrame(seq) {
  return opFrame(DFU_OP.PROBE, seq);
}

/** @param {Uint8Array} datBytes the .dat init packet from the DFU package */
export function initFrame(datBytes, seq) {
  return opFrame(DFU_OP.INIT, seq, datBytes, new Uint8Array([0x00, 0x00]));
}

/**
 * @param {number} imageType one of DFU_IMAGE
 * @param {{ softdevice?: number, bootloader?: number, application?: number }} sizes byte sizes
 * @param {number} seq
 */
export function startFrame(imageType, sizes, seq) {
  return opFrame(
    DFU_OP.START,
    seq,
    u32le(imageType),
    u32le(sizes.softdevice ?? 0),
    u32le(sizes.bootloader ?? 0),
    u32le(sizes.application ?? 0),
  );
}

/** @param {Uint8Array} chunk up to DFU_PACKET_MAX_SIZE bytes of firmware */
export function dataFrame(chunk, seq) {
  return opFrame(DFU_OP.DATA, seq, chunk);
}

/**
 * The STOP packet ends the transfer — on receiving it the bootloader
 * validates the image, activates it, saves settings, and reboots into the
 * new firmware. No further op exists (and the port disappears shortly after).
 * @param {number} seq
 */
export function stopFrame(seq) {
  return opFrame(DFU_OP.STOP, seq);
}

/** Bootloader flash-erase wait for the given total image size, in ms. */
export function eraseWaitMs(totalSize) {
  return Math.max(500, (Math.ceil(totalSize / FLASH_PAGE_SIZE) + 1) * FLASH_PAGE_ERASE_TIME_MS);
}

/** Page-write dwell used every 8 data frames while the CPU is blocked. */
export function pageWriteDwellMs() {
  return FLASH_PAGE_WRITE_TIME_MS;
}
