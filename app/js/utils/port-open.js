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
export const PORT_CLOSE_TIMEOUT_MS = 5000;

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
export async function closePortBounded(port, timeoutMs = PORT_CLOSE_TIMEOUT_MS) {
  try {
    await Promise.race([port.close(), sleep(timeoutMs).then(() => 'stalled')]);
  } catch {}
}
