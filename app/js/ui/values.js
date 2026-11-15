// The <span class="value"> readouts: placeholder/loading state, value writes,
// and the accessibility-label cleanup. VALUE_IDS/VALUE_LABELS come from
// config; this module owns the DOM side-effects for those ids.
import { VALUE_IDS } from '../config/constants.js';
import { $ } from './dom.js';

/** A readout is "blank" while it only carries the not-loaded em dash. The
 *  class drives the quiet unframed placeholder style in styles.css; the em
 *  dash glyph itself comes from `::after`, so the box keeps its footprint and
 *  the card does not reflow when the real value lands. */
function markBlank(el, blank) {
  if (typeof el.classList?.toggle === 'function') el.classList.toggle('is-blank', blank);
}

/** True for the literal placeholder glyphs a readout can hold ("—", "…",
 *  "-", or empty) — i.e. anything that is not a real device value. */
export function isBlankReadout(text) {
  const t = String(text ?? '').trim();
  return t === '' || t === '\u2014' || t === '\u2026' || t === '-';
}

/** Re-derives the blank styling for every readout from its current text. Used
 *  after a session reset, where the markup's own em dash has been restored. */
export function syncBlankReadouts() {
  VALUE_IDS.forEach((id) => {
    const el = $(id);
    if (el) markBlank(el, isBlankReadout(el.textContent));
  });
}

export function setLoadingPlaceholders() {
  VALUE_IDS.forEach((id) => {
    const el = $(id);
    el.textContent = '\u2026';
    el.classList.remove('err');
    el.classList.add('loading');
    markBlank(el, false); // the ellipsis is an active "loading" state, not blank
    if (typeof el.removeAttribute === 'function') {
      el.removeAttribute('aria-label');
      el.removeAttribute('title');
    }
  });
}
export function setValue(id, text) {
  const el = $(id);
  el.textContent = text;
  el.classList.remove('loading', 'err');
  markBlank(el, isBlankReadout(text));
  if (typeof el.removeAttribute === 'function') {
    el.removeAttribute('aria-label');
    el.removeAttribute('title');
  }
}
