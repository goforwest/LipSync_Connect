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

async function sha256HexCompat(buffer) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const FW_ZIP_SHA256 = await sha256HexCompat(
  FW_ZIP_BYTES.buffer.slice(FW_ZIP_BYTES.byteOffset, FW_ZIP_BYTES.byteOffset + FW_ZIP_BYTES.length),
);

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
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? { ok: true, status: 200, json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }) }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  try {
    localStorage.setItem('lipsync-fw-check', JSON.stringify({
      manifest,
      tagName: 'V4.2.0',
      releaseUrl: 'https://github.com/x',
      checkedAt: Date.now(),
      repo: { owner: 'goforwest', name: 'LipSync' },
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

  // ---- Hardening: connection state vs. wizard stage ----
  // The wizard intentionally disconnected, but the Firmware card must stay
  // bright, its nav entry must stay openable, and the header must explain
  // the stage instead of showing a bare "Not connected".
  assert.equal(
    byId('sec-firmware').classList.contains('card-off'),
    false,
    'the firmware card is exempt from disconnect gating while the wizard runs',
  );
  const fwNav = document.querySelector('.circle-trigger[data-section="sec-firmware"]');
  assert.equal(fwNav.getAttribute('aria-disabled'), null, 'the firmware nav trigger stays open');
  assert.equal(document.getElementById('status').textContent, 'Firmware update — choose the update port');

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
  assert.equal(document.getElementById('status').textContent, 'Firmware update — reconnect the LipSync');
  assert.equal(byId('btnConnect').disabled, false, 'Connect re-enables for the post-flash reconnect');
  assert.equal(byId('btnDisconnect').disabled, true, 'Disconnect stays disabled while no session exists');

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
    files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
  };
  try {
    localStorage.setItem(
      'lipsync-fw-check',
      JSON.stringify({ manifest, tagName: 'V4.2.0', releaseUrl: null, checkedAt: Date.now(), repo: { owner: 'goforwest', name: 'LipSync' } }),
    );
  } catch {}
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? { ok: true, status: 200, json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }) }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const sim = createBootloaderSim();
  configureDfuPortSource({ serial: { getPorts: async () => [sim.port], requestPort: async () => sim.port } });
  const appPort = makeTouchedAppPort();
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

// Realistic app-mode port: the touch works on the first attempt (the third
// open — the verify probe — fails like a real device that has rebooted).
const makeTouchedAppPort = () => {
  let opens = 0;
  return {
    async open(opts) {
      opens++;
      if (opens > 2) {
        const e = new Error('device no longer available');
        e.name = 'NotFoundError';
        throw e;
      }
    },
    async close() {},
    async setSignals() {},
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8045 }),
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
  };
};

// ---- Hardening: cancel while the flash is in flight --------------------

test('wizard: cancelling mid-flash closes cleanly with honest recovery guidance', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  try {
    localStorage.setItem(
      'lipsync-fw-check',
      JSON.stringify({
        manifest: { firmwareVersion: '4.2.0', files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } } },
        tagName: 'V4.2.0',
        releaseUrl: null,
        checkedAt: Date.now(),
        repo: { owner: 'goforwest', name: 'LipSync' },
      }),
    );
  } catch {}
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? { ok: true, status: 200, json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }) }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  // A slow bootloader so the flash is still running when Cancel lands.
  const sim = createBootloaderSim({ ackDelayMs: 150 });
  configureDfuPortSource({ serial: { getPorts: async () => [sim.port], requestPort: async () => sim.port } });
  const appPort = makeTouchedAppPort();
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await wizardDone;
  click('btnFwContinue');
  await sleep(150); // inside the erase wait / early frames
  assert.equal(byId('btnFwCancel').textContent, 'Stop update', 'the button says what it does mid-flash');
  click('btnFwCancel');
  await sleep(400);

  assert.equal(byId('fwWizard').hidden, true, 'the wizard closes and stays closed');
  const history = (await import('../app/js/services/log.js')).getLogHistory().join('\n');
  assert.match(history, /Update stopped partway/, 'the honest mid-flash cancel message is logged');
  assert.doesNotMatch(history, /Firmware update failed:/, 'a cancel is not reopened as a failure');
  assert.match(history, /recovery loader/, 'the recovery guidance is present');
  assert.equal(document.getElementById('status').textContent, 'Not connected');
  assert.equal(byId('btnConnect').disabled, false, 'Connect returns after the cancel');
  await app.disconnect({ quiet: true });
});

