// Command path over an open serial session: raw writes, response waiters,
// the SETTINGS handshake, and the per-command queue. Everything here was
// hand-tuned against firmware v4.1 timing — do not restructure casually.
import { CMD_DEFAULT_TIMEOUT, CMD_SETTINGS_TIMEOUT, MAX_WAITERS, READ_TIMEOUT } from '../config/constants.js';
import { parseResponse, isCommandCompletion, commandMatchDetails, responseValueMatches } from './protocol.js';
import { serialSession, serialBus, readWatchdog } from './session.js';
import { log } from '../services/log.js';
import { announceStatus } from '../ui/a11y.js';

const enc = new TextEncoder();

/** The abort error shape shared by the command path and its waiters. */
export function commandAbortError() {
  const e = new Error('Firmware update cancelled.');
  e.name = 'AbortError';
  return e;
}

/**
 * True while a firmware wizard panel is on screen (the section carries the
 * data-wizard marker). Used to mute the idle watchdog below — exported for
 * the test that pins the mute contract (the same DOM check connection.js
 * uses for its guard message; no service import, to keep this layer clean).
 */
export function firmwareWizardPanelActive() {
  return !!document.getElementById('sec-firmware')?.getAttribute('data-wizard');
}

// The watchdog window is 30 s in production; the test seam shrinks it so the
// mute (and the advisory itself) can be exercised without wall-clock waits.
let readTimeoutMs = READ_TIMEOUT;

/** Test seam: shrink the idle-watchdog window. */
export function setReadTimeoutForTests(ms) {
  readTimeoutMs = ms;
}

export function resetReadTimer(gen) {
  if (gen === undefined) gen = readWatchdog.gen;
  if (!serialSession.port) return;
  clearTimeout(readWatchdog.timer);
  readWatchdog.gen = gen;
  readWatchdog.timer = setTimeout(() => {
    if (gen !== serialSession.readerGeneration && serialSession.readerGeneration !== 0) return;
    if (serialSession.disconnecting || !serialSession.port) return;
    // The advisory is session-truthful, but mid-wizard it interrupts the
    // flow's own voice — the one live window (session open, user reading
    // the update prompt) is exactly when a "30 s idle" aside is noise. The
    // wizard's step region is the only voice that matters while it is up.
    if (firmwareWizardPanelActive()) return;
    const message =
      'No data received for ' +
      readTimeoutMs / 1000 +
      's. The connection is still open — this is normal when the device is idle. If a setting was in progress, it may have stalled.';
    announceStatus(message);
    log(message, 'log-info');
  }, readTimeoutMs);
}

/**
 * Resolves with the next line matching `predicate`, or rejects on timeout.
 * An optional AbortSignal rejects the wait early and removes the waiter, so
 * a cancelled flow never leaves a stale waiter to swallow a later response
 * — and never keeps waiting on a device after its caller has gone away.
 * @param {(line: string) => boolean} predicate
 * @param {number} timeoutMs
 * @param {AbortSignal} [signal]
 */
export function waitLine(predicate, timeoutMs, signal) {
  if (serialBus.lineWaiters.length >= MAX_WAITERS) {
    log(
      'Warning: ' + serialBus.lineWaiters.length + ' unserviced device response waiters — connection may be stalled.',
      'log-err',
    );
    return Promise.reject(new Error('Too many pending device response waiters. Disconnect and reconnect.'));
  }
  return new Promise((resolve, reject) => {
    const w = {
      predicate,
      // A normal response resolves the waiter but must also detach its abort
      // listener and timeout; otherwise one load leaves a listener per command
      // on the same load-wide AbortSignal.
      resolve: (value) => {
        removeSelf();
        clearTimeout(w.timer);
        resolve(value);
      },
      reject,
    };
    const removeSelf = () => {
      serialBus.lineWaiters = serialBus.lineWaiters.filter((x) => x !== w);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      removeSelf();
      clearTimeout(w.timer);
      reject(commandAbortError());
    };
    w.timer = setTimeout(() => {
      removeSelf();
      reject(new Error('Timed out waiting for device response'));
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(w.timer);
        reject(commandAbortError());
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    serialBus.lineWaiters.push(w);
  });
}

// ---- Wire protocol v2: newline-terminated commands (roadmap item 6) ------
// Firmware 4.2.0's line parser frames newline-terminated messages the instant
// they arrive, while legacy bare writes keep the 50 ms idle-gap frame that
// pads every exchange (a full 17-setting load: ~50 ms of framing per
// command). Stock 4.1 REJECTS a trailing newline on every comparison, so the
// newline must never go out until the connected device has identified itself
// as 4.2.0 or newer — the VN load (the second command of a fresh session)
// flips the flag, and everything after lands in ~2 ms instead of ~50 ms.
// The first exchange or two of a session stays bare, which every firmware
// accepts. Reset on every connect so a 4.2 device followed by a 4.1 device
// on the same page can never leak v2 framing to the older one.
let wireNewlineFraming = false;

// The connected firmware's parsed version ([major, minor, rev]), known once
// the VN endpoint has answered — null before that. Version-gated features
// (the BH health step, the 4.4.0+ restriction settings) consult this instead
// of re-parsing the DOM, so the decision is always about the CURRENT session
// and resets with every connect.
let sessionDeviceVersion = null;

/** Connect-time hook (serial/connection.js): unknown device → legacy framing, unknown version. */
export function resetWireNewlineFraming() {
  wireNewlineFraming = false;
  sessionDeviceVersion = null;
}

/**
 * True when the connected firmware is at least the given version. False
 * until VN has identified the device (and on every disconnect), which is
 * what keeps version-gated endpoints from ever being sent to older
 * firmware — the device would answer FAIL and the load would log noise.
 * @param {number} major
 * @param {number} minor
 * @param {number} [rev]
 */
export function deviceFirmwareAtLeast(major, minor, rev = 0) {
  if (!sessionDeviceVersion) return false;
  const [dmaj, dmin, drev] = sessionDeviceVersion;
  return dmaj > major || (dmaj === major && (dmin > minor || (dmin === minor && drev >= rev)));
}

/**
 * Records the connected firmware's wire-protocol generation. Called by the
 * VN endpoint renderer once the version has been read. Unparsable versions
 * keep the safe legacy framing.
 * @param {string|number|null} version
 */
export function noteDeviceVersion(version) {
  const m = String(version ?? '')
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)/);
  wireNewlineFraming = !!m && (+m[1] > 4 || (+m[1] === 4 && +m[2] >= 2));
  sessionDeviceVersion = m ? [+m[1], +m[2], +m[3]] : null;
}

