// Named user profiles (services/profiles.js): save captures the settings
// snapshot (the wizard's own capture), apply runs it back through the
// validated restore, delete removes, and a duplicate name overwrites (a
// stale duplicate is worse than a re-save). Malformed storage must never
// crash the card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc, windowListeners } = installGatingDom();
const app = await import('../app/js/main.js');
(windowListeners['DOMContentLoaded'] || []).forEach((fn) => fn());
const { saveCurrentProfile, applyProfile, deleteProfile, renderProfiles } =
  await import('../app/js/services/profiles.js');
const { testHooks } = await import('./harness/test-hooks.mjs');
const { captureSettingsSnapshot } = await import('../app/js/services/firmware-update.js');
const { getLogHistory } = await import('../app/js/services/log.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listChips = () => {
  const list = doc.getElementById('profileList');
  return Array.from(list.children ?? []).map((row) => ({
    name: row.children[0].textContent,
    apply: row.children[2],
    del: row.children[3],
  }));
};

const seedSettings = () => {
  const values = {
    speedVal: '7',
    scrollVal: '5',
    accelVal: '3',
    sipVal: '12.50',
    puffVal: '25.00',
    innerDeadzoneVal: '0.10',
    outerDeadzoneVal: '0.90',
    soundModeVal: 'Basic',
    lightModeVal: 'Basic',
    brightnessVal: '8',
    w1Val: '600',
    w2Val: '1000',
    w3Val: '2500',
  };
  for (const [id, v] of Object.entries(values)) doc.getElementById(id).textContent = v;
};

test('save captures the live snapshot, persists, and renders the list', () => {
  seedSettings();
  assert.equal(saveCurrentProfile('Sarah'), true);
  const chips = listChips();
  assert.equal(chips.length, 1);
  assert.equal(chips[0].name, 'Sarah');
  const stored = JSON.parse(localStorage.getItem('lipsync-profiles'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].name, 'Sarah');
  assert.equal(stored[0].snapshot.SS, '7'); // the snapshot machinery's keys
});

/** The file's tests chain state through localStorage; tests that save extra
 *  profiles snapshot the storage and restore it so the chain stays intact. */
const withIsolatedProfiles = async (body) => {
  const saved = localStorage.getItem('lipsync-profiles');
  localStorage.removeItem('lipsync-profiles');
  try {
    await body();
  } finally {
    if (saved === null) localStorage.removeItem('lipsync-profiles');
    else localStorage.setItem('lipsync-profiles', saved);
    renderProfiles();
  }
};

test('an empty name saves under an auto-generated dated name instead of refusing', async () => {
  await withIsolatedProfiles(async () => {
    seedSettings();
    assert.equal(saveCurrentProfile('  '), true, 'the empty field is the zero-typing path, not a refusal');
    const stored = JSON.parse(localStorage.getItem('lipsync-profiles'));
    const auto = stored[stored.length - 1];
    assert.match(auto.name, /^Profile /);
    assert.ok(auto.name.length <= 40);
    const logEntry = getLogHistory().at(-1);
    assert.ok(logEntry.includes('no name given'), logEntry);
    // A second nameless save never overwrites the first — it increments.
    assert.equal(saveCurrentProfile(''), true);
    const names = JSON.parse(localStorage.getItem('lipsync-profiles')).map((p) => p.name);
    assert.equal(new Set(names).size, names.length, 'auto-names never collide');
  });
});

test('quick-name chips render with the suggestion palette and save in one tap', async () => {
  await withIsolatedProfiles(async () => {
    seedSettings();
    const chipRow = doc.getElementById('profileNameChips');
    const chips = Array.from(chipRow.children ?? []).map((b) => ({ name: b.dataset.name, btn: b }));
    assert.ok(chips.length >= 4, 'the palette rendered');
    assert.ok(chips.every((c) => c.btn.classList.contains('profile-chip')));
    const named = chips.find((c) => c.name === 'Daytime');
    named.btn.dispatch('click');
    await sleep(30);
    const stored = JSON.parse(localStorage.getItem('lipsync-profiles'));
    assert.ok(stored.some((p) => p.name === 'Daytime'), JSON.stringify(stored.map((p) => p.name)));
  });
});

test('a chip tap on an existing name asks before replacing', async () => {
  await withIsolatedProfiles(async () => {
    seedSettings();
    const named = Array.from(doc.getElementById('profileNameChips').children ?? []).find(
      (b) => b.dataset.name === 'Daytime',
    );
    named.dispatch('click');
    await sleep(30); // first save: no confirm
    doc.getElementById('speedVal').textContent = '2'; // a distinct snapshot to detect the replace
    const before = JSON.parse(localStorage.getItem('lipsync-profiles')).find((p) => p.name === 'Daytime');
    named.dispatch('click');
    await sleep(30);
    // The danger confirm is up, Cancel-first; the old snapshot survives cancel.
    doc.getElementById('confirmCancel').dispatch('click');
    await sleep(30);
    const afterCancel = JSON.parse(localStorage.getItem('lipsync-profiles')).find((p) => p.name === 'Daytime');
    assert.equal(afterCancel.snapshot.SS, before.snapshot.SS, 'cancel kept the old snapshot');
    named.dispatch('click');
    await sleep(30);
    doc.getElementById('confirmOk').dispatch('click');
    await sleep(30);
    const replaced = JSON.parse(localStorage.getItem('lipsync-profiles')).find((p) => p.name === 'Daytime');
    assert.equal(replaced.snapshot.SS, '2', 'ok replaced the snapshot');
  });
});