// ---- Hardening: connection lost mid-restore re-arms and retries --------

test('wizard: a disconnect during settings restore retries on the next connect', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  const manifest = { firmwareVersion: '4.2.0', files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } } };
  try {
    localStorage.setItem(
      'lipsync-fw-check',
      JSON.stringify({ manifest, tagName: 'V4.2.0', releaseUrl: null, checkedAt: Date.now(), repo: { owner: 'goforwest', name: 'LipSync' } }),
    );
  } catch {}
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? { ok: true, status: 200, json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }) }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const sim = createBootloaderSim();
  configureDfuPortSource({ serial: { getPorts: async () => [sim.port], requestPort: async () => sim.port } });
  const appPort = makeTouchedAppPort();
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await wizardDone;
  click('btnFwContinue');
  await sleep(900);

  // Reconnect: the device answers the first few restore writes, then the
  // link dies mid-restore (like a cable pull).
  let writesSeen = 0;
  const writerDying = {
    write(bytes) {
      const text = Buffer.from(bytes).toString('utf8');
      if (text === 'SETTINGS') {
        setTimeout(() => app.handleLine('SUCCESS,0:SETTINGS'), 2);
        return;
      }
      const m = text.match(/^([A-Z]{2}),1:(.+)$/);
      if (!m) return;
      if (writesSeen >= 4) {
        setTimeout(() => void app.disconnect({ quiet: true }), 0);
        return; // no reply — the link is gone
      }
      writesSeen++;
      setTimeout(() => app.handleLine(`SUCCESS,0:${m[1]},1:${m[2]}`), 2);
    },
  };
  testHooks.attach({ simulated: true }, writerDying);
  serialSession.port = { simulated: true };
  setLoadedValues({ version: '4.2.0' });
  await fw.afterDeviceLoad();
  await sleep(150);

  assert.match(byId('fwWizardStep').textContent, /Connection lost while restoring/);
  assert.equal(fw.readPending()?.installed, true, 'the update is re-armed so the next connect retries');

  // Second reconnect with a healthy link: the restore picks back up and ends.
  const sentFinal = [];
  const writer3 = {
    write(bytes) {
      const text = Buffer.from(bytes).toString('utf8');
      sentFinal.push(text);
      if (text === 'SETTINGS') {
        setTimeout(() => app.handleLine('SUCCESS,0:SETTINGS'), 2);
        return;
      }
      const m = text.match(/^([A-Z]{2}),1:(.+)$/);
      if (m) setTimeout(() => app.handleLine(`SUCCESS,0:${m[1]},1:${m[2]}`), 2);
    },
  };
  testHooks.attach({ simulated: true }, writer3);
  serialSession.port = { simulated: true };
  setLoadedValues({ version: '4.2.0' });
  await fw.afterDeviceLoad();
  await sleep(120);

  assert.equal(byId('fwWizardStep').textContent, 'Firmware update complete.');
  assert.deepEqual(
    sentFinal.filter((t) => /,1:/.test(t)),
    ['SS,1:5', 'SL,1:5', 'ST,1:3.00', 'PT,1:3.00', 'IZ,1:0.07', 'OZ,1:0.95', 'SM,1:1', 'LM,1:1', 'LL,1:5'],
    'the full restore runs on the retry',
  );
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

// ---- Hardening: page reload mid-flash (device finished on its own) -----

