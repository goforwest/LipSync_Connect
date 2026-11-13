'use strict';

import {
  FEEDBACK_MODES,
  DEBUG_MODES,
  LIVE_STREAM_BUTTONS,
  HEADER_SCROLL_THRESHOLD,
  RESTRICTION_SETTINGS,
  WINDOW_SETTINGS,
  SWITCH_SETTINGS,
  INPUT_STATE_LIGHT_MIN_FIRMWARE,
  FIRMWARE_MANIFEST_URL_OVERRIDE_KEY,
  APP_BUILD_ID,
} from './config/constants.js';
import { debounce, fmtApiFloat, fmtHpa } from './utils/format.js';
import { $, $$ } from './ui/dom.js';
import { log } from './services/log.js';
import { buildLogFile, downloadLogFile, shareLog } from './services/log-export.js';
import { bindSupportReport } from './services/support-report.js';
import { serialApi } from './serial/transport.js';
import { sendCommand, deviceFirmwareAtLeast } from './serial/commands.js';

import {
  gaugeDelta,
  recalcGaugeRange,
  gaugeMarks,
  resetPracticePeaks,
  suggestThresholds,
  formatSuggestion,
} from './plotting/gauge.js';
import { initWindowLadders } from './plotting/windows.js';
import { updateLiveStreamNote } from './plotting/diag.js';

import { setValue } from './ui/values.js';
import { bindModeSwitch, updateModeDisplay } from './services/mode-switch.js';
import { modeState } from './state/modes.js';
import { bindCalibration, resetCalibrationUi } from './services/calibration.js';
import { loadDeviceInfo } from './services/settings-service.js';

import { connect, disconnect } from './serial/connection.js';
import { serialSession } from './serial/session.js';
import { readCalibration, setDeadzone, setSimpleSetting, requireNumber, step } from './services/settings-service.js';
import { updateConnectionGating, hideGuide, setCmdButtons } from './ui/connection-ui.js';
import { showConfirm } from './ui/formatting.js';
import { showNotification } from './ui/notification.js';
import { bindUpdateToast } from './ui/update-toast.js';
import {
  openSectionById,
  openGroupById,
  closeCurrentSection,
  getOpenSection,
  getNavigationTarget,
  onSectionChange,
} from './ui/sections.js';
import { guard } from './ui/guard.js';
import { bindDeviceOps } from './services/device-ops.js';
import { bindHubRemote, resetHubRemote } from './services/hub-remote.js';
import {
  bindWriteConfirm,
  hideWriteConfirm,
  suppressNextWriteConfirm,
  clearWriteConfirmSuppression,
} from './services/confirm.js';
import { updateReadiness } from './services/readiness.js';
import { bindProfiles } from './services/profiles.js';
import { resetPracticeStats, copyPracticeStats } from './services/practice-stats.js';
import { bindWizard, exitWizard } from './services/wizard.js';
import { runDiagnostics } from './services/health.js';
import { exportSettings } from './services/settings-export.js';
import {
  getPressureUnit,
  initPressureUnits,
  onPressureUnitChange,
  setPressureUnit,
} from './services/pressure-units.js';
import { afterDeviceLoad, bindFirmwareUpdate, resetFirmwareUpdateUi } from './services/firmware-update.js';
import { initSettings } from './ui/theme.js';
// bindBluetoothHosts/startBtHostsPoller are dynamically imported by
// firmware-update.js's afterDeviceLoad() — main.js only needs the session
// reset.
import { resetBluetoothHostsUi } from './services/bt-hosts.js';
import {
  setRestriction,
  resetRestrictionsUi,
  setTimingWindow,
  populateSwitchActionSelects,
  resetSwitchActionsUi,
  setSwitchAction,
  resetSwitchActions,
  setHardThreshold,
  setHardAction,
  populateHardActionSelects,
  resetHardBandUi,
} from './services/settings-service.js';
import { HARD_ACTION_SETTINGS } from './config/constants.js';

// Gauge-mark updates on sip/puff input are debounced (100ms); the marks live in
// plotting/gauge.js, and this binding calls them on input edits.
const debouncedGaugeMarks = debounce(gaugeMarks, 100);

// Re-exports so tests can import behavior from the composition root.
export { VALUE_LABELS } from './config/constants.js';
export { $, $$ } from './ui/dom.js';
export { announceStatus } from './ui/a11y.js';

// ------------------------- Global error handler -------------------------
window.addEventListener('error', (e) => {
  console.error(e.error || e.message);
  // Route through log() so uncaught errors land in the session history and are
  // included in Download/Share exports, not just the visible box.
  log('Uncaught: ' + (e.error?.message ?? e.message ?? 'unknown error'), 'log-err');
});
window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  log('Unhandled promise: ' + (e.reason?.message ?? e.reason ?? 'unknown'), 'log-err');
});
// ------------------------- Serial layer -------------------------
// The physical link, waiters, and command queue live in serial/session.js;
// commands.js owns sendCommand/waitLine and device.js owns handleLine.

// Read-activity watchdog + encoder live in serial/commands.js.

// ---- Transport selection ----
// Web Serial / WebUSB-with-shim transport factory lives in serial/transport.js.
// Log export/share lives in services/log-export.js (redaction, build, download, share).

// announceStatus lives in ui/a11y.js (re-exported above).

// Rate-limited logger for out-of-band serial data that *isn't* self-test
// narration (reserved-mode text — LED/Buzzer/Watchdog narration is handled
// separately) lives in services/log.js.
// Connection chrome (status pill, banner+retry, guide, gating) lives in ui/connection-ui.js.

// Device self-test (LED / buzzer) button lockout and the live narration panel
// live in services/selftest.js; connection chrome (status pill, banner+retry,
// guide, updateConnectionGating) lives in ui/connection-ui.js.

// Value readouts (setValue / placeholder loading state) live in ui/values.js.

// ---- Visualization helpers ----
// Firmware's real minimum corner magnitude is 3 (CONF_JOY_CALIB_CORNER_MIN),
// NOT 1 — and any corner below it is *silently replaced with the ±13 default*
// while still printing SUCCESS. WEAK_CORNER_THRESHOLD / JOY_CORNER_DEFAULT let
// us detect both "weak" (<3) and substituted (==13) so the user isn't told
// calibration passed when the device flagged an error.
// plotState and gauge range/delta live in plotting/{plot,gauge}.js — imported above.

