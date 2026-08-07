// Operating/communication mode state and the OM/CM preset display logic that
// keeps the header, the preset <select>, the apply button, and the Bluetooth
// card in sync. The actual mode-switch flows (send OM/CM/SR sequences + the
// restart-and-disconnect dance) are wired in app.js.
import { MODE_PRESETS, OP_MODES, COM_MODES, MODEL_FEATURES } from '../config/constants.js';
import { $ } from '../ui/dom.js';
import { setValue } from '../ui/values.js';
import { serialSession } from '../serial/session.js';
import { modeState } from '../state/modes.js';

export function presetKey(om, cm) {
  return Object.keys(MODE_PRESETS).find((k) => MODE_PRESETS[k].om === om && MODE_PRESETS[k].cm === cm) || null;
}
export function syncModeBtn() {
  const target = MODE_PRESETS[$('operatingMode').value];
  const btn = $('btnSetOperatingMode');
  if (!btn) return;
  if (!target || !serialSession.port) {
    btn.disabled = true;
    return;
  }
  btn.disabled =
    modeState.currentOpMode != null && target.om === modeState.currentOpMode && target.cm === modeState.currentComMode;
}
export function updateModeDisplay() {
  const key = presetKey(modeState.currentOpMode, modeState.currentComMode);
  if (modeState.currentOpMode != null)
    setValue('opmode', key ? MODE_PRESETS[key].label : (OP_MODES[modeState.currentOpMode] ?? modeState.currentOpMode));
  if (modeState.currentComMode != null)
    setValue('commode', COM_MODES[modeState.currentComMode] ?? modeState.currentComMode);
  if (key) $('operatingMode').value = key;
  $('modeGuardHint').textContent = '';
  syncModeBtn();
  updateBtStatus();
}

export function updateBtName() {
  const id = $('deviceId').textContent;
  setValue('btName', id && id !== '…' ? 'LS_' + id : '…');
}
export function updateBtStatus() {
  const bt = modeState.currentComMode === '2';
  setValue('btStatus', bt ? 'Bluetooth mode — advertising' : 'USB mode');
  const btn = $('btnSwitchBt');
  if (btn) btn.disabled = bt || !serialSession.port;
}

export function applyModelFeatures(model) {
  const features = MODEL_FEATURES[model] ?? { bluetooth: true, gamepad: true };
  document.querySelectorAll('[data-feature]').forEach((/** @type {any} */ el) => {
    if (el.tagName === 'OPTION') {
      el.hidden = !features[el.dataset.feature];
      el.disabled = !features[el.dataset.feature];
    } else {
      el.hidden = !features[el.dataset.feature];
    }
  });
}

// ---- Multi-step mode switches (preset apply, Bluetooth switch) ----
// Firmware v4.1 contract:
//  * OM and CM are sent one at a time, SETTINGS handshake before each, and
//    the write order matters — when the target has om==='2' (Gamepad) the
//    commands are reversed so CM applies FIRST: CM→1 (USB) must land before
//    OM→2 (Gamepad), because firmware rejects OM→Gamepad while CM is still
//    BLE (LSAPI.ino:524). (The modes are mutually exclusive in both
//    directions — see also LSAPI.ino:1630.)
//  * The device does NOT auto-reboot on OM change: an explicit SR,1:1
//    follows; if the future firmware restores auto-reset, drop the SR to
//    avoid a double-reset.
//  * After restart, the port is closed and the user reconnects.
import { CMD_MODE_TIMEOUT, CMD_RESET_TIMEOUT } from '../config/constants.js';
import { showConfirm } from '../ui/formatting.js';
import { showNotification } from '../ui/notification.js';
import { setCmdButtons } from '../ui/connection-ui.js';

import { log } from './log.js';
import { sendCommand } from '../serial/commands.js';
import { disconnect } from '../serial/connection.js';

