// End-to-end wizard flow: settings snapshot from the loaded UI, firmware
// download + sha256 verification, the 1200-baud touch on the app port, the
// bootloader port handoff, the full serial-DFU exchange against the
// bootloader simulator, and the post-reconnect settings restore.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { makeEl, installGatingDom } from './harness/dom-stub.mjs';
import { createBootloaderSim } from './harness/bootloader-sim.mjs';

// ---- Build a small but real DFU package for the download step ----

function u16(v) {
  return [v & 0xff, (v >> 8) & 0xff];
}
function u32(v) {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

function buildDeflatedZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = [...Buffer.from(name, 'utf8')];
    const raw = zlib.deflateRawSync(Buffer.from(data));
    const dataBytes = [...raw];
    parts.push([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0), ...u32(0),
      ...u32(dataBytes.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0),
      ...nameBytes, ...dataBytes,
    ]);
    central.push([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0),
      ...u32(0), ...u32(dataBytes.length), ...u32(data.length), ...u16(nameBytes.length),
      ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...nameBytes,
    ]);
    offset += 30 + nameBytes.length + dataBytes.length;
  }
  const centralSize = central.reduce((a, p) => a + p.length, 0);
  const eocd = [
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length),
    ...u32(centralSize), ...u32(offset), ...u16(0),
  ];
  return new Uint8Array([parts, central, eocd].flat(2));
}

const FW_BIN = new Uint8Array(700).fill(0xab);
const FW_DAT = new Uint8Array(14).fill(0x11);
const FW_ZIP_BYTES = buildDeflatedZip([
  {
    name: 'manifest.json',
    data: Buffer.from(
      JSON.stringify({ manifest: { application: { bin_file: 'LipSync_Firmware.ino.bin', dat_file: 'LipSync_Firmware.ino.dat', bin_size: FW_BIN.length } } }),
    ),
  },
  { name: 'LipSync_Firmware.ino.bin', data: Buffer.from(FW_BIN) },
  { name: 'LipSync_Firmware.ino.dat', data: Buffer.from(FW_DAT) },
]);

async function sha256Hex(buffer) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---- DOM stub with wizard controls pre-created ----

const els = new Map();
const init = (id, cls) => {
  const el = makeEl(cls && cls.includes('button') ? 'button' : 'div');
  el.id = id;
  if (cls) el.classList.add(...cls.split(' ').filter(Boolean));
  els.set(id, el);
  return el;
};
for (const id of ['confirmDialog', 'confirmTitle', 'confirmBody', 'confirmOk', 'confirmCancel']) init(id);
init('btnConnect').disabled = false;
init('btnDisconnect', 'cmd').disabled = true;
for (const id of ['btnStartUpdate', 'btnCheckUpdate']) init(id, 'cmd');
// Wizard-stage buttons are deliberately NOT class="cmd": they must stay
// clickable while the session is disconnected (device is in the bootloader).
for (const id of ['btnFwContinue', 'btnFwCancel', 'btnDownloadBackup']) init(id);

const { document: doc, windowListeners } = installGatingDom(els);
const app = await import('../app/js/main.js');
(windowListeners['DOMContentLoaded'] || []).forEach((fn) => fn());
const { testHooks } = await import('./harness/test-hooks.mjs');
const fw = await import('../app/js/services/firmware-update.js');
const { configureDfuPortSource } = await import('../app/js/serial/dfu/dfu-serial.js');

// Node lacks requestAnimationFrame (the settings-backup download uses it) and
// its native URL.createObjectURL works only for real browser Blobs.
globalThis.requestAnimationFrame = () => 0;
globalThis.URL.createObjectURL = () => 'blob:test';
globalThis.URL.revokeObjectURL = () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (id) => doc.getElementById(id).dispatch('click');
const byId = (id) => doc.getElementById(id);

// ---- Fake app-mode device session (the settings protocol side) ----

function launchSettingsDevice(values) {
  const sent = [];
  const writer = {
    write(bytes) {
      const text = Buffer.from(bytes).toString('utf8');
      sent.push(text);
      if (text === 'SETTINGS') {
        setTimeout(() => app.handleLine('SUCCESS,0:SETTINGS'), 2);
      } else if (values[text]) {
        setTimeout(() => app.handleLine(`SUCCESS,0:${values[text]}`), 2);
      }
    },
  };
  testHooks.attach({ simulated: true }, writer);
  return { sent, detach: testHooks.detach };
}

