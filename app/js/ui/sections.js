// Circle-nav section cards: open/close with reduced-motion-aware height
// animation, dimmed/aria-disabled gating, and which card is currently open.
// updateConnectionGating (in connection-ui.js) reads the open card via
// getOpenSection() but never mutates which card is open — that is this
// module's single source of truth.
import { showNotification } from './notification.js';
import { prefersReducedMotion } from './motion.js';
import { announceStatus } from './a11y.js';

let openSection = null; // id of the currently-open section card (null when none)

// Section-change subscription: main.js registers the auto-live hook here so
// this module never needs serial imports (the dependency graph stays
// acyclic). Called with the open section id after every transition (null on
// close), including the open-then-close toggle path.
let changeHandler = null;
export function onSectionChange(fn) {
  changeHandler = fn;
}
const notifySectionChange = () => {
  if (changeHandler) changeHandler(openSection);
};

// URL sync for the open card (#sec-cursor): the state is shareable and
// bookmarkable, and main.js boots/restores the section from the hash.
// replaceState, not pushState — opening cards is same-page navigation, not
// history entries to step back through. Guarded: test harnesses and file://
// contexts may not offer a usable history.
function syncSectionHash(id) {
  try {
    if (id) history.replaceState(null, '', '#' + id);
    else {
      const loc = /** @type {{ pathname?: string, search?: string }} */ (window.location ?? {});
      history.replaceState(null, '', (loc.pathname ?? '/') + (loc.search ?? ''));
    }
  } catch {}
}

export function animateSectionOpen(el) {
  el.removeAttribute('inert');
  el.removeAttribute('aria-hidden');
  if (prefersReducedMotion()) {
    el.classList.add('open');
    el.style.maxHeight = 'none';
    return;
  }
  el.style.willChange = 'max-height, opacity';
  el.classList.add('open');
  el.style.maxHeight = el.scrollHeight + 'px';
  const cleanupTimer = setTimeout(() => {
    el.style.willChange = 'auto';
  }, 1000);
  el.addEventListener(
    'transitionend',
    () => {
      clearTimeout(cleanupTimer);
      el.style.willChange = 'auto';
      el.style.maxHeight = 'none';
    },
    { once: true },
  );
}

export function animateSectionClose(el, onDone) {
  el.setAttribute('inert', '');
  el.setAttribute('aria-hidden', 'true');
  if (!el.classList.contains('open')) {
    if (onDone) onDone();
    return;
  }
  const finalHeight = el.scrollHeight + 'px';
  if (prefersReducedMotion()) {
    el.classList.remove('open');
    el.style.maxHeight = '0';
    if (onDone) onDone();
    return;
  }
  el.style.maxHeight = finalHeight;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.classList.remove('open');
      el.style.maxHeight = '0';
      if (onDone) setTimeout(onDone, 400);
    });
  });
}

export function getOpenSection() {
  return openSection;
}

export function openSectionById(id) {
  const btn = document.querySelector(`.circle-trigger[data-section="${id}"]`);
  if (btn && btn.classList.contains('dimmed')) {
    // The title tooltip only exists for pointer-hover; a tap on a touch
    // device would otherwise look like a dead control. The polite toast
    // covers both audiences — no separate srStatus write, or screen readers
    // would hear the same sentence twice.
    showNotification(
      id === 'sec-device'
        ? 'Connect to a LipSync first to load device settings.'
        : 'Connect to a LipSync first to use this section.',
      true,
    );
    return;
  }
  if (openSection === id) {
    closeCurrentSection();
    return;
  }
  if (!closeCurrentSection()) return;
  openSection = id;
  const next = document.getElementById(id);
  if (next) animateSectionOpen(next);
  const nextBtn = document.querySelector(`.circle-trigger[data-section="${id}"]`);
  if (nextBtn) {
    nextBtn.classList.add('active');
    // aria-current describes the user's location in a set of navigation
    // links; these are disclosure buttons for cards on the same page, so the
    // expanded state is the whole story.
    nextBtn.setAttribute('aria-expanded', 'true');
  }
  document.querySelectorAll('.circle-trigger').forEach((/** @type {any} */ b) => {
    if (b.dataset.section !== id) b.setAttribute('aria-expanded', 'false');
  });
  syncSectionHash(id);
  notifySectionChange();
}

/**
 * Closes the open card. Returns false when a firmware update is mid-flight:
 * the wizard panel is the only surface showing progress, the card is exempt
 * from connection gating while data-wizard is set, and closing it would hide
 * a running update. Finished/failed panels stay dismissible.
 */
export function closeCurrentSection() {
  if (!openSection) return true;
  const prev = document.getElementById(openSection);
  const wizardState = prev?.getAttribute?.('data-wizard');
  if (wizardState && wizardState !== 'done' && wizardState !== 'failed') {
    announceStatus('The firmware update is still in progress — the Firmware section stays open.');
    return false;
  }
  const prevBtn = document.querySelector(`.circle-trigger[data-section="${openSection}"]`);
  if (prevBtn) {
    prevBtn.classList.remove('active');
    prevBtn.setAttribute('aria-expanded', 'false');
  }
  if (prev) animateSectionClose(prev);
  openSection = null;
  syncSectionHash(null);
  notifySectionChange();
  return true;
}
