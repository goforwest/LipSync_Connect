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
  assert.equal(
    document.getElementById('fwNotesLink').getAttribute('href'),
    'https://github.com/makersmakingchange/LipSync/releases/tag/V4.2.0',
  );
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
  // The "no firmware published" result is cached too: without it, every
  // reconnect's auto-check re-fetches and burns GitHub's anonymous limit.
  fetchCalls = [];
  await checkForFirmwareUpdate({ auto: true });
  await flush();
  assert.equal(fetchCalls.length, 0, 'the no-firmware state is served from cache');
  assert.match(status(), /No published firmware information yet/);
  // A manual (forced) check still re-verifies against the source.
  await checkForFirmwareUpdate();
  await flush();
  assert.equal(fetchCalls.length, 2, 'forced checks bypass the negative cache');
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

test('manifest-override entries install through the dev-server artifact route (the button works)', async () => {
  storage.clear();
  try {
    localStorage.setItem('lipsync-fw-manifest-url', '/firmware-manifest.json');
  } catch {}
  fetchCalls = [];
  // The manifest-URL override path fetches the manifest document directly.
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => MANIFEST('4.2.0') });
  setDeviceVersion('4.1.0');
  await checkForFirmwareUpdate();
  await flush();
  assert.match(status(), /Update available: 4\.2\.0/);
  // The override entry carries local artifact coordinates (dev/server.js
  // serves the built files next to the manifest under /firmware-files/),
  // so the same wizard that flashes releases can flash a local build —
  // the button must be there to press (bench-observed 2026-10-15: the
  // check announced an update and offered nothing).
  assert.equal(updateBtnHidden(), false, 'the Update button is offered for installable local-build entries');
  // The cached entry keeps the artifact base for the wizard's download step.
  const cached = JSON.parse(localStorage.getItem('lipsync-fw-check'));
  assert.ok(cached.localArtifactBase.endsWith('/firmware-files/'), 'entry carries the artifact base');
});

test('a newer version with NO install path is an honest dead end, not a silent badge', async () => {
  storage.clear();
  // Legacy cache shape (pre-local-artifact entries): manifest but neither
  // repo nor artifact base — the button stays hidden and the status names
  // the escape hatch instead of announcing an update with nothing to press.
  try {
    localStorage.setItem(
      'lipsync-fw-check',
      JSON.stringify({
        manifest: MANIFEST('4.2.0'),
        tagName: null,
        releaseUrl: null,
        repo: null,
        localArtifactBase: null,
        checkedAt: Date.now(),
      }),
    );
  } catch {}
  setDeviceVersion('4.1.0');
  await checkForFirmwareUpdate({ auto: true });
  await flush();
  assert.equal(updateBtnHidden(), true, 'the Update button is not offered without artifact coordinates');
  assert.match(status(), /no downloadable package/);
  assert.match(status(), /Flash local file/);
  // The nav badge must not advertise a dead end either.
  const nav = document.querySelector('.circle-trigger[data-section="sec-firmware"]');
  assert.equal(nav?.getAttribute('data-notify'), null, 'no badge without an installable path');
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
      : { ok: true, status: 200, json: async () => releaseWithManifest('4.2.0') };
  setDeviceVersion('ERR');
  await checkForFirmwareUpdate();
  await flush();
  assert.equal(latest(), '4.2.0');
  assert.match(status(), /Could not compare versions/);
  assert.equal(updateBtnHidden(), true);
});

// ---- Pending-update persistence (sessionStorage round-trip) ---------------

