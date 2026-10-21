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
import { listProfiles } from './profiles.js';
import { SWITCH_ACTION_PACK_BASE, FEEDBACK_MODES } from '../config/constants.js';

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

  // Profile mismatch — the shared-device signal: a saved profile that this
  // device almost matches (a handful of drifted settings at the coarsest
  // stepper granularity) is exactly the borrowed-and-tweaked case the strip
  // exists to surface. A 100% match is in force (silent); many differences
  // is someone else's config (silent); few comparable keys is not judgeable.
  const mismatch = profileMismatch();
  if (mismatch) items.push(mismatch);

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

// ---- Profile mismatch --------------------------------------------------------
// Granularity = the coarsest step the steppers emit, per the design call:
// a re-saved profile never false-positives on rounding, only real changes.
const DIFF_TOLERANCE = {
  SS: 1,
  SL: 1,
  AV: 1,
  LL: 1,
  ST: 0.25,
  PT: 0.25,
  IZ: 0.05,
  OZ: 0.05,
  WS: 50,
  WL: 50,
  WM: 50,
};
const READOUT_BY_ENDPOINT = {
  SS: 'speedVal',
  SL: 'scrollVal',
  AV: 'accelVal',
  LL: 'brightnessVal',
  ST: 'sipVal',
  PT: 'puffVal',
  IZ: 'innerDeadzoneVal',
  OZ: 'outerDeadzoneVal',
  WS: 'w1Val',
  WL: 'w2Val',
  WM: 'w3Val',
};
const CHECKBOX_BY_ENDPOINT = { SD: 'sapDisabled', MA: 'menuButtonsOnly', LK: 'modeLock', CF: 'cursorHold' };
const SWITCH_SELECT_PREFIX = { SA: 'swSA', SB: 'swSB', SC: 'swSC', GA: 'swGA', GB: 'swGB', GC: 'swGC' };

/** @returns {{text: string, section: string, tone: string}|null} */
function profileMismatch() {
  const profiles = listProfiles();
  if (!profiles.length) return null;
  /** @type {{name: string, comparable: number, mismatches: number}|null} */
  let best = null;
  for (const p of profiles) {
    let comparable = 0;
    let mismatches = 0;
    for (const [endpoint, stored] of Object.entries(p.snapshot || {})) {
      const tol = DIFF_TOLERANCE[endpoint];
      const readoutId = READOUT_BY_ENDPOINT[endpoint];
      if (readoutId) {
        const live = Number(String($(readoutId)?.textContent || '').trim());
        const want = Number(stored);
        if (!Number.isFinite(live) || !Number.isFinite(want)) continue; // unloaded — not judgeable
        comparable++;
        if (Math.abs(live - want) > tol) mismatches++;
      } else if (endpoint === 'SM' || endpoint === 'LM') {
        // The readout shows the mode's label; compare against the stored
        // value's label — no reverse mapping needed.
        const label = FEEDBACK_MODES[stored];
        if (label === undefined) continue;
        comparable++;
        if (String($(endpoint === 'SM' ? 'soundModeVal' : 'lightModeVal')?.textContent || '').trim() !== label)
          mismatches++;
      } else if (CHECKBOX_BY_ENDPOINT[endpoint]) {
        comparable++;
        if (!!$(CHECKBOX_BY_ENDPOINT[endpoint])?.checked !== (stored === '1')) mismatches++;
      } else if (SWITCH_SELECT_PREFIX[endpoint]) {
        const cells = [0, 1, 2].map((i) => parseInt($(SWITCH_SELECT_PREFIX[endpoint] + i)?.value, 10));
        if (!cells.every((c) => Number.isFinite(c))) continue; // not loaded
        const packed = String(SWITCH_ACTION_PACK_BASE + cells[0] * 10000 + cells[1] * 100 + cells[2]);
        comparable++;
        if (packed !== String(stored)) mismatches++;
      }
    }
    if (comparable < 6) continue; // a thin profile is not judgeable
    if (mismatches === 0) return null; // this profile is in force — done
    if (mismatches <= 2 && (!best || mismatches < best.mismatches)) best = { name: p.name, comparable, mismatches };
  }
  if (!best) return null;
  return {
    text: `Device differs from “${best.name}” in ${best.mismatches} setting${best.mismatches === 1 ? '' : 's'}`,
    section: 'sec-device',
    tone: 'info',
  };
}
