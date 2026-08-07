// Settings reads: the initial per-endpoint load (with progress UI), the
// +/- steppers, deadzone writes, and calibration read-back. Everything here
// runs through the commands layer; nothing touches the wire directly.
import { STEP_TARGETS, VALUE_IDS, VALUE_LABELS, DIAG_PANELS, LOAD_TOTAL_TIMEOUT } from '../config/constants.js';
import { $ } from '../ui/dom.js';
import { announceStatus } from '../ui/a11y.js';
import { setStatus } from '../ui/connection-ui.js';
import { setValue, setLoadingPlaceholders } from '../ui/values.js';
import { updateMeter } from '../plotting/gauge.js';
import { plotNeutral, plotCorner, cornerState, plotState } from '../plotting/plot.js';
import { log } from './log.js';
import { sendCommand } from '../serial/commands.js';
import { serialSession, pendingSteps, loadDoneTimerRef } from '../serial/session.js';
import { ENDPOINT_RENDERERS } from './registry.js';

let loadDoneTimer = null;
let loadGeneration = 0;

/** Disconnect/start-of-load hook from services/health.js — injected by main. */
let clearHealth = () => {};
export function configureSettingsListeners(svc) {
  if (svc?.clearHealth) clearHealth = svc.clearHealth;
}

export function getDeviceLoadTasks() {
  return [
    ['MN,0:0', (r) => ENDPOINT_RENDERERS.MN(r.value)],
    ['VN,0:0', (r) => ENDPOINT_RENDERERS.VN(r.value)],
    ['ID,0:0', (r) => ENDPOINT_RENDERERS.ID(r.value)],
    ['OM,0:0', (r) => ENDPOINT_RENDERERS.OM(r.value)],
    ['CM,0:0', (r) => ENDPOINT_RENDERERS.CM(r.value)],
    ['SS,0:0', (r) => ENDPOINT_RENDERERS.SS(r.value)],
    ['SL,0:0', (r) => ENDPOINT_RENDERERS.SL(r.value)],
    ['ST,0:0', (r) => ENDPOINT_RENDERERS.ST(r.value)],
    ['PT,0:0', (r) => ENDPOINT_RENDERERS.PT(r.value)],
    ['IZ,0:0', (r) => ENDPOINT_RENDERERS.IZ(r.value)],
    ['OZ,0:0', (r) => ENDPOINT_RENDERERS.OZ(r.value)],
    ['IN,0:0', (r) => ENDPOINT_RENDERERS.IN(r.value)],
    ['CA,0:0', (r) => displayCalibration(r)],
    ['SM,0:0', (r) => ENDPOINT_RENDERERS.SM(r.value)],
    ['LM,0:0', (r) => ENDPOINT_RENDERERS.LM(r.value)],
    ['LL,0:0', (r) => ENDPOINT_RENDERERS.LL(r.value)],
    ['DM,0:0', (r) => ENDPOINT_RENDERERS.DM(r.value)],
  ];
}

