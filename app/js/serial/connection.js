// Serial connection lifecycle: connect, disconnect, and the read loop with
// reconnect/recovery. The device-services callbacks (settings load, health
// clear) are injected via configureConnection() in main.js so this module
// does not import service-layer code and the graph stays acyclic.
import { BAUD } from '../config/constants.js';
import { serialSession, serialBus, readWatchdog, loadDoneTimerRef } from './session.js';
import { resetReadTimer } from './commands.js';
import { serialApi } from './transport.js';
import { isBootloaderPort } from './dfu/dfu-serial.js';
import { openPortBounded } from '../utils/port-open.js';
import { handleLine } from './device.js';
import { log } from '../services/log.js';
import { announceStatus } from '../ui/a11y.js';
import { resetSelfTestLock } from '../services/selftest.js';
import {
  setConnectedUI,
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
    try {
      await serialSession.port.close();
    } catch {}
    await sleep(300);
    await openPortBounded(serialSession.port, { baudRate: BAUD });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function connect() {
  if (serialSession.port) return;
  $('btnConnect').disabled = true;
  showGuide();
  setConnectStage('requesting');
  try {
    serialSession.disconnecting = false;
    resetPlotState();
    serialSession.port = await /** @type {any} */ (serialApi).requestPort();
    hideGuide();
    setConnectStage('opening');
    await openSerialPortWithRecovery();
    // A LipSync sitting in its update loader accepts the port but cannot
    // answer the settings protocol — every command would time out. It is
    // recognizable by USB identity, so fail fast with recovery guidance
    // (this is the common state after cancelling an update after the
    // 1200-baud restart).
    if (isBootloaderPort(serialSession.port)) {
      try {
        await serialSession.port.close();
      } catch {}
      serialSession.port = null;
      const message =
        'That is the LipSync\u2019s update loader, not the LipSync itself. If the LipSync does not start normally after replugging, its firmware was interrupted — open Firmware and use “Recover a device stuck in update mode” to repair it.';
      log(message, 'log-err');
      announceStatus('Update loader selected. Replug the LipSync — or use Firmware to recover it.');
      // Keep the Firmware card openable and its Recover button reachable
      // while disconnected — when the app firmware is incomplete, recovery
      // is the only way out (reset and replug both land back in update mode).
      const section = document.getElementById('sec-firmware');
      if (section) section.setAttribute('data-recover', 'true');
      const recoverBtn = document.getElementById('btnRecoverDevice');
      if (recoverBtn) recoverBtn.hidden = false;
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
  }
}

export async function disconnect(options = {}) {
  const preserveBanner = options && options.preserveBanner === true;
  const quiet = options && options.quiet === true;
  serialSession.disconnecting = true;
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
      try {
        await serialSession.port.close();
      } catch (e) {
        // A wedged OS port can refuse the close, leaving the SerialPort
        // object open — the next connect would fail with "The port is
        // already open" (observed on hardware). Name it so the user knows
        // the remedy; connect() also attempts a cleanup retry.
        log(
          'The serial port did not close cleanly (' +
            (e?.message ?? 'unknown error') +
            '). If the next connect fails, unplug and replug the LipSync or reload the page.',
          'log-err',
        );
      }
      serialSession.port = null;
    }
  } finally {
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
  let buffer = '';
  let readClosed = false;
  serialSession.currentReader = serialSession.port.readable.getReader();
  try {
    resetReadTimer(myGen);
    while (true) {
      const { value, done } = await serialSession.currentReader.read();
      if (done) {
        readClosed = true;
        break;
      }
      resetReadTimer(myGen);
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.search(/\r\n|\n/)) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + (buffer[idx] === '\r' ? 2 : 1));
        if (line) handleLine(line);
      }
    }
  } catch (e) {
    if (myGen !== serialSession.readerGeneration) return;
    if (!serialSession.disconnecting) {
      const lostMessage = 'Connection lost: ' + e.message + ' — attempting to recover…';
      announceStatus(lostMessage);
      log(lostMessage, 'log-err');
      try {
        await serialSession.currentReader.cancel();
        serialSession.currentReader.releaseLock();
        await new Promise((r) => setTimeout(r, 2000));
        if (myGen !== serialSession.readerGeneration) return;
        announceStatus('Connection recovered.');
        log('Connection recovered.', 'log-info');
        buffer = '';
        await readLoop();
        return;
      } catch (recoveryErr) {
        if (myGen !== serialSession.readerGeneration) return;
        const recoveryMessage = 'Recovery failed: ' + recoveryErr.message + '.';
        announceStatus(recoveryMessage);
        log(recoveryMessage, 'log-err');
        showConnectionError('Connection lost. Recovery failed. Check cable and try again.', connect);
        await disconnect({ preserveBanner: true, quiet: true });
      }
    }
  } finally {
    if (myGen !== serialSession.readerGeneration) return;
    clearTimeout(readWatchdog.timer);
    readWatchdog.timer = null;
    try {
      serialSession.currentReader.releaseLock();
    } catch {}
    serialSession.currentReader = null;
  }
  if (readClosed && myGen === serialSession.readerGeneration && !serialSession.disconnecting) {
    announceStatus('Connection closed by device.');
    log('Connection closed by device.', 'log-err');
    showConnectionError('Connection closed. Check cable and reconnect.', connect);
    await disconnect({ preserveBanner: true });
  }
}
