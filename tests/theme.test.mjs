// Theme persistence + WCAG contrast guard (ui/theme.js): stored theme applies
// on init and restores color inputs, the dark toggle persists an override (and
// clears it when the choice lands back on the OS preference), Reset returns to
// defaults, and the contrast guard warns once below AA and re-arms after a
// compliant value.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

// Track timers so the 8s notification auto-dismiss doesn't hold the process open.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const pendingTimers = new Set();
globalThis.setTimeout = (fn, ms, ...args) => {
  const id = realSetTimeout(
    () => {
      pendingTimers.delete(id);
      fn(...args);
    },
    ms,
    ...args,
  );
  pendingTimers.add(id);
  return id;
};
after(() => {
  for (const id of pendingTimers) realClearTimeout(id);
  pendingTimers.clear();
});

// Install stubs at module scope so app modules can evaluate (theme.js reads
// window.matchMedia at import); tests then install a fresh DOM per case.
installGatingDom();

// Dynamic imports so the window/document stubs exist before app modules evaluate.
const { THEME_STORAGE_KEY, COLOR_DEFAULTS } = await import('../app/js/config/constants.js');
const { initSettings } = await import('../app/js/ui/theme.js');
const { getLogHistory } = await import('../app/js/services/log.js');

// Each test installs a fresh DOM so initSettings' event listeners don't stack up
// on the same elements across tests.
const setup = () => {
  const ctx = installGatingDom();
  return {
    els: ctx.els,
    storage: ctx.storage,
    computedStyles: ctx.computedStyles,
    html: ctx.document.documentElement,
  };
};

const contrastWarnCount = () =>
  getLogHistory().filter((entry) => entry.includes('Appearance contrast below WCAG AA')).length;
const savedTheme = (storage) => JSON.parse(storage.getItem(THEME_STORAGE_KEY));

test('stored theme applies on init and restores color inputs', () => {
  const { els, storage, computedStyles, html } = setup();
  storage.setItem(THEME_STORAGE_KEY, JSON.stringify({ darkMode: true, colors: { '--accent': '#ff0000' } }));
  computedStyles['--accent'] = '#111111'; // AA-safe accent: guard stays silent
  initSettings();
  assert.ok(html.classList.contains('dark-mode'));
  assert.equal(els.get('colorAccent').value, '#ff0000');
  assert.equal(els.get('btnDarkMode').getAttribute('aria-pressed'), 'true');
  assert.equal(contrastWarnCount(), 0);
});

test('dark toggle persists the override; returning to the OS theme clears it', () => {
  const { els, storage, computedStyles, html } = setup();
  computedStyles['--accent'] = '#111111';
  initSettings();
  const btn = els.get('btnDarkMode');
  // No stored choice + stub OS prefers dark => auto-dark.
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  assert.equal(els.get('darkModeLabel').textContent, 'On (Auto)');

  btn.dispatch('click'); // to light: an explicit override, saved
  assert.equal(savedTheme(storage).darkMode, false);
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  assert.equal(els.get('darkModeLabel').textContent, 'Off');
  assert.ok(html.classList.contains('light-mode'));

  btn.dispatch('click'); // back to dark = the OS preference => override cleared
  assert.equal('darkMode' in savedTheme(storage), false);
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  assert.equal(els.get('darkModeLabel').textContent, 'On (Auto)');
});

test('contrast guard warns below AA once and re-arms after a compliant value', () => {
  const { els, computedStyles } = setup();
  computedStyles['--accent'] = '#ee343f'; // 4.04:1 on white — below AA
  initSettings();
  assert.ok(els.get('notification').querySelector('.notif-msg').textContent.includes('Low contrast'));
  assert.equal(contrastWarnCount(), 1);

  // Picker drag to an AA-safe accent: latch resets, no new warning.
  computedStyles['--accent'] = '#111111';
  els.get('colorAccent').value = '#111111';
  els.get('colorAccent').dispatch('input');
  assert.equal(contrastWarnCount(), 1);

  // Drag back below AA: warns again (the latch reset).
  computedStyles['--accent'] = '#ee343f';
  els.get('colorAccent').value = '#ee343f';
  els.get('colorAccent').dispatch('input');
  assert.equal(contrastWarnCount(), 2);
});

test('Reset clears the stored theme and restores default input values', () => {
  const { els, storage } = setup();
  storage.setItem(THEME_STORAGE_KEY, JSON.stringify({ darkMode: true, colors: { '--accent': '#ff0000' } }));
  initSettings();
  els.get('btnResetColors').dispatch('click');
  assert.equal(storage.getItem(THEME_STORAGE_KEY), null);
  assert.equal(els.get('colorAccent').value, COLOR_DEFAULTS.colorAccent);
  // No stored choice => back to following the OS (dark per the stub).
  assert.equal(els.get('btnDarkMode').getAttribute('aria-pressed'), 'true');
  assert.equal(els.get('darkModeLabel').textContent, 'On (Auto)');
});
