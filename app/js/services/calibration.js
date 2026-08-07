// Neutral reset and the six-step calibration sequence. These are the long
// multi-step flows that coordinate UI state (steps/dots/status), protocol
// (CA,1:1 → corner acks → IN,1 → CA,0:0 read-back), and the \±13 default
// substitution watch across the whole calibration.
import {
  CMD_CALIBRATE_TIMEOUT,
  CMD_NEUTRAL_TIMEOUT,
  WEAK_CORNER_THRESHOLD,
  JOY_CORNER_DEFAULT,
} from '../config/constants.js';
import { announceStatus } from '../ui/a11y.js';
import { $ } from '../ui/dom.js';
import { prefersReducedMotion } from '../ui/motion.js';
import { setCmdButtons } from '../ui/connection-ui.js';
import { log } from './log.js';
import { sendCommand, waitLine } from '../serial/commands.js';
import { serialSession } from '../serial/session.js';
import { parseResponse } from '../serial/protocol.js';
import { cornerState, plotState } from '../plotting/plot.js';
import {
  setCalStep,
  showCalSteps,
  resetCalSteps,
  displayCalibration,
  setCalibrationInProgress,
  calibrationIsRunning,
} from './settings-service.js';

// After a successful calibration the completed step strip stays visible for a
// few seconds, then hides itself. The hide timer is tokenized (a module-global
// handle cancelled at the start of every run) so a stale timer from a previous
// run can never hide the strip of a new run started within the 4 s window.
let stripHideTimer = null;

