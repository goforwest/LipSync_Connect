// Firmware update check (services/firmware-update.js): version parsing and
// comparison, the GitHub release→manifest fetch flow, status rendering for
// update-available / up-to-date / no-manifest / offline, and the time-based
// auto-check cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { storage, document } = installGatingDom();
const fw = await import('../app/js/services/firmware-update.js');
const { checkForFirmwareUpdate, resetFirmwareUpdateUi } = fw;

const MANIFEST = (firmwareVersion) => ({
  firmwareVersion,
  files: {
    dfu: { fileName: `LipSync_Firmware_${firmwareVersion}_dfu.zip`, size: 257566, sha256: 'a'.repeat(64) },
    uf2: { fileName: `LipSync_Firmware_${firmwareVersion}.uf2`, size: 513536, sha256: 'b'.repeat(64) },
  },
});
const releaseWithManifest = (version) => ({
  tag_name: 'V' + version,
  html_url: 'https://github.com/makersmakingchange/LipSync/releases/tag/V' + version,
  assets: [{ name: 'firmware-manifest.json', browser_download_url: 'https://github.com/x/firmware-manifest.json' }],
});

let fetchCalls = [];
let fetchImpl = async () => {
  throw new Error('network unavailable');
};
globalThis.fetch = async (url, opts) => {
  fetchCalls.push(String(url));
  return fetchImpl(url, opts);
};

const status = () => document.getElementById('fwUpdateStatus').textContent;
const statusState = () => document.getElementById('fwUpdateStatus').getAttribute('data-state');
const latest = () => document.getElementById('fwLatestVersion').textContent;
const current = () => document.getElementById('fwCurrentVersion').textContent;
const updateBtnHidden = () => document.getElementById('btnStartUpdate').hidden;

function setDeviceVersion(v) {
  document.getElementById('version').textContent = v;
}

async function flush() {
  await new Promise((r) => setTimeout(r, 10));
}

test('parseVersion handles v-prefixed, short, and invalid strings', () => {
  assert.deepEqual(fw.parseVersion('4.1.0'), [4, 1, 0]);
  assert.deepEqual(fw.parseVersion('V4.1.1'), [4, 1, 1]);
  assert.deepEqual(fw.parseVersion('4.1'), [4, 1, 0]);
  assert.deepEqual(fw.parseVersion('4'), [4, 0, 0]);
  assert.equal(fw.parseVersion('—'), null);
  assert.equal(fw.parseVersion(''), null);
  assert.equal(fw.parseVersion(null), null);
});

test('compareVersions orders versions and rejects garbage', () => {
  assert.equal(fw.compareVersions('4.1.0', '4.2.0'), -1);
  assert.equal(fw.compareVersions('4.2.0', '4.1.0'), 1);
  assert.equal(fw.compareVersions('4.1.0', '4.1.0'), 0);
  assert.equal(fw.compareVersions('v4.1', '4.1.0'), 0);
  assert.equal(fw.compareVersions('4.1', '4.1.1'), -1);
  assert.equal(fw.compareVersions('garbage', '4.1.0'), null);
});

test('check finds a newer release and offers the update', async () => {
  storage.clear();
  fetchCalls = [];
  fetchImpl = async (url) =>
    url.endsWith('firmware-manifest.json')
      ? { ok: true, json: async () => MANIFEST('4.2.0') }
      : { ok: true, json: async () => releaseWithManifest('4.2.0') };
  setDeviceVersion('4.1.0');
  await checkForFirmwareUpdate();
  await flush();
  assert.equal(current(), '4.1.0');
  assert.equal(latest(), '4.2.0');
  assert.match(status(), /Update available: 4\.2\.0/);
  assert.equal(updateBtnHidden(), false);
  assert.equal(document.getElementById('fwTargetVersion').textContent, '4.2.0');
  assert.equal(document.getElementById('fwNotesLink').hidden, false);
  assert.equal(document.getElementById('fwNotesLink').getAttribute('href'), 'https://github.com/makersmakingchange/LipSync/releases/tag/V4.2.0');
  assert.equal(document.getElementById('fwNotesLink').textContent, 'What\u2019s new in 4.2.0');
  assert.equal(statusState(), 'available');
  assert.equal(document.getElementById('fwLatestVersion').classList.contains('fw-new'), true);
  assert.equal(fetchCalls.length, 2, 'release API then manifest asset');
});

