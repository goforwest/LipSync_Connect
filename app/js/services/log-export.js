// Log export/share helpers — shared by Download/Share so both emit identical files.
// Privacy: the device identifier is redacted before export so a shared log
// can't disclose the user's device identity — both in its raw form and in the
// derived BLE name "LS_<id>" that the Bluetooth flow logs verbatim. Checked
// against the live UI value each export.
import { SHARE_TEXT_LIMIT, MAIL_BODY_LIMIT } from '../config/constants.js';
import { getLogHistory, log } from './log.js';
import { $ } from '../ui/dom.js';
import { announceStatus } from '../ui/a11y.js';
import { showNotification } from '../ui/notification.js';

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
    redacted = redacted.replace(new RegExp('(?<![0-9A-Fa-f])' + id + '(?![0-9A-Fa-f])', 'g'), '[device-id]');
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
    'Session exported: ' + new Date().toISOString(),
    'Entries: ' + logHistory.length,
    'Device identifiers: redacted',
    '---',
  ];
  const text = header.join('\n') + '\n' + redactLogIdentifiers(logHistory.join('\n')) + '\n';
  const filename = `lipsync-connect-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
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
export async function shareLog(confirmBeforeFallback) {
  const { text, filename } = buildLogFile();
  const sharingMsg = 'Sharing log…';
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
    const msg = 'Share failed — log downloaded instead.';
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
    /** @type {any} */ let payload = { title: 'LipSync Connect log', text: body };
    if (typeof File !== 'undefined' && 'canShare' in navigator && !fileShareBrokenThisSession) {
      try {
        // Chromium safelists shareable file EXTENSIONS, and .log is not on it:
        // canShare({files}) returns true but share() itself rejects with
        // NotAllowedError "Permission denied" (observed on macOS Chrome).
        // Share the same content under a .txt name — .txt is safelisted
        // everywhere — and keep the .log extension for the download path only.
        const file = new File([text], filename.replace(/\.log$/, '.txt'), { type: 'text/plain' });
        if (navigator.canShare({ files: [file] })) payload = { files: [file], title: 'LipSync Connect log' };
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
      const copiedMsg = 'Log copied to clipboard — paste it into an email.';
      log(copiedMsg, 'log-info');
      showNotification(copiedMsg);
      announceStatus(copiedMsg);
      return;
    }
    // Clipboard refused (e.g., insecure context) — open mailto with a
    // paste-here marker; if mailto also leads nowhere there's a download
    // fallback at the end.
    try {
      window.location.href =
        'mailto:?subject=LipSync%20Connect%20log&body=Log%20was%20too%20long%20to%20attach%20%E2%80%94%20email%20it%20from%20the%20downloaded%20file.';
    } catch {
      downloadFallback();
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
    window.location.href = 'mailto:?subject=LipSync%20Connect%20log&body=' + encodeURIComponent(text);
  } catch (e) {
    // e) mailto navigation itself threw (rare) — keep the download copy.
    log('Share failed: ' + e.message, 'log-err');
    downloadFallback();
  }
}