test('wizard: a reload during the flash still verifies and restores', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  fw.writePending({
    target: '4.2.0',
    installed: false, // the page died before continueWizard could mark it
    flashStarted: true, // the flash had begun — the bootloader finished it
    snapshot: { VN: '4.1.0', SS: '5', SL: '5' },
  });
  const sentReload = [];
  const writerReload = {
    write(bytes) {
      const text = Buffer.from(bytes).toString('utf8');
      sentReload.push(text);
      if (text === 'SETTINGS') {
        setTimeout(() => app.handleLine('SUCCESS,0:SETTINGS'), 2);
        return;
      }
      const m = text.match(/^([A-Z]{2}),1:(.+)$/);
      if (m) setTimeout(() => app.handleLine(`SUCCESS,0:${m[1]},1:${m[2]}`), 2);
    },
  };
  testHooks.attach({ simulated: true }, writerReload);
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = { simulated: true };
  setLoadedValues({ version: '4.2.0' }); // the bootloader finished the update
  await fw.afterDeviceLoad();
  await sleep(120);

  assert.equal(byId('fwWizardStep').textContent, 'Firmware update complete.');
  assert.deepEqual(
    sentReload.filter((t) => /,1:/.test(t)),
    ['SS,1:5', 'SL,1:5'],
    "the snapshot's writable settings are restored",
  );
  assert.equal(fw.readPending(), null, 'the pending update is cleared');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

// ---- Audit: cancel/disconnect during the firmware download ------------

test('wizard: cancelling during the download does not resurrect the update', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  try {
    localStorage.setItem(
      'lipsync-fw-check',
      JSON.stringify({
        manifest: { firmwareVersion: '4.2.0', files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } } },
        tagName: 'V4.2.0',
        releaseUrl: null,
        checkedAt: Date.now(),
        repo: { owner: 'goforwest', name: 'LipSync' },
      }),
    );
  } catch {}
  // A fetch we control: the download hangs until we release it.
  let release = null;
  globalThis.fetch = (url) => {
    if (!String(url).includes('/git/trees/')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
      });
    }
    return new Promise((resolve) => {
      release = () =>
        resolve({
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        });
    });
  };
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = makeTouchedAppPort();
  setLoadedValues();

  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;
  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  assert.equal(byId('fwWizard').hidden, false, 'the download step is showing');
  click('btnFwCancel');
  await flush();
  assert.equal(byId('fwWizard').hidden, true, 'cancel closes the panel');

  release();
  await wizardDone;
  await flush();
  assert.equal(byId('fwWizard').hidden, true, 'the finished download must not resurrect the wizard');
  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.doesNotMatch(history, /Flashing firmware/, 'no flash was started');
  assert.doesNotMatch(history, /Update failed:/, 'no failure panel was raised either');
  assert.equal(fw.readPending(), null, 'the pending update stays cleared');
  await app.disconnect({ quiet: true });
});

test('wizard: a disconnect during the download surfaces a clean failure', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  try {
    localStorage.setItem(
      'lipsync-fw-check',
      JSON.stringify({
        manifest: { firmwareVersion: '4.2.0', files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } } },
        tagName: 'V4.2.0',
        releaseUrl: null,
        checkedAt: Date.now(),
        repo: { owner: 'goforwest', name: 'LipSync' },
      }),
    );
  } catch {}
  let release = null;
  globalThis.fetch = (url) => {
    if (!String(url).includes('/git/trees/')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
      });
    }
    return new Promise((resolve) => {
      release = () =>
        resolve({
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        });
    });
  };
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = makeTouchedAppPort();
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  await app.disconnect({ quiet: true }); // the link dies mid-download
  release();
  await wizardDone;
  await flush();

  assert.equal(byId('fwWizard').hidden, false, 'the failure panel opens');
  assert.match(byId('fwWizardStep').textContent, /connection was lost during the download/);
  assert.equal(byId('btnFwCancel').hidden, false, 'the user can dismiss the failure');
  click('btnFwCancel');
  await flush();
  assert.equal(byId('fwWizard').hidden, true);
});

// ---- Audit: cancel during the 1200-baud touch window ------------------

test('wizard: cancelling during the device restart stays quiet and closed', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  try {
    localStorage.setItem(
      'lipsync-fw-check',
      JSON.stringify({
        manifest: { firmwareVersion: '4.2.0', files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } } },
        tagName: 'V4.2.0',
        releaseUrl: null,
        checkedAt: Date.now(),
        repo: { owner: 'goforwest', name: 'LipSync' },
      }),
    );
  } catch {}
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? { ok: true, status: 200, json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }) }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = makeTouchedAppPort();
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await sleep(80); // inside the wake-pulse / pre-touch sleeps
  click('btnFwCancel');
  await wizardDone;
  await sleep(400);

  assert.equal(byId('fwWizard').hidden, true, 'the wizard stays closed after the cancel');
  const history = (await import('../app/js/services/log.js')).getLogHistory().join('\n');
  assert.doesNotMatch(history, /Update failed:/, 'a cancelled touch is not a failure');
  assert.doesNotMatch(history, /Cannot set properties/, 'no internal TypeError leaks to the user');
  await app.disconnect({ quiet: true });
});