// Populate the loaded-settings DOM the wizard snapshots.
function setLoadedValues(v = {}) {
  const defaults = {
    version: '4.1.0',
    speedVal: '5',
    scrollVal: '5',
    sipVal: '3.00',
    puffVal: '3.00',
    innerDeadzoneVal: '0.07',
    outerDeadzoneVal: '0.95',
    soundModeVal: 'Basic',
    lightModeVal: 'Basic',
    brightnessVal: '5',
    opmode: 'Mouse',
    commode: 'USB',
    neutralVal: '0.00',
    corner1: '13.00',
    corner2: '13.00',
    corner3: '13.00',
    corner4: '13.00',
  };
  for (const [id, value] of Object.entries({ ...defaults, ...v })) byId(id).textContent = value;
}

async function flush() {
  await sleep(30);
}

test('wizard: download → touch → bootloader flash → reconnect restore', async () => {
  const sha = await sha256Hex(FW_ZIP_BYTES.buffer.slice(FW_ZIP_BYTES.byteOffset, FW_ZIP_BYTES.byteOffset + FW_ZIP_BYTES.length));
  const manifest = {
    firmwareVersion: '4.2.0',
    files: {
      dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: FW_ZIP_BYTES.length, sha256: sha },
    },
  };
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => FW_ZIP_BYTES.buffer.slice(FW_ZIP_BYTES.byteOffset, FW_ZIP_BYTES.byteOffset + FW_ZIP_BYTES.length),
  });
  try {
    localStorage.setItem('lipsync-fw-check', JSON.stringify({
      manifest,
      tagName: 'V4.2.0',
      releaseUrl: 'https://github.com/x',
      checkedAt: Date.now(),
      assetUrls: { dfu: 'https://github.com/x/download' },
    }));
  } catch {}
  sessionStoreSet('lipsync-fw-pending', null);

  // The app session port: records the 1200-baud touch + wake pulse, and
  // simulates the device disappearing after a successful touch (the second
  // open attempt fails like a detached Web Serial port).
  const touchEvents = [];
  let openCount = 0;
  const appPort = {
    async open(opts) {
      openCount++;
      if (openCount > 2) {
        const e = new Error('device no longer available');
        e.name = 'NotFoundError';
        throw e;
      }
      touchEvents.push('open:' + (opts?.baudRate ?? '?'));
    },
    async close() {
      touchEvents.push('close');
    },
    async setSignals() {
      touchEvents.push('signals');
    },
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
  };

  const settings = launchSettingsDevice({
    'SS,0:0': 'SS,0:5',
    'SL,0:0': 'SL,0:5',
  });
  // Wire the session port directly (bypasses connect()'s requestPort).
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();

  // Bootloader sim as the DFU port source.
  const sim = createBootloaderSim();
  configureDfuPortSource({ serial: { getPorts: async () => [sim.port], requestPort: async () => sim.port } });

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await wizardDone; // runs through wake pulse + touch + verify, stops at the port picker
  // Leading 'close' = the settings session's own disconnect; then the wake
  // pulse, the 1200-baud touch, and the verify probe failing (device gone).
  assert.deepEqual(
    touchEvents,
    ['close', 'open:115200', 'close', 'open:1200', 'signals', 'close'],
    'wake pulse + 1200-baud touch ran on the app port, and the verify probe found the device gone',
  );
  assert.equal(byId('btnFwContinue').hidden, false, 'waiting for the user to pick the bootloader port');
  click('btnFwContinue');
  // Flash of 700 bytes = 2 data frames + fixed frames + the 500 ms erase wait.
  await sleep(900);

  assert.equal(sim.state.activated, true, 'STOP completed the update in the simulated bootloader');
  assert.deepEqual(
    sim.state.ops.map((o) => o.name).filter((n) => n !== 'DATA'),
    ['PROBE', 'START', 'INIT', 'STOP'],
  );
  assert.equal(sim.state.rejectedFrames, 0, 'every frame was accepted by the transport');
  assert.deepEqual([...sim.state.dataBytes], [...FW_BIN], 'bootloader received the exact image bytes');
  assert.equal(sim.state.startSizes.application, FW_BIN.length);
  assert.equal(sim.state.openedBaud, 115200);

  assert.equal(byId('fwWizardStep').textContent.includes('installed'), true);
  assert.equal(serialSession.port, null, 'app session detached after flashing');

  // ---- Polish: wizard focus states while an update is in flight ----
  assert.equal(byId('fwActionsRow').hidden, true, 'the normal actions hide while the wizard runs');
  assert.equal(byId('sec-firmware').getAttribute('data-wizard'), 'active');
  assert.equal(
    byId('fwStepBackup').classList.contains('done') && byId('fwStepRestart').classList.contains('done'),
    true,
    'completed tracker steps are marked done',
  );
  assert.equal(byId('fwStepRestore').classList.contains('active'), true, 'restore is the active tracker step');
  assert.equal(byId('fwPct').textContent, '100%', 'the numeric percent renders outside the live region');
  assert.equal(byId('fwWizardStep').textContent.includes('%'), false, 'the live step text carries no percentage');

  // ---- Simulate the user reconnecting the now-updated device ----
  const sentAfter = [];
  const writer2 = {
    write(bytes) {
      const text = Buffer.from(bytes).toString('utf8');
      sentAfter.push(text);
      if (text === 'SETTINGS') {
        setTimeout(() => app.handleLine('SUCCESS,0:SETTINGS'), 2);
        return;
      }
      const m = text.match(/^([A-Z]{2}),1:(.+)$/);
      // The firmware echoes writes with the write code intact (SS,1:5 →
      // SUCCESS,0:SS,1:5) — commandMatchDetails() matches on that shape.
      if (m) setTimeout(() => app.handleLine(`SUCCESS,0:${m[1]},1:${m[2]}`), 2);
    },
  };
  testHooks.attach({ simulated: true }, writer2);
  serialSession.port = { simulated: true };
  setLoadedValues({ version: '4.2.0' }); // device now reports the new firmware
  // The live neutral reading jitters between reads; only the stored corners
  // count as calibration — a shifted neutral must NOT trigger the
  // recalibration notice.
  byId('neutralVal').textContent = '0.99';

  await fw.afterDeviceLoad();
  await sleep(120);

  const writes = sentAfter.filter((t) => /,1:/.test(t));
  assert.deepEqual(writes, [
    'SS,1:5',
    'SL,1:5',
    'ST,1:3.00',
    'PT,1:3.00',
    'IZ,1:0.07',
    'OZ,1:0.95',
    'SM,1:1',
    'LM,1:1',
    'LL,1:5',
  ]);
  assert.equal(byId('fwWizardStep').textContent, 'Firmware update complete.');

  // ---- Polish: the completed state ----
  assert.equal(byId('fwWizard').getAttribute('data-state'), 'done');
  assert.equal(byId('fwStepRestore').classList.contains('done'), true, 'every tracker step is done');
  assert.equal(byId('fwCurrentVersion').textContent, '4.2.0', 'check rows sync to the new version');
  assert.equal(byId('fwUpdateStatus').getAttribute('data-state'), 'ok');
  assert.equal(byId('fwUpdateStatus').textContent, 'Firmware update complete.');
  await app.disconnect({ quiet: true });
  assert.equal(byId('fwWizard').hidden, true, 'a finished wizard closes on disconnect');
  assert.equal(byId('fwActionsRow').hidden, false, 'the normal actions return');

  settings.detach();
  testHooks.detach();
});

