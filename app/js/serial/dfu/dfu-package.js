// Parses an adafruit-nrfutil DFU package zip (manifest.json + .bin + .dat)
// entirely in the browser with no dependencies: a minimal ZIP reader (stored
// + deflate entries via DecompressionStream) plus manifest validation. The
// .dat file is the pre-built init packet; the .bin is the application image.

const EOCD_SIGNATURE = 0x06054b50;
const CDH_SIGNATURE = 0x02014b50;
const LFH_SIGNATURE = 0x04034b50;

/**
 * @param {ArrayBuffer} zipData
 * @returns {Promise<Map<string, Uint8Array>>} file name → contents
 */
export async function unzip(zipData) {
  const bytes = new Uint8Array(zipData);
  const view = new DataView(zipData);
  const scanStart = Math.max(0, bytes.length - 0xffff - 22);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= scanStart; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive: end-of-central-directory not found.');
  const entryCount = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = new Map();
  for (let n = 0; n < entryCount; n++) {
    if (view.getUint32(p, true) !== CDH_SIGNATURE) throw new Error(`Corrupt ZIP: bad central directory entry ${n}.`);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.slice(p + 46, p + 46 + nameLen));
    if (view.getUint32(localOffset, true) !== LFH_SIGNATURE)
      throw new Error(`Corrupt ZIP: bad local header for ${name}.`);
    const lfNameLen = view.getUint16(localOffset + 26, true);
    const lfExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lfNameLen + lfExtraLen;
    const raw = bytes.slice(dataStart, dataStart + compressedSize);
    if (name.endsWith('/')) {
      // directory entry — nothing to extract
    } else if (method === 0) {
      files.set(name, raw);
    } else if (method === 8) {
      files.set(name, await inflateRaw(raw));
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// The parser works on in-memory buffers, so inflated output needs a hard
// ceiling: raw deflate reaches ~1000:1, and a crafted small zip entry could
// otherwise demand gigabytes of RAM (real firmware images are ~256 KB).
const MAX_INFLATED_BYTES = 8 * 1024 * 1024;

/** @param {Uint8Array} deflated */
async function inflateRaw(deflated) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser cannot decompress the firmware package (no DecompressionStream).');
  }
  const stream = new Blob([/** @type {BlobPart} */ (deflated)])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_INFLATED_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('Firmware package entry is unexpectedly large — refusing to decompress it.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Extracts and validates the application image pieces from a DFU package.
 * @param {ArrayBuffer} zipData
 * @returns {Promise<{manifest: any, bin: Uint8Array, dat: Uint8Array}>}
 */
export async function parseDfuPackage(zipData) {
  const files = await unzip(zipData);
  const manifestFile = files.get('manifest.json');
  if (!manifestFile) throw new Error('Firmware package is missing manifest.json.');
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestFile));
  } catch {
    throw new Error('Firmware package manifest.json is not valid JSON.');
  }
  const application = manifest?.manifest?.application;
  if (!application?.bin_file || !application?.dat_file) {
    throw new Error('Firmware package has no application image (this updater only flashes the app).');
  }
  const bin = files.get(application.bin_file);
  const dat = files.get(application.dat_file);
  if (!bin) throw new Error(`Firmware package is missing ${application.bin_file}.`);
  if (!dat) throw new Error(`Firmware package is missing ${application.dat_file}.`);
  if (bin.length !== application.bin_size && application.bin_size !== undefined)
    throw new Error(`Firmware image size mismatch: manifest says ${application.bin_size}, zip has ${bin.length}.`);
  return { manifest, bin, dat };
}
