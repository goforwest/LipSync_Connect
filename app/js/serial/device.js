// Incoming-line handling: applies parsed device responses to the UI, serves
// pending command waiters, routes self-test narration, and forwards anything
// unparseable to the corrupt-drop logger.
import { parseResponse, isDeviceDiagnosticLine } from './protocol.js';
import { serialBus } from './session.js';
import { log, noisyLineLog, unrecognizedResponseLog } from '../services/log.js';
import {
  maybeUnlockSelfTest,
  getSelfTestState,
  advanceSelfTest,
  closeSelfTestPanel,
  markSelfTestStepsDone,
} from '../services/selftest.js';
import { ENDPOINT_RENDERERS } from '../services/registry.js';
import { applyDebugData, showDiagPanel, syncLiveButtons } from '../plotting/diag.js';
import { gaugeDelta } from '../plotting/gauge.js';
import { plotCorner, plotRawXY, orientFromOutput, cornerState } from '../plotting/plot.js';
import { updateStepButtons, calibrationIsRunning, applySwitchActionValue } from '../services/settings-service.js';
import { noteExternalSettingsChange, applyHubMenuPush } from '../services/hub-remote.js';
import { applyBluetoothPush, applyHostCount, applyHostRow } from '../services/bt-hosts.js';
import { captureWriteConfirm } from '../services/confirm.js';
import { $ } from '../ui/dom.js';

const INPUT_ACTION_NAMES = {
  1: 'Left click',
  2: 'Right click',
  3: 'Middle click',
  4: 'Drag',
  5: 'Scroll',
  6: 'Gamepad B1',
  7: 'Gamepad B2',
  8: 'Gamepad B3',
  9: 'Gamepad B4',
  10: 'Gamepad B5',
  11: 'Gamepad B6',
  12: 'Gamepad B7',
  13: 'Gamepad B8',
  14: 'Center cursor',
  15: 'Calibrate',
  16: 'Speed down',
  17: 'Speed up',
  18: 'Change mode',
  19: 'Open menu',
  20: 'Close menu',
  21: 'Next menu item',
  22: 'Select menu item',
  23: 'Restart',
  24: 'Factory reset',
};

function describeInputSource(inputClass, state) {
  if (inputClass === 0) return state === 1 ? 'Sip' : state === 2 ? 'Puff' : `Sip/puff state ${state}`;
  if (inputClass === 1)
    return { 1: 'Hub Next', 2: 'Hub Select', 3: 'Both Hub buttons' }[state] ?? `Hub buttons ${state}`;
  if (inputClass === 2) {
    const active = [1, 2, 3].filter((jack) => state & (1 << (jack - 1))).map((jack) => `Switch ${jack}`);
    return active.length ? active.join(' + ') : `External switches ${state}`;
  }
  return `Input class ${inputClass}, state ${state}`;
}

