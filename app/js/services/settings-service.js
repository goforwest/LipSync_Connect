// Settings reads: the initial per-endpoint load (with progress UI), the
// +/- steppers, deadzone writes, and calibration read-back. Everything here
// runs through the commands layer; nothing touches the wire directly.
import {
  STEP_TARGETS,
  VALUE_IDS,
  VALUE_LABELS,
  DIAG_PANELS,
  LOAD_TOTAL_TIMEOUT,
  RESTRICTION_SETTINGS,
  RESTRICTIONS_MIN_FIRMWARE,
  WINDOW_SETTINGS,
  SWITCH_SETTINGS,
  SWITCH_ACTIONS_MIN_FIRMWARE,
  SWITCH_ACTION_OPTIONS,
  SWITCH_ACTION_PACK_BASE,
} from '../config/constants.js';
import { $ } from '../ui/dom.js';
import { announceStatus } from '../ui/a11y.js';
import { setStatus } from '../ui/connection-ui.js';
import { setValue, setLoadingPlaceholders } from '../ui/values.js';
import { fmtApiFloat, fmtHpa } from '../utils/format.js';
import { updateMeter } from '../plotting/gauge.js';
import { refreshWindowLadders } from '../plotting/windows.js';
import { updateReadiness } from './readiness.js';
import { plotNeutral, plotCorner, cornerState, plotState } from '../plotting/plot.js';
import { log } from './log.js';
import { sendCommand, deviceFirmwareAtLeast } from '../serial/commands.js';
import { serialSession, pendingSteps, loadDoneTimerRef } from '../serial/session.js';
import { ENDPOINT_RENDERERS } from './registry.js';

let loadDoneTimer = null;
let loadGeneration = 0;

/** Disconnect/start-of-load hook from services/health.js — injected by main. */
let clearHealth = () => {};
export function configureSettingsListeners(svc) {
  if (svc?.clearHealth) clearHealth = svc.clearHealth;
}

/** @param {string} endpoint @returns {{endpoint: string, checkboxId: string, label: string}|null} */
function restrictionByEndpoint(endpoint) {
  return RESTRICTION_SETTINGS.find((r) => r.endpoint === endpoint) ?? null;
}

/**
 * A restriction value landed (initial load, or a MANUAL push after the Hub
 * menu changed it): reflect it in the checkbox and enable the control.
 * @param {string} endpoint SD / MA / LK / CF
 * @param {string|number} value '0' | '1'
 */
export function applyRestrictionValue(endpoint, value) {
  const r = restrictionByEndpoint(endpoint);
  if (!r) return;
  const el = $(r.checkboxId);
  if (!el) return;
  el.checked = String(value) === '1';
  el.disabled = false;
  const note = $('restrictionsNote');
  if (note && !note.textContent.includes('firmware')) note.textContent = '';
}

/**
 * Firmware too old for the restriction settings (pre-4.4.0): keep the card
 * honest instead of failing four loads on every connect — the controls stay
 * off and the note says why, the same contract the BH health step uses.
 */
export function markRestrictionsUnavailable() {
  for (const r of RESTRICTION_SETTINGS) {
    const el = $(r.checkboxId);
    if (el) el.disabled = true;
  }
  const note = $('restrictionsNote');
  if (note)
    note.textContent = `Input restrictions need firmware ${RESTRICTIONS_MIN_FIRMWARE.join('.')}+ — update the firmware to use them.`;
}

/**
 * Firmware too old for the timing windows (pre-4.4.0): the readouts show the
 * not-applicable placeholder (never ERR — nothing failed), and the inputs
 * and Set buttons lock until a firmware that has the endpoints loads.
 */
export function markWindowsUnavailable() {
  for (const w of WINDOW_SETTINGS) {
    const el = $(w.valueId);
    if (el) {
      el.textContent = '—';
      el.classList.remove('loading', 'err');
      el.removeAttribute('aria-label');
    }
    const input = $(w.inputId);
    if (input) input.disabled = true;
    const btn = $('btnSet' + w.endpoint);
    if (btn) btn.disabled = true;
  }
}

/** Disconnect/start-of-load reset: no stale checkbox may survive into a new session. */
export function resetRestrictionsUi() {
  for (const r of RESTRICTION_SETTINGS) {
    const el = $(r.checkboxId);
    if (el) {
      el.checked = false;
      el.disabled = true;
    }
  }
  const note = $('restrictionsNote');
  if (note) note.textContent = '';
}

