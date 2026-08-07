// Incoming-line handling: applies parsed device responses to the UI, serves
// pending command waiters, routes self-test narration, and forwards anything
// unparseable to the corrupt-drop logger.
import { parseResponse } from './protocol.js';
import { serialBus } from './session.js';
import { log, noisyLineLog } from '../services/log.js';
import { maybeUnlockSelfTest, getSelfTestState, advanceSelfTest, closeSelfTestPanel } from '../services/selftest.js';
import { ENDPOINT_RENDERERS } from '../services/registry.js';
import { applyDebugData, showDiagPanel, syncLiveButtons } from '../plotting/diag.js';
import { gaugeDelta } from '../plotting/gauge.js';
import { plotCorner, plotRawXY, orientFromOutput, cornerState } from '../plotting/plot.js';
import { updateStepButtons, calibrationIsRunning } from '../services/settings-service.js';
import { $ } from '../ui/dom.js';

export function applyDeviceResponse(line) {
  const r = parseResponse(line);
  if (!r || !r.ok || r.value == null) return;
  if (r.cmd.startsWith('DEBUG,')) {
    applyDebugData(r.cmd.slice(6), r.value);
    return;
  }
  const endpoint = r.cmd.slice(0, 2);
  const updates = {
    SS: () => ENDPOINT_RENDERERS.SS(r.value),
    SL: () => ENDPOINT_RENDERERS.SL(r.value),
    ST: () => ENDPOINT_RENDERERS.ST(r.value),
    PT: () => ENDPOINT_RENDERERS.PT(r.value),
    IZ: () => ENDPOINT_RENDERERS.IZ(r.value),
    OZ: () => ENDPOINT_RENDERERS.OZ(r.value),
    SM: () => ENDPOINT_RENDERERS.SM(r.value),
    LM: () => ENDPOINT_RENDERERS.LM(r.value),
    LL: () => ENDPOINT_RENDERERS.LL(r.value),
    MN: () => ENDPOINT_RENDERERS.MN(r.value),
    VN: () => ENDPOINT_RENDERERS.VN(r.value),
    ID: () => ENDPOINT_RENDERERS.ID(r.value),
    CA: () => {
      const corner = parseInt(r.cmd.slice(3), 10);
      if (corner >= 1 && corner <= 4) {
        $('corner' + corner).textContent = r.value;
        plotCorner(corner, r.value);
        cornerState(corner, 'captured');
      }
    },
    DM: () => {
      ENDPOINT_RENDERERS.DM(r.value);
      showDiagPanel(r.value);
      syncLiveButtons(r.value);
    },
    OM: () => ENDPOINT_RENDERERS.OM(r.value),
    CM: () => ENDPOINT_RENDERERS.CM(r.value),
    IN: () => {
      ENDPOINT_RENDERERS.IN(r.value);
      // Only claim the neutral was "updated" for a user-triggered IN,1:1
      // (the standalone reset button). When a full calibration is in flight the
      // neutral line is the last firmware-led step; the calibration state
      // machine owns the status text then.
      if (r.cmd === 'IN,1' && !calibrationIsRunning())
        $('calStatus').textContent = 'Neutral position updated on device.';
    },
    PV: () => {
      const p = (r.value || '').split(',');
      $('pvMouth').textContent = p[0] ?? '?';
      $('pvAmbient').textContent = p[1] ?? '?';
      $('pvDiff').textContent = p[2] ?? '?';
      $('diagPressMouth').textContent = p[0] ?? '?';
      $('diagPressAmbient').textContent = p[1] ?? '?';
      $('diagPressDiff').textContent = p[2] ?? '?';
      gaugeDelta(Number(p[2]));
    },
    JV: () => {
      const p = (r.value || '').split(',').map(Number);
      $('joyRaw').textContent = (p[0] ?? '?') + ' | ' + (p[1] ?? '?');
      $('joyOut').textContent = (p[4] ?? '?') + ' | ' + (p[5] ?? '?');
      if (p.length >= 6) orientFromOutput({ x: p[0], y: p[1] }, { x: p[4], y: p[5] });
      plotRawXY(p[0], p[1]);
    },
    SR: () => log('Device acknowledged restart (SR). Restart in progress…', 'log-info'),
    SE: () => log('Device acknowledged settings commit (SE).', 'log-info'),
    // FR/CH/RT all emit a value-bearing ack (SUCCESS,0:<EP>,1:<n>); without a
    // handler here each would fall through to the 'Unrecognized device response'
    // log line even though the app issued the command itself. Log them as what
    // they are so the command log is a faithful transcript.
    FR: () => log('Device acknowledged factory reset (FR). Device will restart with defaults…', 'log-info'),
    CH: () => log('Hub menu press acknowledged (CH,' + r.cmd.slice(3) + ').', 'log-info'),
    RT: () => log('Self-test acknowledged (RT,' + r.cmd.slice(3) + '); narrating steps…', 'log-info'),
  };
  if (updates[endpoint]) updates[endpoint]();
  else if (!r.cmd.startsWith('DEBUG,')) {
    // When firmware adds an endpoint and this map doesn't know it, the response
    // is silently dropped from the readout. Surface it loudly in dev/local use
    // (localhost/127.0.0.1/file:) so support logs show it instead of hiding it.
    // location.hostname (not .host) — .host includes the port, so the dev
    // server at localhost:4443 would never match an anchored hostname list.
    const isDev =
      typeof location === 'object' &&
      (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(location.hostname || '') ||
        (location.protocol || location.href || '').startsWith('file:'));
    log('Unrecognized device response: ' + r.cmd, isDev ? 'log-err' : 'log-info');
  }
  if (!r.cmd.startsWith('DEBUG,')) updateStepButtons();
}

export function handleLine(line) {
  const isDebug = /^SUCCESS,\d+:DEBUG,\d+:/.test(line);
  if (!isDebug) log('<< ' + line, 'log-rx');
  applyDeviceResponse(line);
  if (isDebug) return;
  for (let i = 0; i < serialBus.lineWaiters.length; i++) {
    if (serialBus.lineWaiters[i].predicate(line)) {
      const w = serialBus.lineWaiters.splice(i, 1)[0];
      clearTimeout(w.timer);
      w.resolve(line);
      return;
    }
  }
  maybeUnlockSelfTest(line); // terminal line releases the button lock
  if (getSelfTestState().mode) {
    advanceSelfTest(line); // narrated step lines land here (unparsed by the protocol layer)
    if (line.trim() === 'Test Complete') {
      closeSelfTestPanel(true);
      return; // narration is not data corruption — bypass the "undecodable" logger
    }
    if (!parseResponse(line)) return; // narration is never a parseable protocol line
  }
  // Out-of-band text that arrives outside a self-test (or that looks like a
  // response but doesn't parse) is actual corruption/desync and must be logged.
  if (!parseResponse(line)) noisyLineLog(line);
}
