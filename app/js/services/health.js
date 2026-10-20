// Four-step device health diagnostic — five on firmware 4.3.0+, whose BH
// endpoint adds the I2C bus telemetry: pressure sensors, joystick response,
// neutral position, stored calibration, and bus health. Stale results are
// cleared on disconnect and at the start of each settings load.
import { $ } from '../ui/dom.js';
import { announceStatus } from '../ui/a11y.js';
import { setCmdButtons } from '../ui/connection-ui.js';
import { validFiniteList } from '../utils/format.js';
import { log } from './log.js';
import { updateReadiness } from './readiness.js';
import { recordHealthRun, renderHealthHistory } from './health-history.js';
import { sendCommand } from '../serial/commands.js';
import { serialSession } from '../serial/session.js';

// The firmware that introduced the BH bus-health endpoint. Older firmware
// answers it with FAIL, so the step is reported as unavailable instead of
// failing an otherwise-healthy device.
const BUS_HEALTH_MIN_FIRMWARE = [4, 3, 0];

const HEALTH_STEPS = [
  { id: 'hcPressure', label: 'Pressure sensors' },
  { id: 'hcJoystick', label: 'Joystick response' },
  { id: 'hcNeutral', label: 'Neutral position' },
  { id: 'hcCalibration', label: 'Stored calibration' },
  { id: 'hcBus', label: 'I2C bus' },
];

/** True when the connected firmware is at least [major, minor, rev]. @param {number[]} version */
function firmwareAtLeast(version) {
  const [major, minor, rev] = version;
  const m = (($('version')?.textContent || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/) || []).map(Number);
  if (m.length < 4) return false;
  return m[1] > major || (m[1] === major && (m[2] > minor || (m[2] === minor && m[3] >= rev)));
}
let healthStepState = {}; // id -> 'running' | 'ok' | 'warn' | 'err'

const STATE_WORDS = { ok: 'OK', warn: 'Warning', err: 'Failed', running: 'Checking' };

function setHealthStep(id, state, detail) {
  // state detail, e.g. 'ok' + detail desc optional
  healthStepState[id] = state;
  const cell = $(id);
  if (!cell) return;
  cell.setAttribute('data-state', state);
  const icon = state === 'ok' ? '✓' : state === 'warn' ? '⚠' : state === 'err' ? '✗' : state === 'running' ? '⏳' : '';
  const label = detail || HEALTH_STEPS.find((s) => s.id === id)?.label || '';
  cell.textContent = icon ? icon + ' ' + label : label;
  // The ✓/⚠/✗/⏳ glyphs read as emoji names — the label gives screen readers
  // the same state the colors carry visually.
  cell.setAttribute('aria-label', (STATE_WORDS[state] ? STATE_WORDS[state] + ': ' : '') + label);
  if (state === 'running') cell.setAttribute('aria-current', 'step');
  else cell.removeAttribute('aria-current');
}
function resetHealthSteps() {
  healthStepState = {};
  const grid = $('healthGrid');
  if (!grid) return;
  grid.hidden = false;
  for (const s of HEALTH_STEPS) setHealthStep(s.id, 'idle', s.label);
}
// The clean-pass fade (below) must never race a newer run or a disconnect.
let detailsFadeTimer = 0;
let detailsClearTimer = 0;
function cancelDetailsFade() {
  clearTimeout(detailsFadeTimer);
  detailsFadeTimer = 0;
  clearTimeout(detailsClearTimer);
  detailsClearTimer = 0;
  $('healthDetails')?.classList.remove('fade-out');
}
// On disconnect or the start of a fresh session, clear past results. Otherwise
// a stale "Passed" from a previous LipSync would still be showing while the
// user is connected to a different state (or nothing at all).
export function hideHealthHistory() {
  const el = $('healthHistory');
  if (el) el.hidden = true;
}

