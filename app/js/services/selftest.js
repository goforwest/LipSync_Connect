// Device self-test (LED/buzzer) button lockout + live narration panel.
// Firmware's RT,1:<tab> narrates every step to Serial and ~5–30 s of async
// messages follow (LSTest.ino). While that narration is in flight the device
// is effectively busy: concurrent web commands add to the chatter, arrive
// mid-stream, and can get consumed out of order (observed on hardware:
// timeouts and one wedged "SETTINGSSETTINGS" desync after RT). Lock both test
// buttons until the firmware's terminal "Test Complete" line arrives or the
// safety timer expires, whichever comes first.
import {
  SELF_TEST_COMPLETE_DWELL_MS,
  SELF_TEST_PANEL_LINGER_MS,
  LED_STEPS,
  BUZZER_STEPS,
} from '../config/constants.js';
import { $ } from '../ui/dom.js';
import { announceStatus } from '../ui/a11y.js';
import { log } from './log.js';
import { serialSession } from '../serial/session.js';
import { prefersReducedMotion } from '../ui/motion.js';

let selfTestLock = 0; // timeout id, 0 = unlocked

export function lockSelfTestButtons() {
  clearTimeout(selfTestLock);
  $('btnTestLeds').disabled = true;
  $('btnTestBuzzer').disabled = true;
  // Hard fallback: never stay locked longer than the longest firmware test (~30 s)
  selfTestLock = setTimeout(unlockSelfTestButtons, 30000);
}
export function unlockSelfTestButtons() {
  clearTimeout(selfTestLock);
  selfTestLock = 0;
  if (!serialSession.port) return; // disconnected — keep everything disabled until reconnect
  $('btnTestLeds').disabled = false;
  $('btnTestBuzzer').disabled = false;
}
// Firmware emits its last narration line and the literal terminal line
// "Test Complete" effectively back-to-back, so without a dwell the buttons
// re-enable while the user is still watching the final bullet activate.
let selfTestUnlockPending = 0;
export function maybeUnlockSelfTest(line) {
  if (selfTestLock === 0 || selfTestUnlockPending) return;
  // Firmware's terminal line after any self-test is exactly "Test Complete"
  if (line.trim() === 'Test Complete') {
    log('Self-test sequence complete.', 'log-info');
    clearTimeout(selfTestLock);
    // While the narration panel is on screen the buttons must stay locked for
    // the panel's full linger window: unlocking on the shorter dwell let a
    // click land while the previous run's panel-close timer was still pending,
    // which then hid the panel and nulled the mode mid-run — the observed
    // "re-run with no narration". Both timers now expire together.
    const dwell = selfTestMode ? SELF_TEST_PANEL_LINGER_MS : SELF_TEST_COMPLETE_DWELL_MS;
    selfTestUnlockPending = setTimeout(() => {
      selfTestUnlockPending = 0;
      unlockSelfTestButtons();
    }, dwell);
  }
}

// Disconnect path (in disconnect()'s finally) must cancel both timers — the
// buttons stay disabled until reconnect, which unlockSelfTestButtons enforces
// by checking the port. Exposed as a single reset so the disconnect flow does
// not need to know which timeout id is which.
export function resetSelfTestLock() {
  clearTimeout(selfTestLock);
  selfTestLock = 0;
  clearTimeout(selfTestUnlockPending);
  selfTestUnlockPending = 0;
  clearTimeout(panelCloseTimer);
  panelCloseTimer = 0;
}

// Read-only accessor for tests (lock state is not visible from the DOM alone
// because the dwell intentionally keeps buttons disabled while state clears).
export function isSelfTestLocked() {
  return selfTestLock !== 0 || selfTestUnlockPending !== 0;
}

// ---- Live self-test narration panel ----
// Shows each narrated step as the firmware announces it (TEST_MODE_LED: ...,
// TEST_MODE_BUZZER: ...). aria-live line announces the active step for
// screen readers; the timeline renders the full sequence visually.
let selfTestMode = null; // 'led' | 'buzzer' | null
let selfTestStepIdx = -1;
let panelCloseTimer = 0; // pending hide of a completed panel; 0 = none

export function openSelfTestPanel(mode) {
  // A queued close from the previous run must never fire against this run —
  // it would hide the panel and null the mode mid-narration.
  clearTimeout(panelCloseTimer);
  panelCloseTimer = 0;
  selfTestMode = mode;
  selfTestStepIdx = -1;
  const panel = $('selfTestPanel');
  const list = $('selfTestSteps');
  const title = $('selfTestTitle');
  if (!panel || !list || !title) return;
  const steps = mode === 'led' ? LED_STEPS : BUZZER_STEPS;
  title.textContent = mode === 'led' ? 'LED test — live sequence' : 'Buzzer test — live sequence';
  list.innerHTML = '';
  for (const [, label, opts] of steps) {
    if (opts?.hidden) continue; // sequencing-only; never rendered
    const li = document.createElement('li');
    li.textContent = label;
    li.className = 'pending';
    list.appendChild(li);
  }
  panel.hidden = false;
  // Bring the panel into view so the user doesn't have to hunt for the live step feed
  // (and the test is meaningful precisely because the device is doing something on its
  // own — the screen is the only place the user can watch).
  panel.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
  announceStatus((mode === 'led' ? 'LED' : 'Buzzer') + ' test started. Live progress is now visible below.');
}
export function closeSelfTestPanel(completed) {
  const panel = $('selfTestPanel');
  if (!panel) return;
  clearTimeout(panelCloseTimer);
  panelCloseTimer = 0;
  if (completed) {
    // Let the user see the final state before it clears; the button unlock in
    // maybeUnlockSelfTest uses the same linger, so the progress list and the
    // lock release together and a click can never land in between.
    panelCloseTimer = setTimeout(() => {
      panelCloseTimer = 0;
      panel.hidden = true;
      selfTestMode = null;
      selfTestStepIdx = -1;
    }, SELF_TEST_PANEL_LINGER_MS);
  } else {
    panel.hidden = true;
    selfTestMode = null;
    selfTestStepIdx = -1;
  }
}
export function advanceSelfTest(line) {
  if (!selfTestMode) return;
  const steps = selfTestMode === 'led' ? LED_STEPS : BUZZER_STEPS;
  if (selfTestStepIdx + 1 >= steps.length) return;
  const nextIdx = selfTestStepIdx + 1;
  const [pattern, label, opts] = /** @type {any} */ (steps[nextIdx]);
  const stepPattern = /** @type {RegExp} */ (pattern);
  if (!stepPattern.test(line)) return; // narration arrived out of order; skip
  selfTestStepIdx = nextIdx;
  const items = $('selfTestSteps')?.children;
  if (!items) return;
  // `hidden: true` steps exist purely for sequencing — they track state but
  // never render. The DOM has one fewer <li> than there are steps, so the
  // boolean predicates below map via the same index boundary.
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle('done', i < selfTestStepIdx);
    items[i].classList.toggle('active', !opts?.hidden && i === selfTestStepIdx);
    items[i].classList.toggle('pending', i > selfTestStepIdx);
  }
  const live = $('selfTestLive');
  if (live && !opts?.hidden) live.textContent = label;
  log('Self-test step: ' + label, 'log-info');
}

/** Read-only accessor used by the gating tests. */
export function getSelfTestState() {
  return { mode: selfTestMode, step: selfTestStepIdx };
}