// ---- Audit: operating-mode restore (the two-reboot path) ---------------

test('wizard: a changed operating mode gets restored with one extra reboot', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  try {
    localStorage.setItem(
      'lipsync-fw-check',
      JSON.stringify({
        manifest: { firmwareVersion: '4.2.0', files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } } },
        tagName: 'V4.2.0',
        releaseUrl: null,
        checkedAt: Date.now(),
        repo: { owner: 'goforwest', name: 'LipSync' },
      }),
    );
  } catch {}
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? { ok: true, status: 200, json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }) }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const sim = createBootloaderSim();
  configureDfuPortSource({ serial: { getPorts: async () => [sim.port], requestPort: async () => sim.port } });
  const appPort = makeTouchedAppPort();
  const { serialSession } = await import('../app/js/serial/session.js');
  // The user was on Gamepad when the update started.
  serialSession.port = appPort;
  setLoadedValues({ opmode: 'Gamepad' });

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await wizardDone;
  click('btnFwContinue');
  await sleep(900);
  assert.equal(sim.state.activated, true);

  // After the flash, the firmware reports default Mouse (as a major-version
  // reset would): the wizard must restore Gamepad and reboot once more.
  const sentMode = [];
  const writerMode = {
    write(bytes) {
      const text = Buffer.from(bytes).toString('utf8');
      sentMode.push(text);
      if (text === 'SETTINGS') {
        setTimeout(() => app.handleLine('SUCCESS,0:SETTINGS'), 2);
        return;
      }
      const m = text.match(/^([A-Z]{2}),1:(.+)$/);
      if (m) setTimeout(() => app.handleLine(`SUCCESS,0:${m[1]},1:${m[2]}`), 2);
    },
  };
  testHooks.attach({ simulated: true }, writerMode);
  serialSession.port = { simulated: true };
  setLoadedValues({ version: '4.2.0', opmode: 'Mouse', commode: 'USB' });
  await fw.afterDeviceLoad();
  await sleep(150);

  assert.deepEqual(
    sentMode.filter((t) => /,1:/.test(t)).slice(-2),
    ['OM,1:2', 'SR,1:1'],
    'the mode write is followed by the apply reboot',
  );
  assert.match(byId('fwWizardStep').textContent, /Click Connect one more time/);
  assert.equal(byId('fwWizard').hidden, false, 'the mode-restored wizard survives the reboot');

  // The final reconnect closes the wizard and reports completion.
  const sentFinal2 = [];
  const writerFinal2 = {
    write(bytes) {
      const text = Buffer.from(bytes).toString('utf8');
      sentFinal2.push(text);
      if (text === 'SETTINGS') setTimeout(() => app.handleLine('SUCCESS,0:SETTINGS'), 2);
    },
  };
  testHooks.attach({ simulated: true }, writerFinal2);
  serialSession.port = { simulated: true };
  setLoadedValues({ version: '4.2.0', opmode: 'Gamepad' });
  await fw.afterDeviceLoad();
  await sleep(120);

  assert.equal(byId('fwWizard').hidden, true, 'the wizard closes after the final reconnect');
  assert.equal(document.getElementById('fwUpdateStatus').textContent, 'Firmware update complete.');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

// ---- Hardening: cancel at the port picker leaves the device in update mode --

test('wizard: cancelling at the port picker says the device is in update mode', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  try {
    localStorage.setItem(
      'lipsync-fw-check',
      JSON.stringify({
        manifest: {
          firmwareVersion: '4.2.0',
          files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
        },
        tagName: 'V4.2.0',
        releaseUrl: null,
        repo: { owner: 'goforwest', name: 'LipSync' },
        checkedAt: Date.now(),
      }),
    );
  } catch {}
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? { ok: true, status: 200, json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }) }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const sim = createBootloaderSim();
  configureDfuPortSource({ serial: { getPorts: async () => [sim.port], requestPort: async () => sim.port } });
  const appPort = makeTouchedAppPort();
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await wizardDone; // the touch ran: the device is in its bootloader now
  assert.equal(byId('btnFwContinue').hidden, false, 'sitting at the port picker');

  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;
  click('btnFwCancel');
  await flush();

  assert.equal(byId('fwWizard').hidden, true, 'the wizard closes');
  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.match(history, /now in update mode/, 'the cancel message says the device is in update mode');
  assert.match(history, /unplug and replug/, 'recovery guidance is present');
  assert.doesNotMatch(history, /Nothing was changed/, 'the lying message is gone for this stage');
  await app.disconnect({ quiet: true });
});