test('a duplicate name overwrites the older entry', () => {
  doc.getElementById('speedVal').textContent = '9';
  assert.equal(saveCurrentProfile('Sarah'), true);
  const stored = JSON.parse(localStorage.getItem('lipsync-profiles'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].snapshot.SS, '9');
});

test('apply runs the stored snapshot back through the wire', async () => {
  const sent = [];
  testHooks.attach(
    { simulated: true },
    {
      write(bytes) {
        const text = Buffer.from(bytes)
          .toString('utf8')
          .replace(/\r?\n$/, '');
        sent.push(text);
        if (text === 'SETTINGS') setTimeout(() => app.handleLine('SUCCESS,0:SETTINGS'), 3);
        else setTimeout(() => app.handleLine('SUCCESS,0:' + text), 3);
      },
    },
  );
  const stored = JSON.parse(localStorage.getItem('lipsync-profiles'));
  await applyProfile(stored[0].id);
  await sleep(80);
  assert.ok(sent.includes('SS,1:9'), JSON.stringify(sent));
  assert.ok(sent.includes('ST,1:12.500'), JSON.stringify(sent));
  testHooks.detach();
});

test('delete removes the entry and re-renders', () => {
  const stored = JSON.parse(localStorage.getItem('lipsync-profiles'));
  deleteProfile(stored[0].id);
  assert.equal(JSON.parse(localStorage.getItem('lipsync-profiles')).length, 0);
  assert.equal(listChips().length, 0);
  assert.equal(doc.getElementById('profileEmpty').hidden, false);
});

test('malformed storage never crashes — it reads as an empty list', () => {
  localStorage.setItem('lipsync-profiles', '{not json');
  renderProfiles();
  assert.equal(listChips().length, 0);
  assert.equal(saveCurrentProfile('Bench unit'), true);
  assert.equal(listChips().length, 1);
});

test('the snapshot machinery and the profile agree on what was live', () => {
  seedSettings();
  const snap = captureSettingsSnapshot();
  assert.equal(snap.SS, '7');
  assert.equal(snap.ST, '12.50');
});

test('malformed localStorage entries are dropped, never rendered or applied', () => {
  seedSettings();
  localStorage.setItem(
    'lipsync-profiles',
    JSON.stringify([
      { name: 'NoSnapshot' },
      { name: 'BadTypes', snapshot: { SS: { nested: true } } },
      { name: 'x'.repeat(60), snapshot: { SS: '9' } },
      { name: 'Good', id: 42, createdAt: '2026-01-01T00:00:00Z', snapshot: { SS: '8' } },
      { name: 'Good', id: 42, createdAt: '2026-01-02T00:00:00Z', snapshot: { SS: '9' } },
    ]),
  );
  renderProfiles();
  const chips = listChips();
  assert.equal(chips.length, 1, 'only the well-formed entry survives (dup id dropped)');
  assert.equal(chips[0].name, 'Good');
  // Reads are pure: the next save persists the sanitized list.
  saveCurrentProfile('Fresh');
  const stored = JSON.parse(localStorage.getItem('lipsync-profiles'));
  assert.equal(stored.length, 2);
  assert.ok(stored.every((p) => p.name !== 'NoSnapshot' && p.name !== 'BadTypes'));
});

test('names are trimmed and capped at 40 characters', () => {
  seedSettings();
  assert.equal(saveCurrentProfile('  Padded  '), true);
  const stored = JSON.parse(localStorage.getItem('lipsync-profiles'));
  assert.ok(stored.some((p) => p.name === 'Padded'));
  assert.equal(saveCurrentProfile('x'.repeat(41)), false, '41 characters refuses');
  const after = JSON.parse(localStorage.getItem('lipsync-profiles'));
  assert.equal(after.length, stored.length, 'the refused name was not stored');
});

test('apply with no port refuses before any wire write', async () => {
  seedSettings();
  saveCurrentProfile('NoPort');
  const stored = JSON.parse(localStorage.getItem('lipsync-profiles'));
  const logCount = getLogHistory().length;
  await applyProfile(stored[0].id);
  assert.ok(
    getLogHistory()
      .slice(logCount)
      .some((entry) => entry.includes('Connect the LipSync before applying a profile')),
  );
});
