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
import { announceStatus } from '../ui/a11y.js';
import { showConfirm } from '../ui/formatting.js';
import { captureSettingsSnapshot, restoreSettingsSnapshot } from './firmware-update.js';
import { serialSession } from '../serial/session.js';

const PROFILES_KEY = 'lipsync-profiles';
const PROFILE_NAME_MAX = 40;
const APPLYING_MSG = 'A profile is already being applied — wait for it to finish.';

/** Zero-typing save paths: a tap on a suggestion chip saves under that name,
 *  and saving with an empty field picks today's date. The name field stays
 *  for caregivers typing a person's name — it is no longer the only way in.
 *  @type {string[]} */
export const PROFILE_NAME_SUGGESTIONS = ['Daytime', 'Night', 'Gentle', 'Firm', 'Precision', 'Guest'];

// One restore at a time: the shared command queue would serialize the writes
// anyway, but two overlapping restores would interleave their failure counts
// — and a save captured mid-restore would snapshot half-written values.
let applyingProfile = false;

/**
 * localStorage is user-writable and can outlive several app versions. Treat it
 * as untrusted input: only finite ids, bounded names, and scalar endpoint
 * values ever reach the restore path. Unknown/malformed entries are dropped
 * rather than crashing the card or writing "[object Object]" to the device.
 * @param {any} raw
 * @returns {{id: number, name: string, createdAt: string, snapshot: Record<string, string>}|null}
 */
function sanitizeProfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > PROFILE_NAME_MAX) return null;
  if (!raw.snapshot || typeof raw.snapshot !== 'object' || Array.isArray(raw.snapshot)) return null;
  const snapshot = {};
  for (const [key, value] of Object.entries(raw.snapshot)) {
    if (!/^[A-Z]{2}$/.test(key)) continue;
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const text = String(value).trim();
    if (!text || text.length > 32) continue;
    snapshot[key] = text;
  }
  if (!Object.keys(snapshot).length) return null;
  const id = Number(raw.id);
  const createdAt =
    typeof raw.createdAt === 'string' && Number.isFinite(Date.parse(raw.createdAt)) ? raw.createdAt : '';
  return { id: Number.isFinite(id) ? id : 0, name, createdAt, snapshot };
}

