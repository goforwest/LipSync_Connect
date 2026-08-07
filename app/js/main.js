'use strict';

import { FEEDBACK_MODES, DEBUG_MODES, LIVE_STREAM_BUTTONS, HEADER_SCROLL_THRESHOLD } from './config/constants.js';
import { debounce, fmtApiFloat } from './utils/format.js';
import { $, $$ } from './ui/dom.js';
import { log } from './services/log.js';
import { buildLogFile, downloadLogFile, shareLog } from './services/log-export.js';
import { serialApi } from './serial/transport.js';
import { sendCommand } from './serial/commands.js';

import { gaugeDelta, recalcGaugeRange, gaugeMarks } from './plotting/gauge.js';

import { setValue } from './ui/values.js';
import { bindModeSwitch } from './services/mode-switch.js';
import { bindCalibration } from './services/calibration.js';
import { loadDeviceInfo } from './services/settings-service.js';

import { connect, disconnect } from './serial/connection.js';
import {
  readCalibration,
  setDeadzone,
  setSimpleSetting,
  requireNumber,
  clampInput,
  step,
} from './services/settings-service.js';
import { updateConnectionGating, hideGuide } from './ui/connection-ui.js';
import { showConfirm } from './ui/formatting.js';
import { openSectionById, closeCurrentSection, getOpenSection } from './ui/sections.js';
import { guard } from './ui/guard.js';
import { bindDeviceOps } from './services/device-ops.js';
import { bindHubRemote, resetHubRemote } from './services/hub-remote.js';
import { runDiagnostics } from './services/health.js';
import { initSettings } from './ui/theme.js';

// Gauge-mark updates on sip/puff input are debounced (100ms) — gauge.js owns
// the marks; this binding exists until those listeners move with the settings
// wiring extraction.
const debouncedGaugeMarks = debounce(gaugeMarks, 100);

// Re-export so tests reading these from app.js keep working during the migration.
export { VALUE_LABELS } from './config/constants.js';
export { $, $$ } from './ui/dom.js';
export { announceStatus } from './ui/a11y.js';

// ------------------------- Global error handler -------------------------
window.addEventListener('error', (e) => {
  console.error(e.error || e.message);
  const el = $('log');
  if (el) {
    const entry = document.createElement('div');
    entry.className = 'log-err';
    entry.textContent = 'Uncaught: ' + (e.error?.message ?? e.message ?? 'unknown error');
    el.appendChild(entry);
  }
});
window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  const el = $('log');
  if (el) {
    const entry = document.createElement('div');
    entry.className = 'log-err';
    entry.textContent = 'Unhandled promise: ' + (e.reason?.message ?? e.reason ?? 'unknown');
    el.appendChild(entry);
  }
});
// ------------------------- Serial layer -------------------------
// The physical link, waiters, and command queue are centralized in
// js/serial/session.js; app.js aliases the mutable fields it touches most so
// the diff of this extraction stays small and reviewable.

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

// ---- Visualization helpers ----// ---- Visualization helpers ----
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

// ---- Calibration step indicator ----// ---- Calibration step indicator ----

// Connect/disconnect/readLoop live in serial/connection.js; line dispatch
// (handleLine/applyDeviceResponse) live in serial/device.js.

// ENDPOINT_RENDERERS moved to serial/endpoints.js (registered into
// services/registry.js at import); getDeviceLoadTasks lives in
// services/settings-service.js.

// The initial settings load lives in services/settings-service.js.

// Section-card animations live in ui/sections.js.

// ------------------------- Startup configuration -------------------------
// Endpoint renderers populate the dispatch registry; connection + settings
// services get their cross-module hooks wired here (this ordering is why
// app.js remains the composition root).
import './serial/endpoints.js';
import { configureConnection } from './serial/connection.js';
import { configureSettingsListeners } from './services/settings-service.js';
import { clearHealthResults } from './services/health.js';
// Disconnect (and a fresh settings load) must clear stale health results AND
// the mirrored Hub screen — the device's menu dies with the port.
const clearSessionUi = () => {
  clearHealthResults();
  resetHubRemote();
};
configureConnection({ loadDeviceInfo, clearHealthResults: clearSessionUi });
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
  }

  circleTriggers.forEach((btn) => {
    btn.addEventListener('click', () => openSectionById(btn.dataset.section));
  });

  // Single Escape handler
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.querySelector('dialog[open]')) return;
    if (popup && popup.classList.contains('open')) {
      closePopup();
      return;
    }
    if (getOpenSection()) {
      e.preventDefault();
      closeCurrentSection();
    }
  });

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
    $('btnRunDiagnostics').addEventListener('click', guard(runDiagnostics));
    bindDeviceOps(guard);
    bindModeSwitch(guard);
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
    // Operating mode and Bluetooth flows live in services/mode-switch.js
    document
      .querySelectorAll('button[data-step]')
      .forEach((/** @type {any} */ b) =>
        b.addEventListener('click', () => step(b.dataset.target, parseInt(b.dataset.step, 10))),
      );

    $('btnSetSip').addEventListener(
      'click',
      guard(async () => {
        $('sapError').textContent = '';
        clampInput('sipInput', 2, 149.99, 'sipVal');
        try {
          const v = requireNumber('sipInput', 2, 149.99, 'Sip threshold');
          const r = await sendCommand('ST,1:' + fmtApiFloat(v));
          setValue('sipVal', r.value ?? v);
          recalcGaugeRange();
        } catch (e) {
          $('sapError').textContent = e.message;
          throw e;
        }
      }),
    );
    $('btnSetPuff').addEventListener(
      'click',
      guard(async () => {
        $('sapError').textContent = '';
        clampInput('puffInput', 2, 149.99, 'puffVal');
        try {
          const v = requireNumber('puffInput', 2, 149.99, 'Puff threshold');
          const r = await sendCommand('PT,1:' + fmtApiFloat(v));
          setValue('puffVal', r.value ?? v);
          recalcGaugeRange();
        } catch (e) {
          $('sapError').textContent = e.message;
          throw e;
        }
      }),
    );
    $('sipInput').addEventListener('blur', () => clampInput('sipInput', 2, 149.99, 'sipVal'));
    $('puffInput').addEventListener('blur', () => clampInput('puffInput', 2, 149.99, 'puffVal'));
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
      guard(async () => {
        try {
          await setDeadzone('inner');
        } catch (e) {
          $('formError').textContent = e.message;
          throw e;
        }
      }),
    );
    $('btnSetOuterDeadzone').addEventListener(
      'click',
      guard(async () => {
        try {
          await setDeadzone('outer');
        } catch (e) {
          $('formError').textContent = e.message;
          throw e;
        }
      }),
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

// ---- ESM migration export surface ----
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
