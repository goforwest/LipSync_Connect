// Theme management (dark mode + color customization) and the WCAG contrast
// guard that warns when a custom accent would sink button text below AA.
import { THEME_STORAGE_KEY, COLOR_VARS, COLOR_DEFAULTS } from '../config/constants.js';
import { $, $$ } from './dom.js';
import { log } from '../services/log.js';
import { showNotification } from './notification.js';

const osDarkQuery = window.matchMedia?.('(prefers-color-scheme: dark)');

// Test harnesses stub matchMedia without change events; default to light there.
function osPrefersDark() {
  return !!osDarkQuery?.matches;
}

function loadTheme() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {}
  return saved || {};
}
function saveTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
  } catch {}
}
// Best-known mode, combining the stored override with the live OS preference.
function effectiveDark(theme) {
  return typeof theme.darkMode === 'boolean' ? theme.darkMode : osPrefersDark();
}
function applyTheme(theme) {
  const html = document.documentElement;
  html.classList.toggle('dark-mode', !!theme.darkMode);
  // An explicit in-app light choice must override a dark OS theme; leaving the
  // class absent lets prefers-color-scheme follow the system again.
  html.classList.toggle('light-mode', theme.darkMode === false);
  if (theme.colors) {
    Object.entries(theme.colors).forEach(([key, val]) => html.style.setProperty(key, val));
  }
  const meta = $$('meta[name="theme-color"]');
  // Use the *effective* mode: in auto (no stored darkMode) the OS decides, so
  // a live OS flip must recolor the meta too — theme.darkMode would be undefined.
  if (meta) meta.content = effectiveDark(theme) ? '#10151c' : '#f5f7f8';
  warnLowContrastTheme();
}

// ---- A-2 contrast guard ----
// Users can set an arbitrary accent color, but all action text sits on top of
// it. If the combination falls below WCAG AA (4.5:1), flag it so the user
// knows readability/accessibility took a hit — don't silently serve it.
function hexToRgb(hex) {
  const m = String(hex).replace('#', '');
  if (m.length !== 6) return null;
  return /** @type {[number, number, number]} */ ([
    parseInt(m.slice(0, 2), 16),
    parseInt(m.slice(2, 4), 16),
    parseInt(m.slice(4, 6), 16),
  ]);
}
function relLuminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrastRatio(a, b) {
  const ra = hexToRgb(a),
    rb = hexToRgb(b);
  if (!ra || !rb) return null;
  const [l1, l2] = [relLuminance(ra), relLuminance(rb)];
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}
let contrastWarned = false;
function warnLowContrastTheme() {
  try {
    const styles = getComputedStyle(document.documentElement);
    const accent = styles.getPropertyValue('--accent') || '#ee343f';
    const text = styles.getPropertyValue('--btn-text') || '#ffffff';
    const ratio = contrastRatio(accent.trim(), text.trim());
    if (ratio !== null && ratio < 4.5 && !contrastWarned) {
      contrastWarned = true;
      const msg = `Low contrast (${ratio.toFixed(2)}:1) between your accent and button text colors — this may be hard to read. Consider Reset to defaults.`;
      showNotification(msg, true);
      log('Appearance contrast below WCAG AA (4.5:1): ' + msg, 'log-err');
    } else if (ratio !== null && ratio >= 4.5) {
      contrastWarned = false;
    }
  } catch {}
}

// Live-follow the OS theme only while no explicit in-app choice is stored.
function bindSystemFollow(darkBtn, darkLabel) {
  if (typeof osDarkQuery?.addEventListener !== 'function') return;
  osDarkQuery.addEventListener('change', () => {
    const t = loadTheme();
    if (typeof t.darkMode !== 'boolean') {
      applyTheme(t);
      syncDarkToggle(darkBtn, darkLabel, t);
    }
  });
}
function syncDarkToggle(darkBtn, darkLabel, theme) {
  if (!darkBtn) return;
  const auto = typeof theme.darkMode !== 'boolean';
  const on = effectiveDark(theme);
  darkBtn.setAttribute('aria-pressed', String(on));
  if (darkLabel) darkLabel.textContent = (on ? 'On' : 'Off') + (auto ? ' (Auto)' : '');
}

export function initSettings() {
  const theme = loadTheme();
  applyTheme(theme);
  const darkBtn = $('btnDarkMode'),
    darkLabel = $('darkModeLabel');
  syncDarkToggle(darkBtn, darkLabel, theme);
  bindSystemFollow(darkBtn, darkLabel);
  if (darkBtn) {
    darkBtn.addEventListener('click', () => {
      const t = loadTheme();
      const current = effectiveDark(t);
      const newVal = !current;
      // A manual choice that lands on the OS theme clears the override, so the
      // app goes back to following the system instead of pinning a value.
      if (newVal === osPrefersDark()) {
        delete t.darkMode;
      } else {
        t.darkMode = newVal;
      }
      applyTheme(t);
      syncDarkToggle(darkBtn, darkLabel, t);
      saveTheme(t);
    });
  }
  Object.entries(COLOR_VARS).forEach(([inputId, cssVar]) => {
    const input = $(inputId);
    if (!input) return;
    if (theme.colors && theme.colors[cssVar]) input.value = theme.colors[cssVar];
    input.addEventListener('input', () => {
      document.documentElement.style.setProperty(cssVar, input.value);
      const t = loadTheme();
      t.colors = t.colors || {};
      t.colors[cssVar] = input.value;
      saveTheme(t);
    });
  });
  const resetBtn = $('btnResetColors');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      try {
        localStorage.removeItem(THEME_STORAGE_KEY);
      } catch {}
      // Back to defaults = no stored choice, so the app follows the OS again.
      // applyTheme({}) re-applies the effective (OS) mode and meta correctly.
      document.documentElement.style.cssText = '';
      Object.entries(COLOR_DEFAULTS).forEach(([id, val]) => {
        const el = $(id);
        if (el) el.value = val;
      });
      applyTheme({});
      syncDarkToggle(darkBtn, darkLabel, {});
    });
  }
}