test('wizard: cancel at the confirm dialog changes nothing', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  const manifest = {
    firmwareVersion: '4.2.0',
    files: { dfu: { fileName: 'x_dfu.zip', size: 10, sha256: null } },
  };
  try {
    localStorage.setItem(
      'lipsync-fw-check',
      JSON.stringify({ manifest, tagName: 'V4.2.0', releaseUrl: null, checkedAt: Date.now(), assetUrls: { dfu: 'https://github.com/x' } }),
    );
  } catch {}
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => FW_ZIP_BYTES.buffer.slice(FW_ZIP_BYTES.byteOffset, FW_ZIP_BYTES.byteOffset + FW_ZIP_BYTES.length),
  });
  const sim = createBootloaderSim();
  configureDfuPortSource({ serial: { getPorts: async () => [sim.port], requestPort: async () => sim.port } });
  const appPort = {
    async open() {},
    async close() {},
    async setSignals() {},
    readable: { getReader: () => ({ read: async () => ({ done: true }) }) },
    writable: { getWriter: () => ({ write: async () => {} }) },
  };
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmCancel');
  await wizardDone;
  assert.equal(sim.state.opened, false, 'bootloader port never touched');
  assert.equal(byId('fwWizard').hidden, true, 'wizard closed');
  await app.disconnect({ quiet: true });
});

function sessionStoreSet(key, value) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
