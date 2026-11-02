// Connection-side UI chrome: status pill, connect guide, error banner with
// retry, hardware-action availability, and the connect stage indicator. No
// serial code lives here — this module renders what
// serial/connection.js and services/settings-service.js tell it.
import { serialApi } from '../serial/transport.js';
import { $ } from './dom.js';
import { isSelfTestLocked } from '../services/selftest.js';

export function setStatus(text, connected) {
  const s = $('status');
  s.textContent = text;
  s.title = String(text);
  s.classList.toggle('connected', !!connected);
  const hero = $('homeHero');
  const home = $('sec-home');
  const title = $('homeStatusTitle');
  const detail = $('homeStatusText');
  const connection = $('homeConnection');
  const loading = !!connected && /loading|opening|choose/i.test(String(text));
  const homeState = connected ? (loading ? 'loading' : 'connected') : 'disconnected';
  if (hero) hero.dataset.state = homeState;
  if (home) home.dataset.state = homeState;
  if (title)
    title.textContent = connected
      ? loading
        ? 'Getting your LipSync ready…'
        : 'Your LipSync is connected'
      : 'Connect your LipSync';
  if (detail)
    detail.textContent = connected
      ? loading
        ? 'Loading the device settings. The controls will become available when this finishes.'
        : String(text).includes('failed') || String(text).includes('incomplete')
          ? 'Connected, but some settings need attention. Refresh the settings or check the log for details.'
          : 'Settings are synced. Changes made in the app are saved directly to the device.'
      : 'Connect the device by USB to load its settings, check its health, and make adjustments.';
  if (connection) connection.textContent = connected ? (loading ? 'Connecting…' : 'USB connected') : 'Not connected';
}

let connRetryHandler = null;
export function handleBeforeUnload(e) {
  e.preventDefault();
  e.returnValue = '';
}
export function showConnectionError(msg, retryFn) {
  const banner = $('connectionBanner');
  const msgEl = $('connBannerMsg');
  if (!banner || !msgEl) return;
  msgEl.textContent = msg;
  banner.hidden = false;
  const retryBtn = $('btnConnBannerRetry');
  if (retryBtn) {
    retryBtn.replaceWith(retryBtn.cloneNode(true));
    const freshRetry = $('btnConnBannerRetry');
    if (freshRetry) {
      if (connRetryHandler) freshRetry.removeEventListener('click', connRetryHandler);
      connRetryHandler = () => {
        hideConnectionBanner();
        if (retryFn) retryFn();
      };
      freshRetry.addEventListener('click', connRetryHandler);
    }
  }
  const dismissBtn = $('btnConnBannerDismiss');
  if (dismissBtn) {
    dismissBtn.replaceWith(dismissBtn.cloneNode(true));
    const freshDismiss = $('btnConnBannerDismiss');
    if (freshDismiss) {
      freshDismiss.addEventListener('click', hideConnectionBanner);
    }
  }
}
export function hideConnectionBanner() {
  const banner = $('connectionBanner');
  if (banner) banner.hidden = true;
}

export function showGuide() {
  const el = $('connectGuide');
  if (!el || !serialApi) return;
  el.hidden = false;
}
export function hideGuide() {
  const el = $('connectGuide');
  if (el) el.hidden = true;
}

export function setCmdButtons(enabled) {
  // Reconnect/load/calibration all re-enable every .cmd button. A self-test
  // scheduled its own delayed unlock ("Test Complete" + dwell), and blanking
  // that lockout here let a second RT command land mid-narration.
  const selfTestLocked = isSelfTestLocked();
  document.querySelectorAll('button.cmd').forEach((/** @type {any} */ b) => {
    const lockThis =
      selfTestLocked && (b.id === 'btnTestLeds' || b.id === 'btnTestBuzzer' || b.id === 'btnTestWatchdog');
    b.disabled = !enabled || lockThis;
  });
}

// Every page remains browsable while disconnected. Hardware actions are
// already represented by disabled `.cmd` controls; dimming or blocking an
// entire page hides instructions precisely when a person may need them. Keep
// this lifecycle hook so connect/disconnect callers have one stable seam and
// so stale gating classes from an older cached page are removed.
export function updateConnectionGating() {
  document.querySelectorAll('.section-card.needs-conn').forEach((el) => {
    el.classList.remove('card-off');
  });
  document.querySelectorAll('.section-tab[data-section]').forEach((/** @type {any} */ b) => {
    b.classList.remove('dimmed');
    b.removeAttribute('aria-disabled');
    b.removeAttribute('title');
  });
  document.querySelectorAll('.circle-trigger[data-group]').forEach((/** @type {any} */ b) => {
    b.classList.remove('dimmed');
    b.removeAttribute('aria-disabled');
    b.removeAttribute('title');
  });
}

