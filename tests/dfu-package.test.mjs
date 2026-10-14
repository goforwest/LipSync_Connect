// DFU package (zip) parsing tests: the zero-dependency unzip reader and
// manifest validation, exercised against the real locally built artifact
// from dev/firmware/build-firmware.sh when it exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseDfuPackage, unzip } from '../app/js/serial/dfu/dfu-package.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function u16(v) {
  return [v & 0xff, (v >> 8) & 0xff];
}
function u32(v) {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

/** Minimal stored-method ZIP builder (no compression, spec-correct enough). */
function buildStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = [...Buffer.from(name, 'utf8')];
    const dataBytes = [...data];
    localParts.push([
      ...u32(0x04034b50), // local file header signature
      ...u16(20), // version needed
      ...u16(0), // flags
      ...u16(0), // method: stored
      ...u16(0), ...u16(0), // time/date
      ...u32(0), // crc32 (not checked by the reader)
      ...u32(dataBytes.length),
      ...u32(dataBytes.length),
      ...u16(nameBytes.length),
      ...u16(0), // extra length
      ...nameBytes,
      ...dataBytes,
    ]);
    centralParts.push([
      ...u32(0x02014b50),
      ...u16(20), ...u16(20), // made-by / needed
      ...u16(0), // flags
      ...u16(0), // method
      ...u16(0), ...u16(0),
      ...u32(0),
      ...u32(dataBytes.length),
      ...u32(dataBytes.length),
      ...u16(nameBytes.length),
      ...u16(0), ...u16(0), // extra, comment
      ...u16(0), ...u16(0), // disk numbers
      ...u32(0), // attributes
      ...u32(offset),
      ...nameBytes,
    ]);
    offset += 30 + nameBytes.length + dataBytes.length;
  }
  const centralOffset = offset;
  const centralSize = centralParts.reduce((a, p) => a + p.length, 0);
  const eocd = [
    ...u32(0x06054b50),
    ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(centralSize),
    ...u32(centralOffset),
    ...u16(0),
  ];
  return new Uint8Array([localParts, centralParts, eocd].flat(2)).buffer;
}

function buildDeflatedZip(entries) {
  // Same shape but method 8, deflated via zlib raw — proves the
  // DecompressionStream path against real deflate streams.
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = [...Buffer.from(name, 'utf8')];
    const raw = zlib.deflateRawSync(Buffer.from(data));
    const dataBytes = [...raw];
    parts.push([
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(8),
      ...u16(0), ...u16(0),
      ...u32(0),
      ...u32(dataBytes.length),
      ...u32(data.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...nameBytes,
      ...dataBytes,
    ]);
    central.push([
      ...u32(0x02014b50),
      ...u16(20), ...u16(20),
      ...u16(0),
      ...u16(8),
      ...u16(0), ...u16(0),
      ...u32(0),
      ...u32(dataBytes.length),
      ...u32(data.length),
      ...u16(nameBytes.length),
      ...u16(0), ...u16(0),
      ...u16(0), ...u16(0),
      ...u32(0),
      ...u32(offset),
      ...nameBytes,
    ]);
    offset += 30 + nameBytes.length + dataBytes.length;
  }
  const centralOffset = offset;
  const centralSize = central.reduce((a, p) => a + p.length, 0);
  const eocd = [
    ...u32(0x06054b50),
    ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(centralSize),
    ...u32(centralOffset),
    ...u16(0),
  ];
  return new Uint8Array([parts, central, eocd].flat(2)).buffer;
}

test('unzip reads stored entries', async () => {
  const zip = buildStoredZip([
    { name: 'a.txt', data: Buffer.from('hello lipsync') },
    { name: 'dir/b.bin', data: Buffer.from([1, 2, 3]) },
  ]);
  const files = await unzip(zip);
  assert.equal(files.size, 2);
  assert.equal(new TextDecoder().decode(files.get('a.txt')), 'hello lipsync');
  assert.deepEqual([...files.get('dir/b.bin')], [1, 2, 3]);
});

