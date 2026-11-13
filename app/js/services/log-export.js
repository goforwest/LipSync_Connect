// Log export/share helpers — shared by Download/Share so both emit identical files.
// Privacy: the device identifier is redacted before export so a shared log
// can't disclose the user's device identity — both in its raw form and in the
// derived BLE name "LS_<id>" that the Bluetooth flow logs verbatim. Checked
// against the live UI value each export.
import { SHARE_TEXT_LIMIT, MAIL_BODY_LIMIT, APP_BUILD_ID } from '../config/constants.js';
import { getLogHistory, log } from './log.js';
import { $ } from '../ui/dom.js';
import { announceStatus } from '../ui/a11y.js';
import { showNotification } from '../ui/notification.js';
import { practiceStatsLine } from './practice-stats.js';
import { btHostTable } from './bt-hosts.js';

// The health grid's steps, in display order: the support report ships the
// per-step outcome, not just the one-line summary — "Failed" alone forces a
// follow-up question, the failing step usually answers it.
const HEALTH_REPORT_STEPS = [
  { id: 'hcPressure', label: 'Pressure sensors' },
  { id: 'hcJoystick', label: 'Joystick response' },
  { id: 'hcNeutral', label: 'Neutral position' },
  { id: 'hcCalibration', label: 'Stored calibration' },
  { id: 'hcBus', label: 'Internal sensors (I2C)' },
];
const HEALTH_STATE_WORDS = { ok: 'OK', warn: 'Warning', err: 'Failed', running: 'Checking', idle: 'Not checked' };

// Device identifiers are interpolated into a RegExp below; escape regex
// metacharacters so a non-hex id (e.g. "AB-CD-EF-12") can't throw or widen
// the match. RegExp.escape() is not available in this project's browsers yet.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function redactLogIdentifiers(text) {
  // Collect every identifier this session has seen: the live UI value plus
  // every ID response recorded in the log itself. Relying on the live value
  // alone leaks the raw ID when the field is in a failed/reset state
  // ('—'/'ERR') at export time even though earlier log lines contain it.
  const placeholders = new Set(['', '—', '…', 'ERR']);
  const ids = new Set();
  const idEl = $('deviceId');
  const liveId = idEl && idEl.textContent ? idEl.textContent.trim() : '';
  if (!placeholders.has(liveId)) ids.add(liveId);
  const idLine = /(?:SUCCESS|MANUAL),\d+:ID,\d+:(.+?)\s*$/gm;
  let match;
  while ((match = idLine.exec(text)) !== null) {
    const found = match[1].trim();
    if (!placeholders.has(found)) ids.add(found);
  }
  let redacted = text;
  // Longest ids first: when one id is a prefix of another, the longer match
  // must win so the shorter replacement can't corrupt the tail of the longer.
  const sorted = [...ids].sort((a, b) => b.length - a.length);
  for (const id of sorted) {
    // Watch both raw forms: the bare identifier and the BLE name derived from
    // it as "LS_<id>" (mode-switch logs the latter verbatim, e.g. the pairing
    // instructions). Scrub the longest form first so "LS_<id>" collapses to
    // "LS_[device-id]" in one pass instead of leaving "LS_…" orphaned.
    redacted = redacted.replaceAll('LS_' + id, 'LS_[device-id]');
    // The bare id is replaced only at hex boundaries: an id like "000000" must
    // not be scrubbed out of an unrelated longer token such as "1000000".
    redacted = redacted.replace(new RegExp('(?<![0-9A-Fa-f])' + escapeRe(id) + '(?![0-9A-Fa-f])', 'g'), '[device-id]');
  }
  return redacted;
}