export async function loadDeviceInfo() {
  const gen = ++loadGeneration;
  setLoadingPlaceholders();
  clearHealth(); // stale diagnostics from a previous session would mislead
  Object.values(DIAG_PANELS).forEach((id) => {
    const el = $(id);
    if (el) el.hidden = true;
  });
  const tasks = getDeviceLoadTasks();
  let failed = 0,
    loadAborted = false;
  const progBar = $('loadProgress'),
    progRow = $('loadProgressRow'),
    progLabel = $('loadProgressLabel');
  if (progBar) progBar.max = tasks.length;
  if (progRow) {
    progRow.hidden = false;
    progRow.style.display = '';
    progRow.classList.remove('fade-out');
  }
  const loadTimer = setTimeout(() => {
    loadAborted = true;
    announceStatus('Loading timed out overall; some values may be missing.');
    log('Loading timed out overall; some values may be missing.', 'log-err');
  }, LOAD_TOTAL_TIMEOUT);
  const timingSamples = [];
  for (let i = 0; i < tasks.length; i++) {
    if (!serialSession.port || loadAborted) break;
    setStatus(`Connected — loading ${i + 1}/${tasks.length}…`, true);
    if (progBar) progBar.value = i + 1;
    const remaining =
      timingSamples.length >= 3
        ? Math.round(((tasks.length - i) * timingSamples.reduce((a, b) => a + b, 0)) / timingSamples.length)
        : null;
    if (progLabel)
      progLabel.textContent = `Loading ${i + 1} of ${tasks.length}…` + (remaining ? ` (~${remaining}s)` : '');
    try {
      const t0 = performance.now();
      const r = await sendCommand(tasks[i][0]);
      timingSamples.push((performance.now() - t0) / 1000);
      if (timingSamples.length > 10) timingSamples.shift();
      if (gen !== loadGeneration) break;
      /** @type {any} */ (tasks[i][1])(r);
    } catch (e) {
      if (!serialSession.port || e.message === 'Disconnected' || e.message === 'Not connected') break;
      failed++;
      log('Failed to load ' + tasks[i][0] + ': ' + e.message, 'log-err');
    }
  }
  if (gen !== loadGeneration) {
    // A newer load superseded this one — the overall-timeout timer for this
    // stale generation must die too, or it fires later and logs a misleading
    // "timed out" message against the live session.
    clearTimeout(loadTimer);
    return;
  }
  VALUE_IDS.forEach((id) => {
    const el = $(id);
    el.classList.remove('loading');
    if (el.textContent === '…') {
      el.textContent = 'ERR';
      el.classList.add('err');
      el.setAttribute('aria-label', `${VALUE_LABELS[id] ?? id} failed to load`);
    }
  });
  if (progBar) progBar.value = progBar.max;
  if (progLabel) progLabel.textContent = 'Done';
  if (gen === loadGeneration && serialSession.port) setStatus('Connected', true);
  if (progRow) {
    clearTimeout(loadDoneTimer);
    loadDoneTimerRef.current = null;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
    if (reduceMotion) {
      if (gen === loadGeneration) {
        progRow.hidden = true;
        progRow.style.display = 'none';
      }
    } else {
      loadDoneTimer = setTimeout(() => {
        if (gen !== loadGeneration) return;
        progRow.classList.add('fade-out');
        setTimeout(() => {
          if (gen !== loadGeneration) return;
          progRow.hidden = true;
          progRow.style.display = 'none';
          loadDoneTimerRef.current = null;
        }, 500);
      }, 1000);
      loadDoneTimerRef.current = loadDoneTimer;
    }
  }
  clearTimeout(loadTimer);
  if (!serialSession.port) return;
  updateStepButtons();
  if (loadAborted) {
    const message = 'Settings partially loaded: overall timeout reached. Values shown as ERR did not load.';
    $('modeGuardHint').textContent = message;
    announceStatus(message);
    log('Settings partially loaded (overall timeout reached).', 'log-err');
  } else {
    const message = failed
      ? `${failed} of ${tasks.length} settings failed to load; failed values are shown as ERR. Click Refresh all settings to retry.`
      : '';
    $('modeGuardHint').textContent = message;
    if (message) announceStatus(message);
    log(
      failed ? `Settings loaded with ${failed} error(s).` : 'Device settings loaded.',
      failed ? 'log-err' : 'log-info',
    );
  }
}

export async function step(target, delta) {
  const cfg = STEP_TARGETS[target];
  if (!cfg || pendingSteps.has(target)) return;
  pendingSteps.add(target);
  updateStepButtons();
  try {
    const cur = parseInt($(cfg.valueId).textContent, 10);
    if (isNaN(cur)) return;
    const next = cur + delta;
    if (next < cfg.min || next > cfg.max) return;
    const r = await sendCommand(cfg.endpoint + ',1:' + next);
    const result = Number(r.value ?? next);
    setValue(cfg.valueId, result);
    updateMeter(cfg.meter, result);
  } catch (e) {
    log(e.message, 'log-err');
  } finally {
    pendingSteps.delete(target);
    updateStepButtons();
  }
}

export function updateStepButtons() {
  document.querySelectorAll('button[data-step]').forEach((/** @type {any} */ b) => {
    const cfg = STEP_TARGETS[b.dataset.target];
    if (!cfg) return;
    if (pendingSteps.has(b.dataset.target)) {
      b.disabled = true;
      return;
    }
    const val = parseInt($(cfg.valueId).textContent, 10);
    if (isNaN(val)) {
      b.disabled = true;
      return;
    }
    const delta = parseInt(b.dataset.step, 10);
    b.disabled = val + delta < cfg.min || val + delta > cfg.max;
  });
}

