// Joystick plot geometry and rendering. plotState is the single source of
// truth for the calibration scatter plot; everything here only mutates it or
// the corresponding dot/ring DOM nodes.
import { PLOT_BASE_EXTENT, CORNER_SIGNS } from '../config/constants.js';
import { timers } from '../utils/timers.js';
import { parsePoint } from '../utils/format.js';
import { $ } from '../ui/dom.js';

export const plotState = Object.seal({
  raw: null,
  neutral: null,
  corners: { 1: null, 2: null, 3: null, 4: null },
  orient: { x: 1, y: 1 },
  orientLive: { x: false, y: false },
  range: PLOT_BASE_EXTENT,
  innerDz: null,
  outerDz: null,
});

export function plotDot(id, x, y) {
  const el = $(id);
  if (!el || !el.style || !Number.isFinite(x) || !Number.isFinite(y)) return;
  el.hidden = false;
  const range = plotState.range;
  el.style.left = Math.max(2, Math.min(98, ((x + range) / (2 * range)) * 100)) + '%';
  el.style.top = Math.max(2, Math.min(98, ((range - y) / (2 * range)) * 100)) + '%';
}
function plotCenter() {
  if (plotState.neutral) return plotState.neutral;
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    count = 0;
  for (let i = 1; i <= 4; i++) {
    const p = plotState.corners[i];
    if (p) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
      count++;
    }
  }
  if (count >= 2) return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  return null;
}
export function toScreen(point) {
  const c = plotCenter() || { x: 0, y: 0 };
  return { x: (point.x - c.x) * plotState.orient.x, y: (point.y - c.y) * plotState.orient.y };
}
function inputRadius() {
  let radius = null;
  const c = plotCenter() || { x: 0, y: 0 };
  for (let i = 1; i <= 4; i++) {
    const p = plotState.corners[i];
    if (!p) continue;
    const r = Math.hypot(p.x - c.x, p.y - c.y) / Math.SQRT2;
    if (r > 0 && (radius === null || r < radius)) radius = r;
  }
  return radius ?? PLOT_BASE_EXTENT;
}
function updatePlotOrientation() {
  let voteX = 0,
    voteY = 0;
  const c = plotCenter() || { x: 0, y: 0 };
  for (let i = 1; i <= 4; i++) {
    const p = plotState.corners[i];
    if (!p) continue;
    voteX += CORNER_SIGNS[i][0] * Math.sign(p.x - c.x);
    voteY += CORNER_SIGNS[i][1] * Math.sign(p.y - c.y);
  }
  if (!plotState.orientLive.x && voteX !== 0) plotState.orient.x = voteX < 0 ? -1 : 1;
  if (!plotState.orientLive.y && voteY !== 0) plotState.orient.y = voteY < 0 ? -1 : 1;
}
export function orientFromOutput(raw, out) {
  if (!raw || !out) return;
  const c = plotState.neutral || { x: 0, y: 0 };
  if (!plotState.orientLive.x && Math.abs(out.x) > 100 && Math.abs(raw.x - c.x) > 0.5) {
    const s = Math.sign(out.x) * Math.sign(raw.x - c.x);
    if (s) {
      plotState.orient.x = s;
      plotState.orientLive.x = true;
    }
  }
  if (!plotState.orientLive.y && Math.abs(out.y) > 100 && Math.abs(raw.y - c.y) > 0.5) {
    const s = -Math.sign(out.y) * Math.sign(raw.y - c.y);
    if (s) {
      plotState.orient.y = s;
      plotState.orientLive.y = true;
    }
  }
}
function updatePlotRange() {
  let extent = PLOT_BASE_EXTENT;
  for (let i = 1; i <= 4; i++) {
    const p = plotState.corners[i];
    if (p) {
      const s = toScreen(p);
      extent = Math.max(extent, Math.abs(s.x), Math.abs(s.y));
    }
  }
  plotState.range = extent * 1.15;
}
function drawRing(id, fraction) {
  const el = $(id);
  const f = Number(fraction);
  if (!el || !el.style || !Number.isFinite(f) || f <= 0) return;
  el.hidden = false;
  const size = ((f * inputRadius()) / plotState.range) * 100;
  el.style.width = size + '%';
  el.style.height = size + '%';
}
// B-5 perf: coalesce redraws onto the animation frame to avoid style thrash
// when live debug streams fire at ~10 Hz.
let renderPlotScheduled = false;
export function scheduleRenderPlot() {
  if (renderPlotScheduled) return;
  renderPlotScheduled = true;
  timers.afterFrame(() => {
    renderPlotScheduled = false;
    renderPlot();
  });
}
export function renderPlot() {
  updatePlotOrientation();
  updatePlotRange();
  if (plotState.innerDz !== null) drawRing('ringInner', plotState.innerDz);
  if (plotState.outerDz !== null) drawRing('ringOuter', plotState.outerDz);
  for (let i = 1; i <= 4; i++) {
    const el = $('dotC' + i);
    if (plotState.corners[i]) {
      const s = toScreen(plotState.corners[i]);
      plotDot('dotC' + i, s.x, s.y);
    } else if (el && el.classList && el.classList.contains && el.classList.contains('pending'))
      plotDot('dotC' + i, CORNER_SIGNS[i][0] * inputRadius(), CORNER_SIGNS[i][1] * inputRadius());
  }
  if (plotState.neutral) plotDot('dotN', 0, 0);
  if (plotState.raw) {
    const s = toScreen(plotState.raw);
    plotDot('dotRaw', s.x, s.y);
  }
  const plotEl = $('mainPlot');
  if (plotEl) {
    const raw = plotState.raw;
    const rawLabel = raw ? `raw at ${raw.x.toFixed(1)}, ${raw.y.toFixed(1)}` : 'no raw position';
    const neutralLabel = plotState.neutral
      ? `neutral at ${plotState.neutral.x.toFixed(1)}, ${plotState.neutral.y.toFixed(1)}`
      : 'no neutral set';
    const dzLabel =
      plotState.innerDz !== null || plotState.outerDz !== null
        ? `deadzones (inner ${plotState.innerDz ?? '?'}, outer ${plotState.outerDz ?? '?'})`
        : 'no deadzones set';
    let cornersLabel = '';
    for (let i = 1; i <= 4; i++) {
      const dot = $('dotC' + i);
      const isPending = dot && typeof dot.classList.contains === 'function' && dot.classList.contains('pending');
      const status = plotState.corners[i] ? 'stored' : isPending ? 'pending' : 'empty';
      cornersLabel += ` corner ${i} ${status},`;
    }
    plotEl.setAttribute('aria-label', `Joystick X-Y plot: ${rawLabel}, ${neutralLabel}, ${dzLabel}.${cornersLabel}`);
  }
}
export function plotRawXY(x, y) {
  if (Number.isFinite(x) && Number.isFinite(y)) {
    plotState.raw = { x, y };
    scheduleRenderPlot();
  }
}
export function plotNeutral(pair) {
  const p = parsePoint(pair);
  if (p) {
    plotState.neutral = p;
    renderPlot();
  }
}
export function plotCorner(index, pair) {
  const p = parsePoint(pair);
  if (p) {
    plotState.corners[index] = p;
    renderPlot();
  }
}
export function plotRing(id, fraction) {
  if (id === 'ringInner') plotState.innerDz = Number(fraction);
  if (id === 'ringOuter') plotState.outerDz = Number(fraction);
  renderPlot();
}
export function cornerState(index, state) {
  const el = $('dotC' + index);
  if (!el) return;
  el.classList.remove('pending');
  el.classList.remove('captured');
  if (state) {
    el.classList.add(state);
    el.setAttribute('aria-label', `Corner ${index} ${state}`);
    if (state === 'pending' && !plotState.corners[index] && CORNER_SIGNS[index])
      plotDot('dotC' + index, CORNER_SIGNS[index][0] * inputRadius(), CORNER_SIGNS[index][1] * inputRadius());
  } else {
    el.removeAttribute('aria-label');
  }
}
export function resetPlotState() {
  plotState.raw = null;
  plotState.neutral = null;
  plotState.corners = { 1: null, 2: null, 3: null, 4: null };
  plotState.orient = { x: 1, y: 1 };
  plotState.orientLive = { x: false, y: false };
  plotState.range = PLOT_BASE_EXTENT;
  plotState.innerDz = null;
  plotState.outerDz = null;
  ['dotRaw', 'dotN', 'dotC1', 'dotC2', 'dotC3', 'dotC4', 'ringInner', 'ringOuter'].forEach((id) => {
    const el = $(id);
    if (el) el.hidden = true;
  });
}
