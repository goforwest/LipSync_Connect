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
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(8),
      ...u16(0),
      ...u16(0),
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
      ...u16(20),
      ...u16(20),
      ...u16(0),
      ...u16(8),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(dataBytes.length),
      ...u32(data.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(offset),
      ...nameBytes,
    ]);
    offset += 30 + nameBytes.length + dataBytes.length;
  }
  const centralSize = central.reduce((a, p) => a + p.length, 0);
  const eocd = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(centralSize),
    ...u32(offset),
    ...u16(0),
  ];
  return new Uint8Array([parts, central, eocd].flat(2));
}

const FW_BIN = new Uint8Array(700).fill(0xab);
const FW_DAT = new Uint8Array(14).fill(0x11);
const FW_ZIP_BYTES = buildDeflatedZip([
  {
    name: 'manifest.json',
    data: Buffer.from(
      JSON.stringify({
        manifest: {
          application: {
            bin_file: 'LipSync_Firmware.ino.bin',
            dat_file: 'LipSync_Firmware.ino.dat',
            bin_size: FW_BIN.length,
          },
        },
      }),
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
// The production post-close settle (2 s) exists for real macOS wedged opens;
// the scenarios here don't need it — shrink it so the suite stays fast. The
// settle itself is pinned by a dedicated test below.
fw.setTouchSettleAfterDisconnectForTests(30);
// The SR-first restart's timeouts shrink the same way (its happy path is
// acked in ~2 ms; its failure path would otherwise wait the full 15 s).
fw.setSrRebootSettleForTests(20);
fw.setSrResetTimeoutForTests(400);
const { configureDfuPortSource } = await import('../app/js/serial/dfu/dfu-serial.js');

// Node lacks requestAnimationFrame (the settings-backup download uses it) and
// its native URL.createObjectURL works only for real browser Blobs.
globalThis.requestAnimationFrame = () => 0;
globalThis.URL.createObjectURL = () => 'blob:test';
globalThis.URL.revokeObjectURL = () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (id) => doc.getElementById(id).dispatch('click');
const byId = (id) => doc.getElementById(id);

// Polls until `predicate` holds (deadline-bounded). The flash is a chain of
// timer-paced stages (erase wait, ACK delays); fixed sleeps assert against
// near-zero slack, so every completion assertion polls instead.
async function waitFor(predicate, { timeoutMs = 8000, everyMs = 40, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${what}`);
    await sleep(everyMs);
  }
}

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
  const sha = await sha256Hex(
    FW_ZIP_BYTES.buffer.slice(FW_ZIP_BYTES.byteOffset, FW_ZIP_BYTES.byteOffset + FW_ZIP_BYTES.length),
  );
  const manifest = {
    firmwareVersion: '4.2.0',
    files: {
      dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: FW_ZIP_BYTES.length, sha256: sha },
    },
  };
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  try {
    localStorage.setItem(
      'lipsync-fw-check',
      JSON.stringify({
        manifest,
        tagName: 'V4.2.0',
        releaseUrl: 'https://github.com/x',
        checkedAt: Date.now(),
        repo: { owner: 'goforwest', name: 'LipSync' },
      }),
    );
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
  // Simulate the connect-time auto-check having populated the check rows.
  byId('fwCurrentVersion').textContent = '4.1.0';
  byId('fwLatestVersion').textContent = '4.2.0';
  byId('fwUpdateStatus').textContent = 'Update available: 4.2.0 (installed: 4.1.0).';

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
  // The wizard's own disconnect must not wipe the check rows to '—'
  // (hardware-observed): they stay dimmed-but-present until the completion
  // check refreshes them.
  assert.equal(byId('fwCurrentVersion').textContent, '4.1.0', 'the installed row survives the mid-wizard disconnect');
  assert.notEqual(byId('fwUpdateStatus').textContent, '', 'the check pill survives the mid-wizard disconnect');
  const fwNav = document.querySelector('.circle-trigger[data-section="sec-firmware"]');
  assert.equal(fwNav.getAttribute('aria-disabled'), null, 'the firmware nav trigger stays open');
  assert.equal(document.getElementById('status').textContent, 'Firmware update — choose the update port');

  click('btnFwContinue');
  // The flash window re-arms the beforeunload guard (the wizard's own
  // disconnect removed the session one) — closing the tab mid-flash must
  // warn. The stub's removeEventListener is a no-op, so only the arming is
  // observable here.
  await sleep(60);
  assert.ok(
    (windowListeners['beforeunload'] ?? []).length > 0,
    'the tab-close guard is armed while the flash owns the port',
  );
  // Flash of 700 bytes = 2 data frames + fixed frames + the 500 ms erase wait.
  await waitFor(() => /installed|finishing when the connection dropped/.test(byId('fwWizardStep').textContent), {
    what: 'the flash step to settle',
  });

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
  assert.match(byId('fwUpdateStatus').textContent, /up to date/, 'the completion auto-check reports the truth');
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
      JSON.stringify({
        manifest,
        tagName: 'V4.2.0',
        releaseUrl: null,
        checkedAt: Date.now(),
        repo: { owner: 'goforwest', name: 'LipSync' },
      }),
    );
  } catch {}
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
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
        manifest: {
          firmwareVersion: '4.2.0',
          files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
        },
        tagName: 'V4.2.0',
        releaseUrl: null,
        checkedAt: Date.now(),
        repo: { owner: 'goforwest', name: 'LipSync' },
      }),
    );
  } catch {}
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
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
  // Deterministically PAST the point of no return: wait until the START
  // exchange completed (the device is erasing app memory) before cancelling.
  const stepText = () => byId('fwWizardStep').textContent;
  const startDeadline = Date.now() + 8000;
  while (!/metadata|Sending firmware…/.test(stepText()) && Date.now() < startDeadline) {
    await sleep(50);
  }
  assert.match(stepText(), /metadata|Sending firmware…/, 'the flash reached the post-START phase');
  assert.equal(byId('btnFwCancel').textContent, 'Stop update', 'the button says what it does mid-flash');
  click('btnFwCancel');
  await sleep(400);

  assert.equal(byId('fwWizard').hidden, true, 'the wizard closes and stays closed');
  const history = (await import('../app/js/services/log.js')).getLogHistory().join('\n');
  assert.match(history, /Update stopped partway/, 'the honest mid-flash cancel message is logged');
  assert.match(
    history,
    /now in its update loader/,
    'it says the device starts in its update loader — the old app is erased',
  );
  assert.match(history, /Recover a device stuck in update mode/, 'the message names the in-app repair path');
  assert.equal(
    byId('btnRecoverDevice').hidden,
    false,
    'the Recover button the message names is revealed by the cancel itself — no Connect round-trip needed',
  );
  assert.equal(byId('sec-firmware').getAttribute('data-recover'), 'true', 'the stranded marker is set');
  assert.doesNotMatch(history, /Firmware update failed:/, 'a cancel is not reopened as a failure');
  assert.doesNotMatch(history, /starts normally again/, 'the false normal-boot claim is gone post-START');
  assert.equal(document.getElementById('status').textContent, 'Not connected');
  assert.equal(byId('btnConnect').disabled, false, 'Connect returns after the cancel');
  await app.disconnect({ quiet: true });
});

test('wizard: cancelling before the bootloader accepted START keeps the harmless copy', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  fw.clearBootloaderStranded(); // a previous test's stranded marker must not leak in
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
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  // The probe ACK is slow (600 ms): a cancel at ~150 ms lands while the
  // bootloader is still considering the very first frame — well before the
  // START exchange, so nothing has been written and the normal-boot copy is
  // the honest one.
  const sim = createBootloaderSim({ ackDelayMs: 600 });
  configureDfuPortSource({ serial: { getPorts: async () => [sim.port], requestPort: async () => sim.port } });
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;
  const appPort = makeTouchedAppPort();
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await wizardDone;
  click('btnFwContinue');
  await sleep(150);
  assert.match(byId('fwWizardStep').textContent, /Contacting the device bootloader/, 'still at the probe');
  click('btnFwCancel');
  await sleep(400);

  assert.equal(byId('fwWizard').hidden, true, 'the wizard closes and stays closed');
  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.match(history, /Update stopped before anything was written/, 'the pre-START cancel says nothing was written');
  assert.match(history, /starts normally again/, 'the harmless-copy claim is honest before START');
  assert.doesNotMatch(history, /now in its update loader/, 'it does not over-claim update mode pre-START');
  assert.equal(byId('btnRecoverDevice').hidden, true, 'nothing was written — no stranded marker, no Recover button');
  assert.equal(byId('sec-firmware').getAttribute('data-recover'), null, 'the stranded marker stays unset');
  // The probe's ACK wait is still pending inside the aborted flash — wait for  // it to time out and unwind at its next abort checkpoint, so no dangling
  // continuation can leak into the following tests' shared module state.
  await sleep(5500);
  assert.doesNotMatch(
    logMod.getLogHistory().slice(histStart).join('\n'),
    /Firmware update failed:/,
    'the unwinding flash is not reopened as a failure after the cancel',
  );
  await app.disconnect({ quiet: true });
});

test('wizard: a post-START flash failure reveals Recover immediately', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  fw.clearBootloaderStranded();
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const sim = createBootloaderSim();
  // The port throws on the second data frame's write (frame 5) with a plain
  // error — START was accepted (the device is being erased) but the link
  // failed in a way that is neither the STOP window nor a gone-style error:
  // failWizard runs with postStart, and its hint names Recover.
  const baseWriter = sim.port.writable.getWriter();
  let writes = 0;
  sim.port.writable = {
    getWriter: () => ({
      async write(bytes) {
        writes++;
        if (writes >= 5) throw new Error('A random write failure');
        return baseWriter.write(bytes);
      },
      releaseLock() {},
    }),
  };
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
  await waitFor(() => /Update failed/.test(byId('fwWizardStep').textContent), {
    what: 'the post-START failure panel',
  });

  assert.match(byId('fwWizardStep').textContent, /Update failed/);
  assert.match(
    byId('fwWizardHint').textContent,
    /Recover a device stuck in update mode/,
    'the hint names the repair path',
  );
  assert.equal(
    byId('btnRecoverDevice').hidden,
    false,
    'the Recover button is revealed by the failure itself — no Connect round-trip needed',
  );
  assert.equal(byId('sec-firmware').getAttribute('data-recover'), 'true');
  assert.equal(sim.state.activated, false, 'in this construction the image never completed');
  click('btnFwCancel');
  await flush();
  assert.equal(byId('fwWizard').hidden, true, 'the failure panel closes');
  assert.equal(
    byId('btnRecoverDevice').hidden,
    false,
    'the stranded marker survives the panel dismiss — the device is still in update mode',
  );
  await app.disconnect({ quiet: true });
});

// ---- Hardware round: a port the flash failed on is never silently reused ----

test('wizard: after a probe failure, Continue shows the picker instead of reusing the port', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  // The granted bootloader port that stops answering (hardware: the probe
  // goes silent after the device re-enumerates or wedges — fast-fails on
  // write here so the scenario runs quickly).
  const badOpens = [];
  const badBootPort = {
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x0045 }),
    async open() {
      badOpens.push('open');
    },
    async close() {
      badOpens.push('close');
    },
    async setSignals() {},
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: {
      getWriter: () => ({
        async write() {
          throw new Error('The device is not responding on this port.');
        },
        releaseLock() {},
      }),
    },
  };
  const goodSim = createBootloaderSim();
  let pickerCalls = 0;
  configureDfuPortSource({
    serial: {
      getPorts: async () => [badBootPort],
      requestPort: async () => {
        pickerCalls++;
        return goodSim.port;
      },
    },
  });
  const appPort = makeTouchedAppPort();
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();

  // First attempt: Continue silently reuses the granted (now dead) port and
  // the flash fails on the probe.
  const firstDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await firstDone;
  click('btnFwContinue');
  await waitFor(() => /Update failed/.test(byId('fwWizardStep').textContent), {
    what: 'the probe failure panel',
  });
  assert.match(byId('fwWizardStep').textContent, /did not respond as an update loader/);
  assert.equal(pickerCalls, 0, 'the first attempt reused the granted port silently');
  click('btnFwCancel');
  await flush();
  await app.disconnect({ quiet: true });

  // Second attempt: the guidance says "pick the update loader again" — the
  // dead port must NOT be silently reused; the picker must actually appear.
  serialSession.port = makeTouchedAppPort();
  setLoadedValues();
  const secondDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await secondDone;
  click('btnFwContinue');
  await waitFor(() => /installed/.test(byId('fwWizardStep').textContent), {
    what: 'the picker-based flash to complete',
  });
  assert.equal(pickerCalls, 1, 'the retry showed the real picker (the guidance is followable)');
  assert.equal(goodSim.state.activated, true, 'the flash completed on the freshly picked port');
  assert.equal(
    badOpens.filter((e) => e === 'open').length,
    2,
    'the failed port was opened twice on the first attempt only (liveness probe + flash) — never again after its failure',
  );
  click('btnFwCancel');
  await flush();
  await app.disconnect({ quiet: true });
});

// ---- Honest cancel on the post-reconnect pending panels (no live wizard) ----

test('pending panel: cancelling the failed-load panel never claims nothing changed', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;
  const { serialSession } = await import('../app/js/serial/session.js');
  testHooks.attach({ simulated: true }, { write() {} });
  serialSession.port = { simulated: true };
  // The page died mid-flash and was reloaded; the reconnect's load failed, so
  // the finisher shows the "settings did not load" panel with no live wizard.
  fw.writePending({ target: '4.2.0', installed: true, snapshot: { SS: '5' } });
  byId('version').textContent = '—';
  await fw.afterDeviceLoad();
  await sleep(60);

  assert.equal(byId('fwWizard').hidden, false, 'the pending panel is showing');
  assert.equal(byId('btnFwCancel').hidden, false, 'Cancel is offered');
  click('btnFwCancel');
  await flush();

  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.match(history, /firmware update itself finished/, 'the cancel admits the firmware was changed');
  assert.match(history, /not restored/, 'the cancel admits the settings were not restored');
  assert.match(history, /backup file/, 'the message points at the downloaded backup');
  assert.doesNotMatch(history, /Nothing was changed/, 'the lying default message is not used');
  assert.equal(fw.readPending(), null, 'the pending entry is cleared by the explicit cancel');
  assert.equal(byId('fwWizard').hidden, true, 'the panel closes');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('pending panel: cancelling the version-mismatch panel never claims nothing changed', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;
  const { serialSession } = await import('../app/js/serial/session.js');
  testHooks.attach({ simulated: true }, { write() {} });
  serialSession.port = { simulated: true };
  // A completed update, but the device reports a different version than the
  // pending entry expects — the mismatch panel with no live wizard.
  fw.writePending({ target: '4.2.0', installed: true, snapshot: { SS: '5' } });
  setLoadedValues({ version: '4.1.0' });
  await fw.afterDeviceLoad();
  await sleep(60);

  assert.match(byId('fwWizardStep').textContent, /Expected firmware 4\.2\.0/, 'the mismatch panel is showing');
  click('btnFwCancel');
  await flush();

  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.match(history, /firmware update itself finished/, 'the cancel admits the firmware was changed');
  assert.doesNotMatch(history, /Nothing was changed/, 'the lying default message is not used');
  assert.equal(fw.readPending(), null, 'the pending entry is cleared by the explicit cancel');
  assert.equal(byId('fwWizard').hidden, true, 'the panel closes');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

// ---- Phase 2: the Continue latch (no concurrent flows) ---------------------

test('wizard: a double-click on Continue cannot start two flashes', async () => {
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
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const sim = createBootloaderSim();
  // The bootloader port is already granted: requestDfuPort returns it from
  // getPorts() without any picker, so two same-burst Continue clicks would
  // historically race two opens/flashes against the same port.
  configureDfuPortSource({ serial: { getPorts: async () => [sim.port], requestPort: async () => sim.port } });
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;
  const appPort = makeTouchedAppPort();
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await wizardDone;
  click('btnFwContinue');
  click('btnFwContinue'); // the same-burst second click must no-op at the latch
  await waitFor(() => /installed|finishing when the connection dropped/.test(byId('fwWizardStep').textContent), {
    what: 'the flash step to settle',
  });

  assert.equal(sim.state.activated, true, 'exactly one flash ran and completed');
  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.doesNotMatch(history, /Firmware update failed:/, 'no spurious failure from the second click');
  assert.doesNotMatch(history, /already (open|in progress)/i, 'no port-open race surfaced');
  assert.equal(byId('fwWizardStep').textContent.includes('installed'), true, 'the wizard reached completion');
  click('btnFwCancel');
  await flush();
  await app.disconnect({ quiet: true });
});

// ---- Phase 2: a link failure while finishing hedges instead of failing ------

test('wizard: a link failure while finishing the update hedges instead of failing', async () => {
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
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const sim = createBootloaderSim();
  // The port dies exactly at the STOP write (frame 6 of probe/start/init/
  // data/data/stop). The host cannot know whether an earlier STOP attempt
  // already landed — reporting a plain failure would risk lying.
  const baseWriter = sim.port.writable.getWriter();
  let writes = 0;
  sim.port.writable = {
    getWriter: () => ({
      async write(bytes) {
        writes++;
        if (writes >= 6) {
          const e = new Error("Failed to execute 'write' on 'WritableStream': The port was disconnected.");
          e.name = 'NetworkError';
          throw e;
        }
        return baseWriter.write(bytes);
      },
      releaseLock() {},
    }),
  };
  configureDfuPortSource({ serial: { getPorts: async () => [sim.port], requestPort: async () => sim.port } });
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;
  const appPort = makeTouchedAppPort();
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await wizardDone;
  click('btnFwContinue');
  await waitFor(() => /installed|finishing when the connection dropped/.test(byId('fwWizardStep').textContent), {
    what: 'the flash step to settle',
  });

  assert.equal(sim.state.activated, false, 'in this construction the STOP never reached the device');
  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.doesNotMatch(history, /Firmware update failed:/, 'no failure panel for the ambiguous stop window');
  assert.match(history, /may have completed/, 'the hedge is logged honestly');
  assert.match(byId('fwWizardStep').textContent, /finishing when the connection dropped/);
  assert.match(byId('fwWizardStep').textContent, /usually completes on its own/);
  assert.equal(fw.readPending()?.flashStarted, true, 'the pending entry keeps flashStarted for the reconnect truth');

  click('btnFwCancel');
  await flush();
  assert.match(
    logMod.getLogHistory().slice(histStart).join('\n'),
    /may or may not have completed/,
    'the hedge cancel does not claim the update finished',
  );
  assert.equal(byId('fwWizard').hidden, true);
  await app.disconnect({ quiet: true });
});

// ---- Phase 4: an unplugged device is not "restarted into update mode" ------

test('wizard: an unplugged device is not reported as restarted into update mode', async () => {
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
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;
  // The cable was knocked out during the confirm dialog: every open on the
  // app port fails NotFound, and no bootloader port has ever been granted —
  // the bus holds no proof of update mode.
  const goneError = () => {
    const e = new Error('The port requested does not exist or is no longer available.');
    e.name = 'NotFoundError';
    return e;
  };
  const appPort = {
    async open() {
      throw goneError();
    },
    async close() {},
    async setSignals() {},
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8045 }),
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
  };
  configureDfuPortSource({ serial: { getPorts: async () => [], requestPort: async () => appPort } });
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await wizardDone;

  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.doesNotMatch(history, /Device restarted into update mode/, 'the unplug is not claimed as a restart');
  assert.match(history, /not responding on the bus/, 'the honest unplug diagnosis is logged');
  assert.match(history, /Automatic restart failed after 3 attempts/, 'the retries exhausted');
  assert.match(
    byId('fwWizardStep').textContent,
    /plugged in securely/,
    'the step points at the USB connection, not a reset ritual',
  );
  assert.equal(byId('btnFwContinue').hidden, false, 'Continue stays available for after the replug');
  click('btnFwCancel');
  await flush();
  assert.equal(byId('fwWizard').hidden, true);
  await app.disconnect({ quiet: true });
});

// ---- Phase 4: a departed granted bootloader port falls through to the picker --

test('wizard: a stale granted bootloader port is skipped for the live picker', async () => {
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
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const sim = createBootloaderSim();
  // Yesterday's granted bootloader port: still listed by getPorts() with its
  // cached identity, but the device behind it left. Native SerialPort
  // objects expose no liveness property (this stub deliberately models that:
  // no `connected` field), so only the requestDfuPort liveness probe can
  // tell it apart from a live port — the dead grant must never be silently
  // picked over the live port behind the picker.
  const deadOpens = [];
  const deadBootPort = {
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x0045 }),
    async open() {
      deadOpens.push('open');
      const e = new Error('The port requested does not exist or is no longer available.');
      e.name = 'NotFoundError';
      throw e;
    },
    async close() {},
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
  };
  configureDfuPortSource({
    serial: { getPorts: async () => [deadBootPort], requestPort: async () => sim.port },
  });
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;
  const appPort = makeTouchedAppPort();
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await wizardDone;
  click('btnFwContinue'); // the probe rejects the dead grant, so the picker hands back the live sim
  await waitFor(() => /installed|finishing when the connection dropped/.test(byId('fwWizardStep').textContent), {
    what: 'the flash step to settle',
  });

  assert.equal(sim.state.activated, true, 'the flash ran against the live port from the picker');
  assert.deepEqual(
    deadOpens,
    ['open'],
    'the departed grant was probed exactly once (the liveness probe) and never flashed',
  );
  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.doesNotMatch(history, /no longer connected/, 'the open-reject loop never happened');
  assert.equal(byId('fwWizardStep').textContent.includes('installed'), true);
  click('btnFwCancel');
  await flush();
  await app.disconnect({ quiet: true });
});

// ---- Phase 6: delivery-truth tests -----------------------------------------

function seedFirmwareCache(manifest, tagName) {
  try {
    localStorage.setItem(
      'lipsync-fw-check',
      JSON.stringify({
        manifest,
        tagName,
        releaseUrl: 'https://github.com/goforwest/LipSync/releases/tag/' + tagName,
        repo: { owner: 'goforwest', name: 'LipSync' },
        checkedAt: Date.now(),
      }),
    );
  } catch {}
}

test('update: a manifest that disagrees with its release is refused', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  // The firmware-binaries branch is stale (a failed or raced push): the
  // manifest says 4.1.2 while the release the API reports is V4.2.0.
  seedFirmwareCache(
    {
      firmwareVersion: '4.1.2',
      files: { dfu: { fileName: 'LipSync_Firmware_4.1.2_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;
  const appPort = makeTouchedAppPort();
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();

  await assert.rejects(() => fw.startFirmwareUpdate(), /does not match its release/);
  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.doesNotMatch(history, /Flashing firmware/, 'nothing was flashed from the stale manifest');
  assert.doesNotMatch(history, /Downloading firmware/, 'no download was started either');
  await app.disconnect({ quiet: true });
});

test('snapshot: a failed sound-feedback load stops the update honestly', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const appPort = makeTouchedAppPort();
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();
  // The sound-feedback row failed to load: the restore promises to write SM
  // back, so the snapshot must refuse — silently skipping it would lose the
  // user's feedback configuration while still reporting "settings restored".
  byId('soundModeVal').textContent = 'ERR';

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  await wizardDone;

  assert.match(
    byId('fwWizardStep').textContent,
    /Some settings did not load \(Sound feedback\)/,
    'the failed row is named before anything happens to the device',
  );
  assert.equal(byId('fwWizard').getAttribute('data-state'), 'failed');
  assert.equal(fw.readPending(), null, 'nothing was persisted for a refused snapshot');
  click('btnFwCancel');
  await flush();
  await app.disconnect({ quiet: true });
});

test('download: cancelling aborts the in-flight download instead of letting it run', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  const seenSignals = [];
  globalThis.fetch = (url, opts) => {
    seenSignals.push(opts?.signal ?? null);
    return new Promise((resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => {
        const e = new Error('The operation was aborted.');
        e.name = 'AbortError';
        reject(e);
      });
    });
  };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;
  const appPort = makeTouchedAppPort();
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  assert.ok(seenSignals.length >= 1, 'the download fetch received the wizard abort signal');
  assert.equal(seenSignals[0].aborted, false, 'not aborted before the cancel');
  click('btnFwCancel');
  await flush();
  assert.equal(seenSignals[0].aborted, true, 'the cancel aborts the in-flight download');
  await wizardDone;
  await sleep(60);
  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.doesNotMatch(history, /Firmware update failed:/, 'the user-initiated abort is not a failure');
  assert.equal(byId('fwWizard').hidden, true, 'the panel stays closed');
  await app.disconnect({ quiet: true });
});

// ---- Phase 7: the flashStarted flag is written by the production path ------

test('wizard: the pending entry is marked flashStarted the moment flashing begins', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
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
  // The granted bootloader port is reused silently: the flash begins within
  // milliseconds — and the reload-recovery state machine's linchpin (the
  // flashStarted flag) must be on disk before the first byte moves.
  await sleep(120);
  const pendingMidFlash = fw.readPending();
  assert.equal(pendingMidFlash?.flashStarted, true, 'flashStarted is live during the flash (production path)');
  assert.equal(pendingMidFlash?.installed, false, 'the update is not yet marked installed');

  await waitFor(() => /installed|finishing when the connection dropped/.test(byId('fwWizardStep').textContent), {
    what: 'the flash step to settle',
  });
  assert.equal(sim.state.activated, true, 'the flash completed');
  click('btnFwCancel');
  await flush();
  await app.disconnect({ quiet: true });
});

test('reload: an interrupted local-file update with no version in its name still restores', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;
  // The page died mid-flash of "my_firmware_dfu.zip" (no version triple in
  // the name): the target is 'unknown version', so the version-equality
  // check can never confirm completion — the bootloader finished it anyway.
  fw.writePending({
    target: 'unknown version',
    installed: false,
    flashStarted: true,
    snapshot: { SS: '5', SL: '5' },
  });
  const sentUnversioned = [];
  const writerUnversioned = {
    write(bytes) {
      const text = Buffer.from(bytes).toString('utf8');
      sentUnversioned.push(text);
      if (text === 'SETTINGS') {
        setTimeout(() => app.handleLine('SUCCESS,0:SETTINGS'), 2);
        return;
      }
      const m = text.match(/^([A-Z]{2}),1:(.+)$/);
      if (m) setTimeout(() => app.handleLine(`SUCCESS,0:${m[1]},1:${m[2]}`), 2);
    },
  };
  testHooks.attach({ simulated: true }, writerUnversioned);
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = { simulated: true };
  setLoadedValues({ version: '4.2.0' }); // whatever the device now reports

  await fw.afterDeviceLoad();
  await sleep(120);

  assert.deepEqual(
    sentUnversioned.filter((t) => /,1:/.test(t)),
    ['SS,1:5', 'SL,1:5'],
    'the settings restore runs even though the version could not be checked',
  );
  assert.match(
    logMod.getLogHistory().slice(histStart).join('\n'),
    /no version in its name/,
    'the honest no-version note is logged',
  );
  assert.doesNotMatch(byId('fwWizardStep').textContent, /Expected firmware unknown version/);
  assert.equal(byId('fwWizardStep').textContent, 'Firmware update complete.');
  assert.equal(fw.readPending(), null, 'the pending entry completes and clears');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

// ---- Hardening: connection lost mid-restore re-arms and retries --------

test('wizard: a disconnect during settings restore retries on the next connect', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  const manifest = {
    firmwareVersion: '4.2.0',
    files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
  };
  try {
    localStorage.setItem(
      'lipsync-fw-check',
      JSON.stringify({
        manifest,
        tagName: 'V4.2.0',
        releaseUrl: null,
        checkedAt: Date.now(),
        repo: { owner: 'goforwest', name: 'LipSync' },
      }),
    );
  } catch {}
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
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
  await waitFor(() => /installed|finishing when the connection dropped/.test(byId('fwWizardStep').textContent), {
    what: 'the flash step to settle',
  });

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
        manifest: {
          firmwareVersion: '4.2.0',
          files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
        },
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
        manifest: {
          firmwareVersion: '4.2.0',
          files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
        },
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
  await app.disconnect({ quiet: true });
});

// ---- Hardware round: the touch survives a port left open by a stalled close --

test('wizard: the touch recovers when the session left the port open', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;
  const { setPortCloseTimeoutForTests, PORT_CLOSE_TIMEOUT_MS } = await import('../app/js/utils/port-open.js');
  // The real pathology: the session's close STALLS (macOS, after a settings
  // load) — the bounded close gives up and leaves the port open, after which
  // every touch open fails "The port is already open". Shrink the bound so
  // the stalled close is abandoned quickly here.
  setPortCloseTimeoutForTests(100);
  let closeCalls = 0;
  const portState = { open: true };
  let opens = 0;
  const wedgedAppPort = {
    async open() {
      opens++;
      if (portState.open) {
        throw new Error("Failed to execute 'open' on 'SerialPort': The port is already open.");
      }
      if (opens >= 4) {
        const e = new Error('device no longer available');
        e.name = 'NotFoundError';
        throw e;
      }
      portState.open = true; // opened; a settled close() re-arms the wedge
    },
    close() {
      closeCalls++;
      if (closeCalls === 1) {
        // The session close that stalls and never settles (left open).
        return new Promise(() => {});
      }
      portState.open = false;
      return Promise.resolve();
    },
    async setSignals() {},
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8045 }),
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
  };
  const sim = createBootloaderSim();
  configureDfuPortSource({ serial: { getPorts: async () => [sim.port], requestPort: async () => sim.port } });
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = wedgedAppPort;
  setLoadedValues();

  try {
    const wizardDone = fw.startFirmwareUpdate();
    await flush();
    click('confirmOk');
    await wizardDone;

    const history = logMod.getLogHistory().slice(histStart).join('\n');
    assert.match(history, /left open by the last session/, 'the cleanup-retry ran');
    assert.match(history, /Device restarted into update mode/, 'the 1200-baud signal went out despite the wedge');
    assert.equal(opens, 4, 'wake (recovered) + touch + verify — exactly one recovery, no flailing');
    assert.equal(byId('btnFwContinue').hidden, false, 'the wizard reached the picker step');
    click('btnFwCancel');
    await flush();
    await app.disconnect({ quiet: true });
  } finally {
    setPortCloseTimeoutForTests(PORT_CLOSE_TIMEOUT_MS);
  }
});

// ---- Hardware round 2: the post-close settle and the pending-open wedge ----

test('wizard: the first touch open waits for the OS to settle after the session close', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  assert.equal(fw.TOUCH_AFTER_CLOSE_SETTLE_MS, 2000, 'the production settle is generous for real hardware');
  fw.setTouchSettleAfterDisconnectForTests(1500);
  try {
    const times = [];
    let opens = 0;
    const appPort = {
      async open() {
        opens++;
        times.push(['open', Date.now()]);
        if (opens > 2) {
          const e = new Error('device no longer available');
          e.name = 'NotFoundError';
          throw e;
        }
      },
      async close() {
        times.push(['close', Date.now()]);
      },
      async setSignals() {},
      getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8045 }),
      readable: {
        getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }),
      },
      writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
    };
    const sim = createBootloaderSim();
    configureDfuPortSource({ serial: { getPorts: async () => [sim.port], requestPort: async () => sim.port } });
    const { serialSession } = await import('../app/js/serial/session.js');
    serialSession.port = appPort;
    setLoadedValues();

    const wizardDone = fw.startFirmwareUpdate();
    await flush();
    click('confirmOk');
    await wizardDone;

    const firstClose = times.find(([k]) => k === 'close');
    const firstWake = times.find(([k]) => k === 'open');
    assert.ok(firstClose && firstWake, 'a close and a wake open were recorded');
    assert.ok(
      firstWake[1] - firstClose[1] >= 1400,
      `the wake open waits out the post-close settle (gap ${firstWake[1] - firstClose[1]}ms)`,
    );
    click('btnFwCancel');
    await flush();
    await app.disconnect({ quiet: true });
  } finally {
    fw.setTouchSettleAfterDisconnectForTests(30);
  }
});

test('wizard: the touch waits out a pending stalled open instead of failing into it', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;
  // The wake open stalls (its bound fires; the OS-level open stays pending),
  // so the 1200-baud open hits "A call to open() is already in progress" —
  // the recovery must wait out the pending open, not fail the attempt.
  fw.setTouchOpenTimeoutForTests(250);
  let opens = 0;
  const appPort = {
    open() {
      opens++;
      if (opens === 1) return new Promise(() => {}); // the stalled wake open
      if (opens === 2) {
        return Promise.reject(
          new Error("Failed to execute 'open' on 'SerialPort': A call to open() is already in progress."),
        );
      }
      if (opens >= 4) {
        const e = new Error('device no longer available');
        e.name = 'NotFoundError';
        return Promise.reject(e);
      }
      return Promise.resolve();
    },
    async close() {},
    async setSignals() {},
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8045 }),
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
  };
  const sim = createBootloaderSim();
  configureDfuPortSource({ serial: { getPorts: async () => [sim.port], requestPort: async () => sim.port } });
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();
  try {
    const wizardDone = fw.startFirmwareUpdate();
    await flush();
    click('confirmOk');
    await wizardDone;

    const history = logMod.getLogHistory().slice(histStart).join('\n');
    assert.match(history, /previous open is still settling/, 'the pending-open recovery ran');
    assert.match(
      history,
      /Device restarted into update mode/,
      'the touch completed after waiting out the pending open',
    );
    assert.equal(opens, 4, 'stalled wake + in-progress 1200 + recovered 1200 + verify — no wasted attempts');
    click('btnFwCancel');
    await flush();
    await app.disconnect({ quiet: true });
  } finally {
    fw.setTouchOpenTimeoutForTests(8000);
  }
});

test('wizard: a port whose close is also stuck fails fast with honest guidance', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;
  // The terminal wedge: every open fails "The port is already open." AND
  // every close fails "A call to close() is already in progress." — nothing
  // in this page session can free the port. The touch must fail fast, name
  // the dead end, and land on the replug guidance instead of looping a
  // swallowed-close + doomed-retry storm.
  const wedgedShut = {
    async open() {
      throw new Error("Failed to execute 'open' on 'SerialPort': The port is already open.");
    },
    close() {
      return Promise.reject(
        new Error("Failed to execute 'close' on 'SerialPort': A call to close() is already in progress."),
      );
    },
    async setSignals() {},
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8045 }),
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
  };
  configureDfuPortSource({ serial: { getPorts: async () => [], requestPort: async () => wedgedShut } });
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = wedgedShut;
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await wizardDone;

  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.match(
    history,
    /The port would not close \(Failed to execute 'close'.*already in progress/,
    'the dead end is named',
  );
  assert.match(history, /Unplug the LipSync or reload the page/, 'the remedy is stated');
  assert.match(
    history,
    /Automatic restart failed after 3 attempts \(Failed to execute 'open' on 'SerialPort': The port is already open\.\)/,
    'the attempts exhaust with the real cause',
  );
  assert.match(
    byId('fwWizardStep').textContent,
    /automatic restart did not take|did not restart/,
    'the wizard stays on the restart step with guidance',
  );
  click('btnFwCancel');
  await flush();
  await app.disconnect({ quiet: true });
});

// ---- Hardware round 3: the OS-level wedged open (never settles) ----------

test('wizard: a wedged open fails fast to reset guidance and recovers after a replug', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;
  fw.setTouchOpenTimeoutForTests(250);
  // Hardware model: the first open after the session close wedges at the OS
  // level and NEVER settles — every later open reports "A call to open() is
  // already in progress". After the device is unplugged/replugged the stuck
  // open is force-failed and the port responds again (two opens succeed,
  // then the rebooted enumeration answers NotFound like a departed device).
  const mode = { wedged: true };
  let opens = 0;
  const appPort = {
    open() {
      opens++;
      if (mode.wedged) {
        if (opens === 1) return new Promise(() => {}); // the wedged open: never settles
        return Promise.reject(
          new Error("Failed to execute 'open' on 'SerialPort': A call to open() is already in progress."),
        );
      }
      if (opens >= mode.replugBase + 3) {
        const e = new Error('device no longer available');
        e.name = 'NotFoundError';
        return Promise.reject(e);
      }
      return Promise.resolve();
    },
    async close() {},
    async setSignals() {},
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8045 }),
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
  };
  configureDfuPortSource({
    serial: {
      getPorts: async () => [],
      requestPort: async () => appPort,
    },
  });
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();
  try {
    // ---- Phase 1: the wedge. The first in-progress is waited out once;
    // when the retry reports in-progress too, the port is flagged wedged and
    // every later attempt fails FAST — no more 8.5 s waits per attempt.
    const firstDone = fw.startFirmwareUpdate();
    await flush();
    click('confirmOk');
    await firstDone;

    const history = logMod.getLogHistory().slice(histStart).join('\n');
    assert.match(history, /previous open is still settling/, 'the one legitimate wait ran');
    assert.match(history, /serial port has wedged/, 'the wedge is diagnosed');
    assert.match(history, /reset button twice, slowly/, 'the reset path is the lead remedy');
    assert.match(
      byId('fwWizardStep').textContent,
      /wedged/,
      'the wizard step names the wedge instead of a generic failure',
    );
    const settleWaits = logMod
      .getLogHistory()
      .slice(histStart)
      .filter((l) => /still settling/.test(l)).length;
    assert.equal(settleWaits, 1, 'the futile wait happened exactly once, never again per attempt');
    click('btnFwCancel');
    await flush();
    await app.disconnect({ quiet: true });

    // ---- Phase 2: the replug. The device re-enumerates, the stuck open is
    // force-failed by the OS, and the port answers again — the wedge flag
    // must not poison the next attempt at restarting the device.
    mode.wedged = false;
    mode.replugBase = opens;
    const wedgeOpens = opens;
    serialSession.port = appPort;
    const secondDone = fw.startFirmwareUpdate();
    await flush();
    click('confirmOk');
    await secondDone; // the wizard's own touch now runs against the replugged port

    const history2 = logMod.getLogHistory().slice(histStart).join('\n');
    assert.match(
      history2,
      /Device restarted into update mode/,
      'the touch completed after the replug cleared the wedge',
    );
    assert.equal(opens, wedgeOpens + 3, 'wake + touch + verify ran — the wedge flag did not block them');
    assert.match(byId('fwWizardStep').textContent, /Select the update port/, 'the wizard reached the picker');
    assert.doesNotMatch(byId('fwWizardStep').textContent, /wedged/, 'the wedge copy is gone once cleared');
    click('btnFwCancel');
    await flush();
    await app.disconnect({ quiet: true });
  } finally {
    fw.setTouchOpenTimeoutForTests(8000);
  }
});

// ---- SR-first restart: wedge-free re-enumeration ----------------------------

test('wizard: the soft reset reboots the device first and the touch skips the wake pulse', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;
  const opens = [];
  const appPort = {
    async open(opts) {
      if (opens.length >= 1) {
        // the verify open: the device left app mode after the 1200-baud signal
        const e = new Error('device no longer available');
        e.name = 'NotFoundError';
        throw e;
      }
      opens.push(opts?.baudRate ?? null); // the successful 1200-baud signal
    },
    async close() {},
    async setSignals() {},
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8045 }),
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
  };
  const srEchoWriter = {
    write(bytes) {
      const text = Buffer.from(bytes).toString('utf8');
      if (text === 'SETTINGS') {
        setTimeout(() => app.handleLine('SUCCESS,0:SETTINGS'), 2);
        return;
      }
      const m = text.match(/^([A-Z]{2}),1:(.+)$/);
      if (m) setTimeout(() => app.handleLine(`SUCCESS,0:${m[1]},1:${m[2]}`), 2);
    },
  };
  const sim = createBootloaderSim();
  configureDfuPortSource({ serial: { getPorts: async () => [sim.port], requestPort: async () => sim.port } });
  const { serialSession } = await import('../app/js/serial/session.js');
  testHooks.attach(appPort, srEchoWriter); // a live session: SR can be delivered
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await wizardDone;

  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.match(history, /rebooting \(soft reset\)/, 'the device is rebooted over the live session first');
  const relHistory = logMod.getLogHistory().slice(histStart);
  const srIdx = relHistory.findIndex((l) => /rebooting \(soft reset\)/.test(l));
  const touchedIdx = relHistory.findIndex((l) => /Device restarted into update mode/.test(l));
  assert.ok(srIdx >= 0 && touchedIdx > srIdx, 'the soft reset precedes the update-mode signal');
  assert.match(history, /Device restarted into update mode/, 'the touch landed against the fresh enumeration');
  assert.deepEqual(
    opens,
    [1200],
    'the first and only pre-verify open is the 1200-baud signal — no wake pulse after SR',
  );
  assert.equal(serialSession.port, null, 'the session was torn down by the soft-reset path');
  assert.match(byId('fwWizardStep').textContent, /Select the update port/, 'the wizard reached the picker');
  click('btnFwCancel');
  await flush();
  testHooks.detach();
});

test('wizard: when SR goes unanswered, the standard close-then-touch path runs', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;
  const opens = [];
  const appPort = {
    async open(opts) {
      if (opens.length >= 2) {
        // the verify open: the device left app mode after the 1200-baud signal
        const e = new Error('device no longer available');
        e.name = 'NotFoundError';
        throw e;
      }
      opens.push(opts?.baudRate ?? null); // successful wake + touch opens
    },
    async close() {},
    async setSignals() {},
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8045 }),
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
  };
  // Acks the SETTINGS handshake but never answers SR,1:1 — the soft reset
  // cannot be delivered, and the wizard must fall back to the classic
  // choreography (session close → settle → wake pulse → 1200-baud touch).
  const silentSrWriter = {
    write(bytes) {
      const text = Buffer.from(bytes).toString('utf8');
      if (text === 'SETTINGS') setTimeout(() => app.handleLine('SUCCESS,0:SETTINGS'), 2);
    },
  };
  const sim = createBootloaderSim();
  configureDfuPortSource({ serial: { getPorts: async () => [sim.port], requestPort: async () => sim.port } });
  testHooks.attach(appPort, silentSrWriter);
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await wizardDone;

  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.match(history, /Could not reboot the device over the session/, 'the SR failure is diagnosed');
  assert.match(history, /using the standard restart instead/, 'the fallback is named');
  assert.match(history, /Device restarted into update mode/, 'the classic touch completed');
  assert.deepEqual(opens, [115200, 1200], 'the fallback ran the full wake + touch choreography');
  click('btnFwCancel');
  await flush();
  testHooks.detach();
});

// ---- Audit: cancel during the 1200-baud touch window ------------------

test('wizard: cancelling during the device restart stays quiet and closed', async () => {
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
        checkedAt: Date.now(),
        repo: { owner: 'goforwest', name: 'LipSync' },
      }),
    );
  } catch {}
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
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
        manifest: {
          firmwareVersion: '4.2.0',
          files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
        },
        tagName: 'V4.2.0',
        releaseUrl: null,
        checkedAt: Date.now(),
        repo: { owner: 'goforwest', name: 'LipSync' },
      }),
    );
  } catch {}
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
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
  await waitFor(() => /installed|finishing when the connection dropped/.test(byId('fwWizardStep').textContent), {
    what: 'the flash step to settle',
  });
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
  assert.match(
    document.getElementById('fwUpdateStatus').textContent,
    /up to date/,
    'the completion auto-check reports the truth',
  );
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
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
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
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
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
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
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
  assert.match(
    byId('fwWizardStep').textContent,
    /now in update mode|pick the update loader/,
    'back at the picker, not a failure',
  );
  assert.equal(byId('btnFwContinue').hidden, false, 'Continue is available again');
  assert.doesNotMatch(history, /Firmware update failed:/, 'no failure panel was raised');

  click('btnFwContinue'); // second pick: the real bootloader
  await waitFor(() => /installed|finishing when the connection dropped/.test(byId('fwWizardStep').textContent), {
    what: 'the flash step to settle',
  });
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
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
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
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
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
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
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
  await waitFor(() => /installed|finishing when the connection dropped/.test(byId('fwWizardStep').textContent), {
    what: 'the flash step to settle',
  });
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
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
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

// ---- Zombie-touch hardening: cancel while an open() hangs ----------------

test('wizard: cancelling a hung restart settles cleanly and cannot kill the next connect', async () => {
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
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;

  // The wake open HANGS (the wedged-port variant seen on hardware: macOS
  // can block a serial open indefinitely after rapid open/close cycling).
  // The late-completing continuation must respect the cancel, close the
  // port quietly, and never interfere afterwards.
  let releaseOpen = null;
  const portEvents = [];
  const hungAppPort = {
    open() {
      portEvents.push('open');
      return new Promise((resolve) => {
        releaseOpen = () => resolve();
      });
    },
    async close() {
      portEvents.push('close');
    },
    async setSignals() {},
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8045 }),
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
  };
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = hungAppPort;
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await sleep(100); // the touch is parked inside the hung wake open
  click('btnFwCancel');
  await sleep(2600); // let the cancel's settle window elapse un-resolved
  releaseOpen(); // the hung open resolves only now — after the cancel
  await wizardDone;

  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.match(history, /state is uncertain/, 'the cancel message is honest about the unknown device state');
  assert.doesNotMatch(history, /now in update mode/, 'it does not claim update mode it cannot prove');
  assert.equal(byId('fwWizard').hidden, true);

  // The zombie continuation must have closed the port (hygiene) and exited
  // without logging errors.
  await sleep(200);
  // 'close' = the wizard's own session disconnect before the touch, then the
  // hung wake open, then the late hygiene close from the cancelled flow.
  assert.deepEqual(portEvents, ['close', 'open', 'close'], 'the late open was released quietly');
  assert.doesNotMatch(logMod.getLogHistory().slice(histStart).join('\n'), /Update failed|Firmware update failed/);

  // And the next connect is not blocked or killed by leftovers.
  const sim = createBootloaderSim();
  configureDfuPortSource({ serial: { getPorts: async () => [sim.port], requestPort: async () => sim.port } });
  testHooks.attach({ simulated: true }, { write() {} });
  serialSession.port = { simulated: true };
  setLoadedValues({ version: '4.1.0' });
  await fw.afterDeviceLoad();
  await sleep(100);
  assert.equal(serialSession.port !== null, true, 'a fresh session works untouched');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

// ---- Stalled opens: the touch can never freeze the wizard ---------------

test('wizard: a stalled serial open fails fast with replug guidance, not a frozen wizard', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  fw.setTouchOpenTimeoutForTests(250);
  try {
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
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;

  // The macOS wedged-port hang: open() never resolves at all.
  const stalledAppPort = {
    open() {
      return new Promise(() => {});
    },
    async close() {},
    async setSignals() {},
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8045 }),
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
  };
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = stalledAppPort;
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await wizardDone; // previously froze forever — now bounded per attempt

  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.match(history, /attempt 1 did not take \(the serial port did not respond\)/, 'the stall is diagnosed');
  assert.match(history, /failed after 3 attempts \(the serial port did not respond\)/, 'the failure names the stall');
  assert.match(history, /Unplug the LipSync, plug it back in/, 'the guidance is actionable');
  assert.match(byId('fwWizardStep').textContent, /serial port stopped responding/, 'the picker step says what to do');
  assert.equal(byId('btnFwContinue').hidden, false, 'Continue remains available');
  click('btnFwCancel');
  await flush();
  assert.equal(byId('fwWizard').hidden, true);
  } finally {
    // The seam must be restored on every path — a failed assertion here must
    // not leak a 250 ms touch bound into every later test in this module.
    fw.setTouchOpenTimeoutForTests(8000);
    await app.disconnect({ quiet: true });
  }
});

// ---- Restore re-arm: a silent device retries instead of declaring defeat --

test('restore: writes that fail on a silent device are retried on the next connect', async () => {
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
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;

  // The device answers everything EXCEPT the first two restore writes —
  // the alive-but-silent hang right after a flash (observed on hardware).
  let silentWrites = 0;
  const writerSilent = {
    write(bytes) {
      const text = Buffer.from(bytes).toString('utf8');
      if (text === 'SETTINGS') {
        setTimeout(() => app.handleLine('SUCCESS,0:SETTINGS'), 2);
        return;
      }
      const m = text.match(/^([A-Z]{2}),1:(.+)$/);
      if (!m) return;
      if ((m[1] === 'SS' || m[1] === 'SL') && silentWrites < 2) {
        silentWrites++;
        return; // silence — the write times out
      }
      setTimeout(() => app.handleLine(`SUCCESS,0:${m[1]},1:${m[2]}`), 2);
    },
  };
  const { serialSession } = await import('../app/js/serial/session.js');
  testHooks.attach({ simulated: true }, writerSilent);
  serialSession.port = { simulated: true };
  setLoadedValues({ version: '4.2.0' });

  fw.writePending({
    target: '4.2.0',
    installed: true,
    snapshot: { SS: '5', SL: '5', ST: '3.00', PT: '3.00', IZ: '0.07', OZ: '0.95', SM: '1', LM: '1', LL: '5' },
  });
  await fw.afterDeviceLoad();
  await sleep(400);

  assert.equal(fw.readPending()?.restoreRetried, true, 'the restore is re-armed');
  const history1 = logMod.getLogHistory().slice(histStart).join('\n');
  assert.match(history1, /retried automatically on the next connect/);
  assert.match(byId('fwWizardStep').textContent, /retried automatically/);

  // Second connect with a healthy device: the full restore completes.
  const sentSecond = [];
  const writerSecond = {
    write(bytes) {
      const text = Buffer.from(bytes).toString('utf8');
      sentSecond.push(text);
      if (text === 'SETTINGS') {
        setTimeout(() => app.handleLine('SUCCESS,0:SETTINGS'), 2);
        return;
      }
      const m = text.match(/^([A-Z]{2}),1:(.+)$/);
      if (m) setTimeout(() => app.handleLine(`SUCCESS,0:${m[1]},1:${m[2]}`), 2);
    },
  };
  testHooks.attach({ simulated: true }, writerSecond);
  serialSession.port = { simulated: true };
  setLoadedValues({ version: '4.2.0' });
  await fw.afterDeviceLoad();
  await sleep(120);

  assert.equal(byId('fwWizardStep').textContent, 'Firmware update complete.');
  assert.equal(fw.readPending(), null, 'the pending restore is cleared');
  assert.deepEqual(
    sentSecond.filter((t) => /,1:/.test(t)),
    ['SS,1:5', 'SL,1:5', 'ST,1:3.00', 'PT,1:3.00', 'IZ,1:0.07', 'OZ,1:0.95', 'SM,1:1', 'LM,1:1', 'LL,1:5'],
    'every setting is re-written on the retry',
  );
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

// ---- Completion re-check: flashing down must re-flag the newer release ----

test('completion: a local-file downgrade re-flags the newer release automatically', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  // The cached check says 4.2.0 is latest (the fork release); the user is
  // about to flash DOWN to 4.1.0 from a local file — exactly the hardware
  // scenario where the finisher used to fabricate "latest == installed".
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
  const sim = createBootloaderSim();
  configureDfuPortSource({ serial: { getPorts: async () => [sim.port], requestPort: async () => sim.port } });
  const appPort = makeTouchedAppPort();
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();

  // Local file: a 4.1.0-named DFU package (the version comes from the name).
  const localFile = {
    name: 'LipSync_Firmware_4.1.0_dfu.zip',
    arrayBuffer: async () =>
      FW_ZIP_BYTES.buffer.slice(FW_ZIP_BYTES.byteOffset, FW_ZIP_BYTES.byteOffset + FW_ZIP_BYTES.length),
  };
  const wizardDone = fw.flashLocalFile(localFile);
  await flush();
  click('confirmOk');
  await wizardDone;
  click('btnFwContinue');
  await waitFor(() => /installed|finishing when the connection dropped/.test(byId('fwWizardStep').textContent), {
    what: 'the flash step to settle',
  });
  assert.equal(sim.state.activated, true);

  // Reconnect: the device now reports the downgraded version.
  const sentDown = [];
  const writerDown = {
    write(bytes) {
      const text = Buffer.from(bytes).toString('utf8');
      sentDown.push(text);
      if (text === 'SETTINGS') {
        setTimeout(() => app.handleLine('SUCCESS,0:SETTINGS'), 2);
        return;
      }
      const m = text.match(/^([A-Z]{2}),1:(.+)$/);
      if (m) setTimeout(() => app.handleLine(`SUCCESS,0:${m[1]},1:${m[2]}`), 2);
    },
  };
  testHooks.attach({ simulated: true }, writerDown);
  serialSession.port = { simulated: true };
  setLoadedValues({ version: '4.1.0' });

  await fw.afterDeviceLoad();
  await sleep(150);

  assert.equal(byId('fwWizardStep').textContent, 'Firmware update complete.', 'the update itself completed');
  assert.equal(byId('fwCurrentVersion').textContent, '4.1.0');
  // The completion must NOT claim "latest == installed" — the auto-check
  // re-flags the newer cached release without a manual Check click.
  assert.equal(byId('fwLatestVersion').textContent, '4.2.0');
  assert.match(byId('fwUpdateStatus').textContent, /Update available: 4\.2\.0 \(installed: 4\.1\.0\)/);
  assert.equal(byId('fwUpdateStatus').getAttribute('data-state'), 'available');
  const nav = document.querySelector('.circle-trigger[data-section="sec-firmware"]');
  assert.equal(nav.getAttribute('data-notify'), 'firmware-update', 'the nav badge re-appears');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

// ---- Audit round 3: flash-open bound, vendor gate, rows, manifest override -

test('wizard: a stalled bootloader-port open routes back to the picker step, not a dead-end failure', async () => {
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
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;
  const probeOpens = [];

  // The bootloader port's open() hangs forever (the wedged-port pathology,
  // reached via the silent-reuse probe and then the flash). The probe must
  // give up on it (bounded) and show the picker; the flash's open then
  // stalls against the picked port too — and because nothing was written,
  // the honest step is the picker with its Continue button, matching the
  // stall message's own guidance ("click Continue and pick it again").
  const stalledBootPort = {
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x0045 }),
    open() {
      probeOpens.push('open');
      return new Promise(() => {});
    },
    async close() {},
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
  };
  configureDfuPortSource({
    serial: { getPorts: async () => [stalledBootPort], requestPort: async () => stalledBootPort },
  });
  const appPort = makeTouchedAppPort();
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await wizardDone;
  click('btnFwContinue');
  // The liveness probe stalls ~3 s (falls to the picker), then the flash
  // open stalls the full 10 s bound (PORT_OPEN_TIMEOUT_MS) before the
  // honest routing appears.
  await waitFor(() => /did not respond/.test(byId('fwWizardStep').textContent), {
    timeoutMs: 20000,
    what: 'the bounded stall to surface as picker-step guidance',
  });

  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.match(
    history,
    /did not respond/,
    'the stall message with its replug + Continue guidance is on the record',
  );
  assert.doesNotMatch(history, /Firmware update failed:/, 'a pre-START stall is not a failure');
  assert.equal(
    byId('btnFwContinue').hidden,
    false,
    'the step names a Continue button that actually exists on the panel — the guidance is followable',
  );
  assert.equal(
    byId('fwWizard').getAttribute('data-state'),
    'active',
    'the wizard is still on its picker step, not a failure panel',
  );
  click('btnFwCancel');
  await flush();
  await app.disconnect({ quiet: true });
});

test('wizard: a foreign serial device is never touched with the restart signal', async () => {
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
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;

  // A foreign device (different vendor) that the user picked by mistake: it
  // must NOT be treated as the still-running LipSync (no 1200-baud pulse) —
  // instead the DFU probe rejects it with the honest message.
  const foreignOpens = [];
  const foreignPort = {
    async open(opts) {
      foreignOpens.push(opts?.baudRate ?? '?');
    },
    async close() {},
    async setSignals() {
      foreignOpens.push('signals');
    },
    getInfo: () => ({ usbVendorId: 0x2341, usbProductId: 0x0043 }),
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
  };
  configureDfuPortSource({ serial: { getPorts: async () => [], requestPort: async () => foreignPort } });
  const appPort = makeTouchedAppPort();
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await wizardDone;
  click('btnFwContinue');
  await sleep(1200);

  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.doesNotMatch(history, /running LipSync, not its update loader/, 'no self-heal re-touch of a foreign device');
  assert.match(history, /Flashing firmware 4\.2\.0/, 'the flow went straight to the probe');
  assert.match(byId('fwWizardStep').textContent, /Contacting the device bootloader/, 'the probe is running against it');
  assert.deepEqual(
    foreignOpens,
    [115200],
    'only the probe open ever touched the foreign device — no 1200-baud restart signal was sent',
  );
  click('btnFwCancel');
  // Cancel settles the in-flight flash's wind-down before closing the panel
  // (the probe ACK wait unwinds through its abort checkpoint) — wait for the
  // close, not a fixed microtask flush.
  await waitFor(() => byId('fwWizard').hidden === true, {
    timeoutMs: 4000,
    what: 'the cancelled attempt to close cleanly',
  });
  const afterHistory = logMod.getLogHistory().slice(histStart).join('\n');
  assert.match(
    afterHistory,
    /Update stopped before anything was written|Update cancelled/,
    'the attempt closes cleanly',
  );
  assert.equal(byId('fwWizard').hidden, true);
  await app.disconnect({ quiet: true });
});

// ---- Round-2 remediation: probe-based liveness, SR cancel windows, STOP truth --

test('wizard: an unplugged device with a stale bootloader grant is not reported as restarted', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;

  // A repeat updater's bus: yesterday's bootloader grant still lists in
  // getPorts() with its cached identity (native SerialPort objects expose no
  // liveness property — this stub deliberately models that), but every open
  // on it fails gone-style because the device behind it left. The app port
  // is equally gone (the cable was knocked out during the restart).
  const goneError = () => {
    const e = new Error('The port requested does not exist or is no longer available.');
    e.name = 'NotFoundError';
    return e;
  };
  const departedBootGrant = {
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x0045 }),
    async open() {
      throw goneError();
    },
    async close() {},
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
  };
  const appPort = {
    async open() {
      throw goneError();
    },
    async close() {},
    async setSignals() {},
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8045 }),
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
  };
  configureDfuPortSource({
    serial: { getPorts: async () => [departedBootGrant], requestPort: async () => appPort },
  });
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await wizardDone;

  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.doesNotMatch(
    history,
    /Device restarted into update mode/,
    'a departed grant proves nothing — the unplug is never claimed as a restart',
  );
  assert.match(history, /not responding on the bus/, 'the honest unplug diagnosis is logged');
  assert.match(
    byId('fwWizardStep').textContent,
    /plugged in securely/,
    'the step points at the USB connection, not a fictional update mode',
  );
  click('btnFwCancel');
  await flush();
  assert.equal(byId('fwWizard').hidden, true);
  await app.disconnect({ quiet: true });
});

test('wizard: cancelling while the SR ack is pending stops the update without a false claim', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;

  // The device acks SR,1:1 only after 300 ms — slow, but within the (shrunk
  // to 400 ms) reset timeout. The cancel lands at ~60 ms, after the SR bytes
  // were written but before the ack: the device WILL reboot, so the cancel
  // message must hedge instead of promising nothing happens.
  const sent = [];
  const appPort = {
    async open(opts) {
      sent.push('open:' + (opts?.baudRate ?? '?'));
      if (sent.filter((s) => s.startsWith('open:')).length >= 3) {
        const e = new Error('device no longer available');
        e.name = 'NotFoundError';
        throw e;
      }
    },
    async close() {},
    async setSignals() {},
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8045 }),
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: {
      getWriter: () => ({
        write(bytes) {
          const text = Buffer.from(bytes).toString('utf8');
          sent.push(text);
          if (text === 'SETTINGS') setTimeout(() => app.handleLine('SUCCESS,0:SETTINGS'), 2);
          else if (text === 'SR,1:1') setTimeout(() => app.handleLine('SUCCESS,0:SR,1:1'), 300);
        },
        releaseLock() {},
      }),
    },
  };
  const sim = createBootloaderSim();
  configureDfuPortSource({ serial: { getPorts: async () => [sim.port], requestPort: async () => sim.port } });
  const { serialSession } = await import('../app/js/serial/session.js');
  testHooks.attach(appPort, appPort.writable.getWriter());
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await sleep(60); // inside the SR command: bytes written, ack pending
  click('btnFwCancel');
  await wizardDone;
  await sleep(400); // let the zombie SR continuation finish (ack + teardown)

  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.ok(
    sent.includes('SR,1:1'),
    'sanity: the SR write really happened before the cancel (the honest hard case)',
  );
  assert.match(
    history,
    /may still restart on its own|restarts on its own/,
    'the cancel message hedges about the in-flight reboot',
  );
  assert.doesNotMatch(history, /Nothing was changed\./, 'the flat nothing-changed claim is not used');
  assert.doesNotMatch(history, /Update failed:/, 'the cancel is not reopened as a failure');
  assert.equal(byId('fwWizard').hidden, true);
  assert.equal(serialSession.port, null, 'the session was torn down quietly by the zombie continuation');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('wizard: cancelling after the SR ack says plainly that the device restarts', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;

  const appPort = {
    async open() {},
    async close() {},
    async setSignals() {},
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8045 }),
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: {
      getWriter: () => ({
        write(bytes) {
          const text = Buffer.from(bytes).toString('utf8');
          if (text === 'SETTINGS') setTimeout(() => app.handleLine('SUCCESS,0:SETTINGS'), 2);
          else if (text === 'SR,1:1') setTimeout(() => app.handleLine('SUCCESS,0:SR,1:1'), 2);
        },
        releaseLock() {},
      }),
    },
  };
  configureDfuPortSource({ serial: { getPorts: async () => [], requestPort: async () => appPort } });
  const { serialSession } = await import('../app/js/serial/session.js');
  testHooks.attach(appPort, appPort.writable.getWriter());
  setLoadedValues();

  // The reboot settle is observable: shrink it, wait past the SR ack, and
  // cancel INSIDE the settle window — the ack was already seen, so the
  // message may state the restart as fact.
  fw.setSrRebootSettleForTests(400);
  try {
    const wizardDone = fw.startFirmwareUpdate();
    await flush();
    click('confirmOk');
    await sleep(120); // the SR ack resolves in ~4 ms; the settle has ~300 ms left
    click('btnFwCancel');
    await wizardDone;

    const history = logMod.getLogHistory().slice(histStart).join('\n');
    assert.match(
      history,
      /Update cancelled\. The restart signal was already sent — the LipSync restarts on its own/,
      'the message states the certain reboot as fact',
    );
    assert.equal(byId('fwWizard').hidden, true);
    assert.equal(serialSession.port, null);
  } finally {
    fw.setSrRebootSettleForTests(20);
    await app.disconnect({ quiet: true });
    testHooks.detach();
  }
});

test('wizard: a cancel during the SR handshake leaves the session intact and never sends SR', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;

  // The device is slow to even ack the SETTINGS handshake (300 ms): the
  // cancel lands inside it, and the abort wiring must stop the SR write from
  // ever happening — the session is left alive and untouched.
  const sent = [];
  const appPort = {
    async open() {},
    async close() {},
    async setSignals() {},
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8045 }),
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: {
      getWriter: () => ({
        write(bytes) {
          const text = Buffer.from(bytes).toString('utf8');
          sent.push(text);
          if (text === 'SETTINGS') setTimeout(() => app.handleLine('SUCCESS,0:SETTINGS'), 300);
        },
        releaseLock() {},
      }),
    },
  };
  configureDfuPortSource({ serial: { getPorts: async () => [], requestPort: async () => appPort } });
  const { serialSession } = await import('../app/js/serial/session.js');
  testHooks.attach(appPort, appPort.writable.getWriter());
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await sleep(60); // inside the pending SETTINGS handshake, SR not yet written
  click('btnFwCancel');
  await wizardDone;
  await sleep(350); // the handshake ack lands here — the zombie must not act on it

  assert.ok(sent.includes('SETTINGS'), 'sanity: the cancel landed during the handshake');
  assert.ok(!sent.includes('SR,1:1'), 'the soft-reset command was never written after the cancel');
  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.match(history, /Update cancelled/, 'the cancel is logged');
  assert.doesNotMatch(history, /Update failed:/, 'no failure panel was raised');
  assert.notEqual(serialSession.port, null, 'the session survives untouched — no zombie teardown ran');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('wizard: a cancel inside the final STOP window preserves the maybe-finished update', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;

  // The STOP frame's ACK is delayed (500 ms): the cancel lands after the
  // STOP bytes were written but before the ACK, exactly the window where the
  // bootloader finishes the update on its own. The device DID receive STOP
  // (the sim activates), so "stopped partway — use Recover" would be a lie:
  // the pending entry must keep the flashStarted truth for the reconnect.
  const sim = createBootloaderSim({ stopAckDelayMs: 500 });
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
  await waitFor(() => /Finishing write/.test(byId('fwWizardStep').textContent), {
    what: 'the flash to reach the STOP exchange',
  });
  click('btnFwCancel');
  await waitFor(() => byId('fwWizard').hidden === true, {
    timeoutMs: 4000,
    what: 'the cancel to settle the STOP window',
  });
  await sleep(300); // the delayed ACK fires inside the now-cancelled flash

  assert.equal(sim.state.activated, true, 'the bootloader completed the update on its own');
  const pending = fw.readPending();
  assert.ok(pending, 'the pending entry survives the cancel');
  assert.equal(pending.installed, false, 'the completion is not asserted — only the reconnect can verify it');
  assert.equal(pending.flashStarted, true, 'the flashStarted truth is preserved for the finisher');
  assert.equal(pending.target, '4.2.0');
  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.match(history, /may or may not have completed/, 'the hedge wording is used for the raced STOP');
  assert.doesNotMatch(history, /Update failed:/, 'no failure panel was raised');
  assert.doesNotMatch(history, /now in its update loader/, 'the stranded claim is not made for a completed update');

  // The reconnect settles the truth: the device runs the target version, so
  // the finisher verifies and restores.
  const sentVerify = [];
  const writerVerify = {
    write(bytes) {
      const text = Buffer.from(bytes).toString('utf8');
      sentVerify.push(text);
      if (text === 'SETTINGS') {
        setTimeout(() => app.handleLine('SUCCESS,0:SETTINGS'), 2);
        return;
      }
      const m = text.match(/^([A-Z]{2}),1:(.+)$/);
      if (m) setTimeout(() => app.handleLine(`SUCCESS,0:${m[1]},1:${m[2]}`), 2);
    },
  };
  testHooks.attach({ simulated: true }, writerVerify);
  serialSession.port = { simulated: true };
  setLoadedValues({ version: '4.2.0' });
  await fw.afterDeviceLoad();
  await sleep(120);

  assert.equal(byId('fwWizardStep').textContent, 'Firmware update complete.');
  assert.deepEqual(
    sentVerify.filter((t) => /,1:/.test(t)),
    ['SS,1:5', 'SL,1:5', 'ST,1:3.00', 'PT,1:3.00', 'IZ,1:0.07', 'OZ,1:0.95', 'SM,1:1', 'LM,1:1', 'LL,1:5'],
    'the reconnect verified the completed update and restored the settings',
  );
  assert.equal(fw.readPending(), null, 'the pending entry completes and clears');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('wizard: a STOP whose ACK is lost at the detach hedges instead of declaring an interruption', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;

  // Hardware-shaped departure, host's worst case: the device accepted the
  // STOP (it activates and reboots) but the ACK never crosses the wire —
  // and the departing port RESOLVES every write into a dying buffer, so
  // the host's retransmits all "succeed" and nothing is ever acked. The
  // pure ACK timeout that results is NOT proof the flash failed: the
  // honest answer is the hedge, never "interrupted while memory was
  // rewritten".
  const sim = createBootloaderSim({ loseStopAck: true, departedWritesResolve: true });
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
  await waitFor(() => /finishing when the connection dropped/.test(byId('fwWizardStep').textContent), {
    timeoutMs: 25000,
    what: 'the STOP window to resolve as the hedge (every retransmit "succeeds" into the dead buffer, so all three ACK waits — ~15 s — burn first)',
  });

  assert.equal(sim.state.activated, true, 'the update actually completed on the device');
  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.doesNotMatch(history, /Firmware update failed:/, 'the completed update is not declared a failure');
  assert.doesNotMatch(history, /interrupted while the device.s memory was being rewritten/, 'the stranded claim is never made');
  assert.match(history, /may have completed/, 'the hedge is logged honestly');
  assert.equal(fw.readPending()?.flashStarted, true, 'the flashStarted truth is kept for the reconnect');
  click('btnFwCancel');
  await flush();
  assert.match(
    logMod.getLogHistory().slice(histStart).join('\n'),
    /may or may not have completed/,
    'the hedge cancel keeps its wording',
  );
  assert.equal(fw.readPending()?.flashStarted, true, 'the hedge cancel preserves the pending entry');
  await app.disconnect({ quiet: true });
});

test('wizard: a cancel after the STOP ack still arms the finished update for the reconnect', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;

  // The other half of the STOP window: the cancel lands AFTER the ACK (the
  // device accepted and is rebooting into the new firmware) but before the
  // flash's wrap-up returns. The flash RESOLVES despite the abort — the
  // update unambiguously finished — so the pending entry must be armed as
  // installed, the message must say so, and the reconnect must verify and
  // restore rather than silently dropping the snapshot.
  const sim = createBootloaderSim({ stopAckDelayMs: 300 });
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
  await waitFor(() => /Finishing write/.test(byId('fwWizardStep').textContent), {
    what: 'the flash to reach the STOP exchange',
  });
  await sleep(420); // the ACK lands ~300 ms in; the wrap-up runs until ~505 ms
  click('btnFwCancel');
  await waitFor(() => byId('fwWizard').hidden === true, {
    timeoutMs: 4000,
    what: 'the cancel to settle the wrapping-up flash',
  });
  await sleep(200);

  assert.equal(sim.state.activated, true, 'the update completed on the device');
  const pending = fw.readPending();
  assert.ok(pending, 'the pending entry survives the cancel');
  assert.equal(pending.installed, true, 'a flash that resolved despite the cancel is armed as installed');
  assert.equal(pending.target, '4.2.0');
  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.match(history, /finished just as it was cancelled/, 'the honest completed-anyway log is present');
  assert.match(
    history,
    /Update cancelled — the firmware update finished anyway/,
    'the cancel message owns the completion',
  );
  assert.doesNotMatch(history, /now in its update loader/, 'no stranded claim for a finished update');
  assert.doesNotMatch(history, /Update failed:/, 'no failure panel was raised');

  // The reconnect verifies and restores.
  const sentVerify2 = [];
  const writerVerify2 = {
    write(bytes) {
      const text = Buffer.from(bytes).toString('utf8');
      sentVerify2.push(text);
      if (text === 'SETTINGS') {
        setTimeout(() => app.handleLine('SUCCESS,0:SETTINGS'), 2);
        return;
      }
      const m = text.match(/^([A-Z]{2}),1:(.+)$/);
      if (m) setTimeout(() => app.handleLine(`SUCCESS,0:${m[1]},1:${m[2]}`), 2);
    },
  };
  testHooks.attach({ simulated: true }, writerVerify2);
  serialSession.port = { simulated: true };
  setLoadedValues({ version: '4.2.0' });
  await fw.afterDeviceLoad();
  await sleep(120);
  assert.equal(byId('fwWizardStep').textContent, 'Firmware update complete.');
  assert.equal(fw.readPending(), null);
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('wizard: a cancelled erase-wait flash is settled before a new flash claims the port', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;

  // A big-ish image stretches the erase dwell; the cancel lands inside it.
  // The user immediately starts a new attempt: the interrupted device re-
  // enumerates into its bootloader (a replug — a fresh bootloader with a
  // fresh transport counter; the cancelled one keeps its counter and would
  // reject a re-started probe), and the new flash opens the fresh port. The
  // first flash's teardown close must be settled BEFORE that open, or the
  // zombie close kills the new flash's link.
  const sim = createBootloaderSim();
  const portEvents = [];
  const instrument = (targetPort, tag) => {
    const baseOpen = targetPort.open.bind(targetPort);
    targetPort.open = async (opts) => {
      portEvents.push(`${tag}:open`);
      return baseOpen(opts);
    };
    const baseClose = targetPort.close.bind(targetPort);
    targetPort.close = async () => {
      portEvents.push(`${tag}:close:start`);
      await sleep(80); // a slow-but-healthy teardown close
      portEvents.push(`${tag}:close:done`);
      return baseClose();
    };
  };
  instrument(sim.port, 'A');
  configureDfuPortSource({ serial: { getPorts: async () => [sim.port], requestPort: async () => sim.port } });
  const appPort = makeTouchedAppPort();
  const { serialSession } = await import('../app/js/serial/session.js');
  serialSession.port = appPort;
  setLoadedValues();

  const firstDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await firstDone;
  click('btnFwContinue');
  await waitFor(() => /Preparing device flash memory/.test(byId('fwWizardStep').textContent), {
    what: 'the flash to enter its erase dwell',
  });
  click('btnFwCancel');
  await waitFor(() => byId('fwWizard').hidden === true, {
    timeoutMs: 4000,
    what: 'the cancel to settle the winding-down flash',
  });

  // The replug: the device re-enumerates into a fresh bootloader. Its port
  // is the one the next Continue flashes — the cancelled flash's teardown
  // close is still racing on the OLD port object.
  const sim2 = createBootloaderSim();
  instrument(sim2.port, 'B');
  configureDfuPortSource({ serial: { getPorts: async () => [sim2.port], requestPort: async () => sim2.port } });
  serialSession.port = makeTouchedAppPort();
  setLoadedValues();
  const secondDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await secondDone;
  click('btnFwContinue');
  await waitFor(() => /installed|finishing when the connection dropped/.test(byId('fwWizardStep').textContent), {
    what: 'the second flash to complete on the settled port',
  });
  assert.equal(sim2.state.activated, true, 'the second flash completed');

  // The ordering proof: no port open may ever interleave an in-flight close
  // — the zombie teardown from flash A must be fully settled before the
  // probe/flash opens of session B touch anything.
  let sawCloseStart = false;
  for (const ev of portEvents) {
    if (ev.endsWith(':close:start')) sawCloseStart = true;
    else if (ev.endsWith(':close:done')) sawCloseStart = false;
    else if (ev.endsWith(':open'))
      assert.equal(sawCloseStart, false, `no flash open ever raced an in-flight teardown close (${ev})`);
  }
  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.doesNotMatch(history, /did not respond as an update loader/, 'the zombie close never killed the new flash');
  assert.doesNotMatch(history, /Firmware update failed:/, 'no failure panel was raised');
  await app.disconnect({ quiet: true });
});

test('wizard: the SR reboot departure never trips the read loop recovery chatter', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;

  // The full production stack for once: the REAL connect() opens the port
  // and starts the REAL read loop; the device then acks SR,1:1 and its USB
  // departure rejects the read loop's parked read — exactly the instant the
  // wizard's `disconnecting` mute exists for. Without the mute the loop
  // would announce "Connection lost — attempting to recover…" and try to
  // re-open the port mid-wizard; with it, the departure is silent and the
  // wizard proceeds to the touch.
  const { connect, configureConnection } = await import('../app/js/serial/connection.js');
  const { configureSerialPortSource } = await import('../app/js/serial/transport.js');
  configureConnection({ loadDeviceInfo: async () => {}, clearHealthResults: () => {} });

  let sawSr = false;
  let rejectParkedRead = null;
  const openLog = [];
  const sharedReader = {
    read() {
      // A read parked before the departure must REJECT when the device
      // leaves (hardware: the OS fails the pending read at detach) — a stub
      // that only rejects future calls never exercises the read loop's
      // departure handling at all.
      if (sawSr) return Promise.reject(new Error('Failed to execute "read": The device was disconnected.'));
      return new Promise((_res, rej) => {
        rejectParkedRead = rej;
      });
    },
    async cancel() {},
    releaseLock() {},
  };
  const appPort = {
    async open(opts) {
      openLog.push(opts?.baudRate ?? '?');
      if (openLog.length >= 3) {
        const e = new Error('device no longer available');
        e.name = 'NotFoundError';
        throw e;
      }
    },
    async close() {},
    async setSignals() {},
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8045 }),
    readable: { getReader: () => sharedReader },
    writable: {
      getWriter: () => ({
        write(bytes) {
          const text = Buffer.from(bytes).toString('utf8');
          if (text === 'SETTINGS') setTimeout(() => app.handleLine('SUCCESS,0:SETTINGS'), 2);
          else if (text === 'SR,1:1') {
            sawSr = true;
            rejectParkedRead?.(new Error('Failed to execute "read": The device was disconnected.'));
            setTimeout(() => app.handleLine('SUCCESS,0:SR,1:1'), 2);
          }
        },
        releaseLock() {},
      }),
    },
  };
  configureSerialPortSource({ requestPort: async () => appPort });
  configureDfuPortSource({ serial: { getPorts: async () => [], requestPort: async () => appPort } });
  const { serialSession } = await import('../app/js/serial/session.js');
  await connect();
  assert.notEqual(serialSession.port, null, 'sanity: the real connect() opened the session');
  setLoadedValues();

  const wizardDone = fw.startFirmwareUpdate();
  await flush();
  click('confirmOk');
  await wizardDone;

  const history = logMod.getLogHistory().slice(histStart).join('\n');
  assert.match(history, /rebooting \(soft reset\)/, 'the SR restart ran over the live session');
  assert.doesNotMatch(history, /Connection lost/, 'the departure never announces a lost connection');
  assert.doesNotMatch(history, /attempting to recover/, 'the read loop never tries to recover mid-wizard');
  assert.doesNotMatch(history, /Recovery failed/, 'no bogus recovery failure is logged');
  assert.match(
    byId('fwWizardStep').textContent,
    /Select the update port/,
    'the wizard proceeded to the picker step through the silent departure',
  );
  assert.equal(serialSession.port, null, 'the session was torn down by the soft-reset path');
  click('btnFwCancel');
  await flush();
  await app.disconnect({ quiet: true });
});

test('the SR reboot settle is pinned at its production value and actually observed', async () => {
  // The constant: the settle must cover the device's 1–2 s re-enumeration
  // (ground truth) with margin — pinned so nobody tightens it silently.
  assert.equal(fw.SR_REBOOT_SETTLE_MS, 3000, 'the production SR reboot settle stays generous');
  assert.equal(fw.TOUCH_AFTER_CLOSE_SETTLE_MS, 2000, 'the production post-close settle stays generous');

  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };

  // The behavior: the first touch open must wait out the settle after the
  // SR teardown, exactly like the close-then-touch settle is observed.
  const times = [];
  let openCount = 0;
  const appPort = {
    async open(opts) {
      openCount++;
      // Open #1: the 1200-baud signal (succeeds). Open #2: the verify probe
      // (the device has left app mode — fails gone, unrecorded).
      if (openCount >= 2) {
        const e = new Error('device no longer available');
        e.name = 'NotFoundError';
        throw e;
      }
      times.push(['open', Date.now(), opts?.baudRate ?? null]);
    },
    async close() {
      times.push(['close', Date.now(), null]);
    },
    async setSignals() {},
    getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8045 }),
    readable: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }) },
    writable: {
      getWriter: () => ({
        write(bytes) {
          const text = Buffer.from(bytes).toString('utf8');
          if (text === 'SETTINGS') setTimeout(() => app.handleLine('SUCCESS,0:SETTINGS'), 2);
          else if (text === 'SR,1:1') setTimeout(() => app.handleLine('SUCCESS,0:SR,1:1'), 2);
        },
        releaseLock() {},
      }),
    },
  };
  configureDfuPortSource({ serial: { getPorts: async () => [], requestPort: async () => appPort } });
  testHooks.attach(appPort, appPort.writable.getWriter());
  setLoadedValues();

  fw.setSrRebootSettleForTests(1500);
  try {
    const wizardDone = fw.startFirmwareUpdate();
    await flush();
    click('confirmOk');
    await wizardDone;

    const close = times.find(([k]) => k === 'close');
    const touch = times.find(([k, , b]) => k === 'open' && b === 1200);
    assert.ok(close && touch, 'the SR teardown closed the port and the touch then opened it at 1200 baud');
    assert.ok(
      touch[1] - close[1] >= 1400,
      `the 1200-baud signal waits out the reboot settle (gap ${touch[1] - close[1]}ms)`,
    );
    assert.deepEqual(
      times.filter(([k]) => k === 'open').map((t) => t[2]),
      [1200],
      'the only pre-verify open is the 1200-baud signal — no wake pulse after SR',
    );
    click('btnFwCancel');
    await flush();
  } finally {
    fw.setSrRebootSettleForTests(20);
    await app.disconnect({ quiet: true });
    testHooks.detach();
  }
});

test('reload: a real interrupted flash seeds the production flashStarted entry and recovers', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };
  const logMod = await import('../app/js/services/log.js');
  const histStart = logMod.getLogHistory().length;

  // A REAL flash is interrupted past START (a write failure mid-DATA): the
  // production path writes the flashStarted pending entry. Then the page is
  // "reloaded" (in-memory cache dropped, sessionStorage alive) and the user
  // reconnects to a device the bootloader finished on its own — the full
  // producer → storage → reload → finisher chain must hold.
  const sim = createBootloaderSim();
  const baseWriter = sim.port.writable.getWriter();
  let writes = 0;
  sim.port.writable = {
    getWriter: () => ({
      async write(bytes) {
        writes++;
        if (writes >= 5) throw new Error('The link died mid-transfer');
        return baseWriter.write(bytes);
      },
      releaseLock() {},
    }),
  };
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
  await waitFor(() => /Update failed/.test(byId('fwWizardStep').textContent), {
    what: 'the interrupted flash failure panel',
  });
  const stored = JSON.parse(sessionStorage.getItem('lipsync-fw-pending') ?? 'null');
  assert.equal(stored?.flashStarted, true, 'the production path stored flashStarted on disk');
  assert.equal(stored?.installed, false);
  assert.equal(stored?.target, '4.2.0');
  // NB: the failure panel is NOT dismissed — the modeled reload is the page
  // dying with the panel up (a Cancel would wipe the pending entry by
  // design; the user who reloads instead keeps it).

  // The "reload": the in-memory cache dies, the storage lives.
  fw.resetPendingMemoryForTests();
  assert.equal(fw.readPending()?.flashStarted, true, 'the reloaded page reads the pending entry from storage');

  // The reconnect: the bootloader finished the update on its own.
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
  serialSession.port = { simulated: true };
  setLoadedValues({ version: '4.2.0' });
  await fw.afterDeviceLoad();
  await sleep(120);

  assert.match(
    logMod.getLogHistory().slice(histStart).join('\n'),
    /appears to have completed on its own/,
    'the reload-recovery branch recognized the self-finished update',
  );
  assert.equal(byId('fwWizardStep').textContent, 'Firmware update complete.');
  assert.equal(fw.readPending(), null, 'the pending update completes and clears');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('pending panel: Recover stays reachable from a sentinel panel and takes over cleanly', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };

  // The sentinel panel (a post-reload verify panel with no live wizard):
  // when the stranded marker is set (the connect guard sets it when the
  // user picks the update loader), Recover must be clickable WHILE the
  // panel is up — before the DOM fix the button lived inside #fwActionsRow,
  // which the panel hides, so the wizard's yield-to-Recover machinery was
  // unreachable from the UI.
  const { serialSession } = await import('../app/js/serial/session.js');
  testHooks.attach({ simulated: true }, { write() {} });
  serialSession.port = { simulated: true };
  fw.writePending({ target: '4.2.0', installed: true, snapshot: { SS: '5' } });
  byId('version').textContent = '—';
  await fw.afterDeviceLoad();
  await sleep(60);

  assert.equal(byId('fwWizard').hidden, false, 'the pending panel is showing');
  fw.setBootloaderStranded(); // what the connect guard does on a bootloader pick
  assert.equal(
    byId('btnRecoverDevice').hidden,
    false,
    'Recover is clickable while the sentinel panel is up (it lives outside fwActionsRow)',
  );

  byId('btnRecoverDevice').dispatch('click');
  await waitFor(() => /in update mode/.test(byId('fwWizardStep').textContent), {
    what: 'the recovery wizard to take over from the sentinel',
  });
  assert.equal(fw.readPending(), null, 'the abandoned restore entry was yielded cleanly');
  assert.match(byId('fwWizardStep').textContent, /Click Continue and pick the update loader/);
  fw.clearBootloaderStranded();
  click('btnFwCancel');
  await flush();
  assert.equal(byId('fwWizard').hidden, true);
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('wizard: the session buttons stay locked through a dismissed picker', async () => {
  sessionStoreSet('lipsync-fw-pending', null);
  seedFirmwareCache(
    {
      firmwareVersion: '4.2.0',
      files: { dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 10, sha256: FW_ZIP_SHA256 } },
    },
    'V4.2.0',
  );
  globalThis.fetch = async (url) =>
    String(url).includes('/git/trees/')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ tree: [{ path: 'LipSync_Firmware_4.2.0_dfu.zip', sha: 'fwblob' }] }),
        }
      : {
          ok: true,
          status: 200,
          json: async () => ({ encoding: 'base64', content: Buffer.from(FW_ZIP_BYTES).toString('base64') }),
        };

  // The wizard owns the flow for its lifetime: a Connect click mid-flow
  // would derail the choreography, so the buttons must stay locked through
  // the picker step — a dismissed picker returns to the same locked step,
  // and only the reconnect/cancel/failure transitions hand them back.
  configureDfuPortSource({
    serial: {
      getPorts: async () => [],
      requestPort: async () => {
        const e = new Error('The user did not select a port.');
        e.name = 'NotFoundError';
        throw e;
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
  assert.equal(byId('btnConnect').disabled, true, 'Connect is locked while the wizard owns the flow');
  click('btnFwContinue'); // picker dismissed
  await flush();
  assert.match(byId('fwWizardStep').textContent, /No update port was selected/);
  assert.equal(
    byId('btnConnect').disabled,
    true,
    'a dismissed picker does not unlock Connect — the wizard still owns the flow',
  );
  click('btnFwCancel');
  await flush();
  assert.equal(byId('fwWizard').hidden, true);
  assert.equal(byId('btnConnect').disabled, false, 'the cancel hands the buttons back to the session state');
  await app.disconnect({ quiet: true });
});
