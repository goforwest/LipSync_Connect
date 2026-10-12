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

export function resetReadTimer(gen) {
  if (gen === undefined) gen = readWatchdog.gen;
  if (!serialSession.port) return;
  clearTimeout(readWatchdog.timer);
  readWatchdog.gen = gen;
  readWatchdog.timer = setTimeout(() => {
    if (gen !== serialSession.readerGeneration && serialSession.readerGeneration !== 0) return;
    if (serialSession.disconnecting || !serialSession.port) return;
    const message =
      'No data received for ' +
      READ_TIMEOUT / 1000 +
      's. The connection is still open — this is normal when the device is idle. If a setting was in progress, it may have stalled.';
    announceStatus(message);
    log(message, 'log-info');
  }, READ_TIMEOUT);
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
    const w = { predicate, resolve, reject };
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

export async function sendRaw(text) {
  log('>> ' + text, 'log-tx');
  if (!serialSession.writer) throw new Error('Not connected');
  resetReadTimer();
  await serialSession.writer.write(enc.encode(text));
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
