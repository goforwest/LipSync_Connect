// Connection-side UI chrome: status pill, connect guide, error banner with
// retry, per-card gating (dim/undim until connect), and the connect stage
// indicator. No serial code lives here — this module renders what
// serial/connection.js and services/settings-service.js tell it.
import { serialApi } from '../serial/transport.js';
import { serialSession } from '../serial/session.js';
import { $ } from './dom.js';

export function setStatus(text, connected) {
  const s = $('status');
  s.textContent = text;
  s.classList.toggle('connected', !!connected);
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
  document.querySelectorAll('button.cmd').forEach((/** @type {any} */ b) => (b.disabled = !enabled));
}

// Serial-dependent cards (everything except Help and Log) are visually dimmed
// until a device connects, but deliberately NOT made inert: an open card's
// status text (loading progress, current values) must remain readable by screen
// readers, and every interactive control inside is already disabled while
// disconnected. Help and Log stay fully interactive — a first-time user lands
// on Help and can read it and watch the log before ever connecting.
export function updateConnectionGating() {
  const gated = !serialSession.port;
  document.querySelectorAll('.section-card.needs-conn').forEach((el) => {
    el.classList.toggle('card-off', gated);
  });
  document.querySelectorAll('.circle-trigger[data-section]').forEach((/** @type {any} */ b) => {
    const keepsAccess = ['sec-help', 'sec-log'].includes(b.dataset.section);
    if (!keepsAccess) {
      b.classList.toggle('dimmed', gated);
      b.setAttribute('aria-disabled', String(gated));
      if (gated) b.title = 'Connect a LipSync device first';
      else b.removeAttribute('title');
    }
  });
}

import { syncModeBtn, updateBtStatus } from '../services/mode-switch.js';

export function setConnectedUI(connected) {
  $('btnConnect').disabled = connected;
  $('btnDisconnect').disabled = !connected;
  setCmdButtons(connected);
  // Don't claim "Connected" until the initial settings load actually finishes —
  // a disconnect or command timeout mid-load would otherwise leave the header
  // stuck on "Connected" with no port, which the enable-state didn't catch.
  setStatus(connected ? 'Loading…' : 'Not connected', connected);
  updateConnectionGating();
  if (!connected) {
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