export function bindCalibration(guard) {
  $('btnInit').addEventListener(
    'click',
    guard(async () => {
      $('calStatus').textContent = 'Resetting neutral position…';
      const r = await sendCommand('IN,1:1', CMD_NEUTRAL_TIMEOUT);
      // A full calibration also sends IN,1:1 as its last device-state step, so a
      // full-calibration run must not flip the status before this point.
      if (!calibrationIsRunning()) $('calStatus').textContent = 'Neutral position set to ' + (r.value ?? 'done') + '.';
      log('Neutral position reset complete.', 'log-info');
    }),
  );

  $('btnCalibrate').addEventListener(
    'click',
    guard(async () => {
      setCmdButtons(false);
      $('btnDisconnect').disabled = true;
      clearTimeout(stripHideTimer); // cancel any hide scheduled by a previous run
      stripHideTimer = null;
      let calSuccess = false;
      setCalibrationInProgress(true);
      showCalSteps(true);
      resetCalSteps();
      $('calSteps')?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
      try {
        // Firmware shows "hold top-left" immediately upon CA,1:1 arriving (step 1
        // delay + blinking happens before the actual reading). Match that: the
        // app's first prompt IS the corner-1 phase, not a separate initial-neutral.
        //
        // The firmware emits one async SUCCESS,0:CA,<n>:x|y line per corner at
        // the END of that corner's sampling window (~5s for corner 1: 1000ms
        // start delay + 1950ms blink + 10x200ms readings — LipSync_Firmware.ino
        // 1768-1888). setJoystickCalibration sends NO synchronous ack
        // (LSAPI.ino:963-968), so the sendCommand below only returns once the
        // corner-1 capture line arrives. Marking corner 1 "captured" right
        // after sendCommand was the old bug: it ran the UI ~5s ahead of the
        // device. All four corners are therefore awaited in a uniform loop.
        for (let i = 1; i <= 4; i++) {
          plotState.corners[i] = null;
          cornerState(i, '');
          const dot = $('dotC' + i);
          if (dot) dot.hidden = true;
        }
        cornerState(1, 'pending');
        setCalStep(1, 'active');
        $('calStatus').textContent = 'Step 1 of 6: push firmly to the top-left corner\u2026';
        const startCal = sendCommand('CA,1:1', CMD_CALIBRATE_TIMEOUT);
        for (let corner = 1; corner <= 4; corner++) {
          if (!serialSession.port) throw new Error('Disconnected');
          if (corner > 1) cornerState(corner, 'pending');
          if (corner === 1) {
            await startCal; // resolves on the async CA,1 capture line
          } else {
            await waitLine((l) => {
              const r = parseResponse(l);
              return r && r.ok && r.cmd === 'CA,' + corner;
            }, CMD_CALIBRATE_TIMEOUT);
          }
          cornerState(corner, 'captured');
          setCalStep(corner, 'done');
          setCalStep(corner + 1, 'active');
          const cornerLabel =
            corner === 1 ? 'top-right' : corner === 2 ? 'bottom-right' : corner === 3 ? 'bottom-left' : null;
          $('calStatus').textContent =
            `Corner ${corner} of 4 captured. Step ${corner + 1} of 6: ` +
            (corner < 4 ? `push firmly to the ${cornerLabel} corner\u2026` : 'hold still while re-centering\u2026');
        }
        if (!serialSession.port) throw new Error('Disconnected');
        // Step 5 (re-center) is still running on the device here; advance the
        // strip to step 6 only once the IN,1 line confirms re-centering ended,
        // so the strip never runs ahead of what the device is doing.
        await waitLine((l) => {
          const r = parseResponse(l);
          return r && r.ok && r.cmd === 'IN,1';
        }, CMD_CALIBRATE_TIMEOUT);
        setCalStep(6, 'active');
        $('calStatus').textContent = 'Step 6 of 6: hold the mouthpiece still — verifying stored calibration\u2026';
        const check = await sendCommand('CA,0:0');
        displayCalibration(check);
        const cornerPoints = (check.value || '').split(',').slice(1);
        // BOTH failure modes: a corner measured below the firmware minimum
        // (<3), and a corner the firmware already overwrote with its ±13
        // default because the push was too weak to register as valid.
        const weakCorners = cornerPoints.filter((point) =>
          point.split('|').some((v) => {
            const n = Number(v);
            return Number.isFinite(n) && Math.abs(n) < WEAK_CORNER_THRESHOLD;
          }),
        );
        const defaultedCorners = cornerPoints.filter((point) =>
          point
            .split('|')
            .every((v) => Number.isFinite(Number(v)) && Math.abs(Math.round(Number(v))) === JOY_CORNER_DEFAULT),
        );
        calSuccess = true;
        setCalStep(6, 'done');
        if (weakCorners.length || defaultedCorners.length) {
          const parts = [];
          if (weakCorners.length)
            parts.push(`${weakCorners.length} corner(s) below the minimum strength (${WEAK_CORNER_THRESHOLD})`);
          if (defaultedCorners.length)
            parts.push(
              `${defaultedCorners.length} corner(s) were replaced by defaults because the device did not register a strong enough push`,
            );
          $('calStatus').textContent =
            `Calibration finished with issues: ${parts.join('; ')}. Re-run calibration and push firmly into each corner.`;
          announceStatus('Calibration completed but one or more corners were too weak.');
          log('Calibration issue: ' + parts.join('; '), 'log-err');
        } else {
          $('calStatus').textContent = 'Calibration complete ✓ All four corners verified.';
          announceStatus('Full calibration complete and verified.');
          log('Full calibration complete and verified.', 'log-info');
        }
      } catch (e) {
        $('calStatus').textContent =
          'Calibration did not complete: ' +
          e.message +
          ' \u2014 re-center the mouthpiece, then select Start full calibration to retry.';
        throw e;
      } finally {
        setCalibrationInProgress(false);
        if (!calSuccess) {
          for (let i = 1; i <= 4; i++) {
            cornerState(i, '');
            const dot = $('dotC' + i);
            if (dot) dot.hidden = true;
          }
          showCalSteps(false);
        } else {
          // Leave the completed strip visible for a few seconds so the user sees the finish state
          stripHideTimer = setTimeout(() => {
            stripHideTimer = null;
            if (!serialSession.port) return;
            showCalSteps(false);
          }, 4000);
        }
        setCmdButtons(!!serialSession.port);
        $('btnDisconnect').disabled = !serialSession.port;
      }
    }),
  );
}