export async function sendRaw(text) {
  log('>> ' + text, 'log-tx');
  if (!serialSession.writer) throw new Error('Not connected');
  resetReadTimer();
  await serialSession.writer.write(enc.encode(wireNewlineFraming ? text + '\n' : text));
}

/**
 * Runs one command over the settings protocol (handshake → write → wait for
 * the completion line) on the shared command queue. The optional `{ signal }`
 * makes the exchange abort-aware: the handshake's wait and the command's wait
 * reject early, and — the gate the soft-reset restart depends on — a cancel
 * that lands while the handshake is settling stops the command from ever
 * being written. If the abort arrives AFTER the write, the rejection carries
 * `commandWritten: true`, because the device may already be acting on it.
 * @param {string} cmd
 * @param {number} [timeoutMs]
 * @param {number} [settingsTimeoutMs]
 * @param {{ signal?: AbortSignal }} [options]
 */
export function sendCommand(
  cmd,
  timeoutMs = CMD_DEFAULT_TIMEOUT,
  settingsTimeoutMs = CMD_SETTINGS_TIMEOUT,
  { signal } = {},
) {
  const aborted = () => !!signal?.aborted;
  const run = async () => {
    if (!serialSession.port) throw new Error('Not connected');
    if (aborted()) throw commandAbortError();
    // Fresh connections sometimes reject the very first SETTINGS handshake
    // (observed on hardware: FAIL,0:SETTINGS immediately after port open).
    // Retry that specific failure once. Long-running sessions hit the
    // handshake normally and get no artificial pause.
    for (let attempt = 0; attempt < 2; attempt++) {
      await sendRaw('SETTINGS');
      const line = await waitLine(
        (l) => {
          const response = parseResponse(l);
          return isCommandCompletion(response) && response.cmd === 'SETTINGS';
        },
        settingsTimeoutMs,
        signal,
      );
      const parsed = parseResponse(line);
      if (parsed.ok) {
        break;
      }
      if (attempt === 0) {
        log('Initial SETTINGS handshake rejected — retrying after brief settle.');
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      throw new Error('Device rejected settings handshake.');
    }
    // Between the handshake and the write lies the window where a cancelled
    // caller can still stop the device from ever seeing the command: after
    // this point the bytes are on the wire and the device acts on them
    // whether or not anyone is still listening (SR,1:1 reboots it).
    if (aborted()) throw commandAbortError();
    const { expectedCommand, expectedValue, shouldEchoValue } = commandMatchDetails(cmd);
    await sendRaw(cmd);
    let line;
    try {
      line = await waitLine(
        (l) => {
          const response = parseResponse(l);
          return (
            isCommandCompletion(response) &&
            response.cmd === expectedCommand &&
            (!response.ok || !shouldEchoValue || responseValueMatches(expectedValue, response.value))
          );
        },
        timeoutMs,
        signal,
      );
    } catch (e) {
      if (e?.name === 'AbortError') e.commandWritten = true;
      throw e;
    }
    const resp = parseResponse(line);
    if (!resp.ok) throw new Error('Device rejected command.');
    return resp;
  };
  const thisCmd = /** @type {Promise<any>} */ (serialBus.cmdQueue.then(run, run));
  serialBus.cmdQueue = /** @type {Promise<void>} */ (thisCmd.catch(() => {}));
  return thisCmd;
}