function logInputAction(value) {
  const [inputClass, state, action, holdMs] = String(value).split(',').map(Number);
  if (![inputClass, state, action, holdMs].every(Number.isFinite)) return;
  const source = describeInputSource(inputClass, state);
  const actionName = INPUT_ACTION_NAMES[action] ?? `Action ${action}`;
  log(`Physical input action: ${source} → ${actionName} (${holdMs} ms).`, 'log-info');
}

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
    AV: () => ENDPOINT_RENDERERS.AV(r.value),
    ST: () => ENDPOINT_RENDERERS.ST(r.value),
    PT: () => ENDPOINT_RENDERERS.PT(r.value),
    // Hard band (4.7.0+, upstream #58): the load reads, the SET echoes, AND
    // the Hub menu's own pages/heals push MANUAL,0:HS,1:<v> lines — all three
    // shapes land in the renderers, so the readouts and the Hub mirror follow
    // the device exactly like ST/PT.
    HS: () => ENDPOINT_RENDERERS.HS(r.value),
    HP: () => ENDPOINT_RENDERERS.HP(r.value),
    HA: () => ENDPOINT_RENDERERS.HA(r.value),
    HB: () => ENDPOINT_RENDERERS.HB(r.value),
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
    MP: () => {}, // Atomic mode-preset ack; the device resets immediately after it lands
    IA: () => logInputAction(r.value), // Physical input action witness (firmware 4.6.5+)
    // Input restrictions (4.4.0+): the load reads and any MANUAL push from
    // the Hub menu both land here, keeping the checkboxes in sync.
    SD: () => ENDPOINT_RENDERERS.SD(r.value),
    MA: () => ENDPOINT_RENDERERS.MA(r.value),
    LK: () => ENDPOINT_RENDERERS.LK(r.value),
    CF: () => ENDPOINT_RENDERERS.CF(r.value),
    // Input timing windows (4.4.0+): same sync contract.
    WS: () => ENDPOINT_RENDERERS.WS(r.value),
    WL: () => ENDPOINT_RENDERERS.WL(r.value),
    WM: () => ENDPOINT_RENDERERS.WM(r.value),
    // External switch actions (4.5.0+, upstream #20): the GET answers the
    // "short,long,max" triple and the SET ack echoes the packed wire value —
    // both shapes land in applySwitchActionValue, so writes confirm from
    // device truth exactly like reads. (No Hub-menu surface exists for
    // remaps, so no MANUAL line can arrive here.)
    SA: () => applySwitchActionValue('SA', r.value),
    SB: () => applySwitchActionValue('SB', r.value),
    SC: () => applySwitchActionValue('SC', r.value),
    GA: () => applySwitchActionValue('GA', r.value),
    GB: () => applySwitchActionValue('GB', r.value),
    GC: () => applySwitchActionValue('GC', r.value),
    IN: () => {
      ENDPOINT_RENDERERS.IN(r.value);
      // Only claim the neutral was "updated" for a user-triggered IN,1:1 —
      // the standalone reset button, whose ack is a SUCCESS (firmware 4.5.2:
      // the ack type follows the initiator). Device-initiated centers (the
      // boot auto-center, the Hub-menu Center Reset, the calibration's
      // internal re-center) push the same line as MANUAL: the readout still
      // refreshes from it, but it is not an answer to anything the app
      // asked, so no "updated" status and no waiter may match it. When a
      // full calibration is in flight the neutral line is the last
      // firmware-led step; the calibration state machine owns the status
      // text then.
      if (r.type === 'SUCCESS' && r.cmd === 'IN,1' && !calibrationIsRunning())
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
    // BH answers a 13+ value array (the app's health check parses the first
    // six; the tail is the HID telemetry a bench reads raw). Acknowledge the
    // response so the command transcript does not log it as unrecognized
    // noise on every health check.
    BH: () => {},
    // EX,0:0 frames the raw console's settings dump (BEGIN…END); the body is
    // plain re-reads the endpoint renderers already handle. Acknowledge the
    // frames so the dump transcript stays clean (bench 2026-10-17, E3).
    EX: () => {},
    UM: () =>
      log(
        'Device acknowledged update-mode entry (UM). Entering its update loader — the Hub screen shows the "Update mode" message.',
        'log-info',
      ),
    // Multi-host Bluetooth switching (firmware 4.8.0+, upstream #16): the read
    // ACKs (BT,0:<i>:<name>:<active>, BT,1/2/3 acks) land in the host-table
    // renderer below so the card follows device truth; the MANUAL BT,4/BT,5
    // pushes land in applyBluetoothPush — device truth replaces the mirror
    // without resolving any waiter.
    FR: () => log('Device acknowledged factory reset (FR). Device will restart with defaults…', 'log-info'),
    BT: () => {
      // Both the count answer and a row answer parse as cmd "BT,0" — they
      // differ only in the value: a bare integer vs "i:name:active".
      if (r.cmd === 'BT,0') {
        if (String(r.value).includes(':')) applyHostRow(r.value);
        else applyHostCount(r.value);
        return;
      }
      // MANUAL,0:BT,4:<count> and MANUAL,0:BT,5:<activeRow> pushes (and the
      // BT,1/2/3 acks, which the module ignores — its own calls already
      // validated them).
      applyBluetoothPush(r.cmd, r.value);
    },
    CH: () => {
      // Two-way Hub remote (protocol proposal: docs/upstream-issue-comments.md):
      // a MANUAL CH,5 line is the device pushing its live menu state after a
      // PHYSICAL redraw — the mirror follows it; nothing was requested, so
      // there is no transcript line to log.
      if (r.type === 'MANUAL' && r.cmd === 'CH,5') {
        applyHubMenuPush(r.value);
        return;
      }
      if (r.cmd.startsWith('CH,1')) log('Hub menu press acknowledged (CH,' + r.cmd.slice(3) + ').', 'log-info');
    },
    RT: () => log('Self-test acknowledged (RT,' + r.cmd.slice(3) + '); narrating steps…', 'log-info'),
  };
  // Inline confirm/undo (services/confirm.js): snapshot the pre-write
  // control state BEFORE the renderers replace it, commit the chip after
  // they land the new device truth. Write responses only (",1") — reads and
  // MANUAL pushes confirm nothing.
  const pendingConfirm = captureWriteConfirm(endpoint, r.cmd);
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
    // Dev/local: every unknown line is loud so support logs show it. Production:
    // rate-limited info notes (a firmware that added an endpoint shouldn't be
    // able to flood the user's log, but the response must not vanish silently).
    if (isDev) log('Unrecognized device response: ' + r.cmd, 'log-err');
    else unrecognizedResponseLog(r.cmd);
  }
  // A MANUAL line is a physical Hub-menu change pushed unprompted: the
  // hub-remote mirror's value screens hold local ESTIMATES of these very
  // settings, and device truth just replaced them — refresh a visible value
  // page so the mirror shows what the Hub actually changed.
  if (r.type === 'MANUAL' && endpoint !== 'IA') noteExternalSettingsChange(endpoint);
  if (pendingConfirm) pendingConfirm.commit(r.value);
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
      markSelfTestStepsDone(); // the finished sequence's last bullet completes with the rest
      closeSelfTestPanel(true);
      return; // narration is not data corruption — bypass the "undecodable" logger
    }
    if (!parseResponse(line)) return; // narration is never a parseable protocol line
  }
  // Out-of-band text that arrives outside a self-test (or that looks like a
  // response but doesn't parse) is actual corruption/desync and must be logged.
  if (!parseResponse(line) && !isDeviceDiagnosticLine(line)) noisyLineLog(line);
}
