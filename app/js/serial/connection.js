// Serial connection lifecycle: connect, disconnect, and the read loop with
// reconnect/recovery. The device-services callbacks (settings load, health
// clear) are injected via configureConnection() in main.js so this module
// does not import service-layer code and the graph stays acyclic.
import { BAUD, FIRMWARE_STRANDED_STORAGE_KEY } from '../config/constants.js';
import { serialSession, serialBus, readWatchdog, loadDoneTimerRef, portGeneration } from './session.js';
import { resetReadTimer, resetWireNewlineFraming } from './commands.js';
import { requestSerialPort } from './transport.js';
import { isBootloaderPort } from './dfu/dfu-serial.js';
import { closePortBounded, closePortWithOutcome, openPortBounded, getPortCloseTimeoutMs } from '../utils/port-open.js';
import { sleep } from '../utils/timers.js';
import { handleLine } from './device.js';
import { log } from '../services/log.js';
import { announceStatus } from '../ui/a11y.js';
import { resetSelfTestLock } from '../services/selftest.js';
import {
  setConnectedUI,
  noteConnectPressed,
  hideConnectionBanner,
  showConnectionError,
  showGuide,
  hideGuide,
  setConnectStage,
  setConnectStageAutoHide,
  handleBeforeUnload,
} from '../ui/connection-ui.js';
import { resetPlotState } from '../plotting/plot.js';
import { $ } from '../ui/dom.js';

// Wired at startup by main.js.
let services = {
  loadDeviceInfo: async () => {},
  clearHealthResults: () => {},
};
export function configureConnection(svc) {
  services = { ...services, ...svc };
}

/**
 * Opens the session port with a stall bound (a wedged macOS port can block
 * the OS-level open indefinitely — observed on hardware). If Chrome reports
 * the port as already open — the previous disconnect's close() failed
 * silently — attempts a cleanup close and retries once before giving up.
 */
async function openSerialPortWithRecovery() {
  try {
    await openPortBounded(serialSession.port, { baudRate: BAUD });
  } catch (e) {
    if (!/already open/i.test(e?.message ?? '')) throw e;
    log('The port was left open by the last session — closing it and retrying…', 'log-info');
    const close = await closePortWithOutcome(serialSession.port, 3000);
    if (close.outcome !== 'closed') {
      // The port cannot be closed either (hardware: a close stuck as
      // "already in progress") — a retry open would just fail the same way.
      // Name the dead end instead of grinding through it.
      log(
        'The port would not close (' +
          (close.error?.message ?? close.outcome) +
          '). Unplug and replug the LipSync or reload the page.',
        'log-err',
      );
      throw e;
    }
    await sleep(300);
    await openPortBounded(serialSession.port, { baudRate: BAUD });
  }
}