// ---- Hardening: the bootloader port is recognized before any timeout grind --

test('isBootloaderPort recognizes update-loader ports and nothing else', async () => {
  const { isBootloaderPort } = await import('../app/js/serial/dfu/dfu-serial.js');
  assert.equal(isBootloaderPort({ getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x0045 }) }), true);
  assert.equal(isBootloaderPort({ getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x0044 }) }), true);
  // App-mode LipSync, other vendors, shapeless ports: all not the bootloader.
  assert.equal(isBootloaderPort({ getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8044 }) }), false);
  assert.equal(isBootloaderPort({ getInfo: () => ({ usbVendorId: 0x1209, usbProductId: 0x0044 }) }), false);
  assert.equal(isBootloaderPort({}), false);
  assert.equal(isBootloaderPort(null), false);
  // The WebUSB shim exposes the same identity.
  const { UsbSerialPort } = await import('../app/js/serial/transport.js');
  const shim = new UsbSerialPort({ vendorId: 0x2886, productId: 0x0045 });
  assert.equal(isBootloaderPort(shim), true);
});

// ---- Hardening: the automatic restart retries itself --------------------

test('wizard: a flaky touch is retried automatically instead of demanding reset', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  try {
    localStorage.setItem(
      'lipsync-fw-check',
      JSON.stringify({
        manifest: {
          firmwareVersion: '4.2.0',
          files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
        },
        tagName: 'V4.2.0',
        releaseUrl: null,
        repo: { owner: 'goforwest', name: 'LipSync' },
        checkedAt: Date.now(),
      }),
    );
  } catch {}
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? { ok: true, status: 200, json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }) }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const sim = createBootloaderSim();
  configureDfuPortSource({ serial: { getPorts: async () => [sim.port], requestPort: async () => sim.port } });
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;

  // First touch attempt: the device "doesn't leave" (verify open succeeds).
  // Second attempt: it does. No manual reset should ever be requested.
  let opens = 0;
  const appPort = {
    async open(opts) {
      opens++;
      void opts;
      if (opens > 5) {
        const e = new Error('device no longer available');
        e.name = 'NotFoundError';
        throw e;
      }
    },
    async close() {},
    async setSignals() {},
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8045 }),
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
  };
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await wizardDone;

  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.match(history, /attempt 1 did not take .* retrying/, 'the flaky first attempt is logged');
  assert.match(history, /retry \(attempt 2\)/, 'the second attempt lands');
  assert.doesNotMatch(history, /Automatic restart failed after/, 'no manual reset demanded');
  assert.equal(byId('btnFwContinue').hidden, false, 'the picker step is reachable');
  assert.doesNotMatch(byId('fwWizardStep').textContent, /did not restart/, 'the manual-reset text is not shown');
  click('btnFwCancel');
  await flush();
  await app.disconnect({ quiet: true });
});

// ---- Hardening: picking the still-running LipSync self-heals ------------

