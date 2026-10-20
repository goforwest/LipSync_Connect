'use strict';

import {
  FEEDBACK_MODES,
  DEBUG_MODES,
  LIVE_STREAM_BUTTONS,
  HEADER_SCROLL_THRESHOLD,
  RESTRICTION_SETTINGS,
  WINDOW_SETTINGS,
  SWITCH_SETTINGS,
} from './config/constants.js';
import { debounce, fmtApiFloat, fmtHpa } from './utils/format.js';
import { $, $$ } from './ui/dom.js';
import { log } from './services/log.js';
import { announceStatus } from './ui/a11y.js';
import { buildLogFile, downloadLogFile, shareLog } from './services/log-export.js';
import { serialApi } from './serial/transport.js';
import { sendCommand } from './serial/commands.js';

import { gaugeDelta, recalcGaugeRange, gaugeMarks, resetPracticePeaks, suggestThresholds } from './plotting/gauge.js';
import { initWindowLadders } from './plotting/windows.js';

import { setValue } from './ui/values.js';
import { bindModeSwitch } from './services/mode-switch.js';
import { bindCalibration } from './services/calibration.js';
import { loadDeviceInfo } from './services/settings-service.js';

import { connect, disconnect } from './serial/connection.js';
import { serialSession } from './serial/session.js';
import {
  readCalibration,
  setDeadzone,
  setSimpleSetting,
  requireNumber,
  clampInput,
  step,
} from './services/settings-service.js';
import { updateConnectionGating, hideGuide, setCmdButtons } from './ui/connection-ui.js';
import { showConfirm } from './ui/formatting.js';
import { openSectionById, closeCurrentSection, getOpenSection, onSectionChange } from './ui/sections.js';
import { guard } from './ui/guard.js';
import { bindDeviceOps } from './services/device-ops.js';
import { bindHubRemote, resetHubRemote } from './services/hub-remote.js';
import { bindWriteConfirm, hideWriteConfirm } from './services/confirm.js';
import { updateReadiness } from './services/readiness.js';
import { bindProfiles } from './services/profiles.js';
import { bindWizard, exitWizard } from './services/wizard.js';
import { runDiagnostics } from './services/health.js';
import { exportSettings } from './services/settings-export.js';
import { afterDeviceLoad, bindFirmwareUpdate, resetFirmwareUpdateUi } from './services/firmware-update.js';
import { initSettings } from './ui/theme.js';
import {
  setRestriction,
  resetRestrictionsUi,
  setTimingWindow,
  populateSwitchActionSelects,
  resetSwitchActionsUi,
  setSwitchAction,
  resetSwitchActions,
} from './services/settings-service.js';

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

