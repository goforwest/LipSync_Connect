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
});
// The manifest now rides the firmware-binaries branch and is read through
// the CORS-clean contents API as base64.
const contentsPayload = (json) => ({
  ok: true,
  status: 200,
  json: async () => ({ encoding: 'base64', content: Buffer.from(JSON.stringify(json)).toString('base64') }),
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

test('an available update badges the Firmware nav trigger, up-to-date clears it', async () => {
  storage.clear();
  const navBadge = () =>
    document.querySelector('.circle-trigger[data-section="sec-firmware"]')?.getAttribute('data-notify') ?? null;
  fetchImpl = async (url) =>
    url.includes('/contents/firmware-manifest.json')
      ? contentsPayload(MANIFEST('4.2.0'))
      : { ok: true, status: 200, json: async () => releaseWithManifest('4.2.0') };
  setDeviceVersion('4.1.0');
  await checkForFirmwareUpdate();
  await flush();
  assert.equal(navBadge(), 'firmware-update', 'the nav trigger carries the badge');

  // Up-to-date clears it.
  fetchImpl = async (url) =>
    url.includes('/contents/firmware-manifest.json')
      ? contentsPayload(MANIFEST('4.1.0'))
      : { ok: true, status: 200, json: async () => releaseWithManifest('4.1.0') };
  await checkForFirmwareUpdate();
  await flush();
  assert.equal(navBadge(), null, 'the badge clears when up to date');

  // The disconnect hook clears it too.
  fw.resetFirmwareUpdateUi();
  assert.equal(navBadge(), null, 'reset clears the badge');
});

test('GitHub rate limiting reads as a limit, not as offline', async () => {
  storage.clear();
  fetchImpl = async () => ({ ok: false, status: 403 });
  setDeviceVersion('4.1.0');
  await checkForFirmwareUpdate();
  await flush();
  assert.match(status(), /anonymous request limit/);
  assert.equal(statusState(), 'warn');
});

test('check finds a newer release and offers the update', async () => {
  storage.clear();
  fetchCalls = [];
  fetchImpl = async (url) =>
    url.includes('/contents/firmware-manifest.json')
      ? contentsPayload(MANIFEST('4.2.0'))
      : { ok: true, status: 200, json: async () => releaseWithManifest('4.2.0') };
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
    url.includes('/contents/firmware-manifest.json')
      ? contentsPayload(MANIFEST('4.1.0'))
      : { ok: true, status: 200, json: async () => releaseWithManifest('4.1.0') };
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
  fetchImpl = async (url) =>
    url.includes('/contents/firmware-manifest.json')
      ? { ok: false, status: 404 }
      : {
          ok: true,
          status: 200,
          json: async () => ({
            tag_name: 'V4.1.1',
            html_url: 'https://github.com/makersmakingchange/LipSync/releases/tag/V4.1.1',
          }),
        };
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

test('the release-API override redirects the check and bypasses the cache', async () => {
  storage.clear();
  try {
    localStorage.setItem('lipsync-fw-release-api', 'https://api.github.com/repos/goforwest/LipSync/releases/latest');
  } catch {}
  fetchCalls = [];
  fetchImpl = async (url) =>
    url.includes('goforwest')
      ? { ok: true, status: 200, json: async () => releaseWithManifest('4.2.0') }
      : url.includes('/contents/firmware-manifest.json')
        ? contentsPayload(MANIFEST('4.2.0'))
        : { ok: false, status: 404 };
  setDeviceVersion('4.1.0');
  // Seed a fresh upstream cache entry that would otherwise mask the override.
  try {
    localStorage.setItem(
      'lipsync-fw-check',
      JSON.stringify({
        manifest: MANIFEST('9.9.9'),
        tagName: 'V9.9.9',
        releaseUrl: null,
        repo: { owner: 'makersmakingchange', name: 'LipSync' },
        checkedAt: Date.now(),
      }),
    );
  } catch {}
  await checkForFirmwareUpdate({ auto: true });
  await flush();
  assert.ok(
    fetchCalls.some((u) => u.includes('goforwest')),
    'the check fetches the overridden release API',
  );
  assert.ok(
    !fetchCalls.some((u) => u.endsWith('/releases/latest') && !u.includes('goforwest')),
    'the upstream API is not consulted',
  );
  assert.match(status(), /Update available: 4\.2\.0/);
  assert.equal(latest(), '4.2.0');
});

test('auto checks reuse the 6-hour cache instead of re-fetching', async () => {
  storage.clear();
  fetchCalls = [];
  fetchImpl = async (url) =>
    url.includes('/contents/firmware-manifest.json')
      ? contentsPayload(MANIFEST('4.2.0'))
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
    url.includes('/contents/firmware-manifest.json')
      ? contentsPayload(MANIFEST('4.2.0'))
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
    url.includes('/contents/firmware-manifest.json')
      ? contentsPayload(MANIFEST('4.2.0'))
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
    url.includes('/contents/firmware-manifest.json')
      ? contentsPayload(MANIFEST('4.2.0'))
      : { ok: true, json: async () => releaseWithManifest('4.2.0') };
  setDeviceVersion('ERR');
  await checkForFirmwareUpdate();
  await flush();
  assert.equal(latest(), '4.2.0');
  assert.match(status(), /Could not compare versions/);
  assert.equal(updateBtnHidden(), true);
});