test('wizard: picking the running LipSync retries the restart instead of failing', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  try {
    localStorage.setItem(
      'lipsync-fw-check',
      JSON.stringify({
        manifest: {
          firmwareVersion: '4.2.0',
          files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
        },
        tagName: 'V4.2.0',
        releaseUrl: null,
        repo: { owner: 'goforwest', name: 'LipSync' },
        checkedAt: Date.now(),
      }),
    );
  } catch {}
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? { ok: true, status: 200, json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }) }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const sim = createBootloaderSim();
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;

  // The picker hands back the still-running LipSync (app USB identity) the
  // first time — the wizard must re-touch it and return to the picker.
  let pickerCalls = 0;
  configureDfuPortSource({
    serial: {
      getPorts: async () => [],
      requestPort: async () => {
        pickerCalls++;
        return pickerCalls === 1 ? makeTouchedAppPort() : sim.port;
      },
    },
  });
  const appPort = makeTouchedAppPort();
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await wizardDone;
  click('btnFwContinue'); // picks the app port by mistake

  // The self-heal runs the touch against that port and returns to the picker.
  await sleep(2500);
  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.match(history, /running LipSync, not its update loader/, 'the mispick is diagnosed');
  assert.match(history, /retry \(attempt 1\)|restarted into update mode/, 'the re-touch ran');
  assert.match(byId('fwWizardStep').textContent, /now in update mode|pick the update loader/, 'back at the picker, not a failure');
  assert.equal(byId('btnFwContinue').hidden, false, 'Continue is available again');
  assert.doesNotMatch(history, /Firmware update failed:/, 'no failure panel was raised');

  click('btnFwContinue'); // second pick: the real bootloader
  await sleep(900);
  assert.equal(sim.state.activated, true, 'the flash then completes on the loader');
  await app.disconnect({ quiet: true });
});

// ---- macOS Chrome semantics: NetworkError means the device departed ------

test('wizard: a departed device reporting NetworkError still counts as restarted', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  try {
    localStorage.setItem(
      'lipsync-fw-check',
      JSON.stringify({
        manifest: {
          firmwareVersion: '4.2.0',
          files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
        },
        tagName: 'V4.2.0',
        releaseUrl: null,
        repo: { owner: 'goforwest', name: 'LipSync' },
        checkedAt: Date.now(),
      }),
    );
  } catch {}
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? { ok: true, status: 200, json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }) }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const sim = createBootloaderSim();
  configureDfuPortSource({ serial: { getPorts: async () => [sim.port], requestPort: async () => sim.port } });
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;

  // macOS Chrome: after the device reboots, opening the stale app port
  // throws NetworkError "Failed to open serial port" — not NotFoundError.
  // The recheck (after settling) must still fail → the touch counted.
  const goneError = () => {
    const e = new Error("Failed to execute 'open' on 'SerialPort': Failed to open serial port.");
    e.name = 'NetworkError';
    return e;
  };
  let opens = 0;
  const appPort = {
    async open(opts) {
      opens++;
      void opts;
      if (opens > 2) throw goneError();
    },
    async close() {},
    async setSignals() {},
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8045 }),
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
  };
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await wizardDone;

  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.match(history, /Device restarted into update mode/, 'the touch is recognized despite NetworkError');
  assert.doesNotMatch(history, /did not take/, 'no bogus failure was logged');
  assert.doesNotMatch(
    byId('fwWizardStep').textContent,
    /did not restart|keeps failing/,
    'the reset instruction is not shown',
  );
  click('btnFwCancel');
  await flush();
  await app.disconnect({ quiet: true });
});

test('wizard: a wedged port is distinguished from a departed device and retried', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  try {
    localStorage.setItem(
      'lipsync-fw-check',
      JSON.stringify({
        manifest: {
          firmwareVersion: '4.2.0',
          files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
        },
        tagName: 'V4.2.0',
        releaseUrl: null,
        repo: { owner: 'goforwest', name: 'LipSync' },
        checkedAt: Date.now(),
      }),
    );
  } catch {}
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? { ok: true, status: 200, json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }) }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const sim = createBootloaderSim();
  configureDfuPortSource({ serial: { getPorts: async () => [sim.port], requestPort: async () => sim.port } });
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;

  // Attempt 1: the touch fires but the verify open hits a WEDGED port —
  // NetworkError that clears after settling (the recheck finds the device
  // alive, so the attempt is correctly retried). Attempt 2: clean touch.
  const goneError = () => {
    const e = new Error("Failed to execute 'open' on 'SerialPort': Failed to open serial port.");
    e.name = 'NetworkError';
    return e;
  };
  let opens = 0;
  const appPort = {
    async open(opts) {
      opens++;
      void opts;
      // opens 1-3: wake, touch, and the wedged verify on attempt 1.
      // open 4: the recheck — the wedged port recovered, device alive.
      // opens 5-6: attempt 2's wake and touch; open 7 (verify) sees the
      // device genuinely gone.
      if (opens === 3) throw goneError();
      if (opens > 6) {
        const e = new Error('device no longer available');
        e.name = 'NotFoundError';
        throw e;
      }
    },
    async close() {},
    async setSignals() {},
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8045 }),
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
  };
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await wizardDone;

  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.match(history, /attempt 1 did not take/, 'the wedged attempt is reported, not mistaken for success');
  assert.match(history, /retry \(attempt 2\)/, 'the retry lands once the port clears');
  assert.doesNotMatch(history, /Automatic restart failed after/, 'no manual reset demanded');
  assert.doesNotMatch(byId('fwWizardStep').textContent, /did not restart/);
  click('btnFwCancel');
  await flush();
  await app.disconnect({ quiet: true });
});