export function clearHealthResults() {
  cancelDetailsFade();
  const grid = $('healthGrid');
  if (grid) grid.hidden = true;
  healthStepState = {};
  // Also wipe the four cells so no stale ✓/⚠/✗ can reappear if the grid is
  // shown again before a fresh run resets them.
  for (const s of HEALTH_STEPS) {
    const cell = $(s.id);
    if (!cell) continue;
    cell.removeAttribute('data-state');
    cell.removeAttribute('aria-current');
    cell.removeAttribute('aria-label');
    cell.textContent = '';
  }
  const summary = $('healthSummary');
  const details = $('healthDetails');
  if (summary) summary.textContent = 'Not run';
  if (details) details.textContent = '';
}
export async function runDiagnostics() {
  cancelDetailsFade();
  setCmdButtons(false);
  $('btnDisconnect').disabled = true;
  $('healthSummary').textContent = 'Running…';
  $('healthDetails').textContent = 'Starting health check — reading device sensors…';
  resetHealthSteps();
  const findings = [];
  const healthEl = $('healthDetails');
  const setHealthStatus = (text) => {
    healthEl.textContent = text;
  };
  try {
    setHealthStep('hcPressure', 'running', 'Checking pressure sensors…');
    setHealthStatus('Checking pressure sensors…');
    const pressure = await sendCommand('PV,0:0');
    const pv = (pressure.value || '').split(',').map(Number);
    if (pv.length < 3 || pv.some((v) => !Number.isFinite(v)) || (pv[0] === 0 && pv[1] === 0)) {
      findings.push('Pressure sensors returned invalid or zero readings.');
      setHealthStep('hcPressure', 'err');
    } else if (pv[0] < 300 || pv[0] > 1200 || pv[1] < 300 || pv[1] > 1200) {
      findings.push('Pressure readings are outside the expected atmospheric range.');
      setHealthStep('hcPressure', 'warn');
    } else {
      setHealthStep('hcPressure', 'ok');
    }
    setHealthStep('hcJoystick', 'running', 'Testing joystick response…');
    setHealthStatus('Pressure sensors checked. Testing joystick response…');
    const joystick = await sendCommand('JV,0:0');
    if (!validFiniteList(joystick.value, 6)) {
      findings.push('Joystick returned incomplete readings.');
      setHealthStep('hcJoystick', 'err');
    } else {
      setHealthStep('hcJoystick', 'ok');
    }
    setHealthStep('hcNeutral', 'running', 'Verifying neutral position…');
    setHealthStatus('Joystick response verified. Verifying neutral position…');
    const neutral = await sendCommand('IN,0:0');
    if ((neutral.value || '').split('|').length !== 2) {
      findings.push('Neutral position data is incomplete.');
      setHealthStep('hcNeutral', 'err');
    } else {
      setHealthStep('hcNeutral', 'ok');
    }
    setHealthStep('hcCalibration', 'running', 'Validating stored calibration…');
    setHealthStatus('Neutral position verified. Validating stored calibration…');
    const calibration = await sendCommand('CA,0:0');
    if ((calibration.value || '').split(',').length !== 5) {
      findings.push('Calibration data does not contain four corners and a center.');
      setHealthStep('hcCalibration', 'err');
    } else {
      setHealthStep('hcCalibration', 'ok');
    }
    // I2C bus health (firmware 4.3.0+, roadmap item 3): the telemetry that
    // would have diagnosed the whole flaky-bus saga in minutes — recovery
    // count, per-device health gates, last-recovery age — behind one
    // read-only endpoint. Older firmware reports the step as unavailable
    // instead of failing.
    if (!firmwareAtLeast(BUS_HEALTH_MIN_FIRMWARE)) {
      setHealthStep('hcBus', 'idle', 'I2C bus (needs firmware 4.3.0+)');
    } else {
      setHealthStep('hcBus', 'running', 'Checking the I2C bus…');
      setHealthStatus('Stored calibration validated. Checking the I2C bus…');
      const bus = await sendCommand('BH,0:0');
      const bh = (bus.value || '').split(',').map(Number);
      if (!validFiniteList(bus.value, 6)) {
        findings.push('The I2C bus health reading was incomplete.');
        setHealthStep('hcBus', 'err');
      } else {
        const [recoveries, busHealthy, display, pressure, joystick, ageSec] = bh;
        const busFindings = [];
        if (recoveries > 0)
          busFindings.push(
            `the shared I2C bus wedged ${recoveries} time${recoveries === 1 ? '' : 's'} since power-on` +
              (ageSec >= 0 ? ` (last was ${ageSec}s ago)` : ''),
          );
        if (!busHealthy) busFindings.push('the bus is being held right now');
        if (display === 2) busFindings.push('the display stopped answering and is being re-probed');
        else if (!display) busFindings.push('the display was not detected');
        if (pressure === 2) busFindings.push('the pressure sensors were marked unhealthy (sip/puff paused)');
        else if (!pressure) busFindings.push('the pressure sensors were not detected');
        if (joystick === 2) busFindings.push('the joystick poll backed off because the bus is slow');
        else if (!joystick) busFindings.push('the joystick sensor was not detected');
        if (busFindings.length) {
          findings.push('I2C bus: ' + busFindings.join('; ') + '.');
          setHealthStep('hcBus', 'warn');
        } else {
          setHealthStep('hcBus', 'ok');
        }
      }
    }
    $('healthSummary').textContent = findings.length ? 'Needs attention' : 'Passed';
    recordHealthRun(findings.length ? 'attention' : 'passed', { ...healthStepState });
    updateReadiness();
    // On a clean pass, show a short confirmation and fade it out gently — the
    // header summary ("Passed") plus the ✓ cells carry the lasting state,
    // and an empty notice collapses to zero padding/border.
    const okCount = HEALTH_STEPS.filter((s) => healthStepState[s.id] === 'ok').length;
    healthEl.textContent = findings.length
      ? 'Attention needed: ' + findings.join(' ')
      : `All ${okCount} checks passed ✓`;
    if (!findings.length) {
      detailsFadeTimer = setTimeout(() => {
        detailsFadeTimer = 0;
        healthEl.classList.add('fade-out');
        detailsClearTimer = setTimeout(() => {
          detailsClearTimer = 0;
          healthEl.classList.remove('fade-out');
          healthEl.textContent = '';
        }, 450);
      }, 2500);
    }
    announceStatus(findings.length ? `Health check: ${findings.length} warning(s).` : 'Health check passed.');
    log(
      findings.length ? `Health check completed with ${findings.length} warning(s).` : 'Health check passed.',
      findings.length ? 'log-err' : 'log-info',
    );
    renderHealthHistory();
  } catch (e) {
    $('healthSummary').textContent = 'Error';
    recordHealthRun('error', { ...healthStepState });
    updateReadiness();
    healthEl.textContent = 'Diagnostics failed: ' + e.message;
    // Mark any still-running step as errored so the user sees exactly where it stopped
    for (const s of HEALTH_STEPS) {
      if (healthStepState[s.id] === 'running' || !healthStepState[s.id]) setHealthStep(s.id, 'err');
    }
    announceStatus('Health check failed: ' + e.message);
    throw e;
  } finally {
    setCmdButtons(!!serialSession.port);
    $('btnDisconnect').disabled = !serialSession.port;
  }
}