export async function connect() {
  if (serialSession.port) return;
  // A fresh connect attempt supersedes every in-flight port continuation
  // (a stalled open's late release, a cancelled wizard touch): late
  // teardowns check this generation and must never close what we claim.
  portGeneration.current++;
  // Before the disable lands: if the user activated Connect from the
  // keyboard, setConnectedUI must be able to hand focus off when the attempt
  // settles (Disconnect on success, back to Connect on cancel).
  noteConnectPressed();
  $('btnConnect').disabled = true;
  // Loading state spans the OS port picker and the settings load — the
  // spinner keeps the button from looking dead-while-busy; finally clears it.
  $('btnConnect').classList.add('btn--loading');
  showGuide();
  setConnectStage('requesting');
  try {
    serialSession.disconnecting = false;
    resetWireNewlineFraming(); // unknown device → legacy bare writes until VN identifies it (commands.js)
    resetPlotState();
    serialSession.port = await requestSerialPort();
    hideGuide();
    setConnectStage('opening');
    await openSerialPortWithRecovery();
    // A LipSync sitting in its update loader accepts the port but cannot
    // answer the settings protocol — every command would time out. It is
    // recognizable by USB identity, so fail fast with recovery guidance
    // (this is the common state after cancelling an update after the
    // 1200-baud restart).
    if (isBootloaderPort(serialSession.port)) {
      await closePortBounded(serialSession.port);
      serialSession.port = null;
      // When a firmware wizard is mid-flow (its section carries data-wizard
      // "active"), the wizard owns the recovery: Recover refuses to run
      // beside it, so the message must send the user to the wizard's own
      // Continue button instead of a dead end.
      const wizardActive = document.getElementById('sec-firmware')?.getAttribute('data-wizard') === 'active';
      const message = wizardActive
        ? 'That is the LipSync\u2019s update loader — an update is already in progress. Return to the Firmware section and use its Continue button to pick it there. If the update was abandoned, use \u201cRecover a device stuck in update mode\u201d.'
        : 'That is the LipSync\u2019s update loader, not the LipSync itself. If the LipSync does not start normally after replugging, its firmware was interrupted — open Firmware and use “Recover a device stuck in update mode” to repair it.';
      log(message, 'log-err');
      announceStatus('Update loader selected. Replug the LipSync — or use Firmware to recover it.');
      // Keep the Firmware card openable and its Recover button reachable
      // while disconnected — when the app firmware is incomplete, recovery
      // is the only way out (reset and replug both land back in update mode).
      // The sessionStorage mirror (FIRMWARE_STRANDED_STORAGE_KEY) keeps the
      // marker alive across a page reload; it is cleared on the next
      // successful settings load. Written inline (not via
      // services/firmware-update.js) so the serial layer never imports back
      // up the graph.
      const section = document.getElementById('sec-firmware');
      if (section) section.setAttribute('data-recover', 'true');
      const recoverBtn = document.getElementById('btnRecoverDevice');
      if (recoverBtn) recoverBtn.hidden = false;
      try {
        sessionStorage.setItem(FIRMWARE_STRANDED_STORAGE_KEY, '1');
      } catch {}
      setConnectStageAutoHide('failed', 3000);
      setConnectedUI(false);
      showConnectionError(message, connect);
      return;
    }
    serialSession.writer = serialSession.port.writable.getWriter();
    readLoop().catch((e) => {
      if (!serialSession.disconnecting) log('Read loop fatal: ' + e.message, 'log-err');
    });
    hideConnectionBanner();
    setConnectedUI(true);
    window.addEventListener('beforeunload', handleBeforeUnload);
    log('Serial port opened at ' + BAUD + ' baud.', 'log-info');
    // Firmware needs a beat after port open before it accepts the first SETTINGS
    // handshake — without this, load can fail with FAIL,0:SETTINGS on hive right
    // after open (observed on real hardware). Keep the gap short but real.
    await new Promise((r) => setTimeout(r, 50));
    setConnectStage('loading');
    await services.loadDeviceInfo();
    setConnectStageAutoHide('ready', 1200);
  } catch (e) {
    hideGuide();
    setConnectStageAutoHide('failed', 3000);
    if (e.name === 'NotFoundError') {
      log('Connection cancelled: no serial port selected.', 'log-info');
      setConnectedUI(false);
      return;
    }
    // A port left mid-open by a just-cancelled restart attempt: the OS
    // needs a moment; Chrome reports "A call to open() is already in
    // progress." Point at the settle instead of the cable.
    if (e?.name === 'PortStallError') {
      log(e.message, 'log-err');
      setConnectStageAutoHide('failed', 3000);
      setConnectedUI(false);
      showConnectionError(e.message, connect);
      await disconnect({ preserveBanner: true });
      return;
    }
    if (/already in progress/i.test(e.message ?? '')) {
      log('Connection failed: ' + e.message, 'log-err');
      showConnectionError(
        'The serial port is still settling from the previous operation. Wait a couple of seconds, then click Connect again.',
        connect,
      );
      await disconnect({ preserveBanner: true });
      return;
    }
    log('Connection failed: ' + e.message, 'log-err');
    showConnectionError('Connection failed: ' + e.message + '. Check cable and try again.', connect);
    await disconnect({ preserveBanner: true });
  } finally {
    $('btnConnect').classList.remove('btn--loading');
  }
}