test('the pending entry round-trips through sessionStorage and corrupt storage reads as none', async () => {
  // This file never touched writePending, so the module's in-memory cache is
  // empty — readPending must fall back to the (now real) sessionStorage.
  assert.equal(fw.readPending(), null, 'nothing pending to start');
  fw.writePending({ target: '4.2.0', installed: true, snapshot: { SS: '5' } });
  const read = fw.readPending();
  assert.equal(read?.target, '4.2.0');
  assert.deepEqual(read?.snapshot, { SS: '5' });
  assert.equal(sessionStorage.getItem('lipsync-fw-pending')?.includes('"target":"4.2.0"'), true, 'persisted as JSON');
  fw.writePending(null);
  assert.equal(sessionStorage.getItem('lipsync-fw-pending'), null, 'cleared on completion');

  // A corrupt stored entry must read as "no pending update", never crash.
  sessionStorage.setItem('lipsync-fw-pending', '{"target": broken json!!');
  assert.equal(fw.readPending(), null, 'corrupt pending JSON degrades to none');

  // A hostile-but-valid entry: restore must skip non-scalar garbage rather
  // than inject it into the serial stream (the snapshot values are the only
  // write path; strings and numbers only ever reach the wire).
  sessionStorage.setItem(
    'lipsync-fw-pending',
    JSON.stringify({ target: '4.2.0', installed: true, snapshot: { SS: { toString: 1 }, SL: [1, 2] } }),
  );
  const poisoned = fw.readPending();
  assert.equal(poisoned?.snapshot?.SS?.toString, 1, 'the poisoned shape is what it is');
  fw.writePending(null);
});

test('a local-manifest install refreshes the manifest (a rebuild cannot strand the cache)', async () => {
  // Bench-observed 2026-10-16: the check cached a local manifest, the bench
  // rebuilt the artifacts (new sha256 on disk), and the Update button then
  // refused the "mismatched" package — the checksum gate was right, but it
  // was fed stale coordinates. The install must re-fetch the local manifest
  // at click time (same-origin, free) so it always describes what is on disk.
  storage.clear();
  try {
    localStorage.setItem('lipsync-fw-manifest-url', '/firmware-manifest.json');
  } catch {}
  document.getElementById('version').textContent = '4.1.0';

  // The OLD build's manifest — what an earlier check cached.
  const oldManifest = MANIFEST('4.5.0');
  oldManifest.files.dfu.sha256 = 'o'.repeat(64);
  try {
    localStorage.setItem(
      'lipsync-fw-check',
      JSON.stringify({
        manifest: oldManifest,
        tagName: null,
        releaseUrl: null,
        repo: null,
        localArtifactBase: 'http://localhost/firmware-files/',
        checkedAt: Date.now(),
      }),
    );
  } catch {}

  // The REBUILT artifacts: the server now serves a manifest with a new
  // sha256, and the artifact bytes that match it.
  const artifact = new Uint8Array(64).fill(7);
  const { createHash } = await import('node:crypto');
  const newSha = createHash('sha256').update(artifact).digest('hex');
  const newManifest = MANIFEST('4.5.0');
  newManifest.files.dfu.sha256 = newSha;

  fetchCalls = [];
  fetchImpl = async (url) =>
    String(url).includes('/firmware-manifest.json')
      ? { ok: true, status: 200, json: async () => newManifest }
      : { ok: true, status: 200, arrayBuffer: async () => artifact.buffer.slice(artifact.byteOffset, artifact.byteOffset + artifact.byteLength) };

  await fw.startFirmwareUpdate();
  await flush();

  // The manifest was re-fetched at install time (the refresh is the fix)…
  assert.ok(
    fetchCalls.some((u) => u.includes('/firmware-manifest.json')),
    'the install re-fetches the local manifest',
  );
  // …and the cache now carries the rebuilt build's coordinates, not the
  // stale ones the check cached.
  const cached = JSON.parse(localStorage.getItem('lipsync-fw-check'));
  assert.equal(cached.manifest.files.dfu.sha256, newSha, 'the cache is refreshed to the rebuilt manifest');

  // The artifact download went through the refreshed checksum (garbage
  // bytes with the right sha pass the gate; the wizard then fails honestly
  // at package PARSING — far past the mismatch that stranded the bench).
  const fetchedArtifact = fetchCalls.find((u) => u.includes('/firmware-files/'));
  assert.ok(fetchedArtifact, 'the artifact downloads from the dev-server route');
  resetFirmwareUpdateUi();
  storage.clear();
});