/**
 * Checkbox handler: write the restriction and re-sync from the device's
 * answer. A rejected write reverts the checkbox (the device is the truth).
 * @param {string} endpoint
 * @param {boolean} checked
 */
export async function setRestriction(endpoint, checked) {
  const r = restrictionByEndpoint(endpoint);
  const el = r ? $(r.checkboxId) : null;
  try {
    const resp = await sendCommand(`${endpoint},1:${checked ? 1 : 0}`);
    if (el) el.checked = String(resp.value ?? (checked ? 1 : 0)) === '1';
    log(`${r?.label ?? endpoint} ${checked ? 'applied' : 'removed'}.`, 'log-info');
  } catch (e) {
    if (el) el.checked = !checked; // revert — the device did not take it
    throw e;
  }
}

/** @param {string} endpoint @returns {{endpoint: string, valueId: string, inputId: string, label: string, unit: string, min: number, max: number}|null} */
function windowByEndpoint(endpoint) {
  return WINDOW_SETTINGS.find((w) => w.endpoint === endpoint) ?? null;
}

/**
 * A timing-window value landed (initial load, or a MANUAL push after the
 * Hub menu changed it): reflect it in the readout and the input field.
 * @param {string} endpoint W1 / W2 / W3
 * @param {string|number} value window boundary in ms
 */
export function applyTimingWindowValue(endpoint, value) {
  const w = windowByEndpoint(endpoint);
  if (!w) return;
  setValue(w.valueId, value);
  const input = $(w.inputId);
  if (input) {
    if (document.activeElement !== input) input.value = value;
    input.disabled = false;
  }
  const btn = $('btnSet' + w.endpoint);
  if (btn) btn.disabled = false;
  refreshWindowLadders();
}

/**
 * Timing-window write (roadmap item 15, upstream #62): validates the value
 * against the firmware's ranges AND the short < long < max ordering against
 * the other two windows currently in force, then writes and re-syncs from
 * the device's answer — the firmware validates too (defense in depth), and
 * a rejected write throws with the device's truth left on screen.
 * @param {string} endpoint W1 / W2 / W3
 * @param {number} valueMs window boundary in ms
 */
export async function setTimingWindow(endpoint, valueMs) {
  const w = windowByEndpoint(endpoint);
  if (!w) throw new Error('Unknown timing window.');
  if (!Number.isFinite(valueMs) || valueMs < w.min || valueMs > w.max)
    throw new Error(`${w.label} must be between ${w.min} and ${w.max} ms.`);
  // The full triple with the new value in place; ordering is only checked
  // when both siblings have loaded (the firmware still guards it either way).
  // > 0, not just finite: an unloaded readout parses empty as 0, which would
  // false-refuse a step before its siblings arrive.
  const triple = WINDOW_SETTINGS.map((x) =>
    x.endpoint === endpoint ? valueMs : Number(($(x.valueId)?.textContent || '').trim()),
  );
  if (triple.every((v) => Number.isFinite(v) && v > 0) && !(triple[0] < triple[1] && triple[1] < triple[2]))
    throw new Error('Timing windows must stay ordered: short < long < max.');
  const resp = await sendCommand(`${endpoint},1:${valueMs}`);
  applyTimingWindowValue(endpoint, resp.value ?? valueMs);
  log(`${w.label} set to ${resp.value ?? valueMs} ms.`, 'log-info');
}

// ---- External switch actions (firmware 4.5.0+; upstream #20) ----
// The three assistive-switch jacks' mouse- and gamepad-mode actions are
// settings: one endpoint per (jack, mode), covering that jack's three hold
// windows. The last device-confirmed triple per endpoint, for write reverts.
/** @type {Record<string, number[]>} */
const appliedSwitchActions = {};

/** @param {string} endpoint @returns {{endpoint: string, jack: string, mode: string, selectPrefix: string, jsonKey: string, windowLabels: string[]}|null} */
function switchSettingByEndpoint(endpoint) {
  return SWITCH_SETTINGS.find((s) => s.endpoint === endpoint) ?? null;
}

/** Fills one window select's options from the shared action palette. */
function populateSwitchSelect(sel) {
  if (!sel || sel.options?.length) return;
  for (const [value, label] of Object.entries(SWITCH_ACTION_OPTIONS)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    sel.appendChild(opt);
  }
}

