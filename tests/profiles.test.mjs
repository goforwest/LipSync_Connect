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
  assert.equal(saveCurrentProfile('  '), false, 'empty name refuses');
  assert.equal(saveCurrentProfile('Sarah'), true);
  const chips = listChips();
  assert.equal(chips.length, 1);
  assert.equal(chips[0].name, 'Sarah');
  const stored = JSON.parse(localStorage.getItem('lipsync-profiles'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].name, 'Sarah');
  assert.equal(stored[0].snapshot.SS, '7'); // the snapshot machinery's keys
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