export function buildLogFile() {
  const logHistory = getLogHistory();
  // Full session history — not just what's currently visible in the on-screen
  // log box (which is capped at 400 entries). Includes a header for context.
  // ISO timestamps make entries sortable.
  const header = [
    'LipSync Connect log',
    'App build: ' + APP_BUILD_ID,
    'Session exported: ' + new Date().toISOString(),
    'Entries: ' + logHistory.length,
    'Device identifiers: redacted',
    '---',
  ];
  const text = header.join('\n') + '\n' + redactLogIdentifiers(logHistory.join('\n')) + '\n';
  const filename = `lipsync-connect-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
  return { text, filename };
}

/** Builds the single support artifact shown ahead of the expert log tools.
 * Device identity is intentionally omitted from the summary and scrubbed from
 * the transcript with the same redactor used by detailed-log exports.
 * @param {{ dumpStatus?: string, includeBtHosts?: boolean }} [options]
 */
export function buildSupportReport(options = {}) {
  const read = (id, fallback = 'Not available') => {
    const value = String($(id)?.textContent ?? '').trim();
    return value && !['—', '…', 'ERR'].includes(value) ? value : fallback;
  };
  const logHistory = getLogHistory();
  const connection = read('homeConnection', 'Not connected');
  // Per-step health outcomes: only meaningful once a run has populated the
  // grid this session (the grid hides on disconnect/clear — never report a
  // stale run's steps as current). A cell without a state is skipped, and the
  // line is omitted entirely when no step has a state to report.
  const grid = $('healthGrid');
  const healthSteps =
    grid && !grid.hidden
      ? HEALTH_REPORT_STEPS.map((s) => {
          const cell = $(s.id);
          const raw = cell?.getAttribute?.('data-state');
          return raw ? `${s.label} — ${HEALTH_STATE_WORDS[raw] ?? 'Unknown'}` : null;
        }).filter(Boolean)
      : null;
  // The hold-timing practice aggregate (session-scoped): included only when
  // holds were measured, so the report carries the clinical context an OT
  // would otherwise have to copy separately.
  const stats = practiceStatsLine();
  // Paired Bluetooth host NAMES, strictly opt-in: names are user content
  // ("Mary's iPad") and can identify people, so they ship only when the
  // report option is ticked — and never the MAC addresses (device
  // identifiers, redacted like every other one).
  const hosts = [];
  if (options.includeBtHosts && btHostTable.count > 0) {
    hosts.push('Paired Bluetooth hosts: ' + btHostTable.count);
    for (let i = 1; i <= btHostTable.count; i++) {
      const row = btHostTable.rows[i];
      if (row) hosts.push(`  ${i}. ${row.name}${row.active ? ' (active)' : ''}`);
    }
  }
  const header = [
    'LipSync Connect support report',
    'Created: ' + new Date().toISOString(),
    'App build: ' + APP_BUILD_ID,
    'Connection: ' + connection,
    'Device model: ' + read('model'),
    'Firmware: ' + read('version'),
    'Operating mode: ' + read('opmode'),
    'Communication mode: ' + read('commode'),
    'Health check: ' + read('healthSummary', 'Not run'),
    ...(healthSteps && healthSteps.length ? ['Health check steps: ' + healthSteps.join('; ')] : []),
    ...(stats ? ['Hold practice: ' + stats] : []),
    ...hosts,
    'Settings dump: ' + (options.dumpStatus || 'Not captured'),
    'Session entries: ' + logHistory.length,
    'Device identifiers: redacted',
    '--- Session log ---',
  ];
  const transcript = redactLogIdentifiers(logHistory.join('\n'));
  const text = header.join('\n') + '\n' + (transcript || 'No session events recorded.') + '\n';
  const filename = `lipsync-support-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  return { text, filename };
}