// ---- Recovery: a device stranded in update mode by an interrupted flash --

test('recovery: flashes the latest release through the bootloader and repairs the device', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  try {
    localStorage.setItem(
      'lipsync-fw-check',
      JSON.stringify({
        manifest: {
          firmwareVersion: '4.2.0',
          files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
        },
        tagName: 'V4.2.0',
        releaseUrl: null,
        repo: { owner: 'goforwest', name: 'LipSync' },
        checkedAt: Date.now(),
      }),
    );
  } catch {}
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? { ok: true, status: 200, json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }) }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const sim = createBootloaderSim();
  configureDfuPortSource({ serial: { getPorts: async () => [sim.port], requestPort: async () => sim.port } });
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;

  // The connect guard marked the device as stranded (as the real guard does).
  fw.setBootloaderStranded();
  assert.equal(byId('btnRecoverDevice').hidden, false, 'the Recover button is reachable');
  assert.equal(byId('sec-firmware').getAttribute('data-recover'), 'true');

  const wizardDone = fw.recoverFromBootloader();
  await flush();
  await wizardDone;
  assert.match(byId('fwWizardStep').textContent, /in update mode/, 'the picker step describes recovery');
  assert.equal(
    byId('fwStepFlash').classList.contains('active'),
    true,
    'the tracker sits on Flash — nothing to prepare or restart',
  );

  click('btnFwContinue');
  await sleep(900);
  assert.equal(sim.state.activated, true, 'the flash completed through the bootloader');

  // Reconnect: the repaired device boots normally and reports the new version.
  const sentRecovery = [];
  const writerRecovery = {
    write(bytes) {
      const text = Buffer.from(bytes).toString('utf8');
      sentRecovery.push(text);
      if (text === 'SETTINGS') {
        setTimeout(() => app.handleLine('SUCCESS,0:SETTINGS'), 2);
        return;
      }
      const m = text.match(/^([A-Z]{2}),1:(.+)$/);
      if (m) setTimeout(() => app.handleLine(`SUCCESS,0:${m[1]},1:${m[2]}`), 2);
    },
  };
  testHooks.attach({ simulated: true }, writerRecovery);
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = { simulated: true };
  setLoadedValues({ version: '4.2.0' });
  await fw.afterDeviceLoad();
  await sleep(120);

  assert.equal(byId('fwWizardStep').textContent, 'Firmware update complete.');
  assert.deepEqual(
    sentRecovery.filter((t) => /,1:/.test(t)),
    [],
    'recovery never touches the settings — they survived in the device storage',
  );
  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.match(history, /settings are intact after the recovery/);
  assert.equal(byId('sec-firmware').getAttribute('data-recover'), null, 'the stranded marker clears on success');
  assert.equal(byId('btnRecoverDevice').hidden, true, 'the Recover button hides again');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('recovery: cancelling says the device stays in update mode', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  try {
    localStorage.setItem(
      'lipsync-fw-check',
      JSON.stringify({
        manifest: {
          firmwareVersion: '4.2.0',
          files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
        },
        tagName: 'V4.2.0',
        releaseUrl: null,
        repo: { owner: 'goforwest', name: 'LipSync' },
        checkedAt: Date.now(),
      }),
    );
  } catch {}
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? { ok: true, status: 200, json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }) }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;

  const wizardDone = fw.recoverFromBootloader();
  await flush();
  await wizardDone;
  click('btnFwCancel');
  await flush();
  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.match(history, /Recovery cancelled/, 'the recovery cancel message is used');
  assert.match(history, /remains in update mode/, 'it says the device stays in update mode');
  assert.equal(byId('fwWizard').hidden, true);
});
