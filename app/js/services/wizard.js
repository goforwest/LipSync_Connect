// Guided setup wizard: the first-run flow a clinician with zero training can
// follow — connect, calibrate the joystick, set thresholds from practice,
// verify with a health check — one instruction at a time, advancing on
// observed device state (not on trust). It deliberately COMPOSES the
// existing machinery instead of reimplementing it: each step's action opens
// the section that owns the task and focuses its primary control; completion
// is detected from the same UI state the audit pins (connected readouts,
// calibration status, health summary). The panel lives in the Help card —
// where every first session starts.
import { $ } from '../ui/dom.js';
import { log } from './log.js';
import { connect } from '../serial/connection.js';
import { serialSession } from '../serial/session.js';
import { openSectionById, getOpenSection } from '../ui/sections.js';

// Step order and shape. `done` is a predicate over live UI state, polled
// while the wizard is open; `action` is the step's primary affordance.
const STEPS = [
  {
    id: 'connect',
    title: 'Connect',
    text: 'Click Connect and pick your LipSync from the browser dialog. Settings load in a few seconds.',
    actionLabel: 'Connect',
    action: () => void connect(),
    done: () =>
      !!serialSession.port &&
      ($('version')?.textContent || '').trim() !== '' &&
      ($('version')?.textContent || '').trim() !== '\u2014',
  },
  {
    id: 'calibrate',
    title: 'Calibrate',
    text: 'In the Joystick card, press Start full calibration and follow the Hub display prompts. This step finishes by itself.',
    actionLabel: 'Open the Joystick card',
    action: () => {
      openSectionById('sec-joystick');
      const btn = $('btnCalibrate');
      if (btn && typeof btn.focus === 'function') btn.focus();
    },
    done: () => /complete/i.test(String($('calStatus')?.textContent ?? '')),
  },
  {
    id: 'thresholds',
    title: 'Thresholds',
    // Auto-live starts the pressure stream when the card opens on an idle
    // device — "turn on Live view" would read as an instruction to press the
    // button, which toggles that auto-started stream OFF. Say what to check,
    // not what to press.
    text: 'In the Sip & Puff card: with the live pressure view running (it starts on its own; the Live view button turns it on if it is not), have the user sip and puff firmly a few times, then press Suggest thresholds and Apply both. Use the steppers to fine-tune, then come back to this panel in Help and press Next.',
    actionLabel: 'Open the Sip & Puff card',
    action: () => {
      openSectionById('sec-sip');
      const btn = $('btnLivePressure');
      if (btn && typeof btn.focus === 'function') btn.focus();
    },
    done: null, // Manual advance: thresholds are a judgment call, not a detectable state.
  },
  {
    id: 'verify',
    title: 'Verify',
    text: 'Run the health check in the Diagnostics card. A green summary means the device is ready to hand over.',
    actionLabel: 'Open the Diagnostics card',
    action: () => {
      openSectionById('sec-diagnostics');
      const btn = $('btnRunDiagnostics');
      if (btn && typeof btn.focus === 'function') btn.focus();
    },
    done: () => String($('healthSummary')?.textContent ?? '') === 'Passed',
  },
];

const POLL_MS = 500;
let active = false;
let stepIndex = 0;
let pollTimer = 0;

function renderStep() {
  const done = stepIndex >= STEPS.length;
  const list = document.querySelectorAll('.wiz-steps li');
  for (let i = 0; i < list.length; i++) {
    const li = list[i];
    if (li.classList) {
      li.classList.toggle('current', i === stepIndex);
      li.classList.toggle('done', i < stepIndex);
    }
  }
  const text = $('wizStepText');
  if (text)
    text.textContent = done
      ? 'Guided setup complete — the device is calibrated, configured, and verified. You can exit any time; every setting stays adjustable in its card.'
      : `Step ${stepIndex + 1} of ${STEPS.length} \u2014 ${STEPS[stepIndex].title}: ${STEPS[stepIndex].text}`;
  const actionBtn = $('wizAction');
  if (actionBtn) {
    actionBtn.textContent = done ? '' : (STEPS[stepIndex].actionLabel ?? '');
    actionBtn.hidden = done;
  }
  const next = $('wizNext');
  if (next) next.hidden = !(stepIndex < STEPS.length && STEPS[stepIndex].done === null);
}

function poll() {
  if (!active) return;
  if (stepIndex < STEPS.length && STEPS[stepIndex].done && STEPS[stepIndex].done()) {
    stepIndex++;
    renderStep();
    // The completed step's card took the user elsewhere — its own action
    // opened it, and the accordion keeps one card open, which collapsed the
    // Help card this panel lives in. Bring the wizard back with the next
    // instruction + action on screen the moment the step completes (only
    // when Help is not already the open card — openSectionById toggles).
    if (getOpenSection() !== 'sec-help') openSectionById('sec-help');
    if (stepIndex >= STEPS.length) finish();
  }
  pollTimer = setTimeout(poll, POLL_MS);
}

function finish() {
  clearTimeout(pollTimer);
  pollTimer = 0;
  log('Guided setup complete.', 'log-info');
}

/** Starts (or resumes) the wizard at the first incomplete step. */
export function startWizard() {
  active = true;
  const panel = $('wizardPanel');
  if (panel) panel.hidden = false;
  const start = $('btnStartWizard');
  if (start) start.hidden = true;
  // Resume semantics: re-evaluate from the top — a connected, calibrated
  // device skips straight to where reality says it is.
  stepIndex = 0;
  while (stepIndex < STEPS.length && STEPS[stepIndex].done && STEPS[stepIndex].done()) stepIndex++;
  renderStep();
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, POLL_MS);
}

/** Exits the wizard; the device keeps everything already done. */
export function exitWizard() {
  active = false;
  clearTimeout(pollTimer);
  pollTimer = 0;
  const panel = $('wizardPanel');
  if (panel) panel.hidden = true;
  const start = $('btnStartWizard');
  if (start) start.hidden = false;
}

export function isWizardActive() {
  return active;
}

/** Button wiring from main.js (composition root). */
export function bindWizard() {
  const start = $('btnStartWizard');
  if (start) {
    // Only reached on serial-capable browsers (main.js wires inside its
    // supported branch): the entry point comes alive for the very first
    // run — before any connection — because step 1 of the flow IS the
    // connect. Unsupported browsers never reach this, so the button
    // stays disabled and inert there.
    start.disabled = false;
    start.addEventListener('click', () => startWizard());
  }
  const action = $('wizAction');
  if (action)
    action.addEventListener('click', () => {
      if (active && stepIndex < STEPS.length && STEPS[stepIndex].action) STEPS[stepIndex].action();
    });
  const next = $('wizNext');
  if (next)
    next.addEventListener('click', () => {
      if (active && stepIndex < STEPS.length) {
        stepIndex++;
        renderStep();
        if (stepIndex >= STEPS.length) finish();
      }
    });
  const cancel = $('wizCancel');
  if (cancel) cancel.addEventListener('click', exitWizard);
}