/** Populates every switch-action select (called once at startup wiring). */
export function populateSwitchActionSelects() {
  for (const s of SWITCH_SETTINGS) {
    for (let i = 0; i < s.windowLabels.length; i++) populateSwitchSelect($(s.selectPrefix + i));
  }
}

/**
 * A switch-action value landed (initial load, or a write ack over the wire):
 * reflect it in the three selects. Accepts both wire shapes — the GET's
 * "short,long,max" triple and the SET's packed BASE+short*10000+long*100+max
 * echo — so a change always re-syncs from device truth.
 * @param {string} endpoint SA / SB / SC / GA / GB / GC
 * @param {string|number} value
 */
export function applySwitchActionValue(endpoint, value) {
  const s = switchSettingByEndpoint(endpoint);
  if (!s) return;
  const raw = String(value ?? '');
  let cells = null;
  if (raw.includes(',')) {
    cells = raw.split(',').map((c) => parseInt(c, 10));
  } else {
    const packed = Number(raw) - SWITCH_ACTION_PACK_BASE;
    if (Number.isFinite(packed) && packed >= 0)
      cells = [Math.floor(packed / 10000), Math.floor(packed / 100) % 100, packed % 100];
  }
  if (!cells || cells.length !== 3 || cells.some((c) => !Number.isFinite(c))) return;
  cells.forEach((c, i) => {
    const sel = $(s.selectPrefix + i);
    if (!sel) return;
    populateSwitchSelect(sel);
    if (!(String(c) in SWITCH_ACTION_OPTIONS)) {
      // A future firmware action the palette doesn't know: show it honestly
      // rather than silently blanking the mapping.
      const opt = document.createElement('option');
      opt.value = String(c);
      opt.textContent = `Action #${c}`;
      sel.appendChild(opt);
    }
    sel.value = String(c);
    sel.disabled = false;
  });
  appliedSwitchActions[endpoint] = cells;
  const btn = $('btnResetSwitchActions');
  if (btn) btn.disabled = false;
  const note = $('switchActionsNote');
  if (note && !note.textContent.includes('firmware')) note.textContent = '';
}

/**
 * Firmware too old for the switch-action endpoints (pre-4.5.0): keep the
 * card honest instead of failing six loads on every connect — the selects
 * stay off and the note says why.
 */
export function markSwitchActionsUnavailable() {
  for (const s of SWITCH_SETTINGS) {
    for (let i = 0; i < s.windowLabels.length; i++) {
      const sel = $(s.selectPrefix + i);
      if (sel) sel.disabled = true;
    }
  }
  const btn = $('btnResetSwitchActions');
  if (btn) btn.disabled = true;
  const note = $('switchActionsNote');
  if (note)
    note.textContent = `External switch actions need firmware ${SWITCH_ACTIONS_MIN_FIRMWARE.join('.')}+ — update the firmware to remap the switch jacks.`;
}

/** Disconnect/start-of-load reset: no stale mapping may survive into a new session. */
export function resetSwitchActionsUi() {
  for (const s of SWITCH_SETTINGS) {
    for (let i = 0; i < s.windowLabels.length; i++) {
      const sel = $(s.selectPrefix + i);
      if (sel) {
        sel.value = '';
        sel.disabled = true;
      }
    }
    delete appliedSwitchActions[s.endpoint];
  }
  const btn = $('btnResetSwitchActions');
  if (btn) btn.disabled = true;
  const note = $('switchActionsNote');
  if (note) note.textContent = '';
}

/**
 * Writes one jack/mode's triple from its three selects. The wire value is
 * PACK_BASE + short*10000 + long*100 + max (the base keeps it a 6-digit
 * number — the only magnitude the firmware's serial format validator
 * accepts); a rejected write reverts the picks to the last device-confirmed
 * triple (the device is the truth).
 * @param {string} endpoint
 */
