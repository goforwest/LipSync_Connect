// One canonical renderer per device endpoint. Both the initial load and any
// MANUAL/live push route through ENDPOINT_RENDERERS, so a change lands
// everywhere instead of drifting across two paths.
import { MODELS, FEEDBACK_MODES, DEBUG_MODES, INPUT_STATE_LIGHT_MIN_FIRMWARE } from '../config/constants.js';
import { registerEndpointRenderer } from '../services/registry.js';
import {
  applyRestrictionValue,
  applyTimingWindowValue,
  applyHardActionValue,
  markAccelerationAvailable,
} from '../services/settings-service.js';
import { $ } from '../ui/dom.js';
import { setValue } from '../ui/values.js';
import { fmtHpa } from '../utils/format.js';
import { updateMeter, recalcGaugeRange } from '../plotting/gauge.js';
import { plotRing, plotNeutral } from '../plotting/plot.js';
import { modeState } from '../state/modes.js';
import { updateModeDisplay, updateBtName, applyModelFeatures } from '../services/mode-switch.js';
import { noteDeviceVersion, deviceFirmwareAtLeast } from './commands.js';

const setHomeValue = (id, value) => {
  const el = $(id);
  if (el) el.textContent = value;
};

// The LM=3 option's plain label (mirrors the markup and FEEDBACK_MODES[3]);
// the version gate appends the firmware reason when the device predates it.
const LIGHT_STATE_LABEL = 'Input state';

export const ENDPOINT_RENDERERS = {
  MN: (v) => {
    const model = MODELS[v] ?? v;
    setValue('model', model);
    setHomeValue('homeModel', model);
    applyModelFeatures(v);
  },
  VN: (v) => {
    setValue('version', v);
    setHomeValue('homeVersion', v);
    // The version decides the wire-protocol generation (commands.js): 4.2.0+
    // answers newline-terminated messages instantly, older firmware rejects
    // the trailing newline — so the flag flips only once VN has landed.
    noteDeviceVersion(v);
    // LM=3 was added with the 4.4.0 feedback tier. The bench downgrade log
    // showed the app still offering it on 4.1.0, producing a predictable
    // FAIL,3. Keep the option visible but disabled with the reason (an option
    // that silently vanishes hides a feature the next update unlocks — the
    // same honesty the version-gate notes practice); LM=0..2 stay selectable.
    const lightSelect = $('lightMode');
    const stateOption = Array.from(lightSelect?.options ?? []).find((option) => option.value === '3');
    if (stateOption) {
      const supported = deviceFirmwareAtLeast(...INPUT_STATE_LIGHT_MIN_FIRMWARE);
      stateOption.disabled = !supported;
      stateOption.textContent = supported
        ? LIGHT_STATE_LABEL
        : `${LIGHT_STATE_LABEL} (needs firmware ${INPUT_STATE_LIGHT_MIN_FIRMWARE.join('.')}+)`;
      if (!supported && lightSelect.value === '3') lightSelect.value = '2';
    }
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
    // The AV load is only scheduled on 4.3.0+ (older firmware's setter is a
    // FAIL,3 stub); restoring the hint here clears a previous session's
    // "newer firmware" explanation when the user reconnects to newer firmware.
    markAccelerationAvailable();
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
  // Hard band thresholds (firmware 4.7.0+, upstream #58): same rendering
  // contract as ST/PT, plus the gauge's hard-band markers.
  HS: (v) => {
    const shown = fmtHpa(v);
    setValue('hardSipVal', shown);
    const input = $('hardSipInput');
    if (document.activeElement !== input) input.value = shown;
    // The device answered: the exact-value field unlocks (resetHardBandUi
    // disables it at load start; only a real answer may re-enable it).
    input.disabled = false;
    recalcGaugeRange();
  },
  HP: (v) => {
    const shown = fmtHpa(v);
    setValue('hardPuffVal', shown);
    const input = $('hardPuffInput');
    if (document.activeElement !== input) input.value = shown;
    input.disabled = false; // the device answered: the exact-value field unlocks
    recalcGaugeRange();
  },
  // Hard band actions (HA = hard sip, HB = hard puff): MANUAL pushes from the
  // firmware re-sync the selects exactly like the switch-action endpoints.
  HA: (v) => applyHardActionValue('HA', v),
  HB: (v) => applyHardActionValue('HB', v),
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
    const sel = $('soundMode');
    // The select writes on change, so only a device answer may enable it —
    // and data-applied is the revert-to value when a pick is refused.
    sel.value = v;
    sel.disabled = false;
    sel.dataset.applied = String(v);
  },
  LM: (v) => {
    setValue('lightModeVal', FEEDBACK_MODES[v] ?? v);
    const sel = $('lightMode');
    sel.value = v;
    sel.disabled = false;
    sel.dataset.applied = String(v);
  },
  LL: (v) => {
    setValue('brightnessVal', v);
    updateMeter('brightnessMeter', v);
  },
  DM: (v) => {
    setValue('debugModeVal', DEBUG_MODES[v] ?? v);
    const sel = $('debugMode');
    sel.value = v;
    sel.disabled = false; // renderer runs only on a real device answer
    sel.dataset.applied = String(v); // the revert-to value for a refused pick
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