// ---- Live diagnostic visualizations ----
// Firmware emits {mainState, subState, elapsedMs}; the middle field cycles
// 0 (waiting) / 1 (started) / 2 (released) — don't assume it's always 0.

// Operating/communication mode state lives in state/modes.js; preset sync +
// BT status display live in services/mode-switch.js.

// ---- Calibration step indicator ----

// Connect/disconnect/readLoop live in serial/connection.js; line dispatch
// (handleLine/applyDeviceResponse) live in serial/device.js.

// ENDPOINT_RENDERERS moved to serial/endpoints.js (registered into
// services/registry.js at import); getDeviceLoadTasks lives in
// services/settings-service.js.

// The initial settings load lives in services/settings-service.js.

// Section-card animations live in ui/sections.js.

// ------------------------- Startup configuration -------------------------
// Endpoint renderers populate the dispatch registry; connection + settings
// services get their cross-module hooks wired here (main.js is the composition
// root for this ordering).
import './serial/endpoints.js';
import { configureConnection } from './serial/connection.js';
import { configureSettingsListeners, clearLoadTimer } from './services/settings-service.js';
import { clearHealthResults, hideHealthHistory } from './services/health.js';
// Disconnect (and a fresh settings load) must clear stale health results AND
// the mirrored Hub screen — the device's menu dies with the port. The
// restriction checkboxes reset with the same stroke so a stale checked state
// from a previous device can never leak into a new session.
const clearSessionUi = () => {
  clearHealthResults();
  resetHubRemote();
  resetFirmwareUpdateUi();
  resetRestrictionsUi();
  resetSwitchActionsUi();
  resetHardBandUi(); // the hard sip/puff band (4.7.0+) reads and locks with the same stroke
  resetCalibrationUi(); // no stale "Calibration complete" from a previous session
  resetPracticePeaks(); // fresh session, fresh practice — no stale peaks
  // Multi-host Bluetooth switching (firmware 4.8.0+, upstream #16): the paired
  // host table is session-scoped — clear it on disconnect so a stale "Active"
  // marker never survives into a new session.
  resetBluetoothHostsUi();
  // The streaming select is only meaningful once the device's DM value has
  // loaded; disabling it is also the signal auto-live uses to refuse to send
  // DM over a stream whose current state is still unknown. The feedback
  // selects follow the same contract (enabled by their device answer,
  // disabled with the session) now that they write on change.
  const dmSelect = $('debugMode');
  if (dmSelect) dmSelect.disabled = true;
  const soundSelect = $('soundMode');
  if (soundSelect) {
    soundSelect.disabled = true;
    delete soundSelect.dataset.applied;
  }
  const lightSelect = $('lightMode');
  if (lightSelect) {
    lightSelect.disabled = true;
    delete lightSelect.dataset.applied;
  }
  updateLiveStreamNote(null); // the stream note dies with the session
  hideHealthHistory(); // the stored trend stays; the row hides with the session
  resetPracticeStats(); // practice stats are session-scoped
  hideWriteConfirm(); // a stale Undo must never point at a dead session
  // 4.8.7 review: the OM/CM mode state is device-reported — a stale value
  // from a previous device/session fed currentModeKey() in the Hub mirror
  // and the btStatus readout until the next session's reads landed (or
  // forever, if they failed). Clear with the session and re-render.
  modeState.currentOpMode = null;
  modeState.currentComMode = null;
  updateModeDisplay();
  updateReadiness(); // no port: the strip hides itself
  autoLiveMode = null; // the device's debug mode dies with the port
  autoLivePending = false;
  clearLoadTimer();
};
// The DISCONNECT reset additionally closes the guided wizard: a mid-flow
// wizard must not point at a dead session. The load-start reset above must
// NOT — the wizard's own first step is the connect, and the fresh load it
// triggers is exactly what the wizard is waiting on (exiting there killed
// the first-run flow the moment its Connect step succeeded).
const resetSessionUiOnDisconnect = () => {
  clearSessionUi();
  exitWizard();
};

// --- Auto-live sections -------------------------------------------------------
// Opening Sip & Puff or Joystick while connected starts their live view
// automatically when the device is idle (debug mode 0) — the two-click tax
// on every practice, calibration, and adjustment session disappears. The
// auto-started stream belongs to the app: it stops when its section closes
// or another one opens. A stream the user started (or replaced ours with)
// is theirs and is never touched.
const AUTO_LIVE_SECTION_MODES = { 'sec-sip': '2', 'sec-joystick': '1' };
let autoLiveMode = null; // the DM mode the app auto-started; null = not ours
let autoLivePending = false; // our start's echo hasn't landed yet
let autoLiveTakenFrom = '0'; // the select value when our start was sent
const syncAutoLive = (sectionId) => {
  const dmEl = $('debugMode');
  // Before the settings load lands the select is disabled and still shows its
  // markup default ("0"). Treating that as the device's real mode would send
  // DM,1:2 over a stream the user already had running.
  const dmReady = !!dmEl && !dmEl.disabled;
  const dm = String(dmEl?.value ?? '0');
  // If the stream we started was replaced or stopped elsewhere, it is no
  // longer ours to manage. While our own start's echo is still in flight the
  // select legitimately shows the value we started FROM (staleness, not a
  // takeover — treating it as one orphaned the stream whenever the section
  // closed inside the echo round-trip); only a move to a third value is a
  // user takeover.
  if (autoLiveMode !== null) {
    const replacedElsewhere = autoLivePending
      ? dm !== String(autoLiveMode) && dm !== String(autoLiveTakenFrom)
      : dm !== String(autoLiveMode);
    if (replacedElsewhere) autoLiveMode = null;
  }
  if (autoLiveMode !== null) {
    const wantMode = sectionId ? AUTO_LIVE_SECTION_MODES[sectionId] : null;
    if (!wantMode || String(wantMode) !== String(autoLiveMode)) {
      const stopping = autoLiveMode;
      autoLiveMode = null;
      autoLivePending = false;
      if (serialSession.port) {
        // App housekeeping, not a user edit: no confirmation chip or Undo.
        suppressNextWriteConfirm('DM');
        void setSimpleSetting('DM', '0', 'debugModeVal', DEBUG_MODES).catch(() => {
          clearWriteConfirmSuppression('DM');
          void stopping; // a failed stop is retried by the next transition
        });
      }
    }
  }
  const wantMode = serialSession.port && sectionId ? AUTO_LIVE_SECTION_MODES[sectionId] : null;
  if (wantMode && autoLiveMode === null && dmReady && dm === '0') {
    autoLiveTakenFrom = dm;
    autoLiveMode = wantMode;
    autoLivePending = true;
    suppressNextWriteConfirm('DM');
    void setSimpleSetting('DM', wantMode, 'debugModeVal', DEBUG_MODES)
      .then(() => {
        autoLivePending = false; // echo landed — the select now shows our mode
        log('Live view started for this section — Stop live view turns it off.', 'log-info');
      })
      .catch(() => {
        clearWriteConfirmSuppression('DM');
        autoLiveMode = null; // never started: nothing to manage
        autoLivePending = false;
      });
  }
};
onSectionChange(syncAutoLive);
// After a successful settings load: finish an in-flight firmware update
// (verify + restore settings) when one is pending, otherwise run the
// automatic update check. Fire-and-forget — nothing here may delay "ready".
const loadDeviceInfoThenCheckFirmware = async () => {
  await loadDeviceInfo();
  // The user may have opened a live section while settings were still
  // loading; now that DM is known, let the normal ownership rules decide.
  syncAutoLive(getOpenSection());
  void afterDeviceLoad();
};
configureConnection({
  loadDeviceInfo: loadDeviceInfoThenCheckFirmware,
  clearHealthResults: resetSessionUiOnDisconnect,
});
configureSettingsListeners({ clearHealth: clearSessionUi });

