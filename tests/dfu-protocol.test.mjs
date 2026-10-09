// Wire-format tests for the serial-DFU protocol primitives (serial/dfu/
// dfu-protocol.js): SLIP escaping, HCI header checksum, CRC16 vectors pinned
// against Nordic's reference nrfutil implementation, full frame structure,
// and ACK extraction.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DFU_IMAGE,
  DFU_OP,
  ackFromResponse,
  crc16,
  dataFrame,
  eraseWaitMs,
  hciFrame,
  hciHeader,
  initFrame,
  probeFrame,
  slipDecode,
  slipEncode,
  startFrame,
  stopFrame,
} from '../app/js/serial/dfu/dfu-protocol.js';

test('CRC16 matches the reference nrfutil implementation', () => {
  // Vectors generated with Nordic's nrfutil JS (BSD-3) over fixed inputs.
  assert.equal(crc16(new Uint8Array([49, 50, 51, 52, 53, 54, 55, 56, 57])), 0x29b1);
  assert.equal(crc16(new Uint8Array([0x00])), 0xe1f0);
  assert.equal(crc16(new Uint8Array([0xff, 0xff])), 0x0000);
  assert.equal(crc16(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])), 0x2c72);
});

test('SLIP escapes 0xC0 and 0xDB and roundtrips', () => {
  const tricky = new Uint8Array([0xc0, 0x01, 0xdb, 0xdc, 0xdd, 0x00]);
  const encoded = slipEncode(tricky);
  assert.equal(encoded.includes(0xc0), false, 'no raw END inside the encoded body');
  assert.deepEqual([...slipDecode(encoded)], [...tricky]);
});

test('HCI header carries the length in the reference nibble layout', () => {
  const h = hciHeader(3, 0x123);
  assert.equal(h[0] & 0x07, 3);
  assert.equal((h[0] >> 3) & 0x07, 4, 'ack field carries (seq+1)%8 like the reference tools');
  assert.equal((h[0] >> 6) & 1, 1);
  assert.equal((h[0] >> 7) & 1, 1);
  assert.equal(h[1] & 0x0f, 14, 'packet type in the LOW nibble');
  assert.equal((h[1] >> 4) & 0x0f, 0x123 & 0x0f);
  assert.equal(h[2], 0x123 >> 4);
  assert.equal((~(h[0] + h[1] + h[2]) + 1) & 0xff, h[3]);
  // Sequence numbers wrap: seq 7 announces ack (7+1)%8 = 0.
  assert.equal((hciHeader(7, 4)[0] >> 3) & 0x07, 0);
});

test('a full frame is SLIP-bounded and its header survives a decode', () => {
  const payload = new Uint8Array([1, 2, 3, 0xc0, 0xdb, 4]);
  const frame = hciFrame(payload, 5);
  assert.equal(frame[0], 0xc0);
  assert.equal(frame[frame.length - 1], 0xc0);
  const decoded = slipDecode(frame.slice(1, -1));
  const body = decoded.slice(0, -2);
  const crc = decoded[decoded.length - 2] | (decoded[decoded.length - 1] << 8);
  assert.equal(crc16(body), crc);
  assert.equal(body[0] & 0x07, 5);
  assert.deepEqual([...body.slice(4)], [...payload]);
});

test('ackFromResponse extracts the acknowledged sequence number', () => {
  // Bootloader ACK: header byte 0 carries ack in bits 3-5, zero payload, CRC.
  const b0 = (1 << 7) | (1 << 6) | (4 << 3);
  const b1 = 14;
  const b3 = (~(b0 + b1 + 0) + 1) & 0xff;
  const head = new Uint8Array([b0, b1, 0, b3]);
  const crc = crc16(head);
  const inner = new Uint8Array([...head, crc & 0xff, (crc >> 8) & 0xff]);
  const ack = new Uint8Array([0xc0, ...slipEncode(inner), 0xc0]);
  assert.equal(ackFromResponse(ack), 4);
  // Leading noise must be tolerated (frames can straddle chunk boundaries).
  assert.equal(ackFromResponse(new Uint8Array([0x00, 0x01, ...ack])), 4);
});

test('command frames encode their op codes in little-endian u32', () => {
  const seq = 0;
  const opOf = (frame) => {
    const decoded = slipDecode(frame.slice(1, -1));
    const payload = decoded.slice(4, -2);
    return payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24);
  };
  assert.equal(opOf(probeFrame(seq)), DFU_OP.PROBE);
  assert.equal(opOf(initFrame(new Uint8Array(14), seq)), DFU_OP.INIT);
  assert.equal(opOf(startFrame(DFU_IMAGE.APPLICATION, { application: 256 }, seq)), DFU_OP.START);
  assert.equal(opOf(dataFrame(new Uint8Array(512).fill(0xab), seq)), DFU_OP.DATA);
  assert.equal(opOf(stopFrame(seq)), DFU_OP.STOP);
});

test('init frame appends the two zero pad bytes the bootloader expects', () => {
  const dat = new Uint8Array([9, 8, 7]);
  const frame = initFrame(dat, 2);
  const decoded = slipDecode(frame.slice(1, -1));
  const payload = decoded.slice(4, -2);
  assert.deepEqual([...payload.slice(0, 4)], [1, 0, 0, 0]);
  assert.deepEqual([...payload.slice(4)], [...dat, 0, 0]);
});

test('start frame carries image type and the three sizes', () => {
  const frame = startFrame(DFU_IMAGE.APPLICATION, { application: 0x01020304 }, 1);
  const decoded = slipDecode(frame.slice(1, -1));
  const p = decoded.slice(4, -2);
  const u32 = (i) => p[i] | (p[i + 1] << 8) | (p[i + 2] << 16) | (p[i + 3] << 24);
  assert.equal(u32(0), DFU_OP.START);
  assert.equal(u32(4), DFU_IMAGE.APPLICATION);
  assert.equal(u32(8), 0);
  assert.equal(u32(12), 0);
  assert.equal(u32(16), 0x01020304);
});

test('erase wait scales with image size and never undercuts 500 ms', () => {
  assert.equal(eraseWaitMs(0), 500);
  assert.equal(eraseWaitMs(4096), Math.max(500, 2 * 89.7));
  assert.ok(eraseWaitMs(256 * 1024) > eraseWaitMs(4 * 1024));
});

test('bootloader sim: wrong-sequence frames are re-ACKed and never processed', async () => {
  // Pins the transport semantics that once hid a total-protocol mismatch:
  // a frame whose sequence number is not the one expected gets a reject-ACK
  // carrying the expected number — and must NOT reach the DFU layer.
  const { createBootloaderSim } = await import('./harness/bootloader-sim.mjs');
  const sim = createBootloaderSim();
  const writer = sim.port.writable.getWriter();
  const reader = sim.port.readable.getReader();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await writer.write(probeFrame(0)); // expected is 1 — wrong sequence
  await sleep(20);
  const rejected = await reader.read();
  assert.equal(ackFromResponse(rejected.value), 1, 're-ACK carries the expected number');
  assert.equal(sim.state.rejectedFrames, 1);
  assert.equal(sim.state.ops.length, 0, 'the op never reached the DFU layer');

  await writer.write(probeFrame(1)); // now the expected one
  await sleep(20);
  const accepted = await reader.read();
  assert.equal(ackFromResponse(accepted.value), 2, 'ACK carries the next expected number');
  assert.equal(sim.state.rejectedFrames, 1);
  assert.deepEqual(
    sim.state.ops.map((o) => o.name),
    ['PROBE'],
  );
});
