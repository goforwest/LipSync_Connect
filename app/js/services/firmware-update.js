// Firmware update: version check against the latest published LipSync
// release, and the guided flash wizard (settings backup → bootloader →
// serial DFU → verify → settings restore). The check degrades safely on its
// own; the wizard additionally depends on serial/dfu/*.
//
// Wizard stage flow:
//   snapshot → download → confirm → enter-bootloader → await-bootloader-port
//   → flashing → await-reconnect → (user reconnects) → finished
// The reconnect finish runs after the normal settings load (afterDeviceLoad)
// so the device version and settings are fresh before anything is compared
// or written back.
import { $ } from '../ui/dom.js';
import { announceStatus } from '../ui/a11y.js';
import { showConfirm } from '../ui/formatting.js';
import { handleBeforeUnload, setStatus } from '../ui/connection-ui.js';
import { showNotification } from '../ui/notification.js';
import { log } from './log.js';
import { setWriteConfirmSuppressed } from './confirm.js';
import { updateReadiness } from './readiness.js';
import { downloadLogFile } from './log-export.js';
import { fmtApiFloat } from '../utils/format.js';
import { sendCommand, deviceFirmwareAtLeast } from '../serial/commands.js';
import { serialSession } from '../serial/session.js';
import { disconnect } from '../serial/connection.js';
import { openPortBounded, closePortWithOutcome, isPortOpenWedged, markPortOpenWedged } from '../utils/port-open.js';
import { sleep } from '../utils/timers.js';
import { parseDfuPackage } from '../serial/dfu/dfu-package.js';
import {
  flashSerialDfu,
  getKnownSerialPorts,
  isBootloaderPort,
  requestDfuPort,
  serialDfuPortIsLive,
} from '../serial/dfu/dfu-serial.js';
import { USB_VENDOR_ID } from '../config/constants.js';
import {
  FEEDBACK_MODES,
  OP_MODES,
  COM_MODES,
  CMD_MODE_TIMEOUT,
  CMD_RESET_TIMEOUT,
  FIRMWARE_RELEASE_API,
  FIRMWARE_API_BASE,
  FIRMWARE_BINARIES_BRANCH,
  FIRMWARE_MANIFEST_PATH,
  FIRMWARE_MANIFEST_URL_OVERRIDE_KEY,
  FIRMWARE_RELEASE_API_OVERRIDE_KEY,
  FIRMWARE_CHECK_STORAGE_KEY,
  FIRMWARE_CHECK_MIN_INTERVAL_MS,
  FIRMWARE_FETCH_TIMEOUT_MS,
  FIRMWARE_STRANDED_STORAGE_KEY,
  RESTRICTION_SETTINGS,
  RESTRICTIONS_MIN_FIRMWARE,
  WINDOW_SETTINGS,
  SWITCH_SETTINGS,
  SWITCH_ACTIONS_MIN_FIRMWARE,
  SWITCH_ACTION_PACK_BASE,
} from '../config/constants.js';

// ---- Version parsing / comparison (pure, exported for tests) ----

/** @param {string|number|null|undefined} v */
export function parseVersion(v) {
  const m = String(v ?? '')
    .trim()
    .toLowerCase()
    .match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2] ?? '0', 10), parseInt(m[3] ?? '0', 10)];
}

/** Returns -1 (a<b), 0, or 1 (a>b); null when either side is unparsable. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// ---- Manifest fetching ----

/**
 * @param {string} url
 * @param {{ headers?: Record<string, string>, signal?: AbortSignal }} [options]
 */