export function displayCalibration(resp) {
  const points = (resp.value || '').split(',');
  if (points.length < 5) throw new Error('Device returned incomplete calibration values.');
  $('neutralVal').textContent = points[0];
  plotNeutral(points[0]);
  for (let i = 1; i <= 4; i++) {
    $('corner' + i).textContent = points[i];
    plotCorner(i, points[i]);
    cornerState(i, 'captured');
  }
}
export async function readCalibration() {
  $('calStatus').textContent = 'Reading calibration values…';
  // Reset orientation to identity so a previous live-debug-derived flip doesn't
  // leak into the read-back display.
  plotState.orient = { x: 1, y: 1 };
  plotState.orientLive = { x: false, y: false };
  const neutral = await sendCommand('IN,0:0');
  $('neutralVal').textContent = neutral.value ?? '?';
  displayCalibration(await sendCommand('CA,0:0'));
  $('calStatus').textContent = 'Calibration values refreshed.';
}

// Input coercion/validation for numeric fields. protocol's fmtApiFloat pads
// values to the wire length the firmware validator accepts.
export function requireNumber(id, min, max, label) {
  const value = Number($(id).value);
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(`${label} must be between ${min} and ${max}.`);
  return value;
}
export function clampInput(id, min, max, fallbackId) {
  const el = $(id);
  const value = Number(el.value);
  if (!Number.isFinite(value)) {
    const fallback = Number($(fallbackId).textContent);
    el.value = Number.isFinite(fallback) ? fallback : min;
    el.reportValidity();
    return;
  }
  const clamped = Math.max(min, Math.min(max, value));
  if (clamped !== value) {
    el.value = clamped;
    el.reportValidity();
  }
}

export async function setDeadzone(kind) {
  $('formError').textContent = '';
  const isInner = kind === 'inner';
  const inputEl = $(isInner ? 'innerDeadzone' : 'outerDeadzone');
  const fallbackId = isInner ? 'innerDeadzoneVal' : 'outerDeadzoneVal';
  const otherValId = isInner ? 'outerDeadzoneVal' : 'innerDeadzoneVal';
  clampInput(inputEl.id, 0.01, 1, fallbackId);
  const value = requireNumber(inputEl.id, 0.01, 1, isInner ? 'Inner deadzone' : 'Outer deadzone');
  const otherText = $(otherValId).textContent;
  const otherVal = Number(otherText);
  if (!Number.isFinite(otherVal))
    throw new Error(
      'Cannot validate deadzone: the other deadzone value is not loaded yet. Click Refresh all settings first.',
    );
  if ((isInner && value >= otherVal) || (!isInner && otherVal >= value))
    throw new Error('Inner deadzone must be lower than outer deadzone.');
  const r = await sendCommand((isInner ? 'IZ' : 'OZ') + ',1:' + value);
  setValue(fallbackId, r.value ?? value);
}
export async function setSimpleSetting(endpoint, value, valueId, labels, meterId) {
  const prev = $(valueId).textContent;
  try {
    const r = await sendCommand(`${endpoint},1:${value}`);
    const result = r.value ?? value;
    setValue(valueId, labels ? (labels[result] ?? result) : result);
    if (meterId) updateMeter(meterId, result);
    return result;
  } catch (e) {
    setValue(valueId, prev);
    throw e;
  }
}

// ---- Calibration step indicator ----
export function setCalStep(n, state) {
  // n: 1..6, state: 'active' | 'done' | 'pending'
  // The Hub owns the prompt sequence; the app follows. The strip's six steps
  // mirror the firmware's actual prompt order (corners 1-4, re-center,
  // verify): step N becomes active when the firmware starts prompting N,
  // signalled by the previous step's async ack line arriving.
  const steps = $('calSteps');
  if (!steps) return;
  const items = steps.querySelectorAll('li');
  items.forEach((li) => {
    const step = parseInt(li.dataset.step, 10);
    li.classList.remove('active', 'done', 'pending');
    if (step < n) li.classList.add('done');
    // 'done' must render as done — the old 'active' fallback left the final
    // verify pill highlighted (red) forever instead of turning green.
    else if (step === n) li.classList.add(state === 'done' ? 'done' : state === 'pending' ? 'pending' : 'active');
    else li.classList.add('pending');
  });
  // Completing a mid-sequence step advances the highlight to the next one.
  if (state === 'done' && n < 6) items[n].classList.add('active');
}
export function showCalSteps(show) {
  const steps = $('calSteps');
  if (steps) steps.hidden = !show;
}
export function resetCalSteps() {
  const steps = $('calSteps');
  if (!steps) return;
  steps.querySelectorAll('li').forEach((li) => {
    li.classList.remove('active', 'done');
    li.classList.add('pending');
  });
}

// Shared flag so device.js's IN,1 handler knows when to defer to the
// calibration flow's own status (see services/calibration.js).
let calibrationInProgress = false;
export function calibrationIsRunning() {
  return calibrationInProgress;
}
export function setCalibrationInProgress(running) {
  calibrationInProgress = running;
}
