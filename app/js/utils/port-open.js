// Bounded serial-port open/close. macOS can wedge an OS-level open
// indefinitely after rapid open/close cycling (observed repeatedly on
// hardware — the same pathology that stalls the update wizard's restart
// step), and Web Serial provides no signal to cancel with, so every
// user-waited open needs a bound. A stalled open throws PortStallError;
// if the open resolves later, the port is released quietly so it cannot
// wedge the next attempt.

export const PORT_OPEN_TIMEOUT_MS = 10000;
export const PORT_CLOSE_TIMEOUT_MS = 5000;

/**
 * @param {any} port
 * @param {any} options
 * @param {number} [timeoutMs]
 * @param {string} [stallMessage] recovery guidance for the PortStallError
 */
export async function openPortBounded(port, options, timeoutMs = PORT_OPEN_TIMEOUT_MS, stallMessage) {
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
    // the next connect ("A call to open() is already in progress").
    opened.then(async (result) => {
      if (result !== 'open') return;
      try {
        await port.close();
      } catch {}
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
