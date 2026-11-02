// Grouped navigation + section cards: seven primary areas name user-facing
// work areas, while compact secondary buttons open the existing feature cards.
// Cards retain their old ids so device services, deep links, and support links
// keep one stable target as the information architecture evolves.
// updateConnectionGating (in connection-ui.js) reads the open card via
// getOpenSection() but never mutates which card is open — that is this
// module's single source of truth.
import { showNotification } from './notification.js';
import { prefersReducedMotion } from './motion.js';
import { announceStatus } from './a11y.js';

let openSection = null; // id of the currently-open section card (null when none)

export const SECTION_GROUPS = Object.freeze({
  home: { label: 'Home', defaultSection: 'sec-home', sections: ['sec-home'] },
  movement: { label: 'Movement', defaultSection: 'sec-cursor', sections: ['sec-cursor', 'sec-joystick'] },
  inputs: {
    label: 'Inputs',
    defaultSection: 'sec-sip',
    sections: ['sec-sip', 'sec-switches', 'sec-restrictions'],
  },
  device: {
    label: 'Device',
    defaultSection: 'sec-device',
    sections: ['sec-device', 'sec-feedback', 'sec-bluetooth', 'sec-profiles'],
  },
  care: {
    label: 'Health & updates',
    defaultSection: 'sec-diagnostics',
    sections: ['sec-diagnostics', 'sec-firmware', 'sec-maintenance'],
  },
  advanced: {
    label: 'Tools',
    defaultSection: 'sec-tools',
    sections: ['sec-tools', 'sec-log'],
  },
  help: { label: 'Help', defaultSection: 'sec-help', sections: ['sec-help'] },
});

const SECTION_TO_GROUP = Object.freeze(
  Object.fromEntries(
    Object.entries(SECTION_GROUPS).flatMap(([group, definition]) =>
      definition.sections.map((section) => [section, group]),
    ),
  ),
);
const lastSectionByGroup = {};

export function getGroupForSection(id) {
  return SECTION_TO_GROUP[id] ?? null;
}

export function getSectionsForGroup(group) {
  return SECTION_GROUPS[group]?.sections ?? [];
}

export function getSectionTrigger(id) {
  return /** @type {HTMLElement|null} */ (document.querySelector(`.section-tab[data-section="${id}"]`));
}

export function getGroupTrigger(group) {
  return /** @type {HTMLElement|null} */ (document.querySelector(`.circle-trigger[data-group="${group}"]`));
}

export function getNavigationTarget(id) {
  const tab = getSectionTrigger(id);
  if (tab && !tab.classList.contains('group-hidden') && !tab.hidden) return tab;
  return getGroupTrigger(getGroupForSection(id));
}

// Section-change subscription: main.js registers the auto-live hook here so
// this module never needs serial imports (the dependency graph stays
// acyclic). Called with the open section id after every transition (null on
// close). Primary navigation keeps one page open at all times.
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

function showConnectFirstNotice(id) {
  showNotification(
    id === 'sec-device'
      ? 'Connect to a LipSync first to load device settings.'
      : 'Connect to a LipSync first to use this section.',
    true,
  );
}

function sectionIsDimmed(id) {
  const tab = getSectionTrigger(id);
  if (tab) return tab.classList.contains('dimmed');
  const group = getGroupForSection(id);
  return !!getGroupTrigger(group)?.classList.contains('dimmed');
}

function syncActiveNavigation(id) {
  const activeGroup = id ? getGroupForSection(id) : null;
  /** @type {HTMLElement|null} */ let activeTrigger = null;
  document.querySelectorAll('.circle-trigger[data-group]').forEach((/** @type {any} */ button) => {
    const active = !!activeGroup && button.dataset.group === activeGroup;
    button.classList.toggle('active', active);
    button.setAttribute('aria-expanded', String(active));
    if (active) activeTrigger = button;
  });

  const visibleTabs = [];
  document.querySelectorAll('.section-tab[data-section]').forEach((/** @type {any} */ tab) => {
    const inGroup = !!activeGroup && tab.dataset.group === activeGroup;
    tab.classList.toggle('group-hidden', !inGroup);
    const active = inGroup && tab.dataset.section === id;
    tab.classList.toggle('active', active);
    if (active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
    if (inGroup && !tab.hidden) visibleTabs.push(tab);
  });

  const subnav = document.getElementById('sectionSubnav');
  const label = document.getElementById('sectionSubnavLabel');
  const mobileLabel = document.getElementById('mobileSectionLabel');
  if (label) label.textContent = activeGroup ? (SECTION_GROUPS[activeGroup]?.label ?? '') : '';
  if (mobileLabel) mobileLabel.textContent = activeGroup ? (SECTION_GROUPS[activeGroup]?.label ?? '') : 'Sections';
  if (subnav) subnav.hidden = visibleTabs.length === 0;

  // A task jump can open Health/Advanced while its tile is off-screen in the
  // phone rail. Bring the selected destination into view so navigation state
  // never changes invisibly; desktop keeps its stable centered row.
  if (
    activeTrigger &&
    window.matchMedia?.('(max-width: 700px)').matches &&
    typeof activeTrigger.scrollIntoView === 'function'
  ) {
    const trigger = activeTrigger;
    const reveal = () => trigger.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reveal);
    else reveal();
  }
}

export function openGroupById(group) {
  const definition = SECTION_GROUPS[group];
  if (!definition) return;
  const groupButton = getGroupTrigger(group);
  if (groupButton?.classList.contains('dimmed')) {
    showConnectFirstNotice(definition.defaultSection);
    return;
  }
  if (openSection && getGroupForSection(openSection) === group) {
    return;
  }
  let target = lastSectionByGroup[group] ?? definition.defaultSection;
  if (sectionIsDimmed(target)) {
    target = definition.sections.find((id) => !sectionIsDimmed(id)) ?? target;
  }
  openSectionById(target);
}

export function openSectionById(id) {
  if (!getGroupForSection(id)) return;
  if (sectionIsDimmed(id)) {
    // The title tooltip only exists for pointer-hover; a tap on a touch
    // device would otherwise look like a dead control. The polite toast
    // covers both audiences — no separate srStatus write, or screen readers
    // would hear the same sentence twice.
    showConnectFirstNotice(id);
    return;
  }
  if (openSection === id) {
    return;
  }
  if (!closeCurrentSection()) return;
  openSection = id;
  const next = document.getElementById(id);
  if (next) animateSectionOpen(next);
  const group = getGroupForSection(id);
  lastSectionByGroup[group] = id;
  syncActiveNavigation(id);
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
  if (prev) animateSectionClose(prev);
  openSection = null;
  syncActiveNavigation(null);
  syncSectionHash(null);
  notifySectionChange();
  return true;
}
