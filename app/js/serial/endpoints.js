// One canonical renderer per device endpoint. Both the initial load and any
// MANUAL/live push route through ENDPOINT_RENDERERS, so a change lands
// everywhere instead of drifting across two paths.
import { MODELS, FEEDBACK_MODES, DEBUG_MODES } from '../config/constants.js';
import { registerEndpointRenderer } from '../services/registry.js';
import { $ } from '../ui/dom.js';
import { setValue } from '../ui/values.js';
import { updateMeter, recalcGaugeRange } from '../plotting/gauge.js';
import { plotRing, plotNeutral } from '../plotting/plot.js';
import { modeState } from '../state/modes.js';
import { updateModeDisplay, updateBtName, applyModelFeatures } from '../services/mode-switch.js';

export const ENDPOINT_RENDERERS = {
  MN: (v) => {
    setValue('model', MODELS[v] ? MODELS[v] + ' (' + v + ')' : v);
    applyModelFeatures(v);
  },
  VN: (v) => setValue('version', v),
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
  ST: (v) => {
    setValue('sipVal', v);
    if (document.activeElement !== $('sipInput')) $('sipInput').value = v;
    recalcGaugeRange();
  },
  PT: (v) => {
    setValue('puffVal', v);
    if (document.activeElement !== $('puffInput')) $('puffInput').value = v;
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
  },
  IN: (v) => {
    $('neutralVal').textContent = v ?? '?';
    plotNeutral(v);
  },
};

// Register with the shared registry so serial/device.js can dispatch without
// importing the renderer implementations (keeps the graph acyclic).
for (const [k, fn] of Object.entries(ENDPOINT_RENDERERS)) registerEndpointRenderer(k, fn);