async function fetchJson(url, { headers = {}, signal } = {}) {
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onOuterAbort);
  const timer = setTimeout(() => ctrl.abort(), FIRMWARE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

function readCheckCache() {
  try {
    const raw = localStorage.getItem(FIRMWARE_CHECK_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCheckCache(entry) {
  try {
    localStorage.setItem(FIRMWARE_CHECK_STORAGE_KEY, JSON.stringify(entry));
  } catch {}
}

/**
 * Resolves the latest known firmware entry:
 *   { manifest, tagName, releaseUrl, repo: {owner, name}, checkedAt }
 * manifest is null when the repo publishes no firmware yet (no
 * firmware-binaries branch — today's upstream state). `force` bypasses the
 * time-based cache (manual re-checks).
 * @param {{ force?: boolean }} [options]
 */
export async function fetchLatestFirmware(options = {}) {
  let overrideUrl = null;
  let releaseApiOverride = null;
  try {
    overrideUrl = localStorage.getItem(FIRMWARE_MANIFEST_URL_OVERRIDE_KEY) || null;
    releaseApiOverride = localStorage.getItem(FIRMWARE_RELEASE_API_OVERRIDE_KEY) || null;
  } catch {}
  if (overrideUrl) {
    const manifest = await fetchJson(overrideUrl);
    // The dev-server contract: artifacts built next to the manifest are
    // served under /firmware-files/<name> at the manifest's own origin
    // (dev/server.js). This makes a local build installable through the
    // REAL update wizard — download → sha256 → flash — instead of forcing
    // the "Flash local file…" path. The page URL is the base because the
    // override value itself may be a relative URL; the fallback keeps
    // test environments deterministic.
    let localArtifactBase = null;
    const base = globalThis.location?.href || 'http://localhost/';
    try {
      localArtifactBase = new URL('firmware-files/', new URL(overrideUrl, base)).href;
    } catch {}
    const entry = {
      manifest,
      tagName: null,
      releaseUrl: null,
      repo: null,
      localArtifactBase,
      checkedAt: Date.now(),
    };
    // Cached like any other check result so the wizard's resolve step can
    // find it — but see the cache read below: a local entry never outlives
    // the override that created it.
    writeCheckCache(entry);
    return entry;
  }
  // A redirected release API is a dev pointing at another repo (usually a
  // fork): a stale cached upstream entry would mask it, so bypass the cache
  // read and always hit the (redirected) source.
  if (!options.force && !releaseApiOverride) {
    const cached = readCheckCache();
    // A cached local-manifest entry is only meaningful while its override
    // is set: without the key it must not masquerade as a release result
    // for the cache interval — a dev removing the override expects the
    // next check to go back to GitHub.
    if (cached && !cached.localArtifactBase && Date.now() - cached.checkedAt < FIRMWARE_CHECK_MIN_INTERVAL_MS)
      return cached;
  }
  const release = await fetchJson(releaseApiOverride || FIRMWARE_RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  const base = {
    tagName: release.tag_name ?? null,
    releaseUrl: release.html_url ?? null,
    checkedAt: Date.now(),
  };
  const repo = repoCoordsFromHtmlUrl(release.html_url);
  const noManifest = { ...base, manifest: null, repo: null };
  // Cache the "no firmware published" result too: without it, every
  // connect's auto-check re-fetches the release + manifest (2 requests each)
  // and burns GitHub's 60 req/h anonymous limit within ~30 reconnects —
  // shared IPs (clinics, classrooms) would hit the wall in an hour.
  if (!repo) {
    writeCheckCache(noManifest);
    return noManifest;
  }
  // The release workflow publishes artifacts to the firmware-binaries
  // branch; the manifest rides there. Its absence (404) is the "not
  // published yet" state, not an error.
  const manifest = await fetchRepoJsonFile(repo, FIRMWARE_MANIFEST_PATH, {
    allowMissing: true,
  });
  if (!manifest) {
    writeCheckCache(noManifest);
    return noManifest;
  }
  const entry = { ...base, manifest, repo };
  writeCheckCache(entry);
  return entry;
}

/** Extracts {owner, name} from a github.com release html_url. */
function repoCoordsFromHtmlUrl(htmlUrl) {
  const m = String(htmlUrl ?? '').match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\//);
  return m ? { owner: m[1], name: m[2] } : null;
}

/** Decodes a GitHub base64 payload (line-wrapped) into bytes. */
function base64ToBytes(b64) {
  const clean = String(b64).replace(/\s+/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Fetches a JSON document from the firmware-binaries branch (base64 contents API).
 * @param {{owner: string, name: string}} repo
 * @param {string} path
 * @param {{ allowMissing?: boolean, signal?: AbortSignal }} [options]
 */
async function fetchRepoJsonFile(repo, path, { allowMissing = false, signal } = {}) {
  const url = `${FIRMWARE_API_BASE}/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${FIRMWARE_BINARIES_BRANCH}`;
  let res;
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onOuterAbort);
  const timer = setTimeout(() => ctrl.abort(), FIRMWARE_FETCH_TIMEOUT_MS);
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
  if (res.status === 404 && allowMissing) return null;
  if (res.status === 403) {
    throw new Error('GitHub is limiting anonymous requests from this network — wait a while and try again.');
  }
  if (!res.ok) throw new Error(`GitHub returned an error (HTTP ${res.status}) while reading the firmware information.`);
  const payload = await res.json();
  if (payload.encoding !== 'base64' || !payload.content) throw new Error(`Unexpected payload for ${path}.`);
  return JSON.parse(new TextDecoder().decode(base64ToBytes(payload.content)));
}

/**
 * Downloads a binary from the firmware-binaries branch: tree lookup + git
 * blob (base64, single CORS-clean api.github.com responses; no size limit
 * surprises like the 1 MB contents-API cap).
 * @param {{owner: string, name: string}} repo
 * @param {string} fileName
 * @param {AbortSignal} [signal]
 */
export async function fetchRepoBinary(repo, fileName, signal) {
  const treeUrl = `${FIRMWARE_API_BASE}/repos/${repo.owner}/${repo.name}/git/trees/${FIRMWARE_BINARIES_BRANCH}`;
  const tree = await fetchJson(treeUrl, { signal });
  const blob = (tree.tree || []).find((/** @type {{path: string}} */ e) => e.path === fileName);
  if (!blob?.sha) throw new Error('The published firmware package is missing from the repository.');
  const blobUrl = `${FIRMWARE_API_BASE}/repos/${repo.owner}/${repo.name}/git/blobs/${blob.sha}`;
  const payload = await fetchJson(blobUrl, { signal });
  if (payload.encoding !== 'base64' || !payload.content) {
    throw new Error('The published firmware package could not be read from GitHub.');
  }
  return base64ToBytes(payload.content);
}

// ---- Update-check UI ----

function setRow(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

/**
 * Marks/unmarks the device as stranded in its update loader (set by the
 * Connect guard when the picked port carries the bootloader identity).
 * While set, the Firmware card and its Recover button stay reachable even
 * though no session exists — recovery is the only way back when the app
 * firmware is incomplete (an interrupted flash erases before writing, so
 * reset and replug both land back in update mode).
 */
export function setBootloaderStranded() {
  const section = $('sec-firmware');
  if (section) section.setAttribute('data-recover', 'true');
  const btn = $('btnRecoverDevice');
  if (btn) btn.hidden = false;
  try {
    sessionStorage.setItem(FIRMWARE_STRANDED_STORAGE_KEY, '1');
  } catch {}
}

export function clearBootloaderStranded() {
  const section = $('sec-firmware');
  if (section) section.removeAttribute('data-recover');
  const btn = $('btnRecoverDevice');
  if (btn) btn.hidden = true;
  try {
    sessionStorage.removeItem(FIRMWARE_STRANDED_STORAGE_KEY);
  } catch {}
}

/**
 * Re-reveals Recover after a page reload: the DOM marker dies with the old
 * page, but the sessionStorage mirror survives, so a user whose update was
 * interrupted (and who reloaded — for the wedged-port remedy, a crash,
 * anything) still has the one button that repairs the device within reach.
 * The flag's lifetime ends at the next successful settings load, where
 * afterDeviceLoad() clears it — a normally-booting device never shows it.
 */
export function restoreBootloaderStrandedFromStorage() {
  try {
    if (sessionStorage.getItem(FIRMWARE_STRANDED_STORAGE_KEY)) setBootloaderStranded();
  } catch {}
}

/**
 * Renders the update-check status line with a visual state pill.
 * state: 'busy' | 'ok' | 'available' | 'unknown' | 'warn' | '' (cleared).
 */
function setCheckStatus(text, state = '') {
  const el = $('fwUpdateStatus');
  if (!el) return;
  el.textContent = text;
  if (state) el.setAttribute('data-state', state);
  else el.removeAttribute('data-state');
}

function setUpdateButton(entry, deviceVersion) {
  const btn = $('btnStartUpdate');
  const target = $('fwTargetVersion');
  if (!btn) return;
  // Installable needs artifact coordinates: either repo coordinates (the
  // release path downloads via api.github.com) or a local artifact base
  // (the dev-server manifest override serves the built artifacts at its
  // own origin — a local build installs through the same wizard).
  const installable = !!entry?.manifest && (!!entry.repo || !!entry.localArtifactBase);
  const newer = compareVersions(deviceVersion, entry?.manifest?.firmwareVersion) === -1;
  const available = installable && newer;
  btn.hidden = !available;
  if (available && target) target.textContent = entry.manifest.firmwareVersion;
  // A newer version with no install path must not be a dead end (the
  // pre-fix behavior: the check announced an update, badged the nav, and
  // offered nothing to press — bench-observed 2026-10-15). Name the escape
  // hatch instead.
  if (newer && !available) {
    setCheckStatus(
      `Update available: ${entry.manifest.firmwareVersion}, but this check has no downloadable package — use “Flash local file…” with the built artifact.`,
      'warn',
    );
  }
  // Badge the circle-nav trigger so an available update is discoverable
  // without opening the Firmware card. Screen readers get the same news from
  // the check status, so the dot itself is aria-silent.
  const nav = document.querySelector('.circle-trigger[data-section="sec-firmware"]');
  if (nav) {
    if (available) nav.setAttribute('data-notify', 'firmware-update');
    else nav.removeAttribute('data-notify');
  }
  updateReadiness(); // the strip derives from this button's state
}

function describeCheckedAgo(checkedAt) {
  const mins = Math.max(1, Math.round((Date.now() - checkedAt) / 60000));
  if (mins < 60) return `checked ${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  return `checked ${hours} hour${hours === 1 ? '' : 's'} ago`;
}

/**
 * Compares the connected device's firmware version with the latest published
 * release and updates the Firmware card. Never throws — failures render a
 * readable status and fall back to the last known result when one exists.
 * @param {{ auto?: boolean }} [options] auto = triggered post-load (cache-aware, quiet).
 */
export async function checkForFirmwareUpdate(options = {}) {
  const deviceVersion = ($('version')?.textContent || '').trim() || null;
  setRow('fwCurrentVersion', deviceVersion ?? '—');
  setCheckStatus('Checking for firmware updates…', 'busy');
  let entry;
  try {
    entry = await fetchLatestFirmware({ force: !options.auto });
  } catch (e) {
    const cached = readCheckCache();
    if (cached?.manifest) {
      renderCheckResult(
        cached,
        deviceVersion,
        `Could not check now — last known from ${describeCheckedAgo(cached.checkedAt)}.`,
        'warn',
      );
    } else {
      setRow('fwLatestVersion', '—');
      setUpdateButton(null, deviceVersion);
      setCheckStatus(
        /403/.test(e.message)
          ? 'Update check reached GitHub\u2019s anonymous request limit — try again in a while.'
          : 'Could not check for updates. You may be offline.',
        'warn',
      );
    }
    log('Firmware update check failed: ' + e.message, 'log-err');
    return;
  }
  const manifest = entry?.manifest;
  if (!manifest) {
    setRow('fwLatestVersion', 'Unknown');
    setUpdateButton(null, deviceVersion);
    setCheckStatus('No published firmware information yet.', 'unknown');
    if (!options.auto) announceFirmwareNews('No published firmware information yet.');
    return;
  }
  const cmp = compareVersions(deviceVersion, manifest.firmwareVersion);
  if (cmp === null) {
    setRow('fwLatestVersion', manifest.firmwareVersion);
    setUpdateButton(null, deviceVersion);
    setCheckStatus('Could not compare versions. Reconnect and refresh settings.', 'warn');
    return;
  }
  const upToDate = cmp >= 0;
  const message = upToDate
    ? `Firmware is up to date (${manifest.firmwareVersion}, ${describeCheckedAgo(entry.checkedAt)}).`
    : `Update available: ${manifest.firmwareVersion} (installed: ${deviceVersion}).`;
  renderCheckResult(entry, deviceVersion, message, upToDate ? 'ok' : 'available');
  if (!upToDate) {
    log('Firmware update available: ' + manifest.firmwareVersion + ' (installed: ' + deviceVersion + ').', 'log-info');
    announceFirmwareNews('Firmware update available: version ' + manifest.firmwareVersion + '.');
  } else if (!options.auto) {
    announceFirmwareNews('Firmware is up to date.');
  }
}

function setRowClass(id, cls, on) {
  const el = $(id);
  if (!el) return;
  if (on) el.classList.add(cls);
  else el.classList.remove(cls);
}

/**
 * #fwUpdateStatus and #fwWizardStep are role=status regions: while the
 * Firmware card is open, their text changes ARE the screen-reader
 * announcement. Mirroring the same news into #srStatus too double-voices
 * every message — the mirror is reserved for when the card is collapsed
 * (collapsed sections are aria-hidden and their live regions stay silent).
 */
function announceFirmwareNews(message) {
  const section = $('sec-firmware');
  if (section?.classList?.contains('open')) return;
  announceStatus(message);
}

function renderCheckResult(entry, deviceVersion, message, state = 'ok') {
  setRow('fwLatestVersion', entry.manifest.firmwareVersion);
  setCheckStatus(message, state);
  setRowClass('fwLatestVersion', 'fw-new', state === 'available');
  const notes = $('fwNotesLink');
  if (notes) {
    // The URL comes from the GitHub API, but a poisoned cache could hold
    // anything — only https links may reach the href sink.
    let urlOk = false;
    try {
      urlOk = new URL(entry.releaseUrl).protocol === 'https:';
    } catch {
      urlOk = false;
    }
    if (entry.releaseUrl && urlOk) {
      notes.hidden = false;
      notes.setAttribute('href', entry.releaseUrl);
      notes.textContent = `What\u2019s new in ${entry.manifest.firmwareVersion}`;
    } else {
      notes.hidden = true;
    }
  }
  setUpdateButton(entry, deviceVersion);
}

// ---- Settings snapshot / restore ----

const SNAPSHOT_KEYS = [
  ['SS', 'speedVal', 'Cursor speed level'],
  ['SL', 'scrollVal', 'Scroll level'],
  ['AV', 'accelVal', 'Cursor acceleration'],
  ['ST', 'sipVal', 'Sip threshold'],
  ['PT', 'puffVal', 'Puff threshold'],
  ['IZ', 'innerDeadzoneVal', 'Inner deadzone'],
  ['OZ', 'outerDeadzoneVal', 'Outer deadzone'],
  ['LL', 'brightnessVal', 'LED brightness'],
];
const FLOAT_ENDPOINTS = ['ST', 'PT', 'IZ', 'OZ'];

function labelToValue(map, label) {
  for (const [value, name] of Object.entries(map)) if (name === label) return value;
  return null;
}

/** Reads the loaded settings from the display into wire values. */
export function captureSettingsSnapshot() {
  const snapshot = { VN: ($('version')?.textContent || '').trim() };
  const missing = [];
  for (const [ep, id, label] of SNAPSHOT_KEYS) {
    const v = ($(id)?.textContent || '').trim();
    if (!v || v === '—' || v === 'ERR' || v === '…') {
      missing.push(label);
      continue;
    }
    snapshot[ep] = v;
  }
  // Sound and light feedback are writable settings the restore promises to
  // write back: a failed load (ERR/unrecognized) must fail the snapshot —
  // silently skipping them would lose the user's feedback configuration the
  // moment the new firmware's defaults differ, while still reporting
  // "settings restored".
  for (const [ep, id, label] of [
    ['SM', 'soundModeVal', 'Sound feedback'],
    ['LM', 'lightModeVal', 'Light feedback'],
  ]) {
    const raw = ($(id)?.textContent || '').trim();
    if (!raw || raw === '—' || raw === 'ERR' || raw === '…') {
      missing.push(label);
      continue;
    }
    const value = labelToValue(FEEDBACK_MODES, raw);
    if (value === null) {
      missing.push(label);
      continue;
    }
    snapshot[ep] = value;
  }
  snapshot.OM = labelToValue(OP_MODES, ($('opmode')?.textContent || '').trim());
  snapshot.CM = labelToValue(COM_MODES, ($('commode')?.textContent || '').trim());
  snapshot.CA = [$('neutralVal'), $('corner1'), $('corner2'), $('corner3'), $('corner4')]
    .map((el) => (el?.textContent || '').trim())
    .join(',');
  // Input restrictions (4.4.0+): OPTIONAL snapshot keys. The session's
  // firmware version decides: a pre-4.4.0 device simply doesn't have the
  // settings, and the snapshot must neither fail nor invent values for it.
  // On firmware that DOES have them, a restriction that failed to load is a
  // hole like SM/LM — the restore promises to write these back.
  const deviceHasRestrictions = deviceFirmwareAtLeast(
    RESTRICTIONS_MIN_FIRMWARE[0],
    RESTRICTIONS_MIN_FIRMWARE[1],
    RESTRICTIONS_MIN_FIRMWARE[2],
  );
  for (const r of RESTRICTION_SETTINGS) {
    if (!deviceHasRestrictions) continue;
    const el = $(r.checkboxId);
    if (!el || el.disabled || typeof el.checked !== 'boolean') {
      missing.push(r.label);
      continue;
    }
    snapshot[r.endpoint] = el.checked ? '1' : '0';
  }
  // Input timing windows (4.4.0+, roadmap item 15): the same optional-keys
  // contract — skipped on firmware without them, failed honestly on firmware
  // that has them but whose read did not land.
  for (const w of WINDOW_SETTINGS) {
    if (!deviceHasRestrictions) continue;
    const v = ($(w.valueId)?.textContent || '').trim();
    if (!v || v === '—' || v === 'ERR' || v === '…') {
      missing.push(w.label);
      continue;
    }
    snapshot[w.endpoint] = v;
  }
  // External switch actions (4.5.0+, upstream #20): the same optional-keys
  // contract at its own gate — a pre-4.5.0 device simply doesn't have the
  // settings; on firmware that does, an unloaded mapping is a hole (the
  // restore promises to write a caregiver's remaps back or fail loudly).
  const deviceHasSwitchActions = deviceFirmwareAtLeast(
    SWITCH_ACTIONS_MIN_FIRMWARE[0],
    SWITCH_ACTIONS_MIN_FIRMWARE[1],
    SWITCH_ACTIONS_MIN_FIRMWARE[2],
  );
  if (deviceHasSwitchActions) {
    for (const s of SWITCH_SETTINGS) {
      const cells = s.windowLabels.map((_, i) => parseInt($(s.selectPrefix + i)?.value ?? '', 10));
      const sel = $(s.selectPrefix + 0);
      if (!sel || sel.disabled || cells.some((c) => !Number.isFinite(c))) {
        missing.push(`${s.jack} ${s.mode} mapping`);
        continue;
      }
      // 0 (all nothing) is stored as the packed triple, never confused with
      // the whole-endpoint factory reset (wire 0): snapshot the PACKED wire
      // value exactly as the restore will write it.
      snapshot[s.endpoint] = String(SWITCH_ACTION_PACK_BASE + cells[0] * 10000 + cells[1] * 100 + cells[2]);
    }
  }
  if (missing.length)
    throw new Error('Some settings did not load (' + missing.join(', ') + '). Click Refresh all settings and retry.');
  return snapshot;
}

function settingsBackupText(snapshot) {
  return JSON.stringify(
    {
      device: 'LipSync',
      firmwareVersion: snapshot.VN,
      savedAt: new Date().toISOString(),
      settings: snapshot,
    },
    null,
    2,
  );
}

export function downloadSettingsBackup(snapshot) {
  downloadLogFile({
    text: settingsBackupText(snapshot),
    filename: `lipsync-settings-${snapshot.VN || 'backup'}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`,
  });
  log('Settings backup downloaded.', 'log-info');
}

// ---- Post-flash restore settle -------------------------------------------
// Hardware (2026-10-11 validation round): the first one or two settings
// writes over a freshly restored session can time out right after a flash
// (observed: SS and SL "Timed out waiting for device response" immediately
// after reconnect, succeeding only on the re-armed retry pass — one extra
// reconnect of user cost). The just-flashed device appears to drop its
// first CDC writes while its USB stack finishes coming up; settling after
// the settings load completes, before the first restore write, makes the
// common path land in one pass.
export const RESTORE_SETTLE_MS = 1500;
let restoreSettleMs = RESTORE_SETTLE_MS;

/** Test seam: shrink (or zero) the post-flash settle so scenarios run fast. */
export function setRestoreSettleForTests(ms) {
  restoreSettleMs = ms;
}

/**
 * Re-applies a snapshot's writable settings over the serial API. Float
 * endpoints are normalized through fmtApiFloat so every write lands on a
 * line length the firmware validator accepts. Returns the failures.
 */
export async function restoreSettingsSnapshot(snapshot) {
  const failures = [];
  // The restore writes what the CONNECTED device can hold, not everything
  // the snapshot carries: a snapshot taken on newer firmware (the natural
  // state after a downgrade via "Flash local file…") holds keys older
  // firmware has never heard of — writing them is guaranteed FAIL,1 noise,
  // and two of those failures abort the whole restore early
  // (bench-observed 2026-10-16 restoring a 4.5.0 snapshot onto 4.1.0).
  // Gate each version-gated family on the session's firmware; an unknown
  // version (VN never loaded) skips them too — the conservative direction,
  // since a write to unknown firmware is exactly the noise being fixed.
  const base = ['SS', 'SL', 'AV', 'ST', 'PT', 'IZ', 'OZ', 'SM', 'LM', 'LL'];
  const order = [...base];
  if (deviceFirmwareAtLeast(RESTRICTIONS_MIN_FIRMWARE[0], RESTRICTIONS_MIN_FIRMWARE[1], RESTRICTIONS_MIN_FIRMWARE[2])) {
    order.push('SD', 'MA', 'LK', 'CF', 'WS', 'WL', 'WM');
  }
  if (
    deviceFirmwareAtLeast(
      SWITCH_ACTIONS_MIN_FIRMWARE[0],
      SWITCH_ACTIONS_MIN_FIRMWARE[1],
      SWITCH_ACTIONS_MIN_FIRMWARE[2],
    )
  ) {
    // External switch actions (4.5.0+) restore last: they are plain packed
    // ints exactly as the snapshot captured them (the base included, or the
    // whole-endpoint factory reset for a 0).
    order.push('SA', 'SB', 'SC', 'GA', 'GB', 'GC');
  }
  let consecutive = 0;
  // A restore is a deliberate burst over every settings endpoint at once —
  // one write-confirm chip per write would flicker through a dozen states
  // for a change the wizard already narrates. Suppress the chips for the
  // burst; normal single writes confirm again immediately after.
  setWriteConfirmSuppressed(true);
  try {
    for (const ep of order) {
      const raw = snapshot?.[ep];
      if (raw === undefined || raw === null || raw === '') continue;
      const value = FLOAT_ENDPOINTS.includes(ep) ? fmtApiFloat(raw) : String(raw);
      try {
        await sendCommand(`${ep},1:${value}`);
        consecutive = 0;
      } catch (e) {
        failures.push(`${ep}: ${e.message}`);
        // A dead link (unplug) fails fast; a wedged-but-open port would grind
        // through nine 6-second timeouts instead. Stop after two consecutive
        // failures — the finisher re-arms or reports either way.
        if (!serialSession.port || ++consecutive >= 2) break;
      }
    }
  } finally {
    setWriteConfirmSuppressed(false);
  }
  return failures;
}

// ---- Pending-update persistence (survives page reloads best-effort) ----

const PENDING_KEY = 'lipsync-fw-pending';
let pendingMemory = null;

export function readPending() {
  if (pendingMemory) return pendingMemory;
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    pendingMemory = raw ? JSON.parse(raw) : null;
  } catch {
    pendingMemory = null;
  }
  return pendingMemory;
}

export function writePending(entry) {
  pendingMemory = entry;
  try {
    if (entry) sessionStorage.setItem(PENDING_KEY, JSON.stringify(entry));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {}
}

// Test seam (Node only): drops the in-memory pending cache so a page reload
// (which starts with an empty cache but live sessionStorage) can be
// simulated against the production storage round-trip. Guarded exactly like
// serial/session.js's seams so nothing shipped to a browser can reach it.
export function resetPendingMemoryForTests() {
  const nodeProcess = globalThis['process'];
  if (typeof nodeProcess === 'undefined' || !nodeProcess?.versions?.node)
    throw new Error('resetPendingMemoryForTests is a test-only seam');
  pendingMemory = null;
}

// ---- Flash wizard ----

let wizard = null; // { stage, target, pkg, snapshot, entry, abort }

// The port the last flash attempt failed on (probe silence, write error…).
// It must not be silently reused from getPorts() on the next attempt: the
// wizard's copy says "pick the update loader again", and only the picker can
// honor that. Cleared the moment a flash completes on any port.
let lastFlashFailurePort = null;

// Snapshot of the last completed update, kept only so the success panel's
// "Download settings backup" button keeps working after the pending entry is
// cleared. Cleared with the panel.
let completedSnapshot = null;

// Connect and Disconnect stay clickable for the post-flash reconnect, but a
// click while the wizard owns the session (or the bootloader port) derails
// the flow — so both are locked for the wizard's lifetime and re-enabled
// according to the actual session state afterwards.
function lockSessionButtons(lock) {
  const connect = $('btnConnect');
  const disconnectBtn = $('btnDisconnect');
  if (!connect || !disconnectBtn) return;
  if (lock) {
    connect.disabled = true;
    disconnectBtn.disabled = true;
  } else {
    connect.disabled = !!serialSession.port;
    disconnectBtn.disabled = !serialSession.port;
  }
}

/** The header status bar reflects the wizard, not just the port. */
function setWizardStatus(text) {
  setStatus(text, false);
}

function resetStatusIfDisconnected() {
  if (!serialSession.port) setStatus('Not connected', false);
}

/**
 * Shows/hides the wizard panel. state: 'active' | 'done' | 'failed' drives
 * the panel's accent; showing the wizard also hides the normal check/update
 * actions so the user's eye lands on the wizard alone.
 * Focus: opening the panel hides the row holding the button that was just
 * clicked — keyboard and screen-reader users would be dropped on the page
 * body. The panel takes focus on open (its step region then speaks), and the
 * opener is restored when the panel closes (the showConfirm pattern).
 */
let wizardFocusOpener = null;
function setWizardVisible(show, state = 'active') {
  const el = $('fwWizard');
  if (el) {
    const wasHidden = el.hidden;
    el.hidden = !show;
    if (show) {
      el.setAttribute('data-state', state);
      if (wasHidden) {
        wizardFocusOpener = document.activeElement;
        el.focus?.();
      }
    } else {
      el.removeAttribute('data-state');
      if (!wasHidden) {
        const opener = wizardFocusOpener;
        wizardFocusOpener = null;
        if (opener && typeof opener.focus === 'function') opener.focus();
      }
    }
  }
  const actions = $('fwActionsRow');
  if (actions) actions.hidden = !!show;
  const section = $('sec-firmware');
  if (section) {
    if (show) section.setAttribute('data-wizard', state);
    else section.removeAttribute('data-wizard');
  }
}

// [logical stage key, tracker element id] — the flow passes keys, the tracker
// elements are looked up by id.
const WIZARD_STAGES = [
  ['backup', 'fwStepBackup'],
  ['restart', 'fwStepRestart'],
  ['flash', 'fwStepFlash'],
  ['restore', 'fwStepRestore'],
];

/**
 * Highlights the wizard's step tracker. The given stage becomes active, the
 * ones before it are marked done; null with allDone marks every step done.
 */
function setWizardStage(stage, { allDone = false } = {}) {
  const activeIndex = stage ? WIZARD_STAGES.findIndex(([key]) => key === stage) : -1;
  WIZARD_STAGES.forEach(([, id], i) => {
    const el = $(id);
    if (!el) return;
    el.classList.remove('active', 'done');
    if (allDone || (stage && i < activeIndex)) el.classList.add('done');
    else if (i === activeIndex) el.classList.add('active');
  });
}

/**
 * Renders one wizard step. `percent` drives the bar and the numeric readout
 * (`#fwPct`) — never the step text itself, which lives in a role=status
 * region: writing the percentage there would re-announce it for every frame.
 */
function setWizardStep(
  text,
  {
    percent = null,
    etaSec = null,
    hint = null,
    showContinue = false,
    showCancel = false,
    showBackup = false,
    cancelLabel = null,
  } = {},
) {
  const step = $('fwWizardStep');
  if (step) step.textContent = text || '';
  const bar = $('fwProgress');
  if (bar) {
    if (percent === null) bar.removeAttribute('value');
    else bar.setAttribute('value', String(Math.max(0, Math.min(100, Math.round(percent)))));
  }
  const pct = $('fwPct');
  if (pct) {
    const n = percent === null ? null : Math.max(0, Math.min(100, Math.round(percent)));
    pct.textContent = n === null ? '' : etaSec ? `${n}% · ~${etaSec}s left` : `${n}%`;
  }
  const hintEl = $('fwWizardHint');
  if (hintEl) hintEl.textContent = hint || '';
  const cont = $('btnFwContinue');
  if (cont) cont.hidden = !showContinue;
  const cancel = $('btnFwCancel');
  if (cancel) {
    cancel.hidden = !showCancel;
    // The button means "stop" mid-flash and "cancel" everywhere else — keep
    // the label explicit per step so a stale label never carries over.
    if (showCancel) cancel.textContent = cancelLabel ?? 'Cancel';
  }
  const backup = $('btnDownloadBackup');
  if (backup) backup.hidden = !showBackup;
  // When a step's Continue button appears, keyboard users are often standing
  // nowhere: the control they clicked was hidden by the transition (or never
  // existed — the confirm dialog returns focus to an already-hidden button).
  // Hand focus to the new primary action, but never steal it from someone
  // already inside the panel (a Cancel that persists across steps keeps it).
  if (showContinue && cont && !cont.hidden) {
    const panel = $('fwWizard');
    const focused = document.activeElement;
    if (panel && !panel.hidden && focused !== cont && focused !== cancel && focused !== backup) cont.focus?.();
  }
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Attempts to restart the device into its stock bootloader with the
// 1200-baud touch. Flaky at the USB layer (observed on hardware: the same
// build takes the touch one day and drops it the next), so each attempt is
// verified strictly and retried — a manual double-tap reset stays the last
// resort, never a required step.
const TOUCH_MAX_ATTEMPTS = 3;
// How long to let the USB stack settle before re-checking a port that
// reported a gone-style open failure — enough for the bootloader to finish
// enumerating (or for a wedged port to clear) on the slowest host.
const TOUCH_RECHECK_SETTLE_MS = 2000;
// The settle between the wizard's own session close and the first touch
// open: a close→open with no gap is the documented cause of wedged macOS
// opens (hardware: the wake open stalled 22 s after the session close
// completed, and the pending open then poisoned every retry).
export const TOUCH_AFTER_CLOSE_SETTLE_MS = 2000;
let touchSettleAfterDisconnectMs = TOUCH_AFTER_CLOSE_SETTLE_MS;

/** Test seam: shrink the post-close settle so wizard scenarios run fast. */
export function setTouchSettleAfterDisconnectForTests(ms) {
  touchSettleAfterDisconnectMs = ms;
}

// ---- SR-first restart (wedge-free device restart) --------------------------
// Hardware fact: on some macOS machines the first open after a heavy
// settings session's close wedges at the OS level and NEVER settles — the
// 1200-baud restart signal becomes undeliverable and only a device
// re-enumeration (physical replug, or reset) clears it. Rebooting the
// device with SR,1:1 over the LIVE session makes it re-enumerate — the
// same force-fail of the wedged open a replug performs — while leaving the
// app running, so the touch then runs against a fresh enumeration (where
// opens have never wedged). SR,1:1 is the firmware's established soft-reset
// command (the mode-restore flow already sends it).
export const SR_REBOOT_SETTLE_MS = 3000;
let srRebootSettleMs = SR_REBOOT_SETTLE_MS;
let srResetTimeoutMs = CMD_RESET_TIMEOUT;

/** Test seams: shrink the SR timeouts so soft-reset scenarios run fast. */
export function setSrRebootSettleForTests(ms) {
  srRebootSettleMs = ms;
}
export function setSrResetTimeoutForTests(ms) {
  srResetTimeoutMs = ms;
}

/**
 * Reboots the device over the live session so it re-enumerates, then lets
 * the caller run the 1200-baud touch against the fresh enumeration.
 * Returns 'sent' (device rebooting; session torn down; settle elapsed) |
 * 'unavailable' (SR could not be delivered — no live session or an
 * unresponsive app; the session is untouched and the caller falls back to
 * the standard close-then-touch choreography) | 'cancelled'.
 * The wizard's AbortSignal is threaded into the command: a cancel that lands
 * before the SR bytes are written stops them from ever being sent, and one
 * that lands after (the device acks in milliseconds and reboots on its own)
 * is honored the only way that is still honest — the quiet teardown runs
 * anyway and the caller is told the reboot is in flight ('sent').
 * @param {() => boolean} [cancelled]
 * @param {AbortSignal} [signal]
 */
async function attemptSoftResetRestart(cancelled, signal) {
  if (cancelled?.()) return 'cancelled';
  if (!serialSession.port || !serialSession.writer) return 'unavailable';
  // The reboot's departure must not trip the read loop's recovery chatter.
  serialSession.disconnecting = true;
  let sent = false;
  try {
    await sendCommand('SR,1:1', srResetTimeoutMs, undefined, { signal });
    sent = true;
    // The device acked and is rebooting no matter what happens next — a
    // cancel that lands during the teardown or the settle must be able to
    // say so honestly (cancelWizard reads this flag at its entry).
    if (wizard) wizard.srWritten = true;
  } catch (e) {
    if (e?.name === 'AbortError' && e.commandWritten) {
      // The cancel raced the command's write and lost: the device has the
      // reboot signal and will ack + restart on its own regardless (the
      // ack arrives in milliseconds; the cancel's own message for the
      // restart stage hedges this). Do the honest teardown so the departing
      // session never forms a slow-close wedge.
      sent = true;
      log(
        'The restart signal was already sent when the update was cancelled — the LipSync restarts on its own.',
        'log-info',
      );
    } else {
      log(
        'Could not reboot the device over the session (' + e.message + ') — using the standard restart instead.',
        'log-info',
      );
    }
  }
  if (!sent) {
    // The session is still alive and healthy — restore normal watchdog
    // behavior; the standard restart path will disconnect it.
    serialSession.disconnecting = false;
    return 'unavailable';
  }
  log('Device is rebooting (soft reset) — waiting for it to come back before the update-mode signal.', 'log-info');
  // Closing a port whose device is departing/departed rejects fast — the
  // slow-close-then-wedge cycle never forms.
  await disconnect({ quiet: true });
  await sleep(srRebootSettleMs);
  return cancelled?.() ? 'cancelled' : 'sent';
}

// ---- UM-first update-mode entry (firmware ≥ 4.3.0) ------------------------
// Firmware 4.3.0 adds UM,1:1 — ack, draw the deliberate "Update mode"
// splash, reset into the stock bootloader — so the Hub's screen tells the
// truth during a flash instead of freezing on "Restarting" (the stock
// bootloader never drives the OLED; firmware-update improvements item 1).
// Sending it over the LIVE session mirrors the proven SR,1:1 flow (the same
// abort-aware command path, the same fast close of a departing port) and
// replaces the whole SR + 1200-baud touch choreography in one exchange.
// Any failure — older firmware answers FAIL, the link died, a cancel —
// falls back to the established SR-first + touch path below.
export const UM_FIRMWARE_MIN_VERSION = '4.3.0';

/**
 * Sends UM,1:1 over the live session. Returns 'sent' (device acked and is
 * resetting into its update loader; session torn down; settle elapsed) |
 * 'unavailable' (UM could not be delivered — the session is untouched and
 * the caller falls back to the SR + touch choreography) | 'cancelled'.
 * The wizard's AbortSignal rides the command exactly as it does for SR: a
 * cancel before the write stops the bytes; one after (the device acks in
 * milliseconds) is honored via the honest teardown ('sent').
 * @param {() => boolean} [cancelled]
 * @param {AbortSignal} [signal]
 */
async function attemptUpdateModeRestart(cancelled, signal) {
  if (cancelled?.()) return 'cancelled';
  if (!serialSession.port || !serialSession.writer) return 'unavailable';
  // The reboot's departure must not trip the read loop's recovery chatter.
  serialSession.disconnecting = true;
  let sent = false;
  try {
    await sendCommand('UM,1:1', CMD_RESET_TIMEOUT, undefined, { signal });
    sent = true;
    if (wizard) wizard.umWritten = true;
  } catch (e) {
    if (e?.name === 'AbortError' && e.commandWritten) {
      // The cancel raced the command's write and lost: the device has the
      // update-mode signal and will ack + enter its loader on its own.
      sent = true;
      log(
        'The update-mode signal was already sent when the update was cancelled — the LipSync enters update mode on its own.',
        'log-info',
      );
    } else {
      log(
        'Could not enter update mode over the session (' + e.message + ') — using the standard restart instead.',
        'log-info',
      );
    }
  }
  if (!sent) {
    // The session is still alive and healthy — restore normal watchdog
    // behavior; the standard restart path will disconnect it.
    serialSession.disconnecting = false;
    return 'unavailable';
  }
  log('Device is entering update mode — waiting for its update loader to appear.', 'log-info');
  // Closing a port whose device is departing rejects fast — the same
  // wedge-free property the SR flow relies on. The settle spans the ack, the
  // update-mode splash and the bootloader's enumeration.
  await disconnect({ quiet: true });
  await sleep(srRebootSettleMs);
  return cancelled?.() ? 'cancelled' : 'sent';
}

// The app-mode port stopped opening after a restart signal that never left:
// the only bus-side proof that the device actually entered update mode is a
// previously-granted bootloader port whose device is demonstrably present.
// Native SerialPort objects carry no liveness property (departed grants list
// in getPorts() with cached identities), so presence is proven the only
// honest way: a bounded probe open (serialDfuPortIsLive).
async function liveBootloaderPortPresent() {
  const ports = (await getKnownSerialPorts()) ?? [];
  for (const p of ports) {
    if (isBootloaderPort(p) && (await serialDfuPortIsLive(p))) return true;
  }
  return false;
}

/**
 * One touch attempt: a wake pulse (an idle device may have suspended its USB
 * stack and drop the touch — skipped after a soft reset, where the device
 * just booted and is demonstrably awake), then open at 1200 baud + DTR
 * drop, then verify by reopening the app-mode port — after a successful
 * touch it no longer opens. Returns 'touched' | 'app-live' | 'inconclusive'
 * | 'cancelled'.
 * @param {any} appPort
 * @param {() => boolean} cancelled
 * @param {number} attempt
 * @param {{ skipWake?: boolean }} [options]
 */
async function attemptTouchOnce(appPort, cancelled, attempt, options = {}) {
  const { skipWake = false } = options;
  if (cancelled?.()) return { result: 'cancelled' };
  if (!skipWake) {
    try {
      await openTouchWithRecovery(appPort, { baudRate: 115200 });
      if (cancelled?.()) {
        // The open resolved after a cancel — release the port (nobody else can
        // hold it while our open was pending) and stop touching anything.
        try {
          await appPort.close();
        } catch {}
        return { result: 'cancelled' };
      }
      await sleep(50);
      await appPort.close();
    } catch {}
  }
  if (cancelled?.()) return { result: 'cancelled' };
  // Give wedged ports progressively longer to settle between attempts — a
  // rapid close/open cycle is the main cause of a port refusing to open
  // while the device is still alive (observed on hardware).
  await sleep(300 + (attempt - 1) * 700);
  if (cancelled?.()) return { result: 'cancelled' };
  try {
    // 1200-baud touch: the running firmware sees the line-coding change and
    // a DTR drop, and resets into its stock bootloader.
    await openTouchWithRecovery(appPort, { baudRate: 1200 });
    if (cancelled?.()) {
      // Closing a 1200-baud open IS the touch — the device may restart.
      // Leaking the open would block every future connection, so close and
      // report the state as uncertain.
      try {
        await appPort.close();
      } catch {}
      log('The restart signal was sent before the cancel — the LipSync may still enter update mode.', 'log-info');
      return { result: 'cancelled' };
    }
    try {
      await appPort.setSignals?.({ dataTerminalReady: false });
    } catch {}
    await sleep(100);
    await appPort.close();
  } catch (e) {
    if (!deviceGone(e)) return { result: 'app-live', error: e?.message };
    // Gone-style error from the 1200-baud open itself: the restart signal
    // was never sent, so a bare 'touched' would be a guess. Either the
    // device is unplugged, or it is already sitting in its update loader
    // from an earlier restart — only a live bootloader port on the bus
    // proves the second.
    const recheck = await reopenAfterSettle(appPort, cancelled);
    if (recheck === 'open') return { result: 'app-live', wedged: true };
    if (recheck === 'gone') {
      if (await liveBootloaderPortPresent()) return { result: 'touched' };
      return {
        result: 'inconclusive',
        error: 'the LipSync is not responding on the bus — it may be unplugged',
      };
    }
    return { result: 'inconclusive', error: e?.message };
  }
  await sleep(1200);
  if (cancelled?.()) return { result: 'cancelled' };
  // Verify the device actually left application mode: after a successful
  // touch the app-mode port no longer opens. NotFoundError is definitive;
  // on macOS Chrome a departed device instead reports NetworkError
  // "Failed to open serial port" — the same error a wedged-but-alive port
  // produces — so for those, settle and look once more before believing
  // either outcome (observed on hardware: touches that landed were logged
  // as failures and the user was wrongly told to press reset).
  try {
    await openTouchWithRecovery(appPort, { baudRate: 115200 });
    await appPort.close();
    return { result: 'app-live' };
  } catch (e) {
    if (e?.name === 'NotFoundError') return { result: 'touched' };
    if (!deviceGone(e)) return { result: 'inconclusive', error: e?.message };
    const recheck = await reopenAfterSettle(appPort, cancelled);
    if (recheck === 'gone') return { result: 'touched' };
    if (recheck === 'open') return { result: 'app-live', wedged: true };
    return { result: 'inconclusive', error: e?.message };
  }
}

// macOS can wedge a serial open indefinitely after rapid open/close cycling
// (observed repeatedly on hardware: the wizard sat on 'Restarting…' for
// 3.5 minutes with no log and no way out). Every touch-phase open is
// therefore bounded; a stalled open fails the attempt, which is retried.
const TOUCH_OPEN_TIMEOUT_MS = 8000;
let touchOpenTimeoutMs = TOUCH_OPEN_TIMEOUT_MS;

/** Test seam: shrink the stall bound so stalled-port scenarios run fast. */
export function setTouchOpenTimeoutForTests(ms) {
  touchOpenTimeoutMs = ms;
}

/**
 * The touch-phase bounded open: the shared openPortBounded with the touch's
 * stall wording (its lowercase message is part of the attempt log contract)
 * and the 1200-baud late-note — a late 1200-baud close IS the restart
 * signal: the device simply enters update mode, which the next verify
 * catches. The late release itself is generation-guarded inside
 * openPortBounded, so a zombie touch open can never close a port a newer
 * connect attempt has claimed.
 */
function openBounded(port, opts) {
  return openPortBounded(port, opts, {
    timeoutMs: touchOpenTimeoutMs,
    stallMessage: 'the serial port did not respond',
    onLateOpen: () => {
      if (opts?.baudRate === 1200) {
        log('A stalled restart signal was sent late — the LipSync may enter update mode.', 'log-info');
      }
    },
  });
}

// True while an open() on the touch port is believed stuck at the OS level
// (the macOS wedged-port pathology: the open NEVER settles within the page
// session — hardware showed it still pending after 16+ s, blocking every
// later attempt with "A call to open() is already in progress" for minutes).
// The flag lives in utils/port-open.js (isPortOpenWedged) so every settled
// open anywhere — Connect's included — clears it; this module only SETS it.
// While set, in-progress errors are not waited out again — the wait proved
// futile.

/**
 * The touch-phase open with hardware-wedge recoveries:
 *  - "A call to open() is already in progress": an earlier open is still
 *    pending. Wait past the open bound once (it may land — its late handler
 *    releases the port — or reject). If the retry says "in progress" too,
 *    the open is OS-stuck for good: flag the wedge and fail fast — grinding
 *    more attempts just stalls the user for minutes on a port only a device
 *    reset, replug, or reload can free.
 *  - "The port is already open": a stalled close left the port open. Close
 *    it — outcome-checked, because a close stuck as "already in progress"
 *    means this attempt cannot proceed — settle, and retry.
 * Anything else rethrows: the attempt loop backs off, and repeated failure
 * lands on the honest guidance.
 */
async function openTouchWithRecovery(port, opts) {
  try {
    return await openBounded(port, opts);
  } catch (e) {
    const msg = e?.message ?? '';
    if (/already in progress/i.test(msg)) {
      if (isPortOpenWedged()) throw e; // already proven stuck — fail fast
      log('A previous open is still settling on this port — waiting for it before retrying…', 'log-info');
      await sleep(touchOpenTimeoutMs + 500);
      try {
        return await openBounded(port, opts);
      } catch (e2) {
        if (/already in progress/i.test(e2?.message ?? '')) {
          markPortOpenWedged();
          log(
            'The serial port has wedged — an open is stuck at the OS level and will not settle. It clears with a device reset (press the small reset button twice, slowly), a replug, or a page reload.',
            'log-err',
          );
        }
        throw e2;
      }
    }
    if (!/already open/i.test(msg)) throw e;
    // "The port is already open" is itself a settled answer — responsive.
    log('The port was left open by the last session — closing it and retrying…', 'log-info');
    const close = await closePortWithOutcome(port);
    if (close.outcome !== 'closed') {
      log(
        'The port would not close (' +
          (close.error?.message ?? close.outcome) +
          '). Unplug the LipSync or reload the page, then try again.',
        'log-err',
      );
      throw e;
    }
    await sleep(300);
    return openBounded(port, opts);
  }
}

/** Did the port fail because the device behind it has departed? */
function deviceGone(e) {
  return (
    e?.name === 'NotFoundError' ||
    /no longer|not connected|disconnected|failed to open serial port/i.test(e?.message ?? '')
  );
}

/** Reopens the port after the enumeration settle window: 'open' | 'gone' | 'other'. */
async function reopenAfterSettle(appPort, cancelled) {
  await sleep(TOUCH_RECHECK_SETTLE_MS);
  if (cancelled?.()) return 'other';
  try {
    await openTouchWithRecovery(appPort, { baudRate: 115200 });
    await appPort.close();
    return 'open';
  } catch (e) {
    return deviceGone(e) ? 'gone' : 'other';
  }
}

/**
 * Runs the touch up to TOUCH_MAX_ATTEMPTS times, logging every outcome so
 * hardware sessions are diagnosable from the exported log. Returns whether
 * the device ended up in update mode.
 */
// The in-flight touch attempt, if any — cancelWizard settles it before
// closing the wizard so no half-finished open/close sequence survives into
// the next connection (observed on hardware: a cancelled touch's leftover
// open later closed the port under a fresh Connect, surfacing as
// "The device has been lost" and blocking opens with "already in progress").
let activeTouchOp = null;

// The in-flight flash, if any — settled for the same reason: a cancelled
// flash's teardown close (bounded, but potentially seconds away inside the
// erase dwell or a wedged close) must never outlive the wizard and close a
// port a newer flow has claimed. Bounded settle: the flash's own abort
// checkpoints make the normal unwind prompt.
let activeFlashOp = null;

/** Hint-only update: the step text (live region) stays untouched — retry
 *  liveness is visual information, not worth a re-announcement. */
function setWizardHint(text) {
  const el = $('fwWizardHint');
  if (el) el.textContent = text ?? '';
}

/**
 * Runs the touch up to TOUCH_MAX_ATTEMPTS times, logging every outcome so
 * hardware sessions are diagnosable from the exported log. Returns whether
 * the device ended up in update mode.
 * @param {() => boolean} [cancelled]
 * @param {{ skipWake?: boolean, onAttempt?: (attempt: number) => void }} [options]
 *  `onAttempt` fires when a retry is about to start (attempt numbers count
 *  from 2) — the wizard uses it to keep the restart step visibly alive.
 */
async function tryTouchDevice(appPort, cancelled, options = {}) {
  let stalled = false;
  let unplugged = false;
  let lastError = null;
  for (let attempt = 1; attempt <= TOUCH_MAX_ATTEMPTS; attempt++) {
    if (cancelled?.()) return { touched: false, stalled, unplugged };
    const op = attemptTouchOnce(appPort, cancelled, attempt, options);
    activeTouchOp = op;
    let r;
    try {
      r = await op;
    } finally {
      activeTouchOp = null;
    }
    if (r.result === 'cancelled') return { touched: false, stalled, unplugged };
    if (r.result === 'touched') {
      if (wizard) wizard.touchLanded = true;
      log(
        attempt === 1
          ? 'Device restarted into update mode.'
          : `Device restarted into update mode on retry (attempt ${attempt}).`,
        'log-info',
      );
      return { touched: true, stalled: false, unplugged: false };
    }
    if (r.error) lastError = r.error;
    // The stall error can surface through either classification — the
    // 1200-open path reports non-gone failures as 'app-live' with the error.
    if (r.error?.includes('did not respond')) stalled = true;
    if (r.error?.includes('unplugged')) unplugged = true;
    if (attempt < TOUCH_MAX_ATTEMPTS) {
      log(
        `Automatic restart attempt ${attempt} did not take${r.error ? ' (' + r.error + ')' : ''} — retrying…`,
        'log-info',
      );
      options.onAttempt?.(attempt + 1);
    }
  }
  log(
    `Automatic restart failed after ${TOUCH_MAX_ATTEMPTS} attempts${lastError ? ' (' + lastError + ')' : ''}.` +
      (stalled
        ? ' Unplug the LipSync, plug it back in, and try the update again.'
        : isPortOpenWedged()
          ? ' The serial port wedged — press the small reset button on the Hub twice, slowly, to enter update mode; a replug or page reload also clears it.'
          : unplugged
            ? ' Check that the LipSync is plugged in securely (try another USB cable or port).'
            : ''),
    'log-err',
  );
  return { touched: false, stalled, unplugged, wedged: isPortOpenWedged() };
}

/**
 * The shared flash path used by both the release-update button and local
 * file flashing: snapshot → confirm → 1200-baud touch → bootloader port →
 * serial DFU → await reconnect.
 */
async function runFlashWizard({ pkg, targetVersion }) {
  if (wizard) throw new Error('An update is already in progress.');
  if (!serialSession.port) throw new Error('Connect the LipSync before updating its firmware.');
  wizard = {
    stage: 'snapshot',
    target: targetVersion,
    pkg,
    abort: new AbortController(),
  };
  setWizardVisible(true);
  setWizardStage('backup');
  lockSessionButtons(true);
  // A cancel aborts the wizard's signal and nulls it mid-flight; the touch
  // loop watches both so an in-flight attempt exits at its next checkpoint.
  const cancelled = () => !wizard || wizard.abort.signal.aborted;
  try {
    setWizardStep('Backing up your settings…', {
      showCancel: true,
      showBackup: false,
    });
    const snapshot = captureSettingsSnapshot();
    wizard.snapshot = snapshot;
    writePending({ target: targetVersion, snapshot, installed: false });
    downloadSettingsBackup(snapshot);
    setWizardStep(`Settings backed up — a backup file was downloaded. Installing firmware ${targetVersion}…`, {
      showCancel: true,
      showBackup: true,
    });

    const what =
      targetVersion === 'unknown version' ? 'this firmware package' : `firmware <strong>${targetVersion}</strong>`;
    const confirmed = await showConfirm(
      'Update firmware',
      `Install ${what} on the LipSync?` +
        '<br>Keep the device plugged in until the update finishes — the whole update takes about a minute. The Hub will restart once or twice.',
    );
    if (!confirmed) {
      cancelWizard('Update cancelled. Nothing was changed.');
      return;
    }

    setWizardStage('restart');
    // The logical stage keys the cancel copy: during the SR command and the
    // settle, 'restart' is the honest key (the device may or may not have
    // gotten the signal), not the stale 'snapshot' default.
    wizard.stage = 'restart';
    const appPort = serialSession.port;
    if (!appPort) {
      throw new Error('The connection was lost before the update could start. Reconnect and retry.');
    }
    let touched = false;
    let stalled = false;
    let unplugged = false;
    let wedged = false;
    let umSent = false;
    // UM-first (firmware ≥ 4.3.0): one ack'd exchange over the live session
    // replaces the SR reboot + 1200-baud touch, and the Hub's screen shows
    // the deliberate "Update mode" splash instead of freezing on
    // "Restarting". Older firmware (or any delivery failure) takes the
    // established SR-first + touch choreography below unchanged.
    const deviceVersion = ($('version')?.textContent || '').trim();
    const versionVsUm = compareVersions(deviceVersion, UM_FIRMWARE_MIN_VERSION);
    if (versionVsUm !== null && versionVsUm >= 0) {
      setWizardStep('Switching the LipSync to update mode…', {
        showCancel: true,
        hint: 'The Hub will show an “Update mode” screen while it waits for the flash.',
      });
      const updateMode = await attemptUpdateModeRestart(cancelled, wizard.abort.signal);
      if (cancelled()) return;
      umSent = updateMode === 'sent';
    }
    if (!umSent) {
      setWizardStep('Restarting the LipSync into update mode…', {
        showCancel: true,
        hint: 'This usually takes a few seconds — the wizard retries automatically if the first try does not take.',
      });
      // SR-first: reboot over the live session (wedge-free re-enumeration),
      // then touch the fresh enumeration — no wake pulse needed, the device
      // just booted. On failure ('unavailable') fall back to the standard
      // close-then-touch choreography below. The wizard's abort signal rides
      // along: a cancel during the command's handshake stops the SR bytes
      // from ever being written instead of rebooting a cancelled update.
      const softReset = await attemptSoftResetRestart(cancelled, wizard.abort.signal);
      if (cancelled()) return;
      if (softReset !== 'sent') {
        await disconnect({ quiet: true });
        if (cancelled()) return;
        // Ground truth (observed on hardware): a rapid close/open cycle is the
        // main cause of a macOS port refusing to open — and the session close
        // above JUST completed. Give the OS a beat first.
        await sleep(touchSettleAfterDisconnectMs);
        if (cancelled()) return;
      }
      lockSessionButtons(true);
      wizard.stage = 'enter-bootloader';
      try {
        ({ touched, stalled, unplugged, wedged } = await tryTouchDevice(appPort, cancelled, {
          skipWake: softReset === 'sent',
          // Visible liveness on retries (hint region only — the step text is a
          // live region and must not re-announce every attempt).
          onAttempt: (n) => setWizardHint(`Still restarting — automatic retry ${n} of ${TOUCH_MAX_ATTEMPTS}…`),
        }));
      } catch (e) {
        log('Could not restart the device automatically: ' + e.message, 'log-err');
      }
      if (cancelled()) return;
    }
    wizard.stage = 'await-bootloader-port';
    setWizardStatus('Firmware update — choose the update port');
    setWizardStep(
      umSent
        ? 'The LipSync is in update mode. Click Continue, then pick it in the browser dialog — it may be named “XIAO nRF52840” or “XIAO nRF52840 Sense”.'
        : touched
          ? 'Select the update port: click Continue, then pick the LipSync in the browser dialog — it may be named “XIAO nRF52840” or “XIAO nRF52840 Sense”.'
          : stalled
            ? 'The serial port stopped responding. Unplug the LipSync, plug it back in, wait a few seconds — then click Continue and pick the update loader.'
            : wedged
              ? 'The serial port wedged while restarting (a macOS quirk after a settings session). Press the small reset button on the Hub twice, slowly — the device enters update mode by itself — then click Continue and pick the update loader. (Unplugging and replugging, or reloading the page, also clears it.)'
              : unplugged
                ? 'The LipSync is not responding — check that it is plugged in securely (try another USB cable or port), then click Continue.'
                : 'The automatic restart did not take. Press the small reset button on the Hub twice, slowly — the device enters update mode by itself — then click Continue.',
      {
        hint: umSent
          ? 'In update mode the Hub\u2019s screen shows an \u201cUpdate mode — use the LipSync Connect app\u201d message; its lights go quiet. If the device does not appear in the dialog, unplug it, plug it back in, and press reset twice (slowly).'
          : 'In update mode the Hub\u2019s screen goes dark or stays frozen on its last message (you may still see \u201cRestarting\u201d) — the screen is not live, and that is normal. Its lights go quiet too. If the device does not appear in the dialog, unplug it, plug it back in, and press reset twice (slowly).',
        showContinue: true,
        showCancel: true,
        showBackup: true,
      },
    );
  } catch (e) {
    // A cancel already closed the wizard — never reopen it as a failure.
    if (!wizard) return;
    failWizard(e);
  }
}

async function continueWizard() {
  if (!wizard || wizard.stage !== 'await-bootloader-port') return;
  // Latch the stage synchronously: while this invocation awaits the port
  // picker (or the self-heal restart), a second Continue click must no-op at
  // the entry check instead of racing a second picker/flash against this
  // flow. Every await below re-verifies ownership before mutating state.
  wizard.stage = 'picking';
  const stillOurs = () => wizard?.stage === 'picking';
  let port = null;
  // The flash's pending identity, captured the moment the flash is armed so
  // the catch below can preserve the STOP-window truth without reaching into
  // block-scoped state that may not exist when an earlier step threw.
  let flashTarget = null;
  let flashSnapshot = null;
  setWizardStep('Waiting for the update port…', { showBackup: true });
  try {
    try {
      port = await requestDfuPort({ avoidPort: lastFlashFailurePort });
    } catch (e) {
      if (e?.name !== 'NotFoundError') throw e;
      // The picker was dismissed. Stay on this step so Continue works again
      // instead of dumping the user into a failure panel.
      if (!stillOurs()) return;
      wizard.stage = 'await-bootloader-port';
      setWizardStep(
        'No update port was selected. Make sure the LipSync is in update mode — press the small reset button on the Hub twice, slowly — then click Continue again.',
        {
          showContinue: true,
          showCancel: true,
          showBackup: true,
          hint: 'If the device was unplugged, plug it back in first.',
        },
      );
      return;
    }
    if (!stillOurs()) return; // cancelled (or superseded) while the picker was open
    // Self-heal: when the picked port carries the LipSync's app-mode USB
    // identity, the automatic restart never took and the user just picked
    // the still-running LipSync. Retry the restart on this very port instead
    // of failing — a manual reset stays the last resort, not the required
    // path. Non-LipSync devices never qualify: the probe below rejects them
    // without pulsing 1200 baud into foreign hardware.
    const pickedInfo = port?.getInfo?.() ?? {};
    const pickedIsLipSyncApp = pickedInfo.usbVendorId === USB_VENDOR_ID && !isBootloaderPort(port);
    if (pickedIsLipSyncApp) {
      log('The selected port is the running LipSync, not its update loader — restarting the device again.', 'log-err');
      setWizardStatus('Firmware update — restarting the device again');
      setWizardStep('Restarting the LipSync into update mode again…', {
        showCancel: true,
        hint: 'This usually takes a few seconds — the wizard retries automatically if the first try does not take.',
      });
      let touched = false;
      let stalled = false;
      let unplugged = false;
      let wedged = false;
      try {
        ({ touched, stalled, unplugged, wedged } = await tryTouchDevice(
          port,
          () => !wizard || wizard.abort.signal.aborted,
          {
            onAttempt: (n) => setWizardHint(`Still restarting — automatic retry ${n} of ${TOUCH_MAX_ATTEMPTS}…`),
          },
        ));
      } catch (e) {
        log('Could not restart the device automatically: ' + e.message, 'log-err');
      }
      if (!stillOurs()) return;
      wizard.stage = 'await-bootloader-port';
      setWizardStatus('Firmware update — choose the update port');
      setWizardStep(
        touched
          ? 'The LipSync is now in update mode. Click Continue and pick the update loader in the browser dialog.'
          : wedged
            ? 'The serial port wedged (a macOS quirk). Press the small reset button on the Hub twice, slowly — the device enters update mode by itself — then click Continue and pick the update loader. (A replug or page reload also clears it.)'
            : stalled
              ? 'The serial port stopped responding. Unplug the LipSync, plug it back in, wait a few seconds — then click Continue and pick the update loader.'
              : unplugged
                ? 'The LipSync is not responding — check that it is plugged in securely (try another USB cable or port), then click Continue.'
                : 'The automatic restart keeps failing. Press the small reset button on the Hub twice, slowly — the device enters update mode by itself — then click Continue.',
        {
          hint: 'In update mode the Hub\u2019s screen goes dark or stays frozen on its last message — the screen is not live, and that is normal.',
          showContinue: true,
          showCancel: true,
          showBackup: true,
        },
      );
      return;
    }
    const { target, snapshot, pkg, abort } = wizard;
    flashTarget = target;
    flashSnapshot = snapshot;
    // A prior flash that was cancelled mid-erase or in its STOP wait may
    // still be winding down (its bounded teardown close). Its leftover close
    // must never tear down the port THIS flash is about to claim — settle
    // it first (bounded: a wedged teardown close must not block a new
    // attempt forever; the flash open's own recovery handles any leftover).
    if (activeFlashOp) {
      await Promise.race([
        activeFlashOp.then(
          () => undefined,
          () => undefined,
        ),
        sleep(2500),
      ]);
    }
    // The session's beforeunload guard was removed by the wizard's own
    // disconnect; the flash holds a real serial port, so warn on tab close
    // for exactly this window.
    window.addEventListener('beforeunload', handleBeforeUnload);
    wizard.stage = 'flashing';
    // Mark the pending update the moment flashing begins: this is the signal
    // that lets a later reconnect (or a page-reload survivor) distinguish
    // "device already on the target version" from "update never happened".
    writePending({ target, snapshot, installed: false, flashStarted: true });
    setWizardStage('flash');
    lockSessionButtons(true);
    setWizardStatus('Updating firmware…');
    log('Flashing firmware ' + target + ' over the device bootloader…', 'log-info');
    let announcedMilestone = 0;
    let transferStart = 0;
    const flashOp = flashSerialDfu({
      port,
      bin: pkg.bin,
      dat: pkg.dat,
      signal: abort.signal,
      // Once the bootloader accepts START, the old application is being erased:
      // an interruption from here on strands the device in its update loader.
      // The failure and cancel copy must say so instead of promising normal boot.
      onStartAccepted: () => {
        if (wizard) wizard.postStart = true;
      },
      onProgress: (p) => {
        let etaSec;
        if (p.stage === 'transfer') {
          if (!transferStart) transferStart = Date.now();
          const fraction = (p.percent ?? 0) / 100;
          const elapsed = (Date.now() - transferStart) / 1000;
          if (fraction > 0.05) etaSec = Math.max(1, Math.round((elapsed / fraction) * (1 - fraction)));
        }
        setWizardStep(p.stage === 'transfer' ? 'Sending firmware…' : p.message, {
          percent: p.percent ?? null,
          etaSec,
          showCancel: true,
          showBackup: true,
          cancelLabel: 'Stop update',
          hint: p.stage === 'transfer' ? 'Usually under a minute; keep the device plugged in.' : undefined,
        });
        // The bar and percentage are visual-only (not in the live region) —
        // announce a short milestone instead so screen-reader users hear
        // progress without per-frame chatter.
        const milestone = p.percent === null ? 0 : Math.floor(p.percent / 25);
        if (p.stage === 'transfer' && milestone > announcedMilestone) {
          announcedMilestone = milestone;
          if (p.percent < 100) announceStatus(`Firmware ${Math.round(p.percent)}% sent.`);
        }
      },
    });
    // Track the in-flight flash like the touch op: a cancel (or a superseding
    // flow) settles it before tearing anything down, so its teardown close can
    // never outlive the wizard and land on a port a newer flow has claimed.
    activeFlashOp = flashOp;
    try {
      await flashOp;
    } finally {
      if (activeFlashOp === flashOp) activeFlashOp = null;
    }
    // The flash completed on this port: it is trusted again for silent reuse.
    lastFlashFailurePort = null;
    if (!wizard || wizard.abort.signal.aborted) {
      // Cancelled inside the final STOP window — during its ACK wait or in
      // the wrap-up after it: the bootloader completed the update anyway.
      // The panel is already closed (or closing — the cancel is settling this
      // very resolution) — keep the restore alive so the next connect
      // verifies and restores instead of silently discarding the snapshot.
      writePending({ target, snapshot, installed: true });
      log(
        'The update finished just as it was cancelled. Reconnect to have it verified and your settings restored.',
        'log-info',
      );
      return;
    }
    wizard.stage = 'await-reconnect';
    setWizardStage('restore');
    // The reconnect step lives or dies by the Connect button: hand the
    // session controls back to the actual session state.
    lockSessionButtons(false);
    writePending({
      target: wizard.target,
      snapshot: wizard.snapshot,
      installed: true,
    });
    log('Firmware installed. Reconnect to verify and restore settings.', 'log-info');
    setWizardStatus('Firmware update — reconnect the LipSync');
    setWizardStep(
      'Firmware installed! The LipSync is restarting. Wait ~30 seconds, then click Connect and pick the LipSync. Your settings will be restored automatically.',
      {
        percent: 100,
        showBackup: true,
        hint: 'Update mode and normal mode can show the same port name — waiting (or a quick unplug/replug) clears the stale entry. If the device does not respond, unplug and replug it first.',
      },
    );
  } catch (e) {
    // The flash was aborted by the wizard's own cancel: this is a cancel,
    // not a failure. cancelWizard settles this very rejection (capturing
    // its outcome — a StopWindowError there preserves the flashStarted
    // pending entry) before nulling the wizard, so the wizard may still be
    // alive here for a moment — never reopen it as a failure panel.
    if (wizard?.abort.signal.aborted) return;
    // A cancel already closed the wizard — do not reopen it as a failure.
    // The one exception: a flash that outlived the cancel's settle window
    // and THEN rejected as a STOP-window ambiguity (the update may have
    // completed) — preserve the flashStarted state so the reconnect can
    // verify/restore (or honestly route to Recover). Nothing wipes it
    // afterwards: the wipe already happened inside cancelWizard.
    if (!wizard) {
      if (e?.name === 'StopWindowError') {
        writePending({
          target: flashTarget,
          snapshot: flashSnapshot,
          installed: false,
          flashStarted: true,
        });
        log(
          'The update was finishing when it was cancelled — it may have completed on its own. Reconnect to find out: your settings will be restored automatically if it finished.',
          'log-info',
        );
      }
      return;
    }
    // Whatever failed, this port did not answer as an update loader this
    // time: never silently reuse it again — the next attempt must show the
    // picker, or the "pick the update loader again" guidance is a lie the
    // user can only escape with a physical replug (observed on hardware).
    lastFlashFailurePort = port;
    if (e?.name === 'StopWindowError') {
      // The STOP packet itself triggers validate + activate + reboot, and the
      // port vanishes within ~1s of its ACK. A failure in that window once
      // the STOP bytes were written — link drop, a detach that ate the ACK,
      // or a late cancel — may mean the device already accepted STOP and is
      // rebooting with the new firmware: reporting "Update failed" here would
      // be a lie. The pending flashStarted entry settles the truth on
      // reconnect: the finisher restores settings if the version matches, or
      // the Connect guard routes to Recover if the device is still in its
      // update loader.
      wizard.stage = 'await-reconnect';
      wizard.stopWindowHedge = true;
      setWizardStage('restore');
      setWizardStatus('Firmware update — reconnect the LipSync');
      // The reconnect step needs the Connect button: hand the session
      // controls back for it.
      lockSessionButtons(false);
      log(
        'The connection dropped while the update was finishing — it may have completed. Reconnect to verify.',
        'log-info',
      );
      setWizardStep(
        'The update was finishing when the connection dropped — it usually completes on its own. Wait ~30 seconds, then click Connect and pick the LipSync: your settings will be restored automatically if it finished, or the Firmware section will offer recovery if it did not.',
        {
          percent: 100,
          showBackup: true,
          hint: 'Unplug and replug the LipSync if it does not appear, then click Connect.',
        },
      );
      return;
    }
    if (e?.staleLoaderSession) {
      // A live bootloader rejected the probe because it is still holding the
      // interrupted attempt's transport state (hardware-observed: a recovery
      // started immediately after a cancelled post-START flash). Only a
      // fresh enumeration clears it; the message names that remedy, and the
      // wizard stays on its picker step for the Continue after it.
      wizard.stage = 'await-bootloader-port';
      setWizardStatus('Firmware update — choose the update port');
      log(e.message, 'log-err');
      setWizardStep(e.message, {
        showContinue: true,
        showCancel: true,
        showBackup: true,
      });
      return;
    }
    if (e?.name === 'PortStallError') {
      // The update loader's port did not answer its open — the wedged-open
      // pathology. Nothing was written (the exchange never began), so the
      // honest step is the picker with its Continue button — the stall
      // message's "click Continue and pick it again" must name a button
      // that exists on the panel it appears on. The message goes to the log
      // too: hardware sessions are diagnosed from the exported log.
      wizard.stage = 'await-bootloader-port';
      setWizardStatus('Firmware update — choose the update port');
      log(e.message, 'log-err');
      setWizardStep(e.message, {
        showContinue: true,
        showCancel: true,
        showBackup: true,
      });
      return;
    }
    if (deviceGone(e)) {
      // A previously-granted port whose device has since disconnected (e.g.
      // the bootloader left after a reboot) — reported as NotFoundError or
      // macOS Chrome's NetworkError "Failed to open serial port". Back to
      // the picker, not a failure panel. Past START an interruption strands
      // the device in its update loader, so the copy must not promise a
      // normally-running LipSync — and it offers Recover, so reveal it too.
      wizard.stage = 'await-bootloader-port';
      if (wizard.postStart) setBootloaderStranded();
      setWizardStep(
        wizard.postStart
          ? 'The connection was lost during the update — the LipSync now starts in its update loader. Replug it, click Continue, and pick the update loader to finish the update (or use Recover).'
          : 'The update loader is no longer connected. If the LipSync is running normally, click Continue and try again; if not, press its reset button twice, slowly, first.',
        { showContinue: true, showCancel: true, showBackup: true },
      );
      return;
    }
    failWizard(e);
  } finally {
    window.removeEventListener('beforeunload', handleBeforeUnload);
    // NB: the session buttons stay locked through await-bootloader-port,
    // picking, and flashing — the wizard owns the flow for its lifetime and
    // the await-reconnect transitions unlock them explicitly (a mid-flow
    // Connect derails the choreography). Failure and cancel paths unlock
    // through failWizard/cancelWizard.
  }
}

function failWizard(e) {
  const message = e?.message ?? String(e);
  const duringFlash = wizard?.stage === 'flashing' || wizard?.stage === 'await-reconnect';
  const postStart = wizard?.postStart === true;
  // The post-START hint names the Recover button: reveal it NOW. Leaving it
  // to the connect guard forces the user to attempt a Connect (and pick the
  // bootloader port) before the button the message sends them to even
  // exists — and a page reload loses the marker entirely.
  if (duringFlash && postStart) setBootloaderStranded();
  log('Firmware update failed: ' + message, 'log-err');
  wizard = { ...wizard, stage: 'failed', failedDuringFlash: duringFlash };
  lockSessionButtons(false);
  resetStatusIfDisconnected();
  setWizardVisible(true, 'failed');
  setWizardStep('Update failed: ' + message, {
    showCancel: true,
    showBackup: true,
    hint:
      duringFlash && postStart
        ? // START was accepted: the app region is erased/partial, so every reset
          // and replug lands back in the update loader — only a complete flash
          // repairs it. Never claim a normal boot here.
          'The update was interrupted while the device\u2019s memory was being rewritten. The LipSync now starts in its update loader — open Firmware and use \u201cRecover a device stuck in update mode\u201d to repair it.'
        : duringFlash
          ? 'The LipSync is not harmed — the update stopped before anything was written to its memory. You can retry.'
          : 'Your LipSync is not harmed — nothing was written, or the bootloader kept itself intact. You can retry.',
  });
}

async function cancelWizard(message) {
  const stage = wizard?.stage;
  const failedDuringFlash = !!wizard?.failedDuringFlash;
  const postStart = wizard?.postStart === true;
  const stopWindowHedge = wizard?.stopWindowHedge === true;
  const recovery = !!wizard?.recovery;
  const srWritten = wizard?.srWritten === true;
  const umWritten = wizard?.umWritten === true;
  const cancelTarget = wizard?.target;
  const cancelSnapshot = wizard?.snapshot;
  // An interrupted flash past START strands the device in its update loader,
  // and both the cancel and failure copy send the user to Recover — so the
  // button must be visible the moment that copy is shown, not only after the
  // next Connect attempt re-discovers the stranded state (and never mind a
  // page reload, which would lose a connect-guard-set marker).
  if ((stage === 'flashing' || failedDuringFlash) && postStart) setBootloaderStranded();
  try {
    wizard?.abort.abort();
  } catch {}
  // Settle any in-flight touch or flash operation BEFORE tearing the wizard
  // down: leftover open/close continuations must never outlive the cancel
  // (observed on hardware: a zombie close killed the next connection, and a
  // still-pending open blocked it with "already in progress"). The settle
  // window bounds how long Cancel waits for the panel to close — it does
  // NOT bound the zombie: an open wedged past the window is made harmless by
  // the port-generation guard, and a flash still unwinding is settled again
  // by the next flow before it claims the port. The settled flash's OUTCOME
  // is captured too: a rejection tagged StopWindowError means the cancel
  // raced the final STOP exchange and the update may have completed — the
  // pending entry must survive below, or the reconnect could never find out.
  let flashOutcome = null;
  if (activeFlashOp) {
    await Promise.race([
      activeFlashOp.then(
        () => {
          flashOutcome = 'settled';
        },
        (e) => {
          flashOutcome = e;
        },
      ),
      sleep(2500),
    ]);
  } else if (activeTouchOp) {
    await Promise.race([
      activeTouchOp.then(
        () => undefined,
        () => undefined,
      ),
      sleep(2500),
    ]);
  }
  const touchLanded = wizard?.touchLanded === true;
  // A cancel whose flash settled as a STOP-window ambiguity gets the hedge
  // wording wherever it fell in the stage tree: the update may have completed
  // on its own, and "use Recover"/"nothing was changed" would both be guesses.
  const stopWindowCancel = flashOutcome?.name === 'StopWindowError';
  // A flash that RESOLVED despite the abort completed the whole update — the
  // cancel lost the race to the STOP window's wrap-up. Only a mid-erase or
  // mid-DATA cancel can resolve after the abort; that path rejects instead.
  const flashCompletedDespiteCancel = flashOutcome === 'settled' && (stage === 'flashing' || failedDuringFlash);
  wizard = null;
  // The pending entry's fate: a hedge keeps the flashStarted truth for the
  // reconnect; a completed-despite-cancel flash keeps the installed truth;
  // every other cancel discards the pending state as before. A flash that
  // outlived the settle window settles its own fate late (the continueWizard
  // catch's !wizard branch) — nothing wipes after this point.
  if (stopWindowHedge || stopWindowCancel) {
    writePending({
      target: cancelTarget,
      snapshot: cancelSnapshot,
      installed: false,
      flashStarted: true,
    });
  } else if (flashCompletedDespiteCancel) {
    writePending({
      target: cancelTarget,
      snapshot: cancelSnapshot,
      installed: true,
    });
  } else {
    writePending(null);
  }
  completedSnapshot = null;
  lockSessionButtons(false);
  resetStatusIfDisconnected();
  setWizardVisible(false);
  setWizardStep('', { percent: null });
  // Cancelling mid-flash leaves a partial image in the bootloader's hands:
  // past START the app region is erased, so the device starts in its update
  // loader and only a complete flash repairs it — say exactly that. Before
  // START nothing was touched and a normal boot is the honest claim.
  // The restore-retry panels are a different story: the flash already finished.
  // A cancel during the restart itself is honest about its uncertainty:
  // only claim update mode when a touch demonstrably landed — and only claim
  // the device stays put when the soft-reset signal provably never went out.
  const finalMessage =
    message ??
    (recovery &&
    (stage === 'await-bootloader-port' || stage === 'picking' || stage === 'flashing' || stage === 'download')
      ? 'Recovery cancelled. The LipSync remains in update mode — its firmware stays incomplete until a full recovery finishes. Use Recover again to repair it.'
      : stage === 'restore-pending'
        ? 'Update cancelled. The firmware update itself finished — your settings were not restored automatically. Re-enter any missing settings from your downloaded backup file if needed.'
        : stage === 'flashing' || failedDuringFlash
          ? flashCompletedDespiteCancel
            ? 'Update cancelled — the firmware update finished anyway. Reconnect to have it verified and your settings restored automatically.'
            : stopWindowCancel
              ? 'Update cancelled while the update was finishing — it may or may not have completed. Reconnect the LipSync to find out: if it starts normally the update finished; if it stays in update mode, use Recover to repair it. Your settings will be restored automatically if it finished.'
              : postStart
                ? 'Update stopped partway — the LipSync is now in its update loader. Use \u201cRecover a device stuck in update mode\u201d in the Firmware section to repair it.'
                : 'Update stopped before anything was written. Unplug and replug the LipSync (or press reset once) and it starts normally again, then retry.'
          : stage === 'await-reconnect' || stage === 'mode-restored'
            ? stopWindowHedge
              ? 'Update dismissed. The update may or may not have completed — reconnect the LipSync to find out: if it starts normally the update finished; if it stays in update mode, use Recover to repair it.'
              : 'Restore cancelled. The firmware update itself finished — re-enter any missing settings from your backup file if needed.'
            : stage === 'restart'
              ? umWritten
                ? // The UM ack was received before the cancel: the device is
                  // entering its update loader regardless of anyone waiting.
                  'Update cancelled. The update-mode signal was already sent — the LipSync is entering its update loader. Unplug and replug it (or press its reset button once) to start it normally, then reconnect.'
                : srWritten
                  ? // The SR ack was received before the cancel: the reboot is
                    // happening regardless of anyone waiting for it.
                    'Update cancelled. The restart signal was already sent — the LipSync restarts on its own. Wait a few seconds, then reconnect as usual.'
                  : // The cancel may have landed anywhere inside the SR command —
                    // including between its write and its milliseconds-fast ack,
                    // where the device reboots anyway. Promise nothing.
                    'Update cancelled. The LipSync may still restart on its own if the restart signal had already been sent — wait a few seconds before reconnecting.'
              : (stage === 'enter-bootloader' || stage === 'await-bootloader-port' || stage === 'picking') &&
                  (touchLanded || umWritten)
                ? // "was", not "is": the touch landed at restart time, but the user
                  // may have replugged since (the picker hint tells them to when
                  // the device does not appear) — the claim must survive that.
                  'Update cancelled. The LipSync was restarted into update mode — unplug and replug it (or press its reset button once) to start it normally, then reconnect.'
                : stage === 'enter-bootloader' || stage === 'await-bootloader-port' || stage === 'picking'
                  ? 'Update cancelled while the LipSync was restarting — its state is uncertain. Wait a few seconds: if the screen shows its normal menu again, connect as usual; if it shows nothing or a frozen message, unplug and replug it once, then connect.'
                  : 'Update cancelled. Nothing was changed.');
  log(finalMessage, 'log-info');
  announceStatus(finalMessage);
}

/** Resolves the latest release entry, fetching a fresh check if needed. */
async function resolveLatestRelease() {
  let entry = readCheckCache();
  // A local-manifest entry's artifacts are rebuilt at will — every
  // dev/firmware/build-firmware.sh run rewrites dist/ — so a cached manifest
  // can describe artifacts that no longer exist, and the install would die
  // at the checksum gate with a confusing error (bench 2026-10-16: check
  // cached one manifest, the bench rebuilt, the install refused the
  // "mismatched" package — correctly, but over stale coordinates). The
  // manifest fetch for a local build is same-origin and free: always take
  // it fresh at install time.
  if (entry?.localArtifactBase) {
    entry = await fetchLatestFirmware();
  }
  if (!entry?.manifest || !entry.manifest.files?.dfu || !(entry.repo || entry.localArtifactBase)) {
    await checkForFirmwareUpdate();
    entry = readCheckCache();
  }
  const manifest = entry?.manifest;
  if (!manifest?.files?.dfu || !(entry?.repo || entry?.localArtifactBase)) {
    // Distinguish "nothing published yet" from "we could not reach the
    // update service" — the latter is what a fresh failed check means.
    const statusState = $('fwUpdateStatus')?.getAttribute('data-state');
    throw new Error(
      statusState === 'warn'
        ? 'Could not reach the update service — check your connection and retry.'
        : 'No downloadable firmware package is available yet.',
    );
  }
  if (!manifest.files.dfu.sha256) {
    // Our release pipeline always publishes a checksum; a release without
    // one is not one of ours and will not be installed.
    throw new Error('The latest release does not publish a checksum — refusing to install it.');
  }
  // The manifest rides the firmware-binaries branch, which is force-updated
  // per release — a failed or raced push can leave the branch disagreeing
  // with the release the API reports as latest. A parsable tag that does
  // not match the manifest's version means the published artifacts do not
  // describe this release: refuse instead of flashing a version nothing
  // vouches for. (Unparsable tags cannot be cross-checked and are allowed.)
  const tagVsManifest = compareVersions(manifest.firmwareVersion, entry.tagName);
  if (tagVsManifest !== null && tagVsManifest !== 0) {
    throw new Error(
      `The published firmware information does not match its release (release ${entry.tagName}, manifest ${manifest.firmwareVersion}) — try again in a little while.`,
    );
  }
  return { entry, target: manifest.firmwareVersion };
}

/** Downloads + checksum-verifies + parses the release's DFU package. */
async function downloadReleasePackage(entry, signal) {
  const manifest = entry.manifest;
  let zipBytes;
  if (entry.localArtifactBase) {
    // Dev-server path (manifest-URL override): the artifact sits next to the
    // manifest under /firmware-files/ — same download → sha256 → parse gate
    // as the release path, just a same-origin fetch.
    const url = entry.localArtifactBase + encodeURIComponent(manifest.files.dfu.fileName);
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Could not download the firmware package (HTTP ${res.status}).`);
    zipBytes = new Uint8Array(await res.arrayBuffer());
  } else {
    zipBytes = await fetchRepoBinary(entry.repo, manifest.files.dfu.fileName, signal);
  }
  const zipBuffer = zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength);
  const sha256 = await sha256Hex(zipBuffer);
  if (sha256 !== manifest.files.dfu.sha256) {
    throw new Error(
      'The downloaded firmware package did not match its published checksum — the published artifacts may have changed. ' +
        'Click “Check for updates” and retry the update.',
    );
  }
  const pkg = await parseDfuPackage(zipBuffer);
  log(`Firmware package ${manifest.files.dfu.fileName} verified (sha256 ${sha256.slice(0, 12)}…).`, 'log-info');
  return pkg;
}

/** Maps raw download-stage failures to honest user-facing copy. */
function downloadFailureFor(e) {
  // Chrome rejects an offline fetch with TypeError "Failed to fetch" — name
  // the condition like the update check does instead of the raw browser error.
  if (e instanceof TypeError) {
    return new Error('Could not reach the update service — check your connection and retry the update.');
  }
  return e;
}

/** Release-update entry point (the “Update to X” button). */
export async function startFirmwareUpdate() {
  const { entry, target } = await resolveLatestRelease();
  wizard = { stage: 'download', target, abort: new AbortController() };
  setWizardVisible(true);
  setWizardStage('backup');
  lockSessionButtons(true);
  try {
    setWizardStep(`Downloading firmware ${target}…`, {
      showCancel: true,
      hint: 'This can take a moment on slower connections.',
    });
    const pkg = await downloadReleasePackage(entry, wizard.abort.signal);
    // A cancel or disconnect during the download must not resurrect the
    // wizard on completion.
    if (!wizard) return;
    if (!serialSession.port) {
      throw new Error('The connection was lost during the download. Reconnect and retry the update.');
    }
    wizard = null;
    await runFlashWizard({ pkg, targetVersion: target });
  } catch (e) {
    // A cancel already closed the wizard — don't reopen it with an error.
    if (!wizard) return;
    failWizard(downloadFailureFor(e));
  }
}

/**
 * Recovery entry point: the device sits in its update loader because its app
 * firmware is incomplete (an interrupted flash erases the app region before
 * writing, and the bootloader has nothing valid to boot — reset and replug
 * both land back in update mode). There is nothing to back up or restart:
 * flash the latest release straight through the bootloader port. Settings
 * survive in the device's separate storage and reappear when it reboots.
 */
/**
 * A restore-pending sentinel panel (the post-reload verify/restore panels)
 * must never block an explicit new firmware action: a user who starts
 * recovery or a local flash has superseded the abandoned restore, and its
 * pending entry is moot (the recovery re-establishes the truth).
 */
function yieldRestorePendingPanel() {
  if (wizard?.stage === 'restore-pending') {
    wizard = null;
    writePending(null);
    setWizardVisible(false);
  }
}

export async function recoverFromBootloader() {
  if (wizard && wizard.stage !== 'restore-pending') throw new Error('An update is already in progress.');
  yieldRestorePendingPanel();
  const { entry, target } = await resolveLatestRelease();
  wizard = {
    stage: 'download',
    target,
    abort: new AbortController(),
    recovery: true,
  };
  setWizardVisible(true);
  // Nothing to prepare or restart — the device is already in update mode.
  setWizardStage('flash');
  lockSessionButtons(true);
  try {
    setWizardStep(`Downloading firmware ${target} for recovery…`, {
      showCancel: true,
      hint: 'This can take a moment on slower connections.',
    });
    const pkg = await downloadReleasePackage(entry, wizard.abort.signal);
    if (!wizard) return;
    wizard.pkg = pkg;
    wizard.stage = 'await-bootloader-port';
    setWizardStatus('Recovery — choose the update port');
    setWizardStep(
      'The LipSync is in update mode. Click Continue and pick the update loader in the browser dialog — it may be named “XIAO nRF52840” or “XIAO nRF52840 Sense”.',
      {
        hint: 'In update mode the Hub\u2019s screen goes dark or stays frozen on its last message — the screen is not live, and that is normal.',
        showContinue: true,
        showCancel: true,
      },
    );
  } catch (e) {
    if (!wizard) return;
    failWizard(downloadFailureFor(e));
  }
}

/** Local-file entry point (the “Flash local file…” button + file picker). */
export async function flashLocalFile(file) {
  if (!file) return;
  if (wizard && wizard.stage !== 'restore-pending') throw new Error('An update is already in progress.');
  yieldRestorePendingPanel();
  if (!serialSession.port) throw new Error('Connect the LipSync before flashing it.');
  if (!/\.zip$/i.test(file.name)) {
    throw new Error(
      'Only adafruit-nrfutil DFU packages (.zip) can be flashed from the browser. (.uf2 files are for the bootloader drive on a computer.)',
    );
  }
  const buffer = await file.arrayBuffer();
  const pkg = await parseDfuPackage(buffer);
  const m = file.name.match(/(\d+\.\d+\.\d+)/);
  const target = m ? m[1] : 'unknown version';
  await runFlashWizard({ pkg, targetVersion: target });
}

/**
 * Runs after a normal settings load: finishes an in-flight update (verify
 * version, restore settings) and otherwise runs the automatic update check.
 */
export async function afterDeviceLoad() {
  clearBootloaderStranded();
  const pending = readPending();
  if (pending?.installed) {
    await finishPendingUpdate(pending);
    return;
  }
  // The page may have died mid-flash (reload, crash, tab close): the
  // bootloader finishes the update on its own, so a device already running
  // the target version with an unmarked pending update is a completed
  // update — verify and restore. `flashStarted` (set the moment flashing
  // began) is what makes "already on the target version" mean "the update
  // flashed" instead of "it never happened" — without it, a same-version
  // local re-flash interrupted before the flash would be mistaken for a
  // completed one. A wizard still parked before its flash (port picker or
  // mid-restart) owns the flow and is excluded.
  const deviceVersion = ($('version')?.textContent || '').trim();
  const preFlashStage = wizard && (wizard.stage === 'await-bootloader-port' || wizard.stage === 'enter-bootloader');
  const interruptedFlashComplete =
    pending &&
    !pending.installed &&
    pending.flashStarted &&
    deviceVersion &&
    deviceVersion === pending.target &&
    !preFlashStage;
  if (interruptedFlashComplete) {
    log('A firmware update that was interrupted mid-flash appears to have completed on its own.', 'log-info');
    await finishPendingUpdate({ ...pending, installed: true });
    return;
  }
  // A local-file flash whose name carried no version triple targets
  // 'unknown version' — the version equality check above can never match,
  // but the bootloader still finished the flash on its own. Restore the
  // settings for whatever firmware is running, with honest copy that the
  // installed version could not be checked against the package name.
  const interruptedUnversionedFlash =
    pending && !pending.installed && pending.flashStarted && pending.target === 'unknown version' && !preFlashStage;
  if (interruptedUnversionedFlash) {
    log('An interrupted local-file update (no version in its name) appears to have completed on its own.', 'log-info');
    await finishPendingUpdate({ ...pending, installed: true });
    return;
  }
  // A completed update whose operating-mode restore rebooted the device once
  // more: that reconnect is the final step — close the wizard cleanly.
  if (wizard?.stage === 'mode-restored') {
    wizard = null;
    setWizardVisible(false);
    setCheckStatus('Firmware update complete.', 'ok');
    // The finisher knows the installed version only — let the auto-check
    // below report what is actually latest instead of fabricating rows.
    setRow('fwCurrentVersion', ($('version')?.textContent || '').trim() || '—');
    log('Firmware update complete.', 'log-info');
    announceFirmwareNews('Firmware update complete.');
  }
  void checkForFirmwareUpdate({ auto: true });
}

async function finishPendingUpdate(pending) {
  const installedVersion = ($('version')?.textContent || '').trim();
  // The post-reconnect panels below run with no wizard in memory (page was
  // reloaded, or the wizard already finished). Cancel from them must not fall
  // through to "Nothing was changed" — the firmware HAS been changed and the
  // settings were NOT restored. A lightweight sentinel wizard gives the
  // cancel path an honest stage to key on (a live await-reconnect wizard
  // already has one). Cancel also clears the pending entry, so the message
  // must own up to losing the automatic restore.
  const armPendingPanel = () => {
    if (!wizard)
      wizard = {
        stage: 'restore-pending',
        snapshot: pending.snapshot,
        abort: new AbortController(),
      };
    setWizardVisible(true);
    // The tracker must say where the flow stands — a pending panel IS the
    // verify-&-restore stage, not four gray steps with no active one.
    setWizardStage('restore');
  };
  // A load that failed against a dead/stale port must not read as a version
  // mismatch — the update itself is fine; the connection isn't.
  if (!installedVersion || installedVersion === '—' || installedVersion === 'ERR' || installedVersion === '…') {
    const message =
      'Settings did not load from the device. Unplug and replug the LipSync, wait ~30 seconds, and reconnect to finish verifying the update.';
    log(message, 'log-err');
    announceFirmwareNews('Reconnect the LipSync to finish the update.');
    armPendingPanel();
    setWizardStep(message, { showCancel: true, showBackup: true });
    return;
  }
  if (installedVersion !== pending.target && pending.target !== 'unknown version') {
    const message = `Expected firmware ${pending.target} but the device reports ${installedVersion || 'an unknown version'}. Your settings backup is kept — retry the update if this is unexpected.`;
    log(message, 'log-err');
    announceFirmwareNews('Firmware version does not match the update.');
    armPendingPanel();
    setWizardStep(message, { showCancel: true, showBackup: true });
    return;
  }
  const unverifiableVersion = pending.target === 'unknown version';
  setWizardVisible(true);
  setWizardStage('restore');
  setWizardStep(
    unverifiableVersion
      ? 'The package name carried no version to check against — restoring your settings for the firmware now running…'
      : 'New firmware verified. Restoring your settings…',
    { showBackup: true },
  );
  lockSessionButtons(true);
  let failures = [];
  try {
    // The observed post-flash drop window: give the freshly flashed device a
    // beat before its first settings write (see RESTORE_SETTLE_MS above).
    if (restoreSettleMs > 0) await sleep(restoreSettleMs);
    failures = await restoreSettingsSnapshot(pending.snapshot);
  } finally {
    lockSessionButtons(false);
  }
  if (failures.length && !pending.restoreRetried) {
    // Writes failed — whether the link died outright (cable pulled) or the
    // device went silent with the port open (observed on hardware right
    // after a flash): re-arm once so the next connect automatically retries
    // instead of leaving the user to re-enter anything by hand. A second
    // failing pass falls through and reports honestly.
    writePending({ ...pending, installed: true, restoreRetried: true });
    log('Some settings could not be written — they will be retried automatically on the next connect.', 'log-err');
    armPendingPanel();
    setWizardStep(
      serialSession.port
        ? 'Some settings could not be written. Reconnect — they will be retried automatically.'
        : 'Connection lost while restoring your settings. Reconnect — they will be restored automatically.',
      {
        showCancel: true,
        showBackup: true,
        hint: 'Unplug and replug the LipSync if it does not appear, then click Connect.',
      },
    );
    return;
  }
  if (failures.length) {
    log('Some settings could not be restored: ' + failures.join('; '), 'log-err');
  } else if (pending.snapshot) {
    log('Settings restored after firmware update.', 'log-info');
  } else {
    // Recovery: no snapshot was taken (the device was in update mode when it
    // started) — the settings simply survived in the device's storage.
    log('Device settings are intact after the recovery.', 'log-info');
  }
  // Calibration lives outside the serial API's write set — if the update reset
  // it, the user needs one guided calibration run. Only the four corners are
  // stored settings; the first CA field is the live neutral reading, which
  // legitimately differs between reads and must not trigger the notice.
  const currentCa = [$('neutralVal'), $('corner1'), $('corner2'), $('corner3'), $('corner4')]
    .map((el) => (el?.textContent || '').trim())
    .join(',');
  const cornersOf = (ca) => String(ca).split(',').slice(1).join(',');
  const calibrationLost = pending.snapshot?.CA && cornersOf(currentCa) !== cornersOf(pending.snapshot.CA);
  // Restore operating/communication mode last: applying it reboots the device
  // once more, so it must not clobber the settings restore.
  const wantedOm = pending.snapshot?.OM;
  const wantedCm = pending.snapshot?.CM;
  const currentOm = labelToValue(OP_MODES, ($('opmode')?.textContent || '').trim());
  const currentCm = labelToValue(COM_MODES, ($('commode')?.textContent || '').trim());
  const modeChanged =
    (wantedOm && currentOm && wantedOm !== currentOm) || (wantedCm && currentCm && wantedCm !== currentCm);
  writePending(null);
  wizard = null;
  let modeRestoreError = '';
  if (modeChanged) {
    try {
      if (wantedOm && wantedOm !== currentOm) await sendCommand('OM,1:' + wantedOm, CMD_MODE_TIMEOUT);
      if (wantedCm && wantedCm !== currentCm) await sendCommand('CM,1:' + wantedCm, CMD_MODE_TIMEOUT);
      await sendCommand('SR,1:1', CMD_RESET_TIMEOUT);
      log('Operating mode restored — the device reboots to apply it. Reconnect once more.', 'log-info');
      // Keep the wizard (and its snapshot for the backup button) across the
      // mode-apply reboot; the next device load closes it.
      wizard = {
        stage: 'mode-restored',
        snapshot: pending.snapshot,
        abort: new AbortController(),
      };
      setWizardStep(
        'Settings restored. Your operating mode was restored too — the LipSync is restarting. Click Connect one more time.',
        {
          percent: 100,
          showBackup: true,
        },
      );
      announceFirmwareNews('Firmware update complete. Reconnect once more to finish.');
      await disconnect({ quiet: true });
      return;
    } catch (e) {
      modeRestoreError = e.message;
      log('Could not restore the operating mode: ' + e.message + '. Set it in the Device section.', 'log-err');
      wizard = null;
    }
  }
  const extra =
    (calibrationLost
      ? ' Joystick calibration changed — run Calibrate in the Joystick section if the cursor drifts.'
      : '') +
    (modeRestoreError ? ' The operating mode could not be restored automatically — set it in the Device section.' : '');
  const message =
    'Firmware update complete.' + (failures.length ? ' Some settings could not be restored automatically.' : '');
  completedSnapshot = pending.snapshot ?? null;
  setWizardVisible(true, 'done');
  setWizardStage(null, { allDone: true });
  setWizardStep(message + extra, { percent: 100, showBackup: true });
  // The finisher knows the installed version, but NOT what is latest: the
  // user may have flashed down from a local file, or a newer release may
  // exist. Only the current-version row is synced here — the real check
  // then fills in the latest row, the status pill, and the nav badge
  // (cache-backed, so it is instant and does not burn the rate limit).
  setRow('fwCurrentVersion', installedVersion);
  setRowClass('fwLatestVersion', 'fw-new', false);
  const needsAttention = failures.length || modeRestoreError || calibrationLost;
  setCheckStatus(
    failures.length
      ? 'Update complete, but some settings need a manual retry.'
      : modeRestoreError
        ? 'Update complete, but the operating mode needs to be set manually.'
        : 'Firmware update complete.',
    needsAttention ? 'warn' : 'ok',
  );
  log(message + extra, needsAttention ? 'log-err' : 'log-info');
  void checkForFirmwareUpdate({ auto: true });
}

/** Disconnect/fresh-session hook: clears transient rows, hides actions. */
export function resetFirmwareUpdateUi() {
  const btn = $('btnStartUpdate');
  if (btn) btn.hidden = true;
  const nav = document.querySelector('.circle-trigger[data-section="sec-firmware"]');
  if (nav) nav.removeAttribute('data-notify');
  // An active wizard owns its own disconnects (the touch, the mode reboot):
  // keep the (dimmed) check rows and pill so they do not flip to '—' mid-
  // update, and let the completion check refresh them. A wizard also keeps
  // its panel; a finished panel closes with its snapshot.
  if (wizard) return;
  setRow('fwCurrentVersion', '—');
  setRow('fwLatestVersion', '—');
  setRowClass('fwLatestVersion', 'fw-new', false);
  setCheckStatus('', '');
  const notes = $('fwNotesLink');
  if (notes) notes.hidden = true;
  setWizardVisible(false);
  completedSnapshot = null;
}

/** Button wiring from main.js (composition root). */
export function bindFirmwareUpdate(guard) {
  // A reload must not strand the stranded: restore the Recover marker from
  // its sessionStorage mirror before anything else can hide the card.
  restoreBootloaderStrandedFromStorage();
  const check = $('btnCheckUpdate');
  if (check)
    check.addEventListener(
      'click',
      guard(() => checkForFirmwareUpdate()),
    );
  const update = $('btnStartUpdate');
  if (update)
    update.addEventListener(
      'click',
      guard(() => startFirmwareUpdate()),
    );
  const local = $('btnFlashLocalFile');
  const input = $('fwFileInput');
  if (local && input) {
    local.hidden = false;
    local.addEventListener('click', () => input.click());
    input.addEventListener(
      'change',
      guard(async () => {
        const file = input.files?.[0];
        input.value = '';
        if (file) await flashLocalFile(file);
      }),
    );
  }
  const recover = $('btnRecoverDevice');
  if (recover)
    recover.addEventListener('click', async (event) => {
      const btn = /** @type {HTMLButtonElement} */ (event.currentTarget);
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        await recoverFromBootloader();
      } catch (e) {
        log(e.message, 'log-err');
        showNotification(e.message);
      } finally {
        btn.disabled = false;
      }
    });
  const cont = $('btnFwContinue');
  if (cont)
    cont.addEventListener(
      'click',
      guard(() => continueWizard()),
    );
  const cancel = $('btnFwCancel');
  if (cancel) cancel.addEventListener('click', () => cancelWizard());
  const backup = $('btnDownloadBackup');
  if (backup)
    backup.addEventListener('click', () => {
      const snapshot = wizard?.snapshot ?? readPending()?.snapshot ?? completedSnapshot;
      if (snapshot) downloadSettingsBackup(snapshot);
    });
}
