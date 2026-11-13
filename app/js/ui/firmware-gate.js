// The "needs newer firmware" note, shared by every version-gated feature.
// One helper so the contract stays identical everywhere: say what is locked,
// name the firmware that has it, and hand the user a working link straight
// into the Updates section (the pattern the acceleration card established —
// a plain "update the firmware" sentence made the reader go find the button
// themselves, and the hidden variants said nothing at all).
import { $ } from './dom.js';
import { openSectionById, getSectionTrigger } from './sections.js';

/** Opens Updates and focuses its check button (or the section trigger while
 *  disconnected). The one navigation every gate note's link performs. */
export function openUpdatesSection() {
  openSectionById('sec-firmware');
  const check = $('btnCheckUpdate');
  const focusTarget = check && !check.disabled ? check : getSectionTrigger('sec-firmware');
  focusTarget?.focus?.();
}

/**
 * Replaces a note's content with the gate reason and an inline Updates link.
 * The note's stock text is restored by the feature's own renderer/reset path
 * (clearing textContent also removes the link, so nothing leaks).
 * @param {HTMLElement|null} note the note paragraph
 * @param {string} featureLabel user-facing feature name ("Input safeguards")
 * @param {number[]} minFirmware [major, minor, patch]
 * @param {string} [tail] optional closing sentence after the link
 * @param {string} [verb] the feature's verb ("needs", or "need" for plural names)
 */
export function showFirmwareGateNote(note, featureLabel, minFirmware, tail = ' to install it.', verb = 'needs') {
  if (!note) return;
  note.textContent = `${featureLabel} ${verb} firmware ${minFirmware.join('.')}+ — open `;
  const link = document.createElement('a');
  link.href = '#sec-firmware';
  link.className = 'inline-link';
  link.textContent = 'Updates';
  link.addEventListener('click', (event) => {
    event.preventDefault();
    openUpdatesSection();
  });
  note.appendChild(link);
  note.appendChild(document.createTextNode(tail));
}