export async function disconnect(options = {}) {
  const preserveBanner = options && options.preserveBanner === true;
  const quiet = options && options.quiet === true;
  serialSession.disconnecting = true;
  // A wedged OS close can hold this button's work for seconds (bounded
  // close timeout) — show the spinner so it doesn't look unresponsive.
  $('btnDisconnect').classList.add('btn--loading');
  clearTimeout(loadDoneTimerRef.current);
  try {
    serialSession.readerGeneration++;
    if (serialSession.currentReader) {
      try {
        await serialSession.currentReader.cancel();
      } catch {}
    }
    if (serialSession.writer) {
      try {
        serialSession.writer.releaseLock();
      } catch {}
      serialSession.writer = null;
    }
    if (serialSession.port) {
      // Bounded like every other port operation — a wedged OS close must
      // never hang disconnect (its finally owns the UI reset and waiter
      // cleanup). closePortBounded swallows, so the failure is surfaced
      // here first for the log. A port object without a working close()
      // (missing, wedged, or already dead) is a failed close, not a crash.
      let closeFailed = null;
      const closed = (async () => {
        try {
          await serialSession.port.close();
          return 'closed';
        } catch (e) {
          closeFailed = e;
          return 'failed';
        }
      })();
      const winner = await Promise.race([closed, sleep(getPortCloseTimeoutMs()).then(() => 'stalled')]);
      if (winner !== 'closed') {
        // A failed close leaves the SerialPort object open — the next
        // connect would fail with "The port is already open" (observed on
        // hardware). Name it so the user knows the remedy; connect() also
        // attempts a cleanup retry.
        log(
          'The serial port did not close cleanly (' +
            (closeFailed?.message ?? 'the close stalled') +
            '). If the next connect fails, unplug and replug the LipSync or reload the page.',
          'log-err',
        );
      }
      serialSession.port = null;
    }
  } finally {
    $('btnDisconnect').classList.remove('btn--loading');
    setConnectStage(null);
    clearTimeout(readWatchdog.timer);
    readWatchdog.timer = null;
    resetSelfTestLock();
    // Force the device self-test buttons back to a disabled state — without this,
    // a mid-test disconnect could leave them enabled on a now-closed port.
    const btnLeds = $('btnTestLeds'),
      btnBuzz = $('btnTestBuzzer');
    if (btnLeds) btnLeds.disabled = true;
    if (btnBuzz) btnBuzz.disabled = true;
    serialBus.lineWaiters.forEach((w) => {
      clearTimeout(w.timer);
      w.reject(new Error('Disconnected'));
    });
    serialBus.lineWaiters = [];
    serialBus.cmdQueue = Promise.resolve();
    window.removeEventListener('beforeunload', handleBeforeUnload);
    setConnectedUI(false);
    resetPlotState();
    if (!preserveBanner) hideConnectionBanner();
    if (!quiet) log('Disconnected.', 'log-info');
    services.clearHealthResults();
  }
}

async function readLoop() {
  const myGen = ++serialSession.readerGeneration;
  const decoder = new TextDecoder();
  const MAX_RECOVERY_ATTEMPTS = 3;
  let buffer = '';
  let readClosed = false;
  let recovered = false;
  let recoveryAttempts = 0;
  while (myGen === serialSession.readerGeneration && !serialSession.disconnecting) {
    /** @type {ReadableStreamDefaultReader<Uint8Array>|null} */
    let reader = null;
    try {
      // Acquisition belongs inside the recovery boundary: the stream can be
      // locked or already errored after a device-side disconnect, and that
      // rejection must go through recovery instead of becoming a silent
      // unhandled rejection while the header still says Connected.
      if (!serialSession.port?.readable) throw new Error('Serial port is no longer readable.');
      reader = serialSession.port.readable.getReader();
      serialSession.currentReader = reader;
      resetReadTimer(myGen);
      if (recovered) {
        announceStatus('Connection recovered.');
        log('Connection recovered.', 'log-info');
      }
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          readClosed = true;
          break;
        }
        // Only a reader that actually delivered data counts as healthy; this
        // keeps a getReader()-succeeds-then-immediately-fails loop bounded.
        recoveryAttempts = 0;
        resetReadTimer(myGen);
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.search(/\r\n|\n/)) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + (buffer[idx] === '\r' ? 2 : 1));
          if (line) handleLine(line);
        }
      }
      break;
    } catch (e) {
      if (myGen !== serialSession.readerGeneration || serialSession.disconnecting) return;
      recoveryAttempts++;
      if (recoveryAttempts === 1) {
        const lostMessage = 'Connection lost: ' + e.message + ' — attempting to recover…';
        announceStatus(lostMessage);
        log(lostMessage, 'log-err');
      } else {
        log('Recovery attempt ' + recoveryAttempts + ' failed: ' + e.message, 'log-err');
      }
      try {
        await reader?.cancel();
        reader?.releaseLock();
      } catch {}
      if (serialSession.currentReader === reader) serialSession.currentReader = null;
      if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
        const recoveryMessage = 'Connection lost. Recovery failed: ' + e.message + '.';
        announceStatus(recoveryMessage);
        log(recoveryMessage, 'log-err');
        showConnectionError('Connection lost. Recovery failed. Check cable and try again.', connect);
        await disconnect({ preserveBanner: true, quiet: true });
        return;
      }
      await sleep(2000);
      if (myGen !== serialSession.readerGeneration || serialSession.disconnecting) return;
      recovered = true;
      buffer = '';
      continue;
    } finally {
      if (reader) {
        try {
          reader.releaseLock();
        } catch {}
      }
      if (serialSession.currentReader === reader) serialSession.currentReader = null;
    }
  }
  if (readClosed && myGen === serialSession.readerGeneration && !serialSession.disconnecting) {
    announceStatus('Connection closed by device.');
    log('Connection closed by device.', 'log-err');
    showConnectionError('Connection closed. Check cable and reconnect.', connect);
    await disconnect({ preserveBanner: true });
  }
}
