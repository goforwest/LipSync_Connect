// The <span class="value"> readouts: placeholder/loading state, value writes,
// and the accessibility-label cleanup. VALUE_IDS/VALUE_LABELS come from
// config; this module owns the DOM side-effects for those ids.
import { VALUE_IDS } from '../config/constants.js';
import { $ } from './dom.js';

export function setLoadingPlaceholders() {
  VALUE_IDS.forEach((id) => {
    const el = $(id);
    el.textContent = '\u2026';
    el.classList.remove('err');
    el.classList.add('loading');
    if (typeof el.removeAttribute === 'function') el.removeAttribute('aria-label');
  });
}
export function setValue(id, text) {
  const el = $(id);
  el.textContent = text;
  el.classList.remove('loading', 'err');
  if (typeof el.removeAttribute === 'function') el.removeAttribute('aria-label');
}
