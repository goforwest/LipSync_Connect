// Command path over an open serial session: raw writes, response waiters,
// the SETTINGS handshake, and the per-command queue. Everything here was
// hand-tuned against firmware v4.1 timing — do not restructure casually.
import { CMD_DEFAULT_TIMEOUT, CMD_SETTINGS_TIMEOUT, MAX_WAITERS, READ_TIMEOUT } from '../config/constants.js';
import { parseResponse, isCommandCompletion, commandMatchDetails, responseValueMatches } from './protocol.js';
import { serialSession, serialBus, readWatchdog } from './session.js';
import { log } from '../services/log.js';
import { announceStatus } from '../ui/a11y.js';

const enc = new TextEncoder();

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

export function waitLine(predicate, timeoutMs) {
  if (serialBus.lineWaiters.length >= MAX_WAITERS) {
    log(
      'Warning: ' + serialBus.lineWaiters.length + ' unserviced device response waiters — connection may be stalled.',
      'log-err',
    );
    return Promise.reject(new Error('Too many pending device response waiters. Disconnect and reconnect.'));
  }
  return new Promise((resolve, reject) => {
    const w = { predicate, resolve, reject };
    w.timer = setTimeout(() => {
      serialBus.lineWaiters = serialBus.lineWaiters.filter((x) => x !== w);
      reject(new Error('Timed out waiting for device response'));
    }, timeoutMs);
    serialBus.lineWaiters.push(w);
  });
}

export async function sendRaw(text) {
  log('>> ' + text, 'log-tx');
  if (!serialSession.writer) throw new Error('Not connected');
  resetReadTimer();
  await serialSession.writer.write(enc.encode(text));
}

export function sendCommand(cmd, timeoutMs = CMD_DEFAULT_TIMEOUT, settingsTimeoutMs = CMD_SETTINGS_TIMEOUT) {
  const run = async () => {
    if (!serialSession.port) throw new Error('Not connected');
    // Fresh connections sometimes reject the very first SETTINGS handshake
    // (observed on hardware: FAIL,0:SETTINGS immediately after port open).
    // Retry that specific failure once. Long-running sessions hit the
    // handshake normally and get no artificial pause.
    for (let attempt = 0; attempt < 2; attempt++) {
      await sendRaw('SETTINGS');
      const line = await waitLine((l) => {
        const response = parseResponse(l);
        return isCommandCompletion(response) && response.cmd === 'SETTINGS';
      }, settingsTimeoutMs);
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
    const { expectedCommand, expectedValue, shouldEchoValue } = commandMatchDetails(cmd);
    await sendRaw(cmd);
    const line = await waitLine((l) => {
      const response = parseResponse(l);
      return (
        isCommandCompletion(response) &&
        response.cmd === expectedCommand &&
        (!response.ok || !shouldEchoValue || responseValueMatches(expectedValue, response.value))
      );
    }, timeoutMs);
    const resp = parseResponse(line);
    if (!resp.ok) throw new Error('Device rejected command.');
    return resp;
  };
  const thisCmd = /** @type {Promise<any>} */ (serialBus.cmdQueue.then(run, run));
  serialBus.cmdQueue = /** @type {Promise<void>} */ (thisCmd.catch(() => {}));
  return thisCmd;
}
