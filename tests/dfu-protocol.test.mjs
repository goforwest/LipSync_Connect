// Wire-format tests for the serial-DFU protocol primitives (serial/dfu/
// dfu-protocol.js): SLIP escaping, HCI header checksum, CRC16 vectors pinned
// against Nordic's reference nrfutil implementation, full frame structure,
// and ACK extraction.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DFU_IMAGE,
  DFU_OP,
  DFU_PACKET_MAX_SIZE,
  FLASH_PAGE_SIZE,
  FLASH_PAGE_WRITE_TIME_MS,
  ackFromResponse,
  crc16,
  dataFrame,
  eraseWaitMs,
  hciFrame,
  hciHeader,
  initFrame,
  pageWriteDwellMs,
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

test('transport: a stale ACK forces an unchanged re-send, never a silent advance', async () => {
  // The ACK-number contract: the device answers an accepted frame with the
  // NEXT number it expects; any other number means "I did not accept this
  // frame as-is — send it again". A host that swallowed a wrong number and
  // advanced anyway could strand the transfer while believing it succeeded.
  // The sim's staleAckOnce models a delayed duplicate ACK crossing the wire.
  const { createBootloaderSim } = await import('./harness/bootloader-sim.mjs');
  const { flashSerialDfu } = await import('../app/js/serial/dfu/dfu-serial.js');
  const sim = createBootloaderSim({ staleAckOnce: true, ackDelayMs: 2 });
  const bin = new Uint8Array(700).fill(0x5a);
  const stages = [];
  await flashSerialDfu({
    port: sim.port,
    bin,
    dat: new Uint8Array(14).fill(0x11),
    ackTimeoutMs: 300,
    onProgress: (p) => stages.push(p.stage),
  });

  assert.equal(sim.state.activated, true, 'the transfer completes after the retry');
  assert.equal(
    sim.state.rejectedFrames,
    1,
    'the stale ACK forced exactly one re-send; the duplicate was transport-discarded',
  );
  assert.deepEqual(
    sim.state.ops.map((o) => o.name).filter((n) => n !== 'DATA'),
    ['PROBE', 'START', 'INIT', 'STOP'],
    'every op reached the DFU layer exactly once',
  );
  assert.deepEqual([...sim.state.dataBytes], [...bin], 'no image byte was lost or doubled');
  assert.ok(stages[stages.length - 1] === 'done');
});

test('transfer: every flash page (8×512B frames) pauses for the page-write dwell', async () => {
  // The only flash tests before this used ≤700 B images (2 chunks), so the
  // every-8-frames page-write dwell branch — the pacing that models the
  // nRF52 blocking to erase/write a 4 KB page — had never fired in any
  // test, while every real image is ~256 KB. Flash a 4-page image and prove
  // the dwell is actually observed at each page boundary.
  const { createBootloaderSim } = await import('./harness/bootloader-sim.mjs');
  const { flashSerialDfu } = await import('../app/js/serial/dfu/dfu-serial.js');

  // Production-value pins: these four together are what make "every 8
  // frames" exactly one 4096-byte flash page paced by the write time.
  assert.equal(DFU_PACKET_MAX_SIZE, 512, 'the DFU chunk size stays 512 B');
  assert.equal(FLASH_PAGE_SIZE, 4096, '8 chunks × 512 B = one nRF52 flash page');
  assert.equal(FLASH_PAGE_WRITE_TIME_MS, 102.4, 'the modeled page-write time stays 102.4 ms');
  assert.equal(pageWriteDwellMs(), FLASH_PAGE_WRITE_TIME_MS);

  const sim = createBootloaderSim();
  const bin = new Uint8Array(4 * FLASH_PAGE_SIZE); // 16 KB — 32 chunks, 4 pages
  for (let i = 0; i < bin.length; i++) bin[i] = i & 0xff; // position-unique pattern
  const marks = [];
  await flashSerialDfu({
    port: sim.port,
    bin,
    dat: new Uint8Array(14).fill(0x11),
    ackTimeoutMs: 300,
    onProgress: (p) => marks.push({ stage: p.stage, at: Date.now() }),
  });

  assert.equal(sim.state.activated, true, 'the 4-page image completed');
  assert.deepEqual([...sim.state.dataBytes], [...bin], 'no image byte was lost, doubled, or reordered');
  assert.equal(sim.state.rejectedFrames, 0);

  const transfer = marks.filter((m) => m.stage === 'transfer');
  assert.equal(transfer.length, 32, 'one progress mark per 512 B chunk');
  assert.equal(marks[marks.length - 1].stage, 'done');

  // The erase dwell between the START and INIT exchanges: a >= bound is
  // false-fail-proof (real timers never fire early) while still proving the
  // size-scaled wait was taken (a skipped dwell would land ~10 ms later).
  const eraseAt = marks.find((m) => m.stage === 'erase').at;
  const initAt = marks.find((m) => m.stage === 'init').at;
  assert.ok(
    initAt - eraseAt >= eraseWaitMs(bin.length),
    `erase dwell observed (${initAt - eraseAt} ms >= ${eraseWaitMs(bin.length)} ms)`,
  );

  // Page-write dwells: the gap after chunks 8/16/24 (indices 7/15/23 →
  // 8/16/24) must include the 102.4 ms dwell. Normal chunk gaps are
  // ~10-12 ms of ACK pacing; 90 ms sits far above that yet absorbs any
  // clock truncation on the dwell side, so a removed dwell branch fails
  // this clearly while a live one can never false-fail.
  for (const i of [7, 15, 23]) {
    const gap = transfer[i + 1].at - transfer[i].at;
    assert.ok(
      gap >= 90,
      `page-write dwell observed after chunk ${i + 1} (${gap} ms; a normal chunk gap is ~12 ms)`,
    );
  }
  // The final page's dwell lands between the last chunk and finalize.
  const finalizeAt = marks.find((m) => m.stage === 'finalize').at;
  const tailGap = finalizeAt - transfer[31].at;
  assert.ok(tailGap >= 90, `page-write dwell observed after the final chunk (${tailGap} ms)`);
});
