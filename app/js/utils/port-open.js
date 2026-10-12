// Bounded serial-port open/close. macOS can wedge an OS-level open
// indefinitely after rapid open/close cycling (observed repeatedly on
// hardware — the same pathology that stalls the update wizard's restart
// step), and Web Serial provides no signal to cancel with, so every
// user-waited open needs a bound. A stalled open throws PortStallError;
// if the open resolves later, the port is released quietly so it cannot
// wedge the next attempt — unless a newer port attempt has started in the
// meantime (checked via the session's portGeneration), in which case the
// late release is skipped: a zombie teardown must never close a port a
// newer attempt may have claimed, and the newer attempt's cleanup-retry
// recovers the held port safely.
import { portGeneration } from '../serial/session.js';
import { sleep } from './timers.js';

export const PORT_OPEN_TIMEOUT_MS = 10000;
// Real macOS closes can be slow, not just wedged: hardware sessions show a
// close right after a full settings load resolving anywhere in 5–20 s. A
// 5 s bound declared those healthy closes "stalled" and left the port open,
// poisoning every later flow ("The port is already open"). The bound exists
// to defeat the hang-forever wedged close — it must be generous, not tight.
export const PORT_CLOSE_TIMEOUT_MS = 20000;

let closeTimeoutMs = PORT_CLOSE_TIMEOUT_MS;

/** Test seam: shrink the close bound so wedged-close scenarios run fast. */
export function setPortCloseTimeoutForTests(ms) {
  closeTimeoutMs = ms;
}

/** The effective close bound (honors the test seam). */
export function getPortCloseTimeoutMs() {
  return closeTimeoutMs;
}

// True while an open() on a port is believed stuck at the OS level (the macOS
// wedged-port pathology: the open never settles within the page session —
// hardware showed it still pending after 16+ s, blocking every later attempt
// with "A call to open() is already in progress" for minutes). While set,
// in-progress errors are not waited out again — the wait proved futile.
// The flag lives here (not in the wizard) so it clears on EVERY settled open
// anywhere in the app — Connect's session open included — not only on the
// next touch-phase open: after the device re-enumerates (SR reboot, reset,
// replug), the stuck open is force-failed by the OS and any port operation
// settles again, proving the wedge gone. A stalled open (PortStallError)
// proves nothing either way and leaves the flag untouched.
let portOpenWedged = false;

/** @returns {boolean} */
export const isPortOpenWedged = () => portOpenWedged;

/** Flags the current port as OS-wedged (set after one legitimate wait on a
 *  stuck "already in progress" open; see the wizard's touch recovery). */
export const markPortOpenWedged = () => {
  portOpenWedged = true;
};

/**
 * @param {any} port
 * @param {any} options passed through to port.open()
 * @param {{timeoutMs?: number, stallMessage?: string, onLateOpen?: () => void}} [bounds]
 *   onLateOpen runs after a stalled-but-later-resolved open was released.
 */
export async function openPortBounded(port, options, bounds = {}) {
  const { timeoutMs = PORT_OPEN_TIMEOUT_MS, stallMessage, onLateOpen } = bounds;
  const gen = portGeneration.current;
  let openError = null;
  const opened = port.open(options).then(
    () => 'open',
    (e) => {
      openError = e;
      return 'failed';
    },
  );
  const winner = await Promise.race([opened, sleep(timeoutMs).then(() => 'stalled')]);
  if (winner === 'stalled') {
    // The open may still land later — release the port so it cannot block
    // the next connect ("A call to open() is already in progress"), but only
    // while no newer attempt has started.
    opened.then(async (result) => {
      if (result !== 'open') return;
      if (gen !== portGeneration.current) return;
      try {
        await port.close();
      } catch {}
      onLateOpen?.();
    });
    const e = new Error(
      stallMessage ?? 'The serial port did not respond. Unplug the LipSync, plug it back in, and click Connect again.',
    );
    e.name = 'PortStallError';
    throw e;
  }
  // Any settled outcome proves the port responds: success, or a real error
  // (NotFoundError and friends) — the wedge (if one was flagged) is gone.
  // Two exceptions leave the flag as it was: a stall took the early return
  // above, and "A call to open() is already in progress" is not a settled
  // answer about the port's health at all — it means an earlier open is
  // still pending, which IS the wedged state.
  if (openError) {
    if (!/already in progress/i.test(openError.message ?? '')) portOpenWedged = false;
    throw openError;
  }
  portOpenWedged = false;
}

/** Best-effort close with a bound: a wedged close never hangs the caller. */
export async function closePortBounded(port, timeoutMs = closeTimeoutMs) {
  try {
    await Promise.race([port.close(), sleep(timeoutMs).then(() => 'stalled')]);
  } catch {}
}

/**
 * Bounded close that reports its outcome: 'closed' | 'failed' (the close
 * threw) | 'stalled' (never settled within the bound). Recovery retries
 * need the outcome — a best-effort swallow would send them into a doomed
 * retry against a port nothing can actually free (observed on hardware: a
 * close stuck as "already in progress" makes every later open fail "The
 * port is already open").
 * @returns {Promise<{outcome: 'closed'|'failed'|'stalled', error: any}>}
 */
export async function closePortWithOutcome(port, timeoutMs = closeTimeoutMs) {
  let closeError = null;
  const closed = (async () => {
    try {
      await port.close();
      return 'closed';
    } catch (e) {
      closeError = e;
      return 'failed';
    }
  })();
  const outcome = await Promise.race([closed, sleep(timeoutMs).then(() => /** @type {'stalled'} */ ('stalled'))]);
  return { outcome, error: closeError };
}