test('unzip inflates deflate entries', async () => {
  const zip = buildDeflatedZip([{ name: 'manifest.json', data: Buffer.from('{"manifest":{}}') }]);
  const files = await unzip(zip);
  assert.equal(files.size, 1);
  assert.equal(new TextDecoder().decode(files.get('manifest.json')), '{"manifest":{}}');
});

test('unzip rejects non-zip data', async () => {
  await assert.rejects(() => unzip(new Uint8Array([1, 2, 3]).buffer), /Not a ZIP archive/);
});

test('parseDfuPackage extracts and validates the application image', async () => {
  const bin = new Uint8Array(100).fill(0x5a);
  const dat = new Uint8Array(14).fill(0x11);
  const zip = buildStoredZip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify({ manifest: { application: { bin_file: 'app.bin', dat_file: 'app.dat', bin_size: 100 } } })) },
    { name: 'app.bin', data: Buffer.from(bin) },
    { name: 'app.dat', data: Buffer.from(dat) },
  ]);
  const pkg = await parseDfuPackage(zip);
  assert.equal(pkg.bin.length, 100);
  assert.deepEqual([...pkg.bin.slice(0, 5)], [0x5a, 0x5a, 0x5a, 0x5a, 0x5a]);
  assert.equal(pkg.dat.length, 14);
});

test('parseDfuPackage reports missing pieces clearly', async () => {
  const noManifest = buildStoredZip([{ name: 'app.bin', data: Buffer.from([1]) }]);
  await assert.rejects(() => parseDfuPackage(noManifest), /missing manifest\.json/);
  const noBin = buildStoredZip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify({ manifest: { application: { bin_file: 'gone.bin', dat_file: 'x' } } })) },
  ]);
  await assert.rejects(() => parseDfuPackage(noBin), /missing gone\.bin/);
});

test('corrupt archives surface a friendly error, not an engine stack', async () => {
  // A plausible-looking but garbage central directory: EOCD present, but the
  // entry offset points far outside the buffer — previously this escaped as
  // a raw RangeError from the DataView.
  const bytes = new Uint8Array(200);
  const view = new DataView(bytes.buffer);
  view.setUint32(200 - 22, 0x06054b50, true); // EOCD signature at the tail
  view.setUint16(200 - 22 + 10, 1, true); // one entry
  view.setUint32(200 - 22 + 16, 0xfffff0, true); // bogus central-dir offset
  await assert.rejects(() => unzip(bytes.buffer), /could not be read|corrupted/i);
});

// The real-artifact fixture: derive the file name from the built manifest so
// the test follows the version instead of silently skipping whenever the
// locally built artifact moves past a hard-coded name.
const distDir = path.join(root, 'dev/firmware/dist');
const distManifestPath = path.join(distDir, 'manifest.json');
const distDfuName = fs.existsSync(distManifestPath)
  ? (JSON.parse(fs.readFileSync(distManifestPath, 'utf8')).files?.dfu?.fileName ?? null)
  : null;
const distDfuPath = distDfuName ? path.join(distDir, distDfuName) : null;

test('parses the real locally built artifact when present', { skip: !distDfuPath || !fs.existsSync(distDfuPath) }, async () => {
  const bytes = fs.readFileSync(distDfuPath);
  const pkg = await parseDfuPackage(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const app = pkg.manifest.manifest.application;
  assert.ok(app.bin_file.endsWith('.bin'));
  assert.ok(app.dat_file.endsWith('.dat'));
  assert.ok(pkg.bin.length > 250000, 'real firmware image is ~256 KB');
  assert.equal(pkg.dat.length, 14, 'adafruit init packet for this app is 14 bytes');
});

test('unzip refuses to inflate entries beyond the safety cap', async () => {
  // A 9 MB run of zeros deflates to a few KB — the classic decompression-bomb
  // shape. The parser must abort instead of buffering the expansion.
  const bomb = Buffer.alloc(9 * 1024 * 1024);
  const zip = buildDeflatedZip([{ name: 'manifest.json', data: bomb }]);
  await assert.rejects(() => unzip(zip), /unexpectedly large|refusing/i);
});