// ------------------------- Wiring -------------------------
window.addEventListener('DOMContentLoaded', () => {
  const logo = /** @type {HTMLImageElement|null} */ ($$('header .logo'));
  if (logo) {
    if (logo.complete && (logo.naturalWidth === 0 || logo.naturalHeight === 0)) logo.hidden = true;
    logo.addEventListener('error', function () {
      this.hidden = true;
    });
    if (sessionStorage.getItem('lipsync-logo-animated')) logo.classList.add('played');
    else
      logo.addEventListener(
        'animationend',
        () => {
          try {
            sessionStorage.setItem('lipsync-logo-animated', '1');
          } catch {}
        },
        { once: true },
      );
  }
  initSettings();
  initPressureUnits(); // the display-unit preference must land before the first gauge render

  // --- Always-run initialization (nav, popup, service worker) ---
  // Group tiles + compact page navigation
  const circleTriggers = /** @type {NodeListOf<any>} */ (document.querySelectorAll('.circle-trigger'));
  const sectionTabs = /** @type {NodeListOf<any>} */ (document.querySelectorAll('.section-tab[data-section]'));
  // openSection state is owned by ui/sections.js; nav Reads it via getOpenSection().

  // --- Task-based entry (Home's collapsed More tasks list) ---
  // Plain-language goals jump straight to the control that answers them.
  // Hardware pages remain browsable while disconnected; their device actions
  // stay disabled until connection.
  const TASK_TARGETS = {
    clicks: {
      section: 'sec-sip',
      focus: 'button[data-target="st"][data-step="1"]',
    },
    accidents: { section: 'sec-restrictions', focus: '#sapDisabled' },
    update: { section: 'sec-firmware', focus: '#btnCheckUpdate' },
    switches: { section: 'sec-switches', focus: '#swSA0' },
    profile: { section: 'sec-profiles', focus: '#profileName' },
  };
  document.querySelectorAll('.task-btn').forEach((/** @type {any} */ btn) => {
    btn.addEventListener('click', () => {
      const t = TASK_TARGETS[btn.dataset.task];
      if (!t) return;
      openSectionById(t.section);
      if (getOpenSection() !== t.section) return;
      const target = document.querySelector(t.focus);
      if (target && typeof target.focus === 'function') {
        target.focus();
        target.classList.add('pulse-target');
        setTimeout(() => target.classList.remove('pulse-target'), 2400);
      }
    });
  });

  // Appearance lives in the header at every width. Keeping one trigger avoids
  // the desktop FAB competing with page actions (and looking like support).
  const gearBtns = /** @type {HTMLElement[]} */ ([$('btnSettings')].filter(Boolean));
  const popup = $('appearancePopup');
  /** @type {() => void} */ let openPopup = () => {};
  /** @type {(restoreFocus?: boolean) => void} */ let closePopup = () => {};
  if (gearBtns.length && popup) {
    /** @type {HTMLElement|undefined} */ let lastTrigger = gearBtns[0];
    openPopup = () => {
      popup.style.display = '';
      popup.removeAttribute('aria-hidden');
      gearBtns.forEach((btn) => btn.setAttribute('aria-expanded', 'true'));
      popup.offsetHeight;
      requestAnimationFrame(() => {
        popup.classList.add('open');
        requestAnimationFrame(() => {
          const firstControl = /** @type {HTMLElement|null} */ (
            popup.querySelector(
              'button:not(:disabled), summary, input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]',
            )
          );
          if (firstControl && typeof firstControl.focus === 'function') firstControl.focus({ preventScroll: true });
        });
      });
      gearBtns.forEach((btn) => btn.classList.add('active'));
    };
    closePopup = (restoreFocus = true) => {
      if ((restoreFocus || popup.contains(document.activeElement)) && lastTrigger) {
        lastTrigger.focus({ preventScroll: true });
      }
      popup.classList.remove('open');
      popup.style.display = 'none';
      popup.setAttribute('aria-hidden', 'true');
      gearBtns.forEach((btn) => {
        btn.setAttribute('aria-expanded', 'false');
        btn.classList.remove('active');
      });
    };
    popup.style.display = 'none';
    popup.setAttribute('aria-hidden', 'true');
    gearBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = popup.classList.contains('open');
        if (isOpen) closePopup();
        else {
          lastTrigger = btn;
          openPopup();
        }
      });
    });
    document.addEventListener('click', (e) => {
      if (popup.classList.contains('open') && !popup.contains(e.target) && !gearBtns.some((btn) => btn === e.target)) {
        closePopup(false);
      }
    });
    // Focus trap: while the popup is open, Tab cycles inside it instead of
    // escaping into the page behind (the popup is non-modal — outside clicks
    // close it, but keyboard users should not be stranded behind it).
    popup.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab' || !popup.classList.contains('open')) return;
      const focusables = /** @type {HTMLElement[]} */ (
        Array.from(popup.querySelectorAll('button, summary, input, select, textarea, a[href]')).filter(
          (el) => !el.disabled && el.getAttribute('aria-hidden') !== 'true',
        )
      );
      if (!focusables.length) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  // Pressure display units (hPa default; cmH2O for clinicians who think in
  // it): a reading preference only — steppers, exact inputs, and the wire
  // stay hPa-native (see services/pressure-units.js).
  const unitBtns = /** @type {NodeListOf<any>} */ (document.querySelectorAll('[data-pressure-unit]'));
  const syncUnitButtons = () => {
    unitBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pressureUnit === getPressureUnit())));
  };
  unitBtns.forEach((b) => b.addEventListener('click', () => setPressureUnit(b.dataset.pressureUnit)));
  onPressureUnitChange(syncUnitButtons);
  syncUnitButtons();

  circleTriggers.forEach((btn) => {
    btn.addEventListener('click', () => openGroupById(btn.dataset.group));
  });
  sectionTabs.forEach((btn) => {
    btn.addEventListener('click', () => openSectionById(btn.dataset.section));
  });

  // Compact navigation: phones and narrow tablets get one stable Sections
  // button instead of a partially hidden horizontal rail. The same grouped
  // navigation opens as a large, scrollable panel; desktop keeps the sidebar.
  const appSidebar = $('appSidebar');
  const primaryNav = $('sectionNav');
  const navMore = $('btnNavMore');
  const navMoreLabel = $('navMoreLabel');
  const compactNavQuery = window.matchMedia?.('(max-width: 900px)');
  const compactNav = () => !!compactNavQuery?.matches;
  const syncPrimaryNav = (open) => {
    const expanded = compactNav() && !!open;
    if (appSidebar) appSidebar.classList.toggle('nav-open', expanded);
    if (navMore) {
      navMore.setAttribute('aria-expanded', String(expanded));
      navMore.setAttribute('aria-label', expanded ? 'Sections — close menu' : 'Sections — open menu');
    }
    if (navMoreLabel) navMoreLabel.textContent = 'Sections';
    if (primaryNav) {
      if (compactNav() && !expanded) {
        primaryNav.setAttribute('aria-hidden', 'true');
        primaryNav.setAttribute('inert', '');
      } else {
        primaryNav.removeAttribute('aria-hidden');
        primaryNav.removeAttribute('inert');
      }
    }
  };
  const closePrimaryNav = (restoreFocus = false) => {
    const wasOpen = !!appSidebar?.classList.contains('nav-open');
    syncPrimaryNav(false);
    if (wasOpen && restoreFocus && typeof navMore?.focus === 'function') navMore.focus({ preventScroll: true });
  };
  const openPrimaryNav = () => {
    if (!compactNav()) return;
    syncPrimaryNav(true);
    const active = /** @type {HTMLElement|null} */ (document.querySelector('.circle-trigger.active'));
    const target = active ?? circleTriggers[0];
    if (target && typeof target.focus === 'function') {
      const focusTarget = () => target.focus({ preventScroll: true });
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focusTarget);
      else focusTarget();
    }
  };
  if (primaryNav && navMore && appSidebar) {
    navMore.addEventListener('click', (e) => {
      e.stopPropagation();
      if (appSidebar.classList.contains('nav-open')) closePrimaryNav(true);
      else openPrimaryNav();
    });
    circleTriggers.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (compactNav()) closePrimaryNav(true);
      });
    });
    document.addEventListener('click', (e) => {
      if (
        appSidebar.classList.contains('nav-open') &&
        typeof appSidebar.contains === 'function' &&
        !appSidebar.contains(e.target)
      ) {
        closePrimaryNav(false);
      }
    });
    if (typeof compactNavQuery?.addEventListener === 'function') {
      compactNavQuery.addEventListener('change', () => syncPrimaryNav(false));
    }
    syncPrimaryNav(false);
  }
  document.querySelectorAll('[data-open-section]').forEach((/** @type {any} */ btn) => {
    btn.addEventListener('click', () => openSectionById(btn.dataset.openSection));
  });

  // Card "×" close buttons (4.8.7 review): the sixteen .card-close buttons
  // in index.html had no handler — clicking "×" did nothing. Bind them to
  // the nav's own close path so the wizard mid-flight refusal and the URL
  // sync behave identically.
  document.querySelectorAll('.card-close').forEach((/** @type {any} */ btn) => {
    btn.addEventListener('click', () => closeCurrentSection());
  });

  // Single Escape handler
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.querySelector('dialog[open]')) return;
    // The connection guide outranks a section: while the port picker hint is
    // up, Escape should clear the overlay the user is looking at.
    const guide = $('connectGuide');
    if (guide && !guide.hidden) {
      hideGuide();
      return;
    }
    if (appSidebar?.classList.contains('nav-open')) {
      e.preventDefault();
      closePrimaryNav(true);
      return;
    }
    if (popup && popup.classList.contains('open')) {
      closePopup();
      return;
    }
    const openId = getOpenSection();
    if (openId && openId !== 'sec-home') {
      e.preventDefault();
      // Pages no longer behave like dismissible dialogs. Escape is a simple
      // "back to Home" shortcut; the section controller's firmware guard still
      // keeps an active update visible and announces why it cannot move.
      openSectionById('sec-home');
      if (getOpenSection() === 'sec-home') {
        const trigger = /** @type {HTMLElement|null} */ (getNavigationTarget('sec-home'));
        if (trigger && typeof trigger.focus === 'function') trigger.focus();
      }
    }
  });

  // Clicking the guide's dim backdrop dismisses it — same as its Dismiss
  // button; there is nothing else to do behind the overlay while it is up.
  document.querySelector('.guide-backdrop')?.addEventListener('click', hideGuide);

  // Header scroll shadow
  const headerEl = $('appHeader');
  if (headerEl) {
    const syncHeaderHeight = () => {
      const measured =
        (typeof headerEl.getBoundingClientRect === 'function' && headerEl.getBoundingClientRect().height) ||
        Number(headerEl.offsetHeight) ||
        0;
      if (measured > 0 && document.documentElement?.style?.setProperty) {
        // getBoundingClientRect includes body zoom, while sticky `top` is a CSS
        // length that will be zoomed again. Store the unzoomed height so 150%
        // UI scale does not turn a 60px header into a 135px sticky offset.
        const scale = Number(document.body?.style?.zoom) || 1;
        document.documentElement.style.setProperty('--app-header-height', `${Math.ceil(measured / scale)}px`);
      }
    };
    syncHeaderHeight();
    window.addEventListener('resize', syncHeaderHeight, { passive: true });
    if (typeof ResizeObserver === 'function') new ResizeObserver(syncHeaderHeight).observe(headerEl);
    let scrollTicking = false;
    window.addEventListener(
      'scroll',
      () => {
        if (!scrollTicking) {
          requestAnimationFrame(() => {
            headerEl.classList.toggle('scrolled', window.scrollY > HEADER_SCROLL_THRESHOLD);
            scrollTicking = false;
          });
          scrollTicking = true;
        }
      },
      { passive: true },
    );
  }

  // Initialize collapsed section cards as inert. Connection state never gates
  // reading a page; only its hardware-dependent controls are disabled.
  document.querySelectorAll('.section-card').forEach((el) => {
    el.setAttribute('inert', '');
    el.setAttribute('aria-hidden', 'true');
  });
  // --- Hash deep links (#sec-cursor, #sec-firmware, …) ---
  // A shared/bookmarked link opens the right card on load. The hash must be
  // read BEFORE the default Home open — sections.js syncs the URL on every
  // open, so the default would overwrite the incoming link first. Hardware
  // controls remain disabled until connected, but the linked page is readable.
  const sectionFromHash = () => {
    try {
      const id = String(window.location?.hash ?? '').replace(/^#/, '');
      return id && document.getElementById(id)?.classList?.contains?.('section-card') ? id : '';
    } catch {
      return '';
    }
  };
  // Clear stale dimming from an older cached build before honoring a deep link.
  updateConnectionGating();
  openSectionById(sectionFromHash() || 'sec-home');
  if (!getOpenSection()) openSectionById('sec-home');
  initWindowLadders();
  bindSupportReport();
  // Manual hash edits and history navigation open their section too (the
  // skip link's #main-content is not a section and is ignored).
  window.addEventListener('hashchange', () => {
    const id = sectionFromHash();
    if (id && id !== getOpenSection()) openSectionById(id);
  });

  // Service worker registration
  const canRegisterServiceWorker =
    'serviceWorker' in navigator && window.isSecureContext && ['http:', 'https:'].includes(window.location.protocol);
  if (canRegisterServiceWorker) {
    let localFirmwareOverride = false;
    try {
      localFirmwareOverride = !!localStorage.getItem(FIRMWARE_MANIFEST_URL_OVERRIDE_KEY);
    } catch {}
    if (localFirmwareOverride) {
      // A local firmware build and stale app JavaScript are a dangerous mix:
      // the 4.6.4 bench flashed the new MP-capable firmware while cache v40
      // still served the old OM/CM mode-switch flow. Developer overrides now
      // opt out of offline caching and clear LipSync's old caches so a reload
      // always tests the files currently on disk.
      const wasControlled = !!navigator.serviceWorker.controller;
      const localWorkerResetKey = 'lipsync-local-worker-reset';
      void Promise.all([
        navigator.serviceWorker
          .getRegistrations()
          .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister()))),
        globalThis.caches
          ? globalThis.caches
              .keys()
              .then((keys) =>
                Promise.all(
                  keys.filter((key) => key.startsWith('lipsync-connect-')).map((key) => globalThis.caches.delete(key)),
                ),
              )
          : Promise.resolve(),
      ])
        .then(() => {
          // The worker that served this navigation can finish background
          // stale-while-revalidate writes after cache deletion and recreate
          // v40/v41. Navigate once after unregistering; that next page is no
          // longer controlled and performs the deletion a final time.
          if (wasControlled) {
            let alreadyReloaded = false;
            try {
              alreadyReloaded = sessionStorage.getItem(localWorkerResetKey) === APP_BUILD_ID;
              if (!alreadyReloaded) sessionStorage.setItem(localWorkerResetKey, APP_BUILD_ID);
            } catch {}
            if (!alreadyReloaded) {
              window.location.reload();
              return;
            }
          } else {
            try {
              sessionStorage.removeItem(localWorkerResetKey);
            } catch {}
          }
        })
        .catch((err) => console.error('Could not clear the local development cache:', err));
    } else {
      // A deploy takes over the open page mid-session (the new worker claims
      // clients over the stale one) — say so and offer the reload; the user
      // decides when.
      bindUpdateToast();
      navigator.serviceWorker.register('./service-worker.js').catch((err) => {
        console.error('Service worker registration failed:', err);
        log('Service worker registration failed: ' + err.message, 'log-err');
        // Offline caching is an enhancement, not a requirement — say so rather
        // than leaving the user to discover it the next time they are offline.
        showNotification('Offline support could not start — the app still works while online.', true);
      });
    }
  }

  // --- Unsupported browser guard (only skips serial-dependent wiring) ---
  if (!serialApi) {
    $('unsupported').hidden = false;
    $('btnConnect').disabled = true;
    $('btnHomeConnect').disabled = true;
  } else {
    if (!('serial' in navigator))
      log(
        'Web Serial unavailable; using the WebUSB fallback (Android). Connect the LipSync with a USB-C/OTG cable.',
        'log-info',
      );
    $('btnConnect').addEventListener('click', connect);
    $('btnHomeConnect').disabled = false;
    $('btnHomeConnect').addEventListener('click', () => {
      if (!$('btnConnect').disabled) void connect();
    });
    $('btnGuideDismiss').addEventListener('click', hideGuide);
    $('btnDisconnect').addEventListener('click', disconnect);
    $('btnRefreshAll').addEventListener('click', guard(loadDeviceInfo));
    $('btnExportSettings').addEventListener('click', guard(exportSettings));
    $('btnRunDiagnostics').addEventListener('click', guard(runDiagnostics));
    bindDeviceOps(guard);
    bindWriteConfirm(); // the inline write-confirm chip's Undo button
    bindProfiles(); // named per-user settings profiles (Device card)
    bindWizard(); // Home's guided setup flow
    bindModeSwitch(guard, disconnect, setCmdButtons);
    bindCalibration(guard);
    // The live-stream select writes on change (same contract as the feedback
    // selects): the pick is the write, a rejected write reverts the select,
    // and programmatic value sync (the renderer, auto-live) never fires
    // change — so auto-live's own DM writes cannot re-enter here.
    $('debugMode').addEventListener(
      'change',
      guard(async () => {
        const sel = $('debugMode');
        const next = sel.value;
        const prev = sel.dataset.applied ?? '0';
        try {
          await setSimpleSetting('DM', next, 'debugModeVal', DEBUG_MODES);
          sel.dataset.applied = next;
          log(`Live diagnostic output ${next === '0' ? 'disabled' : 'set to ' + DEBUG_MODES[next]}.`, 'log-info');
        } catch (e) {
          sel.value = prev;
          throw e;
        }
      }),
    );

    // Self-test LED/buzzer buttons and soft/factory reset live in services/device-ops.js
    // and are bound via bindDeviceOps(guard) above.

    // Remote Hub menu (Open/Close + the mirrored Hub screen driven by
    // Next/Select) lives in services/hub-remote.js. Class "cmd" on the four
    // buttons makes setCmdButtons handle connect/disconnect disabling.
    bindHubRemote(guard);
    // Firmware update check + flash wizard live in services/firmware-update.js.
    bindFirmwareUpdate(guard);
    // Operating mode and Bluetooth flows live in services/mode-switch.js
    document
      .querySelectorAll('button[data-step]')
      .forEach((/** @type {any} */ b) =>
        b.addEventListener('click', () => step(b.dataset.target, parseInt(b.dataset.step, 10))),
      );

    $('btnSetSip').addEventListener(
      'click',
      guard(
        async () => {
          $('sapError').textContent = '';
          try {
            const v = requireNumber('sipInput', 2, 149.99, 'Sip threshold');
            const r = await sendCommand('ST,1:' + fmtApiFloat(v));
            // fmtHpa: the SET echo carries the wire-format padding; show the
            // 2-decimal form the loaded values use.
            setValue('sipVal', fmtHpa(r.value ?? v));
            recalcGaugeRange();
          } catch (e) {
            $('sapError').textContent = e.message;
            throw e;
          }
        },
        // Error is shown inline in #sapError; skip the redundant notification.
        { quiet: true },
      ),
    );
    $('btnSetPuff').addEventListener(
      'click',
      guard(
        async () => {
          $('sapError').textContent = '';
          try {
            const v = requireNumber('puffInput', 2, 149.99, 'Puff threshold');
            const r = await sendCommand('PT,1:' + fmtApiFloat(v));
            setValue('puffVal', fmtHpa(r.value ?? v));
            recalcGaugeRange();
          } catch (e) {
            $('sapError').textContent = e.message;
            throw e;
          }
        },
        { quiet: true },
      ),
    );
    // Exact-value fields are validated only at Set: an empty or out-of-range
    // draft stays in the field and the Set click explains itself inline —
    // nothing is written (and no boundary value silently substituted) until
    // the typed value is one the device can hold. The readout beside the
    // field always shows the value actually in force.

    // Practice watch + suggest-from-practice: the maxima track in
    // plotting/gauge.js off every pressure frame; these buttons are the
    // user-facing half. Suggest (unlocked by updatePracticeUi once both sides
    // are measured) computes 65%-of-peak trigger values; Apply writes both
    // through the same SET path the manual buttons use (device truth re-syncs
    // the readouts and marks through the endpoint renderers).
    $('btnClearPeaks').addEventListener(
      'click',
      guard(() => {
        resetPracticePeaks();
        $('sapSuggestion').hidden = true;
        $('btnApplySuggested').hidden = true;
        $('btnDismissSuggestion').hidden = true;
        log('Practice measurements cleared — start a fresh round.', 'log-info');
      }),
    );
    $('btnSuggestThresholds').addEventListener(
      'click',
      guard(() => {
        const s = suggestThresholds();
        if (!s.ready) return; // the button is disabled until ready; guard anyway
        $('sapSuggestionText').textContent = formatSuggestion(s);
        $('sapSuggestion').hidden = false;
        $('btnApplySuggested').hidden = false;
        $('btnDismissSuggestion').hidden = false;
      }),
    );
    $('btnApplySuggested').addEventListener(
      'click',
      guard(
        async () => {
          const s = suggestThresholds();
          if (!s.ready) return;
          $('sapError').textContent = '';
          try {
            const rs = await sendCommand('ST,1:' + fmtApiFloat(s.sip));
            setValue('sipVal', fmtHpa(rs.value ?? s.sip));
            const rp = await sendCommand('PT,1:' + fmtApiFloat(s.puff));
            setValue('puffVal', fmtHpa(rp.value ?? s.puff));
            recalcGaugeRange();
            log('Suggested thresholds applied (from the measured practice).', 'log-info');
            $('sapSuggestion').hidden = true;
            $('btnApplySuggested').hidden = true;
            $('btnDismissSuggestion').hidden = true;
          } catch (e) {
            $('sapError').textContent = e.message;
            throw e;
          }
        },
        { quiet: true },
      ),
    );
    $('btnCopyPracticeStats').addEventListener(
      'click',
      guard(async () => {
        await copyPracticeStats();
      }),
    );
    $('btnDismissSuggestion').addEventListener('click', () => {
      $('sapSuggestion').hidden = true;
      $('btnApplySuggested').hidden = true;
      $('btnDismissSuggestion').hidden = true;
    });

    // Input timing windows (roadmap item 15; firmware 4.4.0+): each Set
    // validates range and short < long < max ordering before writing; the
    // firmware validates again (defense in depth).
    WINDOW_SETTINGS.forEach((w) => {
      $('btnSet' + w.endpoint).addEventListener(
        'click',
        guard(
          async () => {
            $('sapError').textContent = '';
            try {
              const v = Number($(w.inputId).value);
              await setTimingWindow(w.endpoint, v);
            } catch (e) {
              $('sapError').textContent = e.message;
              throw e;
            }
          },
          { quiet: true },
        ),
      );
      // Typing a valid value clears a stale inline error (the windows never
      // had this — an ordering refusal used to survive any edit).
      $(w.inputId).addEventListener('input', () => {
        const v = Number($(w.inputId).value);
        if ($('sapError').textContent && (!Number.isFinite(v) || (Number.isInteger(v) && v >= w.min && v <= w.max)))
          $('sapError').textContent = '';
      });
      // On blur, re-validate against the allowed range: a valid entry clears
      // a stale inline error, an out-of-range one shows the range message
      // the moment the field loses focus — the user no longer has to
      // remember to tap Set to learn their value is out of range.
      $(w.inputId).addEventListener('blur', () => {
        const v = Number($(w.inputId).value);
        const errEl = $('sapError');
        const unit = w.inputId === 'w1Input' || w.inputId === 'w2Input' || w.inputId === 'w3Input' ? 'ms' : '';
        const inRange = Number.isFinite(v) && Number.isInteger(v) && v >= w.min && v <= w.max;
        errEl.textContent = inRange ? '' : `Expected ${w.min}–${w.max} ${unit}.`;
      });
    });
    // Same blur contract for the free-number exact-value fields (sip/puff and
    // hard thresholds in hPa, deadzones unitless): a valid value clears the
    // field's inline error; anything else (out of range, empty) states the
    // expected range. The message lands in the same error element the field's
    // Set button writes to — named explicitly, since the id-prefix sniff this
    // replaces once routed the sip/puff fields' messages into the joystick
    // card's error element, where nobody on the Sip & Puff page could see them.
    const makeRangeBlur = (id, min, max, msg, errId) => {
      const input = $(id);
      if (!input) return;
      input.addEventListener('blur', () => {
        const errEl = $(errId);
        const v = Number(input.value);
        errEl.textContent = Number.isFinite(v) && v >= min && v <= max ? '' : msg;
      });
    };
    makeRangeBlur('sipInput', 2, 149.99, 'Expected 2–149.99 hPa.', 'sapError');
    makeRangeBlur('puffInput', 2, 149.99, 'Expected 2–149.99 hPa.', 'sapError');
    makeRangeBlur('hardSipInput', 2, 149.99, 'Expected 2–149.99 hPa.', 'sapError');
    makeRangeBlur('hardPuffInput', 2, 149.99, 'Expected 2–149.99 hPa.', 'sapError');
    makeRangeBlur('innerDeadzone', 0.01, 0.99, 'Expected 0.01–0.99.', 'formError');
    makeRangeBlur('outerDeadzone', 0.01, 0.99, 'Expected 0.01–0.99.', 'formError');
    $('btnReadCalibration').addEventListener('click', guard(readCalibration));
    $('btnSetInnerDeadzone').addEventListener(
      'click',
      guard(
        async () => {
          try {
            await setDeadzone('inner');
          } catch (e) {
            $('formError').textContent = e.message;
            throw e;
          }
        },
        // Error is shown inline in #formError; skip the redundant notification.
        { quiet: true },
      ),
    );
    $('btnSetOuterDeadzone').addEventListener(
      'click',
      guard(
        async () => {
          try {
            await setDeadzone('outer');
          } catch (e) {
            $('formError').textContent = e.message;
            throw e;
          }
        },
        { quiet: true },
      ),
    );
    // Feedback and stream selects write on change (the same contract the
    // switch-jack and hard-band selects use): the pick is the write, a
    // rejected write reverts the select to the last device-confirmed value,
    // and the selects are enabled only by their device answer (disabled with
    // the session). The former Set/Apply buttons are gone — one less click
    // and one consistent interaction for every settings select.
    $('soundMode').addEventListener(
      'change',
      guard(async () => {
        const sel = $('soundMode');
        const prev = sel.dataset.applied ?? '';
        try {
          await setSimpleSetting('SM', sel.value, 'soundModeVal', FEEDBACK_MODES);
          sel.dataset.applied = sel.value;
        } catch (e) {
          if (prev) sel.value = prev;
          throw e;
        }
      }),
    );
    $('lightMode').addEventListener(
      'change',
      guard(async () => {
        const sel = $('lightMode');
        if (sel.value === '3' && !deviceFirmwareAtLeast(...INPUT_STATE_LIGHT_MIN_FIRMWARE)) {
          // Revert the pick before surfacing the refusal — the option is
          // disabled on gated firmware, so this is defense in depth.
          sel.value = sel.dataset.applied ?? '2';
          throw new Error(`Input-state light feedback needs firmware ${INPUT_STATE_LIGHT_MIN_FIRMWARE.join('.')}+.`);
        }
        const prev = sel.dataset.applied ?? '';
        try {
          await setSimpleSetting('LM', sel.value, 'lightModeVal', FEEDBACK_MODES);
          sel.dataset.applied = sel.value;
        } catch (e) {
          if (prev) sel.value = prev;
          throw e;
        }
      }),
    );

    // Input restrictions (roadmap item 11; firmware 4.4.0+): each checkbox
    // writes on change; a rejected write reverts (the device is the truth).
    RESTRICTION_SETTINGS.forEach((r) => {
      $(r.checkboxId).addEventListener(
        'change',
        guard(async () => {
          const el = $(r.checkboxId);
          el.disabled = true; // one write at a time; the renderer re-enables
          try {
            await setRestriction(r.endpoint, el.checked);
          } finally {
            // Restore the connection-derived state, not an unconditional
            // enable: a disconnect mid-write must leave the box disabled like
            // every other cmd control.
            el.disabled = !serialSession.port;
          }
        }),
      );
    });

    // External switch actions (upstream #20; firmware 4.5.0+): each pick
    // writes its jack/mode's triple immediately; a rejected write reverts
    // to the last device-confirmed mapping.
    populateSwitchActionSelects();
    SWITCH_SETTINGS.forEach((s) => {
      for (let i = 0; i < s.windowLabels.length; i++) {
        $(s.selectPrefix + i).addEventListener(
          'change',
          guard(
            async () => {
              $('switchError').textContent = '';
              try {
                await setSwitchAction(s.endpoint);
              } catch (e) {
                $('switchError').textContent = e.message;
                throw e;
              }
            },
            { quiet: true },
          ),
        );
      }
    });
    $('btnResetSwitchActions').addEventListener(
      'click',
      guard(async () => {
        await resetSwitchActions();
      }),
    );
    // Per-jack Mouse/Gamepad segmented toggle: one mode's mapping grid is
    // visible at a time; the pressed tab is the whole state (aria-pressed,
    // same pattern as the live-view toggles).
    document.querySelectorAll('.switch-tab').forEach((/** @type {any} */ tab) => {
      tab.addEventListener('click', () => {
        if (tab.getAttribute('aria-pressed') === 'true') return;
        document
          .querySelectorAll(`.switch-tab[data-jack="${tab.dataset.jack}"]`)
          .forEach((/** @type {any} */ b) => b.setAttribute('aria-pressed', String(b === tab)));
        document.querySelectorAll(`.switch-mode[data-jack="${tab.dataset.jack}"]`).forEach((/** @type {any} */ p) => {
          p.hidden = p.dataset.mode !== tab.dataset.mode;
        });
      });
    });

    // Hard sip/puff band (upstream #58; firmware 4.7.0+): the two exact-value
    // Set buttons validate range AND the hard >= regular + margin rule
    // against the live regular readouts before writing; the action selects
    // write on change with revert-on-FAIL, same as the switch jacks.
    populateHardActionSelects();
    HARD_ACTION_SETTINGS.forEach((a) => {
      $(a.selectId).addEventListener(
        'change',
        guard(
          async () => {
            $('sapError').textContent = '';
            try {
              await setHardAction(a.endpoint);
            } catch (e) {
              $('sapError').textContent = e.message;
              throw e;
            }
          },
          { quiet: true },
        ),
      );
    });
    $('btnSetHardSip').addEventListener(
      'click',
      guard(
        async () => {
          $('sapError').textContent = '';
          try {
            const v = requireNumber('hardSipInput', 2, 149.99, 'Hard sip threshold');
            await setHardThreshold('HS', v);
          } catch (e) {
            $('sapError').textContent = e.message;
            throw e;
          }
        },
        { quiet: true },
      ),
    );
    $('btnSetHardPuff').addEventListener(
      'click',
      guard(
        async () => {
          $('sapError').textContent = '';
          try {
            const v = requireNumber('hardPuffInput', 2, 149.99, 'Hard puff threshold');
            await setHardThreshold('HP', v);
          } catch (e) {
            $('sapError').textContent = e.message;
            throw e;
          }
        },
        { quiet: true },
      ),
    );
    $('hardSipInput').addEventListener('input', () => {
      const v = Number($('hardSipInput').value);
      if ($('sapError').textContent && (!Number.isFinite(v) || (v >= 2 && v <= 149.99))) $('sapError').textContent = '';
      debouncedGaugeMarks();
    });
    $('hardPuffInput').addEventListener('input', () => {
      const v = Number($('hardPuffInput').value);
      if ($('sapError').textContent && (!Number.isFinite(v) || (v >= 2 && v <= 149.99))) $('sapError').textContent = '';
      debouncedGaugeMarks();
    });

    $('btnReadPressure').addEventListener(
      'click',
      guard(async () => {
        const r = await sendCommand('PV,0:0');
        const p = (r.value || '').split(',');
        $('pvMouth').textContent = p[0] ?? '?';
        $('pvAmbient').textContent = p[1] ?? '?';
        $('pvDiff').textContent = p[2] ?? '?';
        gaugeDelta(Number(p[2]));
      }),
    );

    $('btnReadJoy').addEventListener(
      'click',
      guard(async () => {
        await sendCommand('JV,0:0');
      }),
    );

    Object.entries(LIVE_STREAM_BUTTONS).forEach(([id, mode]) => {
      $(id).addEventListener(
        'click',
        guard(async () => {
          const next = $(id).getAttribute('aria-pressed') === 'true' ? '0' : mode;
          await setSimpleSetting('DM', next, 'debugModeVal', DEBUG_MODES);
          log(
            next === '0' ? 'Live view stopped.' : 'Live view streaming; readings update about ten times per second.',
            'log-info',
          );
        }),
      );
    });

    // Neutral reset and the full 6-step calibration live in services/settings-service.js
    // (bound via bindCalibration(guard)).

    // Soft/factory reset handlers live in services/device-ops.js (bound above).
    $('btnClearLog').addEventListener('click', () => {
      $('log').textContent = '';
    });
    // "Errors only" (support triage): one toggle isolates the session's
    // error lines from the RX echoes and info notes.
    const logFilterBtn = $('btnLogErrorsOnly');
    if (logFilterBtn) {
      logFilterBtn.addEventListener('click', () => {
        const on = logFilterBtn.getAttribute('aria-pressed') === 'true';
        logFilterBtn.setAttribute('aria-pressed', String(!on));
        $('log').classList.toggle('errors-only', !on);
      });
    }
    // The native share sheet doubles as the privacy confirm (the user picks
    // the destination app), so it must fire directly from the click — any
    // in-app dialog first burns transient activation and the sheet fails
    // with NotAllowedError on desktop. The in-app confirm is only shown for
    // the fallback paths (mailto/clipboard/download), which disclose without
    // an OS picker; shareLog invokes it lazily, after the sheet is skipped.
    $('btnShareLog').addEventListener('click', () => {
      const confirmFallback = () =>
        showConfirm(
          'Share log',
          'Share the session log via email/clipboard? It contains every command and reading from this session. Your device identifier is masked.',
        );
      void shareLog(confirmFallback);
    });
    $('btnDownloadLog').addEventListener('click', () => {
      downloadLogFile(buildLogFile());
    });
  }
});

// ---- Re-export surface ----
// Re-exports from the owning modules so tests import behavior, not plumbing.
// Attach/detach for simulated hardware is the named seam in
// serial/session.js (injectSerialPort/detachSerialPort); the test-only lock
// queries live in services/selftest.js. There is no app-wide test backdoor.
export { parseResponse, isDeviceDiagnosticLine } from './serial/protocol.js';
export { sendCommand, waitLine } from './serial/commands.js';
export { renderSafeFormatting } from './ui/formatting.js';
export { handleLine } from './serial/device.js';
export { setConnectedUI } from './ui/connection-ui.js';
export { lockSelfTestButtons, unlockSelfTestButtons } from './services/selftest.js';
export { disconnect } from './serial/connection.js';
export { fmtApiFloat };
