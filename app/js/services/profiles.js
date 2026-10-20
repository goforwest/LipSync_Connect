// Named user profiles: the settings snapshot machinery (capture/restore, the
// same path the firmware-update wizard uses) with names on top — per-person
// configurations for shared or re-configured devices. Thresholds, speeds,
// windows, restrictions, and switch mappings are individual; calibration is
// deliberately NOT profiled (it is the physical joystick's, per device).
// Profiles live in localStorage as a JSON list of
// { id, name, createdAt, snapshot } — the snapshot is exactly what
// captureSettingsSnapshot produces, so applying reuses restoreSettingsSnapshot
// (version-gated writes, chip suppression, failure reporting) unchanged.
import { $ } from '../ui/dom.js';
import { log } from './log.js';
import { captureSettingsSnapshot, restoreSettingsSnapshot } from './firmware-update.js';
import { serialSession } from '../serial/session.js';

const PROFILES_KEY = 'lipsync-profiles';

/** @returns {{id: number, name: string, createdAt: string, snapshot: Record<string, string>}[]} */
function loadProfiles() {
  try {
    const raw = JSON.parse(localStorage.getItem(PROFILES_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((p) => p && p.name && p.snapshot) : [];
  } catch {
    return [];
  }
}

function saveProfiles(list) {
  try {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    log('Profile could not be saved — ' + e.message, 'log-err');
    return false;
  }
}

/** Saves the current in-force settings under `name` (the name is the only
 *  user-authored field; a duplicate name overwrites the older entry — a
 *  stale duplicate is the one thing worse than a re-save). */
export function saveCurrentProfile(name) {
  const clean = String(name || '').trim();
  if (!clean) {
    log('Give the profile a name first.', 'log-err');
    return false;
  }
  let snapshot;
  try {
    snapshot = captureSettingsSnapshot();
  } catch (e) {
    // The capture refuses incomplete loads (a profile that silently dropped
    // unloaded settings would overwrite them with nothing on apply). The
    // message tells the user how to recover; never throw from a click.
    log('Profile not saved — ' + e.message, 'log-err');
    return false;
  }
  const list = loadProfiles().filter((p) => p.name !== clean);
  list.push({ id: Date.now(), name: clean, createdAt: new Date().toISOString(), snapshot });
  if (!saveProfiles(list)) return false;
  log(`Profile "${clean}" saved (${Object.keys(snapshot).length - 1} settings, calibration excluded).`, 'log-info');
  renderProfiles();
  return true;
}

/** Applies a profile through the validated restore path. */
export async function applyProfile(id) {
  const p = loadProfiles().find((x) => String(x.id) === String(id));
  if (!p) {
    log('That profile no longer exists.', 'log-err');
    return;
  }
  const failures = await restoreSettingsSnapshot(p.snapshot);
  if (failures.length) {
    log(`Profile "${p.name}" applied with ${failures.length} setting(s) the device refused.`, 'log-err');
  } else {
    log(`Profile "${p.name}" applied.`, 'log-info');
  }
}

export function deleteProfile(id) {
  const list = loadProfiles();
  const p = list.find((x) => String(x.id) === String(id));
  const next = list.filter((x) => String(x.id) !== String(id));
  if (!saveProfiles(next)) return;
  if (p) log(`Profile "${p.name}" deleted.`, 'log-info');
  renderProfiles();
}

/** Rebuilds the profile list UI. Indexed child access on both real DOM and
 *  stub (the windows.js convention). */
export function renderProfiles() {
  const listEl = $('profileList');
  if (!listEl) return;
  while (listEl.children?.length) listEl.removeChild(listEl.children[listEl.children.length - 1]);
  const profiles = loadProfiles();
  for (const p of profiles) {
    const row = document.createElement('div');
    row.className = 'profile-row';
    const name = document.createElement('span');
    name.className = 'profile-name';
    name.textContent = p.name;
    const when = document.createElement('span');
    when.className = 'profile-date';
    try {
      when.textContent = new Date(p.createdAt).toLocaleDateString();
    } catch {
      when.textContent = '';
    }
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'cmd secondary profile-apply';
    apply.textContent = 'Apply';
    apply.title = `Apply "${p.name}" to the connected device`;
    apply.dataset.profileId = String(p.id);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'secondary profile-delete';
    del.textContent = 'Delete';
    del.setAttribute('aria-label', `Delete profile "${p.name}"`);
    del.dataset.profileId = String(p.id);
    row.appendChild(name);
    row.appendChild(when);
    row.appendChild(apply);
    row.appendChild(del);
    listEl.appendChild(row);
  }
  const empty = $('profileEmpty');
  if (empty) empty.hidden = profiles.length > 0;
  // Apply buttons respect the connection like every cmd button (setCmdButtons
  // handles connect/disconnect); re-derive their disabled state here so a
  // freshly rendered list matches the current port state.
  if (listEl.querySelectorAll) {
    for (const b of listEl.querySelectorAll('button.cmd')) {
      if (b.classList.toggle) b.classList.toggle('cmd', true);
      b.disabled = !serialSession.port;
    }
  }
}

/** Button wiring from main.js (composition root). */
export function bindProfiles() {
  const save = $('btnSaveProfile');
  if (save) {
    save.addEventListener('click', () => {
      saveCurrentProfile(String($('profileName')?.value ?? ''));
      const input = $('profileName');
      if (input) input.value = '';
    });
  }
  const listEl = $('profileList');
  if (listEl) {
    listEl.addEventListener('click', (e) => {
      const target = /** @type {any} */ (e.target);
      const id = target?.dataset?.profileId;
      if (!id) return;
      if (target.classList?.contains('profile-apply')) void applyProfile(id);
      else if (target.classList?.contains('profile-delete')) deleteProfile(id);
    });
    renderProfiles();
  }
}