export function downloadLogFile({ text, filename }) {
  const blob = new Blob([text], { type: 'text/plain' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  link.click();
  requestAnimationFrame(() => URL.revokeObjectURL(url));
}

// Session-scoped circuits: once we've seen this browser/engine refuse a
// legitimate user-gesture share (Edge desktop is the known case), stop
// attempting the sheet — every later click would burn another activation on
// the same hard failure. A FILE-payload refusal is tracked separately: some
// engines accept text shares but reject file shares, so the next click
// downgrades to a text payload instead of abandoning the sheet entirely.
// Both cleared by page reload.
let logShareBrokenThisSession = false;
let fileShareBrokenThisSession = false;

// `confirmBeforeFallback` is consulted only when the native share sheet is
// unavailable or throws: the sheet itself already doubles as the privacy
// confirm (the user picks the destination app), but mailto/clipboard/
// download disclose without any further UI, so those paths ask first.
// The callback must be synchronous-ish to stay inside transient activation.
export async function shareTextFile(
  { text, filename },
  confirmBeforeFallback,
  { title = 'LipSync Connect log', noun = 'log' } = {},
) {
  const nounTitle = noun.charAt(0).toUpperCase() + noun.slice(1);
  const sharingMsg = `Sharing ${noun}…`;
  log(sharingMsg, 'log-info');
  announceStatus(sharingMsg);
  const wasCancelled = (e) => e && e.name === 'AbortError';
  const gleanCancel = (e) => {
    // User dismissed the share dialog — not an error.
    log('Share cancelled.', 'log-info');
    announceStatus('Share cancelled.');
    void e;
  };
  const clipboardCopy = async () => {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // fall through to the legacy path
      }
    }
    // Legacy path: hidden textarea + execCommand('copy').
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let okCopy = false;
    try {
      okCopy = document.execCommand('copy');
    } catch {
      okCopy = false;
    }
    ta.remove();
    if (!okCopy) throw new Error('Clipboard unavailable.');
  };
  const clipboardFallback = async () => {
    try {
      await clipboardCopy();
      return true;
    } catch {
      return false;
    }
  };
  const downloadFallback = () => {
    downloadLogFile({ text, filename });
    const msg = `Share failed — ${noun} downloaded instead.`;
    log(msg, 'log-err');
    showNotification(msg + ' Attach the downloaded file to your email or message.');
    announceStatus(msg);
  };
  // a/b) Native Web Share — ATTEMPTED IMMEDIATELY, before any dialog. Chrome
  //      enforces transient user activation (~5 s) for navigator.share();
  //      awaiting a confirm dialog between the click and this call reliably
  //      burns that window, surfacing as NotAllowedError on desktop. The
  //      share sheet itself doubles as the privacy confirm — the user must
  //      pick a destination app — so no in-app confirm is needed here. One
  //      payload only: Chrome allows one share per activation; a files-then-
  //      text retry would throw "Must be handling a user gesture".
  //
  //      Edge-on-desktop divergence: its UserActivation.isActive reports
  //      false even inside a real click handler (observed in Edge 139+ on
  //      macOS), and navigator.share({files}) throws NotAllowedError though
  //      canShare() returns true. The ONLY reliable signal is the share call
  //      itself, so we don't gate — we attempt optimistically and learn from
  //      the outcome. Session-level circuit below remembers a hard share
  //      failure so a second click goes straight to fallbacks instead of
  //      burning another activation on a browser that won't show the sheet.
  const ua = /** @type {any} */ (navigator).userActivation || {};
  if ('share' in navigator && !logShareBrokenThisSession) {
    // Truncate to the LAST 20,000 chars; recipients care most about recent entries.
    let body = text;
    if (body.length > SHARE_TEXT_LIMIT) {
      body = '... (earlier entries truncated)\n' + body.slice(-SHARE_TEXT_LIMIT);
    }
    // Capability-based selection (NOT UA sniffing): try an actual file share
    // only when the platform actually accepts it; otherwise always fall back
    // to the text payload, which is portable everywhere.
    /** @type {any} */ let payload = { title, text: body };
    if (typeof File !== 'undefined' && 'canShare' in navigator && !fileShareBrokenThisSession) {
      try {
        // Chromium safelists shareable file EXTENSIONS, and .log is not on it:
        // canShare({files}) returns true but share() itself rejects with
        // NotAllowedError "Permission denied" (observed on macOS Chrome).
        // Share the same content under a .txt name — .txt is safelisted
        // everywhere — and keep the .log extension for the download path only.
        const file = new File([text], filename.replace(/\.log$/, '.txt'), { type: 'text/plain' });
        if (navigator.canShare({ files: [file] })) payload = { files: [file], title };
      } catch {
        // files unsupported/omitted — keep the text payload
      }
    }
    try {
      await navigator.share(payload);
      return;
    } catch (e) {
      if (wasCancelled(e)) {
        gleanCancel(e);
        return;
      }
      // Remember the failure for this page-view. A file-payload refusal only
      // disables FILE shares — the next click retries the sheet with a text
      // payload (Chrome allows one share attempt per activation, so an
      // in-click retry would throw). A text-payload refusal means the sheet
      // itself is broken; later clicks go straight to fallbacks.
      if (e.name === 'NotAllowedError' || e.name === 'InvalidStateError') {
        if ('files' in payload) fileShareBrokenThisSession = true;
        else logShareBrokenThisSession = true;
      }
      log(
        `Share sheet failed: ${e.name}: ${e.message} ` +
          `(payload=${'files' in payload ? 'files' : 'text'}, ` +
          `activation: isActive=${ua.isActive}, hasBeenActive=${ua.hasBeenActive}) — trying email/clipboard.`,
        'log-info',
      );
    }
  }
  // Fallbacks disclose the log WITHOUT an OS-level picker, so gate them
  // behind the in-app confirm (S-2). This runs after a failed/cancelled
  // sheet or when 'share' is unsupported — transient activation is already
  // gone in those cases, so a modal here costs nothing.
  if (confirmBeforeFallback) {
    const ok = await confirmBeforeFallback();
    if (!ok) {
      const cancelMsg = 'Share cancelled.';
      log(cancelMsg, 'log-info');
      announceStatus(cancelMsg);
      return;
    }
  }
  // c) Desktop/laptop path: on a full-size browser the log belongs in the
  //    clipboard (easy to paste into any mail/chat client), and mailto:
  //    without an email handler registered is a dead end — so try the
  //    clipboard FIRST and only lean on mailto when the clipboard refuses.
  if (text.length > MAIL_BODY_LIMIT) {
    if (await clipboardFallback()) {
      const copiedMsg = `${nounTitle} copied to clipboard — paste it into an email.`;
      log(copiedMsg, 'log-info');
      showNotification(copiedMsg);
      announceStatus(copiedMsg);
      return;
    }
    // Clipboard refused (e.g., insecure context). Produce the file the
    // mailto text promises BEFORE opening the mail client: the old flow
    // claimed "email it from the downloaded file" without ever downloading
    // it. The download is the guaranteed artifact; mailto is a convenience.
    let downloaded = false;
    try {
      downloadLogFile({ text, filename });
      downloaded = true;
    } catch {}
    try {
      window.location.href =
        'mailto:?subject=' +
        encodeURIComponent(title) +
        '&body=' +
        encodeURIComponent(`${nounTitle} was too long to paste — attach the downloaded file.`);
    } catch {
      // Navigation failure is not a second failure: the file is already saved.
    }
    if (downloaded) {
      const msg = `${nounTitle} downloaded — attach the downloaded file to your email.`;
      log(msg, 'log-info');
      showNotification(msg);
      announceStatus(msg);
    } else {
      log(`The ${noun} could not be downloaded — use Copy instead.`, 'log-err');
      showNotification(`The ${noun} could not be downloaded — use Copy instead.`);
    }
    return;
  }
  // d) Short log: mailto with the full body is the least-friction path when
  //    an email client exists. If this navigation goes nowhere (desktop
  //    Chrome without a handler shows "no app to open this link"), the user
  //    can still hit Download — but we surface the clipboard copy as well so
  //    there's a guaranteed-working artifact on desktop.
  try {
    await clipboardFallback(); // best-effort; ignore the outcome
    window.location.href = 'mailto:?subject=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(text);
  } catch (e) {
    // e) mailto navigation itself threw (rare) — keep the download copy.
    log('Share failed: ' + e.message, 'log-err');
    downloadFallback();
  }
}

export function shareLog(confirmBeforeFallback) {
  return shareTextFile(buildLogFile(), confirmBeforeFallback);
}
