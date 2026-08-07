// Circle-nav section cards: open/close with reduced-motion-aware height
// animation, dimmed/aria-disabled gating, and which card is currently open.
// updateConnectionGating (in connection-ui.js) reads the open card via
// getOpenSection() but never mutates which card is open — that is this
// module's single source of truth.
import { announceStatus } from './a11y.js';
import { prefersReducedMotion } from './motion.js';

let openSection = null; // id of the currently-open section card (null when none)

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
    announceStatus(
      id === 'sec-device'
        ? 'Connect to a LipSync first to load device settings.'
        : 'Connect to a LipSync first to use this section.',
    );
    return;
  }
  if (openSection === id) {
    closeCurrentSection();
    return;
  }
  closeCurrentSection();
  openSection = id;
  const next = document.getElementById(id);
  if (next) animateSectionOpen(next);
  const nextBtn = document.querySelector(`.circle-trigger[data-section="${id}"]`);
  if (nextBtn) {
    nextBtn.classList.add('active');
    nextBtn.setAttribute('aria-expanded', 'true');
    nextBtn.setAttribute('aria-current', 'page');
  }
  document.querySelectorAll('.circle-trigger').forEach((/** @type {any} */ b) => {
    if (b.dataset.section !== id) {
      b.setAttribute('aria-expanded', 'false');
      b.removeAttribute('aria-current');
    }
  });
}

export function closeCurrentSection() {
  if (!openSection) return;
  const prev = document.getElementById(openSection);
  const prevBtn = document.querySelector(`.circle-trigger[data-section="${openSection}"]`);
  if (prevBtn) {
    prevBtn.classList.remove('active');
    prevBtn.setAttribute('aria-expanded', 'false');
    prevBtn.removeAttribute('aria-current');
  }
  if (prev) animateSectionClose(prev);
  openSection = null;
}