export function bindModeSwitch(guard) {
  $('btnSetOperatingMode').addEventListener(
    'click',
    guard(async () => {
      const btn = $('btnSetOperatingMode');
      btn.disabled = true;
      try {
        const target = MODE_PRESETS[$('operatingMode').value];
        if (!target) return;
        if (target.om === modeState.currentOpMode && target.cm === modeState.currentComMode) {
          $('modeGuardHint').textContent = 'The device is already in ' + target.label + ' mode.';
          return;
        }
        if (
          !(await showConfirm(
            'Change operating mode',
            `Switch to <strong>${target.label}</strong>? The LipSync will save the setting, restart, and disconnect. After the restart, reconnect to continue.`,
          ))
        )
          return;
        setCmdButtons(false);
        let stored = false;
        try {
          const commands = [];
          if (modeState.currentOpMode !== target.om) commands.push('OM,1:' + target.om);
          if (modeState.currentComMode !== target.cm) commands.push('CM,1:' + target.cm);
          if (target.om === '2') commands.reverse();
          for (const cmd of commands) await sendCommand(cmd, CMD_MODE_TIMEOUT, 10000);
          stored = true;
          log(`Operating mode saved as ${target.label}; restarting the LipSync…`, 'log-info');
          try {
            await sendCommand('SR,1:1', CMD_RESET_TIMEOUT, 20000);
          } catch {
            log('Restart command did not confirm (device may already be starting).', 'log-info');
          }
          if (serialSession.port) await disconnect();
          log('Mode change complete. Reconnect once the LipSync has restarted.', 'log-info');
          showNotification('Mode set to ' + target.label + '. Click Connect after ~30s when the LipSync restarts.');
        } catch (e) {
          if (stored) {
            if (serialSession.port) await disconnect();
            log(
              'The new mode is saved, but the automatic restart did not confirm. Unplug the LipSync and plug it back in (or wait about 30 seconds for its watchdog) to finish the change.',
              'log-err',
            );
            return;
          }
          setCmdButtons(!!serialSession.port);
          throw e;
        }
      } finally {
        syncModeBtn();
      }
    }),
  );
  $('operatingMode').addEventListener('change', syncModeBtn);

  $('btnSwitchBt').addEventListener(
    'click',
    guard(async () => {
      const btn = $('btnSwitchBt');
      btn.disabled = true;
      try {
        if (modeState.currentComMode === '2') {
          log(
            'Already in Bluetooth mode. Open your computer’s Bluetooth settings and pair with “' +
              $('btName').textContent +
              '”.',
            'log-info',
          );
          return;
        }
        if (
          !(await showConfirm(
            'Switch to Bluetooth',
            'Switch to <strong>Mouse (Bluetooth)</strong>? The LipSync will save the setting, restart, and disconnect. After the restart, open Bluetooth settings on your computer to pair with it.',
          ))
        )
          return;
        setCmdButtons(false);
        let stored = false;
        try {
          if (modeState.currentOpMode !== '1') {
            await sendCommand('OM,1:1', CMD_MODE_TIMEOUT, 10000);
          }
          await sendCommand('CM,1:2', CMD_MODE_TIMEOUT, 10000);
          stored = true;
          log('Bluetooth mode saved; restarting the LipSync…', 'log-info');
          try {
            await sendCommand('SR,1:1', CMD_RESET_TIMEOUT, 20000);
          } catch {
            log('Restart command did not confirm (device may already be restarting).', 'log-info');
          }
          if (serialSession.port) await disconnect();
          log(
            'Bluetooth mode change complete. On your computer, open Bluetooth settings and pair with “' +
              $('btName').textContent +
              '”.',
            'log-info',
          );
          showNotification(
            'Bluetooth mode active. Open Bluetooth settings and pair with "' + $('btName').textContent + '".',
          );
        } catch (e) {
          if (stored) {
            if (serialSession.port) await disconnect();
            log(
              'Bluetooth mode saved but the automatic restart did not confirm. Unplug the LipSync and plug it back in (or wait about 30 seconds for its watchdog) to finish the change.',
              'log-err',
            );
            return;
          }
          setCmdButtons(!!serialSession.port);
          throw e;
        }
      } finally {
        updateBtStatus();
      }
    }),
  );
}
