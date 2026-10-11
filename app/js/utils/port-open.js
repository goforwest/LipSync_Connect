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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (openError) throw openError;
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