/** @returns {{id: number, name: string, createdAt: string, snapshot: Record<string, string>}[]} */
function loadProfiles() {
  try {
    const raw = JSON.parse(localStorage.getItem(PROFILES_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    const list = [];
    const seen = new Set();
    raw.forEach((entry, index) => {
      const p = sanitizeProfile(entry);
      if (!p) return;
      // Missing/corrupt ids get a stable placeholder id; duplicate ids would
      // make Apply/Delete address the wrong row.
      if (!p.id) p.id = -(index + 1);
      if (seen.has(String(p.id))) return;
      seen.add(String(p.id));
      list.push(p);
    });
    return list;
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

/** A fresh name for a nameless save: "Profile <Mon D>", deduplicated against
 *  the saved list with a counter — never a silent overwrite, never a prompt
 *  the user has to read. */
function autoProfileName() {
  const base = 'Profile ' + new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const existing = new Set(loadProfiles().map((p) => p.name));
  if (!existing.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!existing.has(candidate) && candidate.length <= PROFILE_NAME_MAX) return candidate;
  }
}

/** Saves the current in-force settings under `name`. An empty/whitespace name
 *  saves under an auto-generated dated name instead of refusing — the
 *  zero-typing path. A duplicate name overwrites the older entry (a stale
 *  duplicate is the one thing worse than a re-save); auto-names never
 *  collide, so they never overwrite. */
export function saveCurrentProfile(name) {
  if (applyingProfile) {
    log(APPLYING_MSG, 'log-err');
    return false;
  }
  const clean = String(name || '').trim();
  if (clean.length > PROFILE_NAME_MAX) {
    log(`Profile names must be ${PROFILE_NAME_MAX} characters or fewer.`, 'log-err');
    return false;
  }
  const finalName = clean || autoProfileName();
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
  const list = loadProfiles().filter((p) => p.name !== finalName);
  // Re-saving a name replaces its snapshot in place (the row keeps its id and
  // position), so an open confirmation/focus target cannot jump to a new row.
  const previous = loadProfiles().find((p) => p.name === finalName);
  list.push({
    id: previous?.id ?? Date.now(),
    name: finalName,
    createdAt: new Date().toISOString(),
    snapshot,
  });
  if (!saveProfiles(list)) return false;
  const suffix = clean ? '' : ' (no name given — saved by date)';
  log(
    `Profile "${finalName}" saved${suffix} (${Object.keys(snapshot).length - 1} settings, calibration excluded).`,
    'log-info',
  );
  announceStatus(`Profile "${finalName}" saved.`);
  renderProfiles();
  return true;
}

/** Applies a profile through the validated restore path. */
export async function applyProfile(id) {
  if (applyingProfile) {
    log(APPLYING_MSG, 'log-err');
    return;
  }
  const p = loadProfiles().find((x) => String(x.id) === String(id));
  if (!p) {
    log('That profile no longer exists.', 'log-err');
    return;
  }
  if (!serialSession.port) {
    log('Connect the LipSync before applying a profile.', 'log-err');
    return;
  }
  applyingProfile = true;
  const listEl = $('profileList');
  const buttons = listEl?.querySelectorAll ? Array.from(listEl.querySelectorAll('button')) : [];
  buttons.forEach((b) => {
    b.disabled = true;
  });
  try {
    const failures = await restoreSettingsSnapshot(p.snapshot);
    if (failures.length) {
      log(`Profile "${p.name}" applied with ${failures.length} setting(s) the device refused.`, 'log-err');
    } else {
      log(`Profile "${p.name}" applied.`, 'log-info');
    }
  } catch (e) {
    log(`Profile "${p.name}" could not be applied — ${e.message}`, 'log-err');
  } finally {
    applyingProfile = false;
    renderProfiles(); // restore per-row disabled state from the live port
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

/** The one save path for every control: an intentional duplicate name asks
 *  before replacing (silent data loss otherwise); anything else saves
 *  directly (auto-names never collide). */
async function confirmAndSave(name) {
  if (name && loadProfiles().some((p) => p.name === name)) {
    // The dialog holds no user data in its hardcoded markup; the name is
    // only logged after the decision.
    const ok = await showConfirm(
      'Replace profile',
      'A profile with this name already exists. Replace its saved settings?',
      { danger: true },
    );
    if (!ok) return false;
  }
  return saveCurrentProfile(name);
}

/** Button wiring from main.js (composition root). */
export function bindProfiles() {
  const save = $('btnSaveProfile');
  if (save) {
    save.addEventListener('click', async () => {
      const input = $('profileName');
      const ok = await confirmAndSave(String(input?.value ?? '').trim());
      if (ok && input) input.value = '';
    });
  }
  // Quick-name chips: one tap saves the current settings under a suggested
  // name — the zero-typing save path for switch/sip users. The name field
  // stays for caregivers typing a person's name. Like every cmd button, the
  // chips gate on the connection through setCmdButtons.
  const chips = $('profileNameChips');
  if (chips) {
    for (const suggestion of PROFILE_NAME_SUGGESTIONS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'cmd secondary profile-chip';
      chip.textContent = suggestion;
      chip.dataset.name = suggestion;
      chip.setAttribute('aria-label', `Save profile as ${suggestion}`);
      chip.addEventListener('click', async () => {
        chip.disabled = true;
        try {
          await confirmAndSave(suggestion);
        } finally {
          chip.disabled = !serialSession.port;
        }
      });
      chips.appendChild(chip);
    }
  }
  const listEl = $('profileList');
  if (listEl) {
    listEl.addEventListener('click', async (e) => {
      const target = /** @type {any} */ (e.target);
      const id = target?.dataset?.profileId;
      if (!id) return;
      if (target.classList?.contains('profile-apply')) {
        target.disabled = true;
        try {
          await applyProfile(id);
        } finally {
          target.disabled = !serialSession.port;
        }
      } else if (target.classList?.contains('profile-delete')) {
        const ok = await showConfirm('Delete profile', 'Delete this saved profile? This cannot be undone.', {
          danger: true,
        });
        if (!ok) return;
        const deletes = listEl.querySelectorAll ? Array.from(listEl.querySelectorAll('.profile-delete')) : [];
        const index = deletes.findIndex((b) => String(b.dataset.profileId) === String(id));
        deleteProfile(id);
        // The clicked button is gone with the row: land on the next delete
        // button (or the name field when the list emptied) instead of <body>.
        const remaining = listEl.querySelectorAll ? Array.from(listEl.querySelectorAll('.profile-delete')) : [];
        const next = remaining[Math.min(index, remaining.length - 1)];
        if (next && typeof next.focus === 'function') next.focus();
        else if (inputName()) inputName().focus();
      }
    });
    renderProfiles();
  }
}

function inputName() {
  const input = $('profileName');
  return input && typeof input.focus === 'function' ? input : null;
}
