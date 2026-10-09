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
import { setStatus } from '../ui/connection-ui.js';
import { log } from './log.js';
import { downloadLogFile } from './log-export.js';
import { fmtApiFloat } from '../utils/format.js';
import { sendCommand } from '../serial/commands.js';
import { serialSession } from '../serial/session.js';
import { disconnect } from '../serial/connection.js';
import { parseDfuPackage } from '../serial/dfu/dfu-package.js';
import { flashSerialDfu, requestDfuPort } from '../serial/dfu/dfu-serial.js';
import {
  FEEDBACK_MODES,
  OP_MODES,
  COM_MODES,
  CMD_MODE_TIMEOUT,
  CMD_RESET_TIMEOUT,
  FIRMWARE_RELEASE_API,
  FIRMWARE_MANIFEST_ASSET_NAME,
  FIRMWARE_MANIFEST_URL_OVERRIDE_KEY,
  FIRMWARE_RELEASE_API_OVERRIDE_KEY,
  FIRMWARE_CHECK_STORAGE_KEY,
  FIRMWARE_CHECK_MIN_INTERVAL_MS,
  FIRMWARE_FETCH_TIMEOUT_MS,
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

async function fetchJson(url, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FIRMWARE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
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
 *   { manifest, tagName, releaseUrl, checkedAt, assetUrls: { dfu, uf2 } }
 * manifest is null when a release exists but carries no manifest asset yet.
 * `force` bypasses the time-based cache (manual re-checks).
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
    return { manifest, tagName: null, releaseUrl: null, checkedAt: Date.now(), assetUrls: {} };
  }
  // A redirected release API is a dev pointing at another repo (usually a
  // fork): a stale cached upstream entry would mask it, so bypass the cache
  // read and always hit the (redirected) source.
  if (!options.force && !releaseApiOverride) {
    const cached = readCheckCache();
    if (cached && Date.now() - cached.checkedAt < FIRMWARE_CHECK_MIN_INTERVAL_MS) return cached;
  }
  const release = await fetchJson(releaseApiOverride || FIRMWARE_RELEASE_API, {
    Accept: 'application/vnd.github+json',
  });
  const assets = release.assets || [];
  const asset = assets.find((/** @type {{name: string}} */ a) => a.name === FIRMWARE_MANIFEST_ASSET_NAME);
  const base = {
    tagName: release.tag_name ?? null,
    releaseUrl: release.html_url ?? null,
    checkedAt: Date.now(),
  };
  if (!asset) return { ...base, manifest: null, assetUrls: {} };
  const manifest = await fetchJson(asset.browser_download_url);
  const urlFor = (name) =>
    name ? (assets.find((/** @type {{name: string}} */ a) => a.name === name)?.browser_download_url ?? null) : null;
  const entry = {
    ...base,
    manifest,
    assetUrls: {
      dfu: urlFor(manifest.files?.dfu?.fileName),
      uf2: urlFor(manifest.files?.uf2?.fileName),
    },
  };
  writeCheckCache(entry);
  return entry;
}

// ---- Update-check UI ----

function setRow(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
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
  if (!btn || !entry?.manifest) return;
  const cmp = compareVersions(deviceVersion, entry.manifest.firmwareVersion);
  const available = cmp !== null && cmp < 0;
  btn.hidden = !available;
  if (available && target) target.textContent = entry.manifest.firmwareVersion;
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
      setCheckStatus('Could not check for updates. You may be offline.', 'warn');
    }
    log('Firmware update check failed: ' + e.message, 'log-err');
    return;
  }
  const manifest = entry?.manifest;
  if (!manifest) {
    setRow('fwLatestVersion', 'Unknown');
    setUpdateButton(null, deviceVersion);
    setCheckStatus('No published firmware information yet.', 'unknown');
    if (!options.auto) announceStatus('No published firmware information yet.');
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
    announceStatus('Firmware update available: version ' + manifest.firmwareVersion + '.');
  } else if (!options.auto) {
    announceStatus('Firmware is up to date.');
  }
}

