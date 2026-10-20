// Input-window ladder: the Sip & Puff timing windows (short < long < max,
// firmware 4.4.0+) drawn as one proportional timeline — green / yellow / red
// zones matching the micro-LED's window colors next to the USB-C port, so the
// app and the device teach the same color language. Both instances (the
// Sip & Puff card and the Diagnostics sip & puff panel) carry a live sweep
// driven by the DEBUG,5 stream: the fill crosses each boundary exactly as
// the face LEDs fill (1 in short, 2 in long, 3 in very-long), and the zone
// highlight plus the "n of 3" aria carry the count for anyone who cannot
// rely on color. The Sip & Puff side is driven by its "Watch holds" button,
// the Diagnostics side by the live-stream dropdown — one picture, two doors.
import { WINDOW_SETTINGS } from '../config/constants.js';
import { $ } from '../ui/dom.js';

// Pre-4.4.0 firmware had fixed compiled-in action windows (0–1000 click,
// 1000–3000 drag/scroll, 3000–8000 menu/middle). Used as the boundary
// fallback whenever the WS/WL/WM readouts are not loaded (older firmware or
// mid-load), so sweeps and log lines never carry invented boundaries.
export const LEGACY_SAP_WINDOWS = [1000, 3000, 8000];

const INSTANCES = [
  { ladderId: 'winLadder', scaleId: 'winScale', sweep: true },
  { ladderId: 'winLadderDiag', scaleId: 'winScaleDiag', sweep: true },
];

const readWindowValues = () => WINDOW_SETTINGS.map((w) => Number(($(w.valueId)?.textContent || '').trim()));

const windowsLoaded = (vals) => vals.length === 3 && vals.every((v) => Number.isFinite(v) && v > 0);

const WAITING_ARIA = 'Input window timeline — waiting for the timing windows to load.';

// The static (no-hold) label both ladders share — the color legend the
// micro LED teaches, with the live boundary values.
const staticAria = (w1, w2, w3) =>
  `Input window timeline: short holds to ${w1} ms (green), long to ${w2} ms (yellow), very-long to ${w3} ms (red).`;

/** Configured [short, long, max] boundaries, or the legacy fixed ones. */
export function windowBoundaries() {
  const vals = readWindowValues();
  return windowsLoaded(vals) ? vals : LEGACY_SAP_WINDOWS;
}

/**
 * Builds the zone / sweep / scale children once per instance. Idempotent —
 * safe to call from more than one init path.
 */
export function initWindowLadders() {
  for (const inst of INSTANCES) {
    const ladder = $(inst.ladderId);
    if (!ladder) continue;
    // children (not childElementCount): the gating stub only exposes the array.
    if (!ladder.children?.length) {
      for (const cls of ['win-zone--short', 'win-zone--long', 'win-zone--max']) {
        const z = document.createElement('div');
        z.className = 'win-zone ' + cls;
        ladder.appendChild(z);
      }
      if (inst.sweep) {
        const s = document.createElement('div');
        s.className = 'win-sweep';
        ladder.appendChild(s);
      }
    }
    const scale = $(inst.scaleId);
    if (scale && !scale.children?.length) {
      for (let i = 0; i < 4; i++) scale.appendChild(document.createElement('span'));
    }
  }
  refreshWindowLadders();
}

/**
 * Re-derives every instance from the w1/w2/w3 readouts. Called whenever a
 * window value lands (applyTimingWindowValue) — that covers the initial
 * load, MANUAL pushes, explicit writes, and Refresh-all.
 */
export function refreshWindowLadders() {
  const vals = readWindowValues();
  const loaded = windowsLoaded(vals);
  for (const inst of INSTANCES) {
    const ladder = $(inst.ladderId);
    if (!ladder) continue;
    if (!loaded) {
      ladder.classList.add('win-ladder--empty');
      ladder.setAttribute('aria-label', WAITING_ARIA);
      continue;
    }
    ladder.classList.remove('win-ladder--empty');
    const [w1, w2, w3] = vals;
    // Zones are children 0–2 (the sweep, when present, is appended after).
    const pct = (v) => (Math.max(v, 0) / w3) * 100;
    const widths = [pct(w1), pct(w2 - w1), pct(w3 - w2)];
    for (let i = 0; i < 3; i++) {
      const z = ladder.children[i];
      if (z?.style) z.style.flexBasis = widths[i].toFixed(2) + '%';
    }
    ladder.setAttribute('aria-label', staticAria(w1, w2, w3));
    const scale = $(inst.scaleId);
    if (scale?.children?.length === 4) {
      const marks = [
        { text: '0 ms', left: '0%' },
        { text: String(w1), left: pct(w1).toFixed(2) + '%' },
        { text: String(w2), left: pct(w2).toFixed(2) + '%' },
        { text: w3 + ' ms', left: '100%' },
      ];
      // Indexed access, not .forEach: children is a live HTMLCollection in the
      // real DOM (no Array methods — forEach threw in the browser audit);
      // the index loop matches the zone styling above and the test stub both.
      for (let i = 0; i < 4; i++) {
        const span = scale.children[i];
        if (span) {
          span.textContent = marks[i].text;
          span.style.left = marks[i].left;
        }
      }
    }
  }
}

/**
 * Live hold progress on BOTH ladders (the DEBUG,5 stream): fills the sweep
 * proportional to the elapsed hold and highlights the zone it is in. The
 * Sip & Puff card's "Watch holds" button and the Diagnostics sip & puff
 * panel share the same two instances, so wherever the user watches from,
 * the picture is the same. `holding` false resets both to the static legend —
 * release frames and stream switches must not leave a stale fill behind.
 */
export function paintWindowSweep(elapsedMs, holding) {
  const vals = readWindowValues();
  const loaded = windowsLoaded(vals);
  const [w1, w2, w3] = loaded ? vals : LEGACY_SAP_WINDOWS;
  const ms = holding && Number.isFinite(elapsedMs) ? Math.max(elapsedMs, 0) : 0;
  const idx = ms <= 0 ? -1 : ms < w1 ? 0 : ms < w2 ? 1 : 2;
  const liveAria =
    ms > 0 ? `Hold at ${ms} ms — in the ${['short', 'long', 'very-long'][idx]} window (${idx + 1} of 3).` : null;
  for (const inst of INSTANCES) {
    const ladder = $(inst.ladderId);
    if (!ladder) continue;
    const sweep = ladder.children[3];
    if (sweep?.style) sweep.style.width = (Math.min(ms / w3, 1) * 100).toFixed(2) + '%';
    for (let i = 0; i < 3; i++) ladder.children[i]?.classList?.toggle?.('active', i === idx);
    // Resting state restores the static legend exactly — never a stale
    // "hold at" line, and never the legacy numbers over an unloaded bar.
    ladder.setAttribute('aria-label', liveAria ?? (loaded ? staticAria(w1, w2, w3) : WAITING_ARIA));
  }
}
