// One-off device actions that coordinate multiple module boundaries and/or
// end in restart/disconnect: the LED/buzzer self-tests and soft/factory reset.
import { CMD_RESET_TIMEOUT, CMD_TEST_TIMEOUT, VALUE_IDS, DEBUG_MODES } from '../config/constants.js';
import { $ } from '../ui/dom.js';
import { showConfirm } from '../ui/formatting.js';
import { log } from './log.js';
import { sendCommand } from '../serial/commands.js';
import { serialSession } from '../serial/session.js';
import { disconnect } from '../serial/connection.js';
import { lockSelfTestButtons, unlockSelfTestButtons, openSelfTestPanel, closeSelfTestPanel } from './selftest.js';
import { resetPlotState } from '../plotting/plot.js';
import { modeState } from '../state/modes.js';

export function bindDeviceOps(guard) {
  $('btnTestLeds').addEventListener(
    'click',
    guard(async () => {
      lockSelfTestButtons(); // disable both while firmware narrates the LED sequence (~20s)
      openSelfTestPanel('led');
      try {
        await sendCommand('RT,1:1', CMD_TEST_TIMEOUT); // can take ~20 s to acknowledge under load
        log('LED test started — watch the panel for live progress.', 'log-info');
      } catch (e) {
        closeSelfTestPanel(false);
        unlockSelfTestButtons();
        throw e;
      }
    }),
  );
  $('btnTestBuzzer').addEventListener(
    'click',
    guard(async () => {
      lockSelfTestButtons();
      openSelfTestPanel('buzzer');
      try {
        await sendCommand('RT,1:2', CMD_TEST_TIMEOUT); // ~8s of narration
        log('Buzzer test started — watch the panel for live progress.', 'log-info');
      } catch (e) {
        closeSelfTestPanel(false);
        unlockSelfTestButtons();
        throw e;
      }
    }),
  );
  $('btnSoftReset').addEventListener(
    'click',
    guard(async () => {
      if (
        !(await showConfirm(
          'Soft reset',
          'Reset the LipSync? The device will restart and disconnect. You will need to reconnect afterwards.',
        ))
      )
        return;
      await sendCommand('SR,1:1', CMD_RESET_TIMEOUT);
      await disconnect();
    }),
  );
  $('btnFactoryReset').addEventListener(
    'click',
    guard(async () => {
      if (
        !(await showConfirm(
          'Factory reset',
          '<strong>This restores ALL settings to defaults.</strong> The device will restart with default settings. Reconnect afterwards.',
        ))
      )
        return;
      await sendCommand('FR,1:1', CMD_RESET_TIMEOUT);
      log('Factory reset sent. The device restarts with default settings; reconnect afterwards.', 'log-info');
      VALUE_IDS.forEach((id) => {
        const el = $(id);
        if (el) {
          el.textContent = '—';
          el.classList.remove('loading', 'err');
        }
      });
      [
        'pvMouth',
        'pvAmbient',
        'pvDiff',
        'joyRaw',
        'joyOut',
        'neutralVal',
        'corner1',
        'corner2',
        'corner3',
        'corner4',
        'btName',
        'btStatus',
        'healthSummary',
        'healthDetails',
        'calStatus',
      ].forEach((id) => {
        const el = $(id);
        if (el) el.textContent = '—';
      });
      resetPlotState();
      // The device is about to reboot with defaults, so the live-diagnostic
      // selection and the OM/CM mode state must not keep showing pre-reset
      // values until the next successful load overwrites them.
      const dmSelect = $('debugMode');
      if (dmSelect) dmSelect.value = '0';
      const dmVal = $('debugModeVal');
      if (dmVal) dmVal.textContent = DEBUG_MODES[0];
      modeState.currentOpMode = null;
      modeState.currentComMode = null;
      if (serialSession.port) await disconnect();
    }),
  );
}