import { syncModeBtn, updateBtStatus } from '../services/mode-switch.js';

// connect() disables the Connect button the instant it is pressed (the OS
// port picker and the settings load span that state), so a focused press
// drops to <body> long before setConnectedUI could hand focus anywhere.
// Record which of the two connection surfaces held focus. setConnectedUI
// resolves it in whichever direction the attempt ends: success focuses the
// now-relevant Disconnect, while a cancelled picker returns focus to the
// exact Connect button the keyboard user activated.
let connectPressedFrom = null;
export function noteConnectPressed() {
  const active = document.activeElement;
  const headerConnect = $('btnConnect');
  const homeConnect = $('btnHomeConnect');
  connectPressedFrom = active === headerConnect || active === homeConnect ? active : null;
}

export function setConnectedUI(connected) {
  const connectBtn = $('btnConnect');
  const disconnectBtn = $('btnDisconnect');
  const homeConnectBtn = $('btnHomeConnect');
  // Home owns the prominent connection action. Header Connect and Disconnect
  // are both quiet session controls, so neither competes with the page's next
  // step or resembles a destructive action.
  connectBtn.classList.add('secondary');
  disconnectBtn.classList.add('secondary');
  // The status pill already communicates the state. Once connected, keeping a
  // disabled Connect button beside Disconnect repeats the same information and
  // costs precious header space, especially at larger text sizes.
  connectBtn.hidden = connected;
  disconnectBtn.hidden = !connected;
  if (homeConnectBtn) {
    homeConnectBtn.hidden = connected;
    homeConnectBtn.disabled = connected;
  }
  // A focused button that just turned disabled drops focus to <body> — the
  // keyboard/AT user who pressed Connect (or Disconnect) is stranded with
  // nothing focused. Capture the holder first, flip the disabled states,
  // then hand focus to the sibling that just became the relevant action
  // (focusing a still-disabled button is a no-op, so enable first).
  const active = /** @type {HTMLElement|null} */ (document.activeElement ?? null);
  connectBtn.disabled = connected;
  disconnectBtn.disabled = !connected;
  if (connected) {
    if (
      (connectPressedFrom || active === connectBtn || active === homeConnectBtn) &&
      typeof disconnectBtn?.focus === 'function'
    ) {
      disconnectBtn.focus();
    }
    connectPressedFrom = null;
  } else if (connectPressedFrom || active === disconnectBtn) {
    const returnTarget = connectPressedFrom === homeConnectBtn ? homeConnectBtn : connectBtn;
    if (typeof returnTarget?.focus === 'function') returnTarget.focus();
    connectPressedFrom = null;
  }
  setCmdButtons(connected);
  // Don't claim "Connected" until the initial settings load actually finishes —
  // a disconnect or command timeout mid-load would otherwise leave the header
  // stuck on "Connected" with no port, which the enable-state didn't catch.
  setStatus(connected ? 'Loading…' : 'Not connected', connected);
  // Tab/breadcrumb state for when the app is backgrounded mid-session.
  document.title = connected ? 'LipSync Connect — Connected' : 'LipSync Connect';
  updateConnectionGating();
  if (!connected) {
    ['homeModel', 'homeVersion', 'homeMode'].forEach((id) => {
      const el = $(id);
      if (el) el.textContent = '—';
    });
    const homeProfile = $('homeProfile');
    if (homeProfile) homeProfile.textContent = 'Connect to check';
    syncModeBtn();
    updateBtStatus();
  }
}

// ---- Connect stage indicator ----
let connectStageToken = 0; // bumped every time we set/clear, so stale timers can't hide a fresh stage
export function setConnectStage(stage) {
  // stage: null hides; 'requesting' | 'opening' | 'loading' | 'ready' | 'failed'
  const el = $('connectStage');
  if (!el) return;
  connectStageToken++;
  if (!stage) {
    el.hidden = true;
    el.removeAttribute('data-stage');
    return;
  }
  el.hidden = false;
  el.setAttribute('data-stage', stage);
  const text =
    stage === 'requesting'
      ? 'Choose your LipSync device…'
      : stage === 'opening'
        ? 'Opening port…'
        : stage === 'loading'
          ? 'Loading settings…'
          : stage === 'ready'
            ? 'Connected'
            : stage === 'failed'
              ? 'Connection failed'
              : '';
  el.textContent = text;
}
// Auto-hide transient terminal stages; safe against racing with a new attempt
export function setConnectStageAutoHide(stage, ms) {
  setConnectStage(stage);
  const token = connectStageToken;
  setTimeout(() => {
    if (token === connectStageToken) setConnectStage(null);
  }, ms);
}