export async function setSwitchAction(endpoint) {
  const s = switchSettingByEndpoint(endpoint);
  if (!s) throw new Error('Unknown switch endpoint.');
  const cells = s.windowLabels.map((_, i) => parseInt($(s.selectPrefix + i)?.value, 10));
  if (cells.some((c) => !Number.isFinite(c) || !(String(c) in SWITCH_ACTION_OPTIONS)))
    throw new Error('Pick an action for each hold window first (load the device settings).');
  const packed = cells[0] * 10000 + cells[1] * 100 + cells[2];
  try {
    const resp = await sendCommand(`${endpoint},1:${SWITCH_ACTION_PACK_BASE + packed}`);
    // The SET ack echoes the packed value; the response dispatch has already
    // re-applied it to the selects (device truth), so only a divergent echo
    // needs the explicit apply here.
    const echoed = Number(resp.value);
    if (Number.isFinite(echoed) && echoed !== SWITCH_ACTION_PACK_BASE + packed)
      applySwitchActionValue(endpoint, echoed);
    log(`${s.jack} ${s.mode === 'mouse' ? 'mouse' : 'gamepad'} mapping applied.`, 'log-info');
  } catch (e) {
    const prev = appliedSwitchActions[endpoint];
    if (prev)
      prev.forEach((c, i) => {
        const sel = $(s.selectPrefix + i);
        if (sel) sel.value = String(c);
      });
    throw e;
  }
}

/**
 * Restores the compiled factory mapping on all six jack/modes: write 0 to
 * each endpoint, then re-read them — the reset ack carries no triple, so the
 * device's answer is the only truth worth displaying.
 */
export async function resetSwitchActions() {
  for (const s of SWITCH_SETTINGS) {
    await sendCommand(`${s.endpoint},1:0`);
    await sendCommand(`${s.endpoint},0:0`); // its ack re-syncs the selects
  }
  log('External switch mappings restored to the factory defaults.', 'log-info');
}

