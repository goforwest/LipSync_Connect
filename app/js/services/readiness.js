// Post-connect readiness strip: after the settings load, one glance answers
// "is this device good to use?" — "All set ✓", or the specific things worth
// looking at, each a jump-link into the section that handles it. Today's
// signals: a firmware update the device is behind on (the automatic check's
// own result), and the health check's state (never run / needs attention /
// failed to run). Proactive instead of requiring the user to know where to
// look — the orientation case for first-time users and clinicians.
import { $ } from '../ui/dom.js';
import { serialSession } from '../serial/session.js';
import { openSectionById } from '../ui/sections.js';

/** Re-derives the strip from the live UI state. Cheap; called at every seam
 *  where a signal can change (settings load done, firmware check result,
 *  health check outcome, session reset). */
export function updateReadiness() {
  const strip = $('readinessStrip');
  if (!strip) return;
  if (!serialSession.port) {
    strip.hidden = true;
    return;
  }
  /** @type {{text: string, section: string|null, tone: string}[]} */
  const items = [];
  const updateBtn = $('btnStartUpdate');
  if (updateBtn && !updateBtn.hidden) {
    const target = $('fwTargetVersion');
    items.push({
      text: 'Firmware ' + (target?.textContent || 'update') + ' available',
      section: 'sec-firmware',
      tone: 'info',
    });
  }
  const health = String($('healthSummary')?.textContent ?? '');
  if (health === 'Not run') {
    items.push({ text: 'Health check not run yet', section: 'sec-diagnostics', tone: 'info' });
  } else if (health === 'Needs attention') {
    items.push({ text: 'Health check needs attention', section: 'sec-diagnostics', tone: 'warn' });
  } else if (health === 'Error') {
    items.push({ text: 'Health check could not complete', section: 'sec-diagnostics', tone: 'warn' });
  }
  // 'Running…' and 'Passed' carry no readiness signal — transient or green.

  // Rebuild: at most a handful of chips, and never hot enough to matter.
  // Indexed access (children is a live HTMLCollection in the real DOM, a
  // plain array in the test stub — neither promised lastElementChild here).
  while (strip.children?.length) strip.removeChild(strip.children[strip.children.length - 1]);
  if (!items.length) {
    const ok = document.createElement('span');
    ok.className = 'ready-chip ready-chip--ok';
    ok.textContent = 'All set \u2713';
    strip.appendChild(ok);
  } else {
    for (const item of items) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ready-chip ready-chip--' + item.tone;
      chip.textContent = item.text;
      if (item.section) {
        chip.setAttribute('aria-label', item.text + ' — open the section');
        chip.addEventListener('click', () => openSectionById(/** @type {string} */ (item.section)));
      }
      strip.appendChild(chip);
    }
  }
  strip.hidden = false;
}
