// One canonical renderer per device endpoint. Both the initial load and any
// MANUAL/live push route through ENDPOINT_RENDERERS, so a change lands
// everywhere instead of drifting across two paths.
import { MODELS, FEEDBACK_MODES, DEBUG_MODES } from '../config/constants.js';
import { registerEndpointRenderer } from '../services/registry.js';
import { applyRestrictionValue, applyTimingWindowValue } from '../services/settings-service.js';
import { $ } from '../ui/dom.js';
import { setValue } from '../ui/values.js';
import { fmtHpa } from '../utils/format.js';
import { updateMeter, recalcGaugeRange } from '../plotting/gauge.js';
import { plotRing, plotNeutral } from '../plotting/plot.js';
import { modeState } from '../state/modes.js';
import { updateModeDisplay, updateBtName, applyModelFeatures } from '../services/mode-switch.js';
import { noteDeviceVersion } from './commands.js';

export const ENDPOINT_RENDERERS = {
  MN: (v) => {
    setValue('model', MODELS[v] ?? v);
    applyModelFeatures(v);
  },
  VN: (v) => {
    setValue('version', v);
    // The version decides the wire-protocol generation (commands.js): 4.2.0+
    // answers newline-terminated messages instantly, older firmware rejects
    // the trailing newline — so the flag flips only once VN has landed.
    noteDeviceVersion(v);
  },
  ID: (v) => {
    setValue('deviceId', v);
    updateBtName();
  },
  OM: (v) => {
    modeState.currentOpMode = v;
    updateModeDisplay();
  },
  CM: (v) => {
    modeState.currentComMode = v;
    updateModeDisplay();
  },
  SS: (v) => {
    setValue('speedVal', v);
    updateMeter('speedMeter', v);
  },
  SL: (v) => {
    setValue('scrollVal', v);
    updateMeter('scrollMeter', v);
  },
  AV: (v) => {
    setValue('accelVal', v);
    updateMeter('accelMeter', v);
  },
  ST: (v) => {
    const shown = fmtHpa(v);
    setValue('sipVal', shown);
    if (document.activeElement !== $('sipInput')) $('sipInput').value = shown;
    recalcGaugeRange();
  },
  PT: (v) => {
    const shown = fmtHpa(v);
    setValue('puffVal', shown);
    if (document.activeElement !== $('puffInput')) $('puffInput').value = shown;
    recalcGaugeRange();
  },
  IZ: (v) => {
    setValue('innerDeadzoneVal', v);
    if (document.activeElement !== $('innerDeadzone')) $('innerDeadzone').value = v;
    plotRing('ringInner', v);
  },
  OZ: (v) => {
    setValue('outerDeadzoneVal', v);
    if (document.activeElement !== $('outerDeadzone')) $('outerDeadzone').value = v;
    plotRing('ringOuter', v);
  },
  SM: (v) => {
    setValue('soundModeVal', FEEDBACK_MODES[v] ?? v);
    $('soundMode').value = v;
  },
  LM: (v) => {
    setValue('lightModeVal', FEEDBACK_MODES[v] ?? v);
    $('lightMode').value = v;
  },
  LL: (v) => {
    setValue('brightnessVal', v);
    updateMeter('brightnessMeter', v);
  },
  DM: (v) => {
    setValue('debugModeVal', DEBUG_MODES[v] ?? v);
    $('debugMode').value = v;
    $('debugMode').disabled = false; // renderer runs only on a real device answer
  },
  IN: (v) => {
    $('neutralVal').textContent = v ?? '?';
    plotNeutral(v);
  },
  // Input restrictions (roadmap item 11; firmware 4.4.0+). MANUAL pushes — a
  // Hub-menu toggle on the device — flow through here too, keeping the
  // checkboxes in sync exactly like every other setting readout.
  SD: (v) => applyRestrictionValue('SD', v),
  MA: (v) => applyRestrictionValue('MA', v),
  LK: (v) => applyRestrictionValue('LK', v),
  CF: (v) => applyRestrictionValue('CF', v),
  // Input timing windows (roadmap item 15; firmware 4.4.0+) — same MANUAL
  // sync contract.
  WS: (v) => applyTimingWindowValue('WS', v),
  WL: (v) => applyTimingWindowValue('WL', v),
  WM: (v) => applyTimingWindowValue('WM', v),
};

// Register with the shared registry so serial/device.js can dispatch without
// importing the renderer implementations (keeps the graph acyclic).
for (const [k, fn] of Object.entries(ENDPOINT_RENDERERS)) registerEndpointRenderer(k, fn);
