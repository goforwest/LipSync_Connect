// Pressure DISPLAY units (the clinician-facing cmH2O option). The device's
// wire format, its stored thresholds, and its hard-band margin rule are all
// hPa-native — so everything EDITABLE (steppers, exact-value inputs) stays
// in hPa with hPa labels, and this preference converts what the user READS:
// the gauge (scale, mark titles, current delta), the practice guide line,
// the suggestion copy, and a ≈-annotation beside each hPa readout. Editing
// granularity never changes, so no value can drift between display and wire.
// 1 cmH2O = 0.980665 hPa (the conventional definition).
import { $ } from '../ui/dom.js';

export const PRESSURE_UNIT_STORAGE_KEY = 'lipsync-pressure-unit';
export const HPA_PER_CMH2O = 0.980665;

const UNITS = { hpa: 'hPa', cmh2o: 'cmH2O' };
let unit = 'hpa';
const subscribers = new Set();

export function getPressureUnit() {
  return unit;
}

/** Persists the preference and re-renders every subscriber (the gauge owns
 *  its own surfaces; the readout ≈-annotations ride gaugeMarks). */
export function setPressureUnit(next) {
  if (!(next in UNITS) || next === unit) return;
  unit = next;
  try {
    localStorage.setItem(PRESSURE_UNIT_STORAGE_KEY, unit);
  } catch {}
  for (const fn of subscribers) fn(unit);
}

export function onPressureUnitChange(fn) {
  subscribers.add(fn);
}

/** Loads the persisted preference; call once before the first render. */
export function initPressureUnits() {
  let saved = null;
  try {
    saved = localStorage.getItem(PRESSURE_UNIT_STORAGE_KEY);
  } catch {}
  if (saved === 'cmh2o' || saved === 'hpa') unit = saved;
}

export function unitLabel() {
  return UNITS[unit];
}

/** hPa → display-unit number. */
export function toDisplayPressure(hpa) {
  return unit === 'cmh2o' ? Number(hpa) * HPA_PER_CMH2O : Number(hpa);
}

/**
 * Formats a wire hPa value for display. `decimals` is explicit per surface
 * so the hPa default stays byte-identical to the pre-preference strings:
 * mark titles used the bare number ("12.5"), the gauge scale one decimal
 * ("15.0"), readouts and the practice line two ("4.50"). In cmH2O mode a
 * bare request means two decimals (the unit's useful precision).
 * @param {number} hpa
 * @param {{ decimals?: number, withUnit?: boolean }} [options]
 */
export function fmtPressure(hpa, options = {}) {
  const value = toDisplayPressure(hpa);
  const decimals = options.decimals ?? (unit === 'cmh2o' ? 2 : null);
  const text = decimals != null ? value.toFixed(decimals) : String(value);
  return options.withUnit ? `${text} ${UNITS[unit]}` : text;
}

/** The ≈-annotation beside an hPa readout: wire unit first (it is the value
 *  the steppers and inputs act on), the display conversion second. */
export function pressureHintText(hpa) {
  if (unit !== 'cmh2o' || !Number.isFinite(hpa) || !(hpa > 0)) return 'hPa';
  return `hPa \u2248 ${fmtPressure(hpa, { decimals: 2 })} cmH2O`;
}

/** Re-renders the four readout annotations from the live hPa readouts.
 *  Called by gaugeMarks (which already runs after every threshold change)
 *  and on unit switches. */
export function renderPressureHints() {
  const pairs = [
    ['st', 'sipVal'],
    ['pt', 'puffVal'],
    ['hs', 'hardSipVal'],
    ['hp', 'hardPuffVal'],
  ];
  for (const [key, valueId] of pairs) {
    const el = document.querySelector(`[data-pressure-hint="${key}"]`);
    if (!el) continue;
    const value = Number(($(valueId)?.textContent ?? '').trim());
    el.textContent = pressureHintText(value);
  }
}