/** The per-endpoint load plan: wire command + its render function (+ optional minimum firmware). @returns {[string, (r: any) => void, (number[] | undefined)?][]} */
export function getDeviceLoadTasks() {
  return [
    ['MN,0:0', (r) => ENDPOINT_RENDERERS.MN(r.value)],
    ['VN,0:0', (r) => ENDPOINT_RENDERERS.VN(r.value)],
    ['ID,0:0', (r) => ENDPOINT_RENDERERS.ID(r.value)],
    ['OM,0:0', (r) => ENDPOINT_RENDERERS.OM(r.value)],
    ['CM,0:0', (r) => ENDPOINT_RENDERERS.CM(r.value)],
    ['SS,0:0', (r) => ENDPOINT_RENDERERS.SS(r.value)],
    ['SL,0:0', (r) => ENDPOINT_RENDERERS.SL(r.value)],
    ['AV,0:0', (r) => ENDPOINT_RENDERERS.AV(r.value)],
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
    // Input restrictions (4.4.0+): the third element is the minimum firmware
    // the endpoints exist on — the load loop skips (and marks unavailable)
    // instead of sending them to older firmware, which would only FAIL.
    ['SD,0:0', (r) => ENDPOINT_RENDERERS.SD(r.value), RESTRICTIONS_MIN_FIRMWARE],
    ['MA,0:0', (r) => ENDPOINT_RENDERERS.MA(r.value), RESTRICTIONS_MIN_FIRMWARE],
    ['LK,0:0', (r) => ENDPOINT_RENDERERS.LK(r.value), RESTRICTIONS_MIN_FIRMWARE],
    ['CF,0:0', (r) => ENDPOINT_RENDERERS.CF(r.value), RESTRICTIONS_MIN_FIRMWARE],
    // Input timing windows (4.4.0+, roadmap item 15): same version gate —
    // the readouts stay at their loading placeholders on older firmware.
    ['WS,0:0', (r) => ENDPOINT_RENDERERS.WS(r.value), RESTRICTIONS_MIN_FIRMWARE],
    ['WL,0:0', (r) => ENDPOINT_RENDERERS.WL(r.value), RESTRICTIONS_MIN_FIRMWARE],
    ['WM,0:0', (r) => ENDPOINT_RENDERERS.WM(r.value), RESTRICTIONS_MIN_FIRMWARE],
    // External switch actions (4.5.0+, upstream #20): same version gate —
    // the selects stay disabled on older firmware.
    ...SWITCH_SETTINGS.map(
      (s) =>
        /** @type {[string, (r: any) => void, number[]]} */ ([
          `${s.endpoint},0:0`,
          (r) => applySwitchActionValue(s.endpoint, r.value),
          SWITCH_ACTIONS_MIN_FIRMWARE,
        ]),
    ),
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
    attempted = 0,
    loadAborted = false,
    deadLink = false;
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
    // Version-gated task (e.g. the 4.4.0+ restriction and timing endpoints):
    // never send it to firmware that doesn't have it — mark the surface
    // unavailable and move on, the same honesty the BH health step practices.
    const minFw = /** @type {number[]|undefined} */ (/** @type {any} */ (tasks[i])[2]);
    if (minFw && !deviceFirmwareAtLeast(minFw[0], minFw[1], minFw[2] ?? 0)) {
      if (WINDOW_SETTINGS.some((w) => w.endpoint === tasks[i][0].slice(0, 2))) markWindowsUnavailable();
      else if (SWITCH_SETTINGS.some((s) => s.endpoint === tasks[i][0].slice(0, 2))) markSwitchActionsUnavailable();
      else markRestrictionsUnavailable();
      continue;
    }
    setStatus(`Connected — loading ${i + 1}/${tasks.length}…`, true);
    if (progBar) progBar.value = i + 1;
    attempted++;
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
      // Two consecutive handshake timeouts from the very start of a fresh
      // session mean the port is open but nothing is answering — a wedged
      // OS port or a frozen device (a healthy device's known hiccup is a
      // single rejected handshake, which sendCommand already retries).
      // Diagnose the dead link instead of grinding all seventeen tasks.
      if (failed >= 2 && failed === i + 1) {
        deadLink = true;
        break;
      }
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
      // aria-label carries the news for screen readers; the title mirrors it
      // as a hover tooltip so sighted users also learn why a value reads ERR.
      const label = `${VALUE_LABELS[id] ?? id} failed to load`;
      el.setAttribute('aria-label', label);
      el.setAttribute('title', label);
    }
  });
  if (progBar) progBar.value = progBar.max;
  if (progLabel) progLabel.textContent = 'Done';
  if (gen === loadGeneration && serialSession.port) {
    setStatus('Connected', true);
    updateReadiness(); // the strip derives from state that just landed
  }
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
  if (deadLink) {
    const message =
      'The port opened but the LipSync is not responding. Unplug it, plug it back in, wait a few seconds, then click Connect again.';
    $('modeGuardHint').textContent = message;
    announceStatus(message);
    log(message, 'log-err');
  } else if (loadAborted) {
    const message = 'Settings partially loaded: overall timeout reached. Values shown as ERR did not load.';
    $('modeGuardHint').textContent = message;
    announceStatus(message);
    log('Settings partially loaded (overall timeout reached).', 'log-err');
  } else {
    const message = failed
      ? `${failed} of ${attempted} settings failed to load; failed values are shown as ERR. Click Refresh all settings to retry.`
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
    const cur = parseFloat(String($(cfg.valueId)?.textContent ?? '').trim());
    if (!Number.isFinite(cur)) return;
    // Float steps accumulate binary drift (0.01 is not representable); snap
    // to the step's own grid so 0.07 + 0.01 is exactly 0.08, never 0.08000…1.
    const stepSize = cfg.step ?? 1;
    let next = Math.round((cur + delta * stepSize) / stepSize) * stepSize;
    next = Number(next.toFixed(4));
    if (next < cfg.min || next > cfg.max) return;
    if (cfg.endpoint === 'WS' || cfg.endpoint === 'WL' || cfg.endpoint === 'WM') {
      // The window steppers delegate to the validated write: setTimingWindow
      // owns the short < long < max ordering contract, and its refusal
      // message is the honest answer to a step that cannot land.
      try {
        await setTimingWindow(cfg.endpoint, next);
      } catch (e) {
        const err = $('sapError');
        if (err) err.textContent = e.message;
      }
      return;
    }
    // Floats ride the wire as fmtApiFloat (the exact same format the
    // typed-value Set buttons send); ints go as plain decimals.
    const wire = stepSize < 1 ? fmtApiFloat(next) : String(next);
    const r = await sendCommand(cfg.endpoint + ',1:' + wire);
    const result = Number(r.value ?? next);
    setValue(cfg.valueId, cfg.hpa ? fmtHpa(result) : result);
    if (cfg.meter) updateMeter(cfg.meter, result);
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
    const val = parseFloat(String($(cfg.valueId)?.textContent ?? '').trim());
    if (!Number.isFinite(val)) {
      b.disabled = true;
      return;
    }
    const delta = parseFloat(b.dataset.step) * (cfg.step ?? 1);
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
