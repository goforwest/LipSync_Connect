// Live diagnostic visualizations (DEBUG,<mode> streams): which panel is
// visible, the per-mode renderers, and the rAF-batched live-stream paints.
import { DIAG_PANELS, LIVE_STREAM_BUTTONS, LIVE_READ_BUTTONS } from '../config/constants.js';
import { timers } from '../utils/timers.js';
import { parsePoint } from '../utils/format.js';
import { $ } from '../ui/dom.js';
import { plotDot, toScreen, orientFromOutput, scheduleRenderPlot, plotState } from './plot.js';
import { gaugeDelta } from './gauge.js';
import { serialSession } from '../serial/session.js';

export function showDiagPanel(mode) {
  Object.entries(DIAG_PANELS).forEach(([m, id]) => {
    const el = $(id);
    if (el) el.hidden = String(mode) !== m;
  });
  // Keep the rolling technical log silent for AT always — announcements go
  // through #srStatus. Prevents 10 Hz debug streams from flooding screen readers.
  const logEl = $('log');
  if (logEl && logEl.setAttribute) logEl.setAttribute('aria-live', 'off');
  if (String(mode) === '0') syncLiveButtons('0');
}
export function syncLiveButtons(mode) {
  Object.entries(LIVE_STREAM_BUTTONS).forEach(([id, m]) => {
    const btn = $(id);
    if (!btn || !btn.setAttribute) return;
    const on = String(mode) === m;
    btn.textContent = on ? 'Stop live view' : 'Live view';
    btn.setAttribute('aria-pressed', String(on));
    const readBtn = $(LIVE_READ_BUTTONS[id]);
    if (readBtn) readBtn.disabled = on || !serialSession.port;
  });
}
function setDiagKeys(prefix, count, mask) {
  for (let i = 1; i <= count; i++) {
    const el = $(prefix + i);
    if (el && el.classList) el.classList.toggle('on', !!(mask & (1 << (i - 1))));
  }
}
// B-5 perf: batch high-frequency (~10 Hz) live-stream DOM updates onto the
// next animation frame instead of styling per serial line.
let pendingDiagDotRaw = null,
  pendingDiagDotOut = null,
  diagPaintScheduled = false;
function scheduleDiagPaint() {
  if (diagPaintScheduled) return;
  diagPaintScheduled = true;
  timers.afterFrame(() => {
    diagPaintScheduled = false;
    if (pendingDiagDotRaw) plotDot('diagDotRaw', pendingDiagDotRaw.x, pendingDiagDotRaw.y);
    if (pendingDiagDotOut) plotDot('diagDotOut', pendingDiagDotOut.x, pendingDiagDotOut.y);
  });
}
export function applyDebugData(mode, value) {
  if (mode === '1') {
    const p = (value || '').split(',');
    const raw = parsePoint(p[0]),
      out = parsePoint(p[2]);
    orientFromOutput(raw, out);
    if (raw) {
      $('joyRaw').textContent = raw.x + ' | ' + raw.y;
      $('diagJoyRaw').textContent = raw.x + ' | ' + raw.y;
      plotState.raw = raw;
      scheduleRenderPlot();
      pendingDiagDotRaw = toScreen(raw);
    }
    if (out) {
      $('joyOut').textContent = out.x + ' | ' + out.y;
      $('diagJoyOut').textContent = out.x + ' | ' + out.y;
      pendingDiagDotOut = { x: (out.x / 1024) * plotState.range, y: (-out.y / 1024) * plotState.range };
    }
    const diagPlotEl = $('diagPlot');
    if (diagPlotEl) {
      const r = raw ? `raw ${raw.x.toFixed(1)},${raw.y.toFixed(1)}` : 'no raw';
      const o = out ? `out ${out.x.toFixed(0)},${out.y.toFixed(0)}` : 'no out';
      diagPlotEl.setAttribute('aria-label', `Live joystick diagnostic plot: ${r}, ${o}.`);
    }
    scheduleDiagPaint();
  } else if (mode === '2') {
    const p = (value || '').split(',').map(Number);
    const fmt = (v) => (Number.isFinite(v) ? v.toFixed(2) : '?');
    $('pvMouth').textContent = fmt(p[0]);
    $('pvAmbient').textContent = fmt(p[1]);
    $('pvDiff').textContent = fmt(p[2]);
    $('diagPressMouth').textContent = fmt(p[0]);
    $('diagPressAmbient').textContent = fmt(p[1]);
    $('diagPressDiff').textContent = fmt(p[2]);
    gaugeDelta(p[2]);
    const diagGaugeEl = $('diagGauge');
    if (diagGaugeEl && Number.isFinite(p[2])) {
      diagGaugeEl.setAttribute(
        'aria-label',
        `Diagnostic pressure gauge: ${Math.abs(p[2]).toFixed(1)} hPa ${p[2] < 0 ? 'sip' : 'puff'}.`,
      );
    }
  } else if (mode === '3') {
    const p = (value || '').split(',').map(Number);
    setDiagKeys('diagBtn', 2, p[0] || 0);
    setDiagSubState('diagBtnTime', p);
  } else if (mode === '4') {
    const p = (value || '').split(',').map(Number);
    setDiagKeys('diagSw', 3, p[0] || 0);
    setDiagSubState('diagSwTime', p);
  } else if (mode === '5') {
    const p = (value || '').split(',').map(Number);
    const sip = $('diagSip'),
      puff = $('diagPuff');
    if (sip && sip.classList) sip.classList.toggle('on', p[0] === 1);
    if (puff && puff.classList) puff.classList.toggle('on', p[0] === 2);
    setDiagSubState('diagSapTime', p);
  }
}
// Firmware emits {mainState, subState, elapsedMs}; the middle field cycles
// 0 (waiting) / 1 (started) / 2 (released) — don't assume it's always 0.
function setDiagSubState(id, p) {
  const el = $(id);
  if (!el) return;
  const ms = Number.isFinite(p[2]) ? p[2] : 0;
  const sub = ['waiting', 'started', 'released'][p[1]] || null;
  el.textContent = ms + ' ms' + (sub ? ' · ' + sub : '');
}