function setRowClass(id, cls, on) {
  const el = $(id);
  if (!el) return;
  if (on) el.classList.add(cls);
  else el.classList.remove(cls);
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
  const soundLabel = ($('soundModeVal')?.textContent || '').trim();
  snapshot.SM = labelToValue(FEEDBACK_MODES, soundLabel);
  const lightLabel = ($('lightModeVal')?.textContent || '').trim();
  snapshot.LM = labelToValue(FEEDBACK_MODES, lightLabel);
  snapshot.OM = labelToValue(OP_MODES, ($('opmode')?.textContent || '').trim());
  snapshot.CM = labelToValue(COM_MODES, ($('commode')?.textContent || '').trim());
  snapshot.CA = [$('neutralVal'), $('corner1'), $('corner2'), $('corner3'), $('corner4')]
    .map((el) => (el?.textContent || '').trim())
    .join(',');
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
    filename: `lipsync-settings-${snapshot.VN || 'backup'}.json`,
  });
  log('Settings backup downloaded.', 'log-info');
}

/**
 * Re-applies a snapshot's writable settings over the serial API. Float
 * endpoints are normalized through fmtApiFloat so every write lands on a
 * line length the firmware validator accepts. Returns the failures.
 */
export async function restoreSettingsSnapshot(snapshot) {
  const failures = [];
  const order = ['SS', 'SL', 'ST', 'PT', 'IZ', 'OZ', 'SM', 'LM', 'LL'];
  let consecutive = 0;
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

// ---- Flash wizard ----

let wizard = null; // { stage, target, pkg, snapshot, entry, abort }

// Snapshot of the last completed update, kept only so the success panel's
// "Download settings backup" button keeps working after the pending entry is
// cleared. Cleared with the panel.
let completedSnapshot = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
 */
function setWizardVisible(show, state = 'active') {
  const el = $('fwWizard');
  if (el) {
    el.hidden = !show;
    if (show) el.setAttribute('data-state', state);
    else el.removeAttribute('data-state');
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
  { percent = null, etaSec = null, hint = null, showContinue = false, showCancel = false, showBackup = false } = {},
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
  if (cancel) cancel.hidden = !showCancel;
  const backup = $('btnDownloadBackup');
  if (backup) backup.hidden = !showBackup;
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * The shared flash path used by both the release-update button and local
 * file flashing: snapshot → confirm → 1200-baud touch → bootloader port →
 * serial DFU → await reconnect.
 */
async function runFlashWizard({ pkg, targetVersion }) {
  if (wizard) throw new Error('An update is already in progress.');
  if (!serialSession.port) throw new Error('Connect the LipSync before updating its firmware.');
  wizard = { stage: 'snapshot', target: targetVersion, pkg, abort: new AbortController() };
  setWizardVisible(true);
  setWizardStage('backup');
  lockSessionButtons(true);
  // A cancel nulls the wizard mid-flight; every await below can therefore
  // resume into a dead flow — the guard keeps cancellations silent.
  const cancelled = () => !wizard;
  try {
    setWizardStep('Backing up your settings…', { showCancel: true, showBackup: false });
    const snapshot = captureSettingsSnapshot();
    wizard.snapshot = snapshot;
    writePending({ target: targetVersion, snapshot, installed: false });
    downloadSettingsBackup(snapshot);
    setWizardStep(`Settings backed up — a backup file was downloaded. Installing firmware ${targetVersion}…`, {
      showCancel: true,
      showBackup: true,
    });

    const confirmed = await showConfirm(
      'Update firmware',
      `Install firmware <strong>${targetVersion}</strong> on the LipSync?` +
        '<br>Keep the device plugged in until the update finishes. It will restart once or twice.',
    );
    if (!confirmed) {
      cancelWizard('Update cancelled. Nothing was changed.');
      return;
    }

    setWizardStage('restart');
    setWizardStep('Restarting the LipSync into update mode…', { showCancel: true });
    const appPort = serialSession.port;
    if (!appPort) {
      throw new Error('The connection was lost before the update could start. Reconnect and retry.');
    }
    await disconnect({ quiet: true });
    if (cancelled()) return;
    lockSessionButtons(true);
    wizard.stage = 'enter-bootloader';
    let touched = false;
    try {
      // Wake pulse: a device that has sat idle may have suspended its USB
      // stack and drop the touch (observed on hardware). A short open/close
      // at the normal baud resumes it first.
      try {
        await appPort.open({ baudRate: 115200 });
        await sleep(50);
        await appPort.close();
      } catch {}
      if (cancelled()) return;
      await sleep(300);
      // 1200-baud touch: the running firmware sees the line-coding change and
      // a DTR drop, and resets into its stock bootloader.
      await appPort.open({ baudRate: 1200 });
      try {
        await appPort.setSignals?.({ dataTerminalReady: false });
      } catch {}
      await sleep(100);
      await appPort.close();
      if (cancelled()) return;
      await sleep(1200);
      if (cancelled()) return;
      // Verify the device actually left application mode: after a successful
      // touch the app-mode port is gone. If it still opens, the touch did not
      // take and the user must double-tap reset instead of picking a port
      // that can never answer the bootloader protocol.
      try {
        await appPort.open({ baudRate: 115200 });
        await appPort.close();
      } catch {
        touched = true;
      }
    } catch (e) {
      log('Could not restart the device automatically: ' + e.message, 'log-err');
    }
    if (cancelled()) return;
    wizard.stage = 'await-bootloader-port';
    setWizardStatus('Firmware update — choose the update port');
    setWizardStep(
      touched
        ? 'Select the update port: click Continue, then pick the LipSync in the browser dialog — it may be named “XIAO nRF52840” or “XIAO nRF52840 Sense”.'
        : 'The device did not restart automatically. Press the small reset button on the Hub twice, slowly — the device enters update mode by itself — then click Continue.',
      {
        hint: 'If the device does not appear, unplug it, plug it back in, and press reset twice (slowly) to enter update mode.',
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
  setWizardStep('Waiting for the update port…', { showBackup: true });
  try {
    let port;
    try {
      port = await requestDfuPort();
    } catch (e) {
      if (e?.name !== 'NotFoundError') throw e;
      // The picker was dismissed. Stay on this step so Continue works again
      // instead of dumping the user into a failure panel.
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
    const { target, snapshot, pkg, abort } = wizard;
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
    await flashSerialDfu({
      port,
      bin: pkg.bin,
      dat: pkg.dat,
      signal: abort.signal,
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
    if (!wizard) {
      // Cancelled inside the final STOP window: the bootloader completed the
      // update anyway. The panel is already closed — keep the restore alive
      // so the next connect verifies and restores instead of silently
      // discarding the snapshot.
      writePending({ target, snapshot, installed: true });
      log(
        'The update finished just as it was cancelled. Reconnect to have it verified and your settings restored.',
        'log-info',
      );
      return;
    }
    wizard.stage = 'await-reconnect';
    setWizardStage('restore');
    writePending({ target: wizard.target, snapshot: wizard.snapshot, installed: true });
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
    announceStatus('Firmware installed. Please reconnect the LipSync.');
  } catch (e) {
    // A cancel already closed the wizard — do not reopen it as a failure.
    if (!wizard) return;
    failWizard(e);
  } finally {
    lockSessionButtons(false);
  }
}

function failWizard(e) {
  const message = e?.message ?? String(e);
  const duringFlash = wizard?.stage === 'flashing' || wizard?.stage === 'await-reconnect';
  log('Firmware update failed: ' + message, 'log-err');
  announceStatus('Firmware update failed.');
  wizard = { ...wizard, stage: 'failed' };
  lockSessionButtons(false);
  resetStatusIfDisconnected();
  setWizardVisible(true, 'failed');
  setWizardStep('Update failed: ' + message, {
    showCancel: true,
    showBackup: true,
    hint: duringFlash
      ? 'The LipSync is not harmed — its recovery loader discards a partial update. Unplug and replug it (or press reset once) to get back to normal, then retry.'
      : 'Your LipSync is not harmed — nothing was written, or the bootloader kept itself intact. You can retry.',
  });
}

function cancelWizard(message) {
  const stage = wizard?.stage;
  try {
    wizard?.abort.abort();
  } catch {}
  wizard = null;
  writePending(null);
  completedSnapshot = null;
  lockSessionButtons(false);
  resetStatusIfDisconnected();
  setWizardVisible(false);
  setWizardStep('', { percent: null });
  // Cancelling mid-flash leaves a partial image in the bootloader's hands:
  // the recovery loader discards it and boots the old firmware after a
  // power cycle — say so instead of pretending nothing was touched. The
  // restore-retry panels are a different story: the flash already finished.
  const finalMessage =
    message ??
    (stage === 'flashing'
      ? 'Update stopped partway. Unplug and replug the LipSync (or press reset once) and it starts normally again — its recovery loader keeps the current firmware.'
      : stage === 'await-reconnect' || stage === 'mode-restored'
        ? 'Restore cancelled. The firmware update itself finished — re-enter any missing settings from your backup file if needed.'
        : 'Update cancelled. Nothing was changed.');
  log(finalMessage, 'log-info');
  announceStatus(finalMessage);
}

/** Release-update entry point (the “Update to X” button). */
export async function startFirmwareUpdate() {
  let entry = readCheckCache();
  if (!entry?.manifest || !entry.manifest.files?.dfu || !entry.assetUrls?.dfu) {
    await checkForFirmwareUpdate();
    entry = readCheckCache();
  }
  const manifest = entry?.manifest;
  if (!manifest?.files?.dfu) {
    // Distinguish "nothing published yet" from "we could not reach the
    // update service" — the latter is what a fresh failed check means.
    const statusState = $('fwUpdateStatus')?.getAttribute('data-state');
    throw new Error(
      statusState === 'warn'
        ? 'Could not reach the update service — check your connection and retry.'
        : 'No downloadable firmware package is available yet.',
    );
  }
  if (!entry.assetUrls?.dfu) throw new Error('The latest release does not include a downloadable firmware package.');
  if (!manifest.files.dfu.sha256) {
    // Our release pipeline always publishes a checksum; a release without
    // one is not one of ours and will not be installed.
    throw new Error('The latest release does not publish a checksum — refusing to install it.');
  }
  const target = manifest.firmwareVersion;
  wizard = { stage: 'download', target, abort: new AbortController() };
  setWizardVisible(true);
  setWizardStage('backup');
  lockSessionButtons(true);
  try {
    setWizardStep(`Downloading firmware ${target}…`, {
      showCancel: true,
      hint: 'This can take a moment on slower connections.',
    });
    const zipResponse = await fetch(entry.assetUrls.dfu, { signal: wizard.abort.signal });
    if (!zipResponse.ok) throw new Error(`Could not download the firmware package (HTTP ${zipResponse.status}).`);
    const zipBuffer = await zipResponse.arrayBuffer();
    const sha256 = await sha256Hex(zipBuffer);
    if (sha256 !== manifest.files.dfu.sha256) {
      throw new Error('The downloaded firmware package did not match its published checksum.');
    }
    const pkg = await parseDfuPackage(zipBuffer);
    log(`Firmware package ${manifest.files.dfu.fileName} verified (sha256 ${sha256.slice(0, 12)}…).`, 'log-info');
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
    failWizard(e);
  }
}

/** Local-file entry point (the “Flash local file…” button + file picker). */
export async function flashLocalFile(file) {
  if (!file) return;
  if (wizard) throw new Error('An update is already in progress.');
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
  // A completed update whose operating-mode restore rebooted the device once
  // more: that reconnect is the final step — close the wizard cleanly.
  if (wizard?.stage === 'mode-restored') {
    wizard = null;
    setWizardVisible(false);
    setCheckStatus('Firmware update complete.', 'ok');
    setRow('fwCurrentVersion', ($('version')?.textContent || '').trim() || '—');
    setRow('fwLatestVersion', $('fwCurrentVersion')?.textContent || '—');
    setRowClass('fwLatestVersion', 'fw-new', false);
    log('Firmware update complete.', 'log-info');
    announceStatus('Firmware update complete.');
    return;
  }
  void checkForFirmwareUpdate({ auto: true });
}

async function finishPendingUpdate(pending) {
  const installedVersion = ($('version')?.textContent || '').trim();
  // A load that failed against a dead/stale port must not read as a version
  // mismatch — the update itself is fine; the connection isn't.
  if (!installedVersion || installedVersion === '—' || installedVersion === 'ERR' || installedVersion === '…') {
    const message =
      'Settings did not load from the device. Unplug and replug the LipSync, wait ~30 seconds, and reconnect to finish verifying the update.';
    log(message, 'log-err');
    announceStatus('Reconnect the LipSync to finish the update.');
    setWizardVisible(true);
    setWizardStep(message, { showCancel: true, showBackup: true });
    return;
  }
  if (installedVersion !== pending.target) {
    const message = `Expected firmware ${pending.target} but the device reports ${installedVersion || 'an unknown version'}. Your settings backup is kept — retry the update if this is unexpected.`;
    log(message, 'log-err');
    announceStatus('Firmware version does not match the update.');
    setWizardVisible(true);
    setWizardStep(message, { showCancel: true, showBackup: true });
    return;
  }
  setWizardVisible(true);
  setWizardStage('restore');
  setWizardStep('New firmware verified. Restoring your settings…', { showBackup: true });
  lockSessionButtons(true);
  let failures = [];
  try {
    failures = await restoreSettingsSnapshot(pending.snapshot);
  } finally {
    lockSessionButtons(false);
  }
  if (failures.length && !serialSession.port) {
    // The link died mid-restore (cable pulled, device wedged): re-arm the
    // update so the next connect picks the restore back up instead of
    // leaving the user to re-enter everything by hand.
    writePending({ ...pending, installed: true });
    log('Connection lost while restoring settings — they will be restored on the next connect.', 'log-err');
    setWizardVisible(true);
    setWizardStep('Connection lost while restoring your settings. Reconnect — they will be restored automatically.', {
      showCancel: true,
      showBackup: true,
      hint: 'Unplug and replug the LipSync if it does not appear, then click Connect.',
    });
    announceStatus('Connection lost. Reconnect the LipSync to restore your settings.');
    return;
  }
  if (failures.length) {
    log('Some settings could not be restored: ' + failures.join('; '), 'log-err');
  } else {
    log('Settings restored after firmware update.', 'log-info');
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
  if (modeChanged) {
    try {
      if (wantedOm && wantedOm !== currentOm) await sendCommand('OM,1:' + wantedOm, CMD_MODE_TIMEOUT);
      if (wantedCm && wantedCm !== currentCm) await sendCommand('CM,1:' + wantedCm, CMD_MODE_TIMEOUT);
      await sendCommand('SR,1:1', CMD_RESET_TIMEOUT);
      log('Operating mode restored — the device reboots to apply it. Reconnect once more.', 'log-info');
      // Keep the wizard (and its snapshot for the backup button) across the
      // mode-apply reboot; the next device load closes it.
      wizard = { stage: 'mode-restored', snapshot: pending.snapshot, abort: new AbortController() };
      setWizardStep(
        'Settings restored. Your operating mode was restored too — the LipSync is restarting. Click Connect one more time.',
        {
          percent: 100,
          showBackup: true,
        },
      );
      announceStatus('Firmware update complete. Reconnect once more to finish.');
      await disconnect({ quiet: true });
      return;
    } catch (e) {
      log('Could not restore the operating mode: ' + e.message + '. Set it in the Device section.', 'log-err');
      wizard = null;
    }
  }
  const extra = calibrationLost
    ? ' Joystick calibration changed — run Calibrate in the Joystick section if the cursor drifts.'
    : '';
  const message =
    'Firmware update complete.' + (failures.length ? ' Some settings could not be restored automatically.' : '');
  completedSnapshot = pending.snapshot ?? null;
  setWizardVisible(true, 'done');
  setWizardStage(null, { allDone: true });
  setWizardStep(message + extra, { percent: 100, showBackup: true });
  // Sync the check rows: the device now runs the target version.
  setRow('fwCurrentVersion', installedVersion);
  setRow('fwLatestVersion', installedVersion);
  setRowClass('fwLatestVersion', 'fw-new', false);
  setCheckStatus(
    failures.length ? 'Update complete, but some settings need a manual retry.' : 'Firmware update complete.',
    failures.length ? 'warn' : 'ok',
  );
  log(message + extra, failures.length || calibrationLost ? 'log-err' : 'log-info');
  announceStatus(message);
}

/** Disconnect/fresh-session hook: clears transient rows, hides actions. */
export function resetFirmwareUpdateUi() {
  setRow('fwCurrentVersion', '—');
  setRow('fwLatestVersion', '—');
  setRowClass('fwLatestVersion', 'fw-new', false);
  setCheckStatus('', '');
  const btn = $('btnStartUpdate');
  if (btn) btn.hidden = true;
  const notes = $('fwNotesLink');
  if (notes) notes.hidden = true;
  // No wizard is in flight (an active one survives the mid-update
  // disconnect) — close a finished panel too, along with its snapshot.
  if (!wizard) {
    setWizardVisible(false);
    completedSnapshot = null;
  }
}

/** Button wiring from main.js (composition root). */
export function bindFirmwareUpdate(guard) {
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