// announceStatus lives in ui/a11y.js (imported above).

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
import { configureSettingsListeners } from './services/settings-service.js';
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
  resetPracticePeaks(); // fresh session, fresh practice — no stale peaks
  hideHealthHistory(); // the stored trend stays; the row hides with the session
  hideWriteConfirm(); // a stale Undo must never point at a dead session
  updateReadiness(); // no port: the strip hides itself
  autoLiveMode = null; // the device's debug mode dies with the port
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
const syncAutoLive = (sectionId) => {
  const dm = String($('debugMode')?.value ?? '0');
  // If the stream we started was replaced or stopped elsewhere, it is no
  // longer ours to manage.
  if (autoLiveMode !== null && dm !== String(autoLiveMode)) autoLiveMode = null;
  if (autoLiveMode !== null) {
    const wantMode = sectionId ? AUTO_LIVE_SECTION_MODES[sectionId] : null;
    if (!wantMode || String(wantMode) !== String(autoLiveMode)) {
      const stopping = autoLiveMode;
      autoLiveMode = null;
      if (serialSession.port) {
        void setSimpleSetting('DM', '0', 'debugModeVal', DEBUG_MODES).catch(() => {
          void stopping; // a failed stop is retried by the next transition
        });
      }
    }
  }
  const wantMode = serialSession.port && sectionId ? AUTO_LIVE_SECTION_MODES[sectionId] : null;
  if (wantMode && autoLiveMode === null && dm === '0') {
    autoLiveMode = wantMode;
    void setSimpleSetting('DM', wantMode, 'debugModeVal', DEBUG_MODES)
      .then(() => log('Live view started for this section — Stop live view turns it off.', 'log-info'))
      .catch(() => {
        autoLiveMode = null; // never started: nothing to manage
      });
  }
};
onSectionChange(syncAutoLive);
// After a successful settings load: finish an in-flight firmware update
// (verify + restore settings) when one is pending, otherwise run the
// automatic update check. Fire-and-forget — nothing here may delay "ready".
const loadDeviceInfoThenCheckFirmware = async () => {
  await loadDeviceInfo();
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

  // --- Always-run initialization (nav, popup, service worker) ---
  // Circle navigation
  const circleTriggers = /** @type {NodeListOf<any>} */ (document.querySelectorAll('.circle-trigger'));
  // openSection state is owned by ui/sections.js; nav Reads it via getOpenSection().

  // --- Task-based entry (Help card's Common tasks) ---
  // Plain-language goals jump straight to the control that answers them —
  // the caregiver path for people who don't know the vocabulary. The
  // dimmed-guard case (not connected) already speaks via its own notice, so
  // the focus/pulse only run when the section actually opened.
  const TASK_TARGETS = {
    cursor: { section: 'sec-cursor', focus: 'button[data-target="speed"][data-step="1"]' },
    clicks: { section: 'sec-sip', focus: 'button[data-target="st"][data-step="1"]' },
    accidents: { section: 'sec-restrictions', focus: '#sapDisabled' },
    health: { section: 'sec-diagnostics', focus: '#btnRunDiagnostics' },
    update: { section: 'sec-firmware', focus: '#btnCheckUpdate' },
    switches: { section: 'sec-switches', focus: '#swSA0' },
  };
  document.querySelectorAll('.task-btn').forEach((/** @type {any} */ btn) => {
    btn.addEventListener('click', () => {
      const t = TASK_TARGETS[btn.dataset.task];
      if (!t) return;
      openSectionById(t.section);
      if (getOpenSection() !== t.section) return; // the dimmed guard spoke
      const target = document.querySelector(t.focus);
      if (target && typeof target.focus === 'function') {
        target.focus();
        target.classList.add('pulse-target');
        setTimeout(() => target.classList.remove('pulse-target'), 2400);
      }
    });
  });

  // Floating button toggles the appearance popup
  const gearBtn = $('btnSettings');
  const popup = $('appearancePopup');
  /** @type {() => void} */ let openPopup = () => {};
  /** @type {(restoreFocus?: boolean) => void} */ let closePopup = () => {};
  if (gearBtn && popup) {
    openPopup = () => {
      popup.style.display = '';
      popup.removeAttribute('aria-hidden');
      gearBtn.setAttribute('aria-expanded', 'true');
      popup.offsetHeight;
      requestAnimationFrame(() => {
        popup.classList.add('open');
        requestAnimationFrame(() => {
          const firstControl = /** @type {HTMLElement|null} */ (
            popup.querySelector('button, input, select, textarea, a[href]')
          );
          if (firstControl && typeof firstControl.focus === 'function') firstControl.focus({ preventScroll: true });
        });
      });
      gearBtn.classList.add('active');
    };
    closePopup = (restoreFocus = true) => {
      if ((restoreFocus || popup.contains(document.activeElement)) && typeof gearBtn.focus === 'function') {
        gearBtn.focus({ preventScroll: true });
      }
      popup.classList.remove('open');
      popup.style.display = 'none';
      popup.setAttribute('aria-hidden', 'true');
      gearBtn.setAttribute('aria-expanded', 'false');
      gearBtn.classList.remove('active');
    };
    popup.style.display = 'none';
    popup.setAttribute('aria-hidden', 'true');
    gearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = popup.classList.contains('open');
      if (isOpen) closePopup();
      else openPopup();
    });
    document.addEventListener('click', (e) => {
      if (popup.classList.contains('open') && !popup.contains(e.target) && e.target !== gearBtn) {
        closePopup(false);
      }
    });
    // Focus trap: while the popup is open, Tab cycles inside it instead of
    // escaping into the page behind (the popup is non-modal — outside clicks
    // close it, but keyboard users should not be stranded behind it).
    popup.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab' || !popup.classList.contains('open')) return;
      const focusables = /** @type {any[]} */ (
        popup
          .querySelectorAll('button, input, select, textarea, a[href]')
          .filter((el) => !el.disabled && el.getAttribute('aria-hidden') !== 'true')
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

  circleTriggers.forEach((btn) => {
    btn.addEventListener('click', () => openSectionById(btn.dataset.section));
  });

  // In-card close buttons (one per section header): mirror the nav toggle,
  // then hand focus back to the section's circle trigger — the card turns
  // inert as it closes, and focus left inside it would fall back to <body>.
  document.querySelectorAll('.card-close').forEach((/** @type {any} */ btn) => {
    btn.addEventListener('click', () => {
      const sectionId = btn.dataset.close;
      if (getOpenSection() === sectionId) closeCurrentSection();
      const trigger = /** @type {HTMLElement|null} */ (
        document.querySelector(`.circle-trigger[data-section="${sectionId}"]`)
      );
      // No preventScroll here: the card the user was reading is gone, so
      // scrolling back up with the trigger is the natural landing.
      if (trigger && typeof trigger.focus === 'function') trigger.focus();
    });
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
    if (popup && popup.classList.contains('open')) {
      closePopup();
      return;
    }
    if (getOpenSection()) {
      e.preventDefault();
      // A section with an active firmware wizard stays open — closing it would
      // hide the only surface showing update progress, and mid-update the
      // card is exempt from gating so it could not be reopened. A finished
      // panel may be dismissed.
      const openEl = document.getElementById(getOpenSection());
      const wizardState = openEl?.getAttribute('data-wizard');
      // 'failed' panels stay dismissible: everything they say is already in
      // the log, the panel is reopenable (the card is exempt from gating
      // while data-wizard is set), and stranding a keyboard user on a dead
      // panel is worse than letting them move on.
      if (wizardState && wizardState !== 'done' && wizardState !== 'failed') {
        announceStatus('The firmware update is still in progress — the Firmware section stays open.');
        return;
      }
      closeCurrentSection();
    }
  });

  // Clicking the guide's dim backdrop dismisses it — same as its Dismiss
  // button; there is nothing else to do behind the overlay while it is up.
  document.querySelector('.guide-backdrop')?.addEventListener('click', hideGuide);

  // Header scroll shadow
  const headerEl = $('appHeader');
  if (headerEl) {
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

  // Initialize collapsed section cards as inert
  document.querySelectorAll('.section-card').forEach((el) => {
    if (el.id !== 'sec-help') {
      el.setAttribute('inert', '');
      el.setAttribute('aria-hidden', 'true');
    }
    if (!['sec-help', 'sec-log'].includes(el.id)) el.classList.add('needs-conn');
  });
  openSectionById('sec-help');
  updateConnectionGating();
  initWindowLadders();

  // Service worker registration
  const canRegisterServiceWorker =
    'serviceWorker' in navigator && window.isSecureContext && ['http:', 'https:'].includes(window.location.protocol);
  if (canRegisterServiceWorker) {
    navigator.serviceWorker.register('./service-worker.js').catch((err) => {
      console.error('Service worker registration failed:', err);
      log('Service worker registration failed: ' + err.message, 'log-err');
    });
  }

  // --- Unsupported browser guard (only skips serial-dependent wiring) ---
  if (!serialApi) {
    $('unsupported').hidden = false;
    $('btnConnect').disabled = true;
  } else {
    if (!('serial' in navigator))
      log(
        'Web Serial unavailable; using the WebUSB fallback (Android). Connect the LipSync with a USB-C/OTG cable.',
        'log-info',
      );
    $('btnConnect').addEventListener('click', connect);
    $('btnGuideDismiss').addEventListener('click', hideGuide);
    $('btnDisconnect').addEventListener('click', disconnect);
    $('btnRefreshAll').addEventListener('click', guard(loadDeviceInfo));
    $('btnExportSettings').addEventListener('click', guard(exportSettings));
    $('btnRunDiagnostics').addEventListener('click', guard(runDiagnostics));
    bindDeviceOps(guard);
    bindWriteConfirm(); // the inline write-confirm chip's Undo button
    bindProfiles(); // named per-user settings profiles (Device card)
    bindWizard(); // the Help card's guided setup flow
    bindModeSwitch(guard, disconnect, setCmdButtons);
    bindCalibration(guard);
    $('btnSetDebug').addEventListener(
      'click',
      guard(async () => {
        const mode = $('debugMode').value;
        await setSimpleSetting('DM', mode, 'debugModeVal', DEBUG_MODES);
        log(`Live diagnostic output ${mode === '0' ? 'disabled' : 'set to ' + DEBUG_MODES[mode]}.`, 'log-info');
      }),
    );
    // Self-test LED/buzzer buttons and soft/factory reset live in services/device-ops.js
    // and are bound via bindDeviceOps(guard) below.

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
          clampInput('sipInput', 2, 149.99, 'sipVal');
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
          clampInput('puffInput', 2, 149.99, 'puffVal');
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
    $('sipInput').addEventListener('blur', () => clampInput('sipInput', 2, 149.99, 'sipVal'));
    $('puffInput').addEventListener('blur', () => clampInput('puffInput', 2, 149.99, 'puffVal'));

    // Practice peaks + suggest-from-practice: the peaks track in
    // plotting/gauge.js off every pressure frame; these three buttons are the
    // user-facing half. Suggest computes 65%-of-peak trigger values; Apply
    // writes both through the same SET path the manual buttons use (device
    // truth re-syncs the readouts and marks through the endpoint renderers).
    $('btnClearPeaks').addEventListener(
      'click',
      guard(() => {
        resetPracticePeaks();
        $('sapSuggestion').hidden = true;
        $('btnApplySuggested').hidden = true;
        $('btnDismissSuggestion').hidden = true;
        log('Practice peaks cleared.', 'log-info');
      }),
    );
    $('btnSuggestThresholds').addEventListener(
      'click',
      guard(() => {
        const s = suggestThresholds();
        if (!s.ready) return; // the button is hidden until ready; guard anyway
        $('sapSuggestionText').textContent =
          'Suggested: sip ' +
          fmtHpa(s.sip) +
          ' hPa, puff ' +
          fmtHpa(s.puff) +
          ' hPa \u2014 65% of the practice peaks. A deliberate hold crosses them; breathing noise should not.';
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
            log('Suggested thresholds applied (from practice peaks).', 'log-info');
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
      $(w.inputId).addEventListener('blur', () => clampInput(w.inputId, w.min, w.max, w.valueId));
    });
    $('innerDeadzone').addEventListener('blur', () => clampInput('innerDeadzone', 0.01, 1, 'innerDeadzoneVal'));
    $('outerDeadzone').addEventListener('blur', () => clampInput('outerDeadzone', 0.01, 1, 'outerDeadzoneVal'));
    $('sipInput').addEventListener('input', () => {
      const v = Number($('sipInput').value);
      if ($('sapError').textContent && (!Number.isFinite(v) || (v >= 2 && v <= 149.99))) $('sapError').textContent = '';
      debouncedGaugeMarks();
    });
    $('puffInput').addEventListener('input', () => {
      const v = Number($('puffInput').value);
      if ($('sapError').textContent && (!Number.isFinite(v) || (v >= 2 && v <= 149.99))) $('sapError').textContent = '';
      debouncedGaugeMarks();
    });
    $('innerDeadzone').addEventListener('input', () => {
      const v = Number($('innerDeadzone').value);
      if ($('formError').textContent && (!Number.isFinite(v) || (v >= 0.01 && v <= 1))) $('formError').textContent = '';
    });
    $('outerDeadzone').addEventListener('input', () => {
      const v = Number($('outerDeadzone').value);
      if ($('formError').textContent && (!Number.isFinite(v) || (v >= 0.01 && v <= 1))) $('formError').textContent = '';
    });
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
    $('btnSetSound').addEventListener(
      'click',
      guard(async () => {
        await setSimpleSetting('SM', $('soundMode').value, 'soundModeVal', FEEDBACK_MODES);
      }),
    );
    $('btnSetLight').addEventListener(
      'click',
      guard(async () => {
        await setSimpleSetting('LM', $('lightMode').value, 'lightModeVal', FEEDBACK_MODES);
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
            el.disabled = false;
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
export { parseResponse } from './serial/protocol.js';
export { sendCommand, waitLine } from './serial/commands.js';
export { renderSafeFormatting } from './ui/formatting.js';
export { handleLine } from './serial/device.js';
export { setConnectedUI } from './ui/connection-ui.js';
export { lockSelfTestButtons, unlockSelfTestButtons } from './services/selftest.js';
export { disconnect } from './serial/connection.js';
export { fmtApiFloat };