test('up-to-date devices get a calm status and no update button', async () => {
  storage.clear();
  fetchImpl = async (url) =>
    url.endsWith('firmware-manifest.json')
      ? { ok: true, json: async () => MANIFEST('4.1.0') }
      : { ok: true, json: async () => releaseWithManifest('4.1.0') };
  setDeviceVersion('4.1.0');
  await checkForFirmwareUpdate();
  await flush();
  assert.match(status(), /up to date/);
  assert.equal(statusState(), 'ok');
  assert.equal(updateBtnHidden(), true);
  assert.equal(document.getElementById('fwLatestVersion').classList.contains('fw-new'), false);
});

test('a release without a manifest asset reads as unknown, not an error', async () => {
  storage.clear();
  fetchImpl = async () => ({ ok: true, json: async () => ({ tag_name: 'V4.1.1', html_url: 'x', assets: [] }) });
  setDeviceVersion('4.1.0');
  await checkForFirmwareUpdate();
  await flush();
  assert.equal(latest(), 'Unknown');
  assert.match(status(), /No published firmware information yet/);
  assert.equal(statusState(), 'unknown');
  assert.equal(updateBtnHidden(), true);
});

test('offline failures surface a readable status without throwing', async () => {
  storage.clear();
  fetchImpl = async () => {
    throw new Error('TypeError: Failed to fetch');
  };
  setDeviceVersion('4.1.0');
  await checkForFirmwareUpdate();
  await flush();
  assert.match(status(), /Could not check for updates/);
  assert.equal(statusState(), 'warn');
  assert.equal(latest(), '—');
  assert.equal(updateBtnHidden(), true);
});

test('auto checks reuse the 6-hour cache instead of re-fetching', async () => {
  storage.clear();
  fetchCalls = [];
  fetchImpl = async (url) =>
    url.endsWith('firmware-manifest.json')
      ? { ok: true, json: async () => MANIFEST('4.2.0') }
      : { ok: true, json: async () => releaseWithManifest('4.2.0') };
  setDeviceVersion('4.1.0');
  await checkForFirmwareUpdate();
  await flush();
  assert.equal(fetchCalls.length, 2);
  await checkForFirmwareUpdate({ auto: true });
  await flush();
  assert.equal(fetchCalls.length, 2, 'cached entry served without network');
  assert.match(status(), /Update available/);
});

test('manual (forced) checks bypass the cache', async () => {
  storage.clear();
  fetchCalls = [];
  fetchImpl = async (url) =>
    url.endsWith('firmware-manifest.json')
      ? { ok: true, json: async () => MANIFEST('4.2.0') }
      : { ok: true, json: async () => releaseWithManifest('4.2.0') };
  setDeviceVersion('4.1.0');
  await checkForFirmwareUpdate();
  await flush();
  await checkForFirmwareUpdate();
  await flush();
  assert.equal(fetchCalls.length, 4, 'both checks hit the network');
});

test('resetFirmwareUpdateUi clears rows and hides actions', async () => {
  storage.clear();
  fetchImpl = async (url) =>
    url.endsWith('firmware-manifest.json')
      ? { ok: true, json: async () => MANIFEST('4.2.0') }
      : { ok: true, json: async () => releaseWithManifest('4.2.0') };
  setDeviceVersion('4.1.0');
  await checkForFirmwareUpdate();
  await flush();
  assert.equal(updateBtnHidden(), false);
  resetFirmwareUpdateUi();
  assert.equal(statusState(), null, 'reset clears the state pill');
  assert.equal(current(), '—');
  assert.equal(latest(), '—');
  assert.equal(status(), '');
  assert.equal(updateBtnHidden(), true);
  assert.equal(document.getElementById('fwNotesLink').hidden, true);
});

test('an unparsable device version reports a comparison problem, not a false update', async () => {
  storage.clear();
  fetchImpl = async (url) =>
    url.endsWith('firmware-manifest.json')
      ? { ok: true, json: async () => MANIFEST('4.2.0') }
      : { ok: true, json: async () => releaseWithManifest('4.2.0') };
  setDeviceVersion('ERR');
  await checkForFirmwareUpdate();
  await flush();
  assert.equal(latest(), '4.2.0');
  assert.match(status(), /Could not compare versions/);
  assert.equal(updateBtnHidden(), true);
});
