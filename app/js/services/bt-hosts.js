// Bluetooth host management (upstream #16, firmware 4.8.0+): the paired-host
// table that the LipSync exposes over the BT endpoint family.
//
// Storage model (mirrors the firmware exactly): the host table IS the device's
// bond directory — one file per bonded peer under /adafruit/bond_prph/<12-hex-
// MAC>, holding the host's keys and its GAP name. The app stores NOTHING new:
// this module adds no snapshot/restore keys and no settings-export values —
// the table exists only on a device that is actually bonded (and is rebuilt
// from the firmware on every load).
//
// Wire protocol (firmware response grammar [A-Z]{1,4}, comma + one digit):
//   read   SUCCESS,0:BT,0:<n>                       host count
//   read   SUCCESS,0:BT,0:<i>:<name>:<active>       host row i (MAC order)
//   switch SUCCESS,0:BT,1:<i>                       switch ack
//   forget SUCCESS,0:BT,2:<i>                       forget ack
//   pair   SUCCESS,0:BT,3:1                         advertising ready
//   push   MANUAL,0:BT,4:<count>                    list changed
//   push   MANUAL,0:BT,5:<activeRow>                active host changed
//
// Refusals: FAIL,3:BT,1:<i> / FAIL,3:BT,2:<i> (the deliberate-reset contract:
// a refused host switch never resets the device) plus named ERROR lines. The
// firmware re-validates every row index at execution time, so a stale index
// can only ever refuse or land on the right host — never on the wrong one.
//
// The parse shape for a count response and a row response is identical at the
// cmd level (both "BT,0"); they differ only in the value: a bare integer vs
// "i:name:active". This module and serial/device.js both branch on that.

import { sendCommand, deviceFirmwareAtLeast } from '../serial/commands.js';
import { serialSession } from '../serial/session.js';
import { log, noisyLineLog } from '../services/log.js';
import { $ } from '../ui/dom.js';

// The minimum firmware that owns the BT endpoint family + the MANUAL,0:BT,4/5
// pushes.
export const BT_HOSTS_MIN_FIRMWARE = [4, 8, 0];

// In-memory mirror of the host table. Row keys are 1-based enumeration indices
// in MAC order; 'count' holds the total number of bonds (the device's Hub page
// shows the MAC-lowest 4; the app mirrors that cap on the card).
/** @typedef {{ i: number, mac: string, name: string, active: number }} BtHostRow */
/** @type {{ count: number, rows: Record<number, BtHostRow> }} */
export const btHostTable = { count: 0, rows: {} };

/** Parse one host-row value ("<i>:<name>:<active>"). The wire name is already
 * sanitized by the firmware (',' ':' '/' -> '_'), so a value with a different
 * shape is corrupt — drop it (noisy log). */
export function parseHostRow(value) {
  const parts = String(value).split(':');
  if (parts.length !== 3) return null;
  const [idx, name, active] = parts;
  const i = Number(idx);
  if (!Number.isInteger(i) || i < 1) return null;
  // A row for a host whose name never cached at pair time arrives as its MAC;
  // keep the raw name for display and the MAC separately for stable identity.
  const macOk = /^[0-9A-F]{12}$/i.test(name);
  return { i, mac: macOk ? name.toUpperCase() : null, name: macOk ? null : name, active: Number(active) };
}

/** Apply a host count (the read answer or a MANUAL BT,4 push). Shrinking is
 * authoritative immediately (a forget — rows above the new count are gone);
 * growth just updates the total — rows arrive via loadBluetoothHostTable or
 * the poller's refetch. */
export function applyHostCount(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    noisyLineLog('BT,0 count not an integer: ' + value);
    return;
  }
  const oldCount = btHostTable.count;
  btHostTable.count = n;
  if (n !== oldCount) {
    // A forget renumbers: drop rows at or above the new count.
    for (const key of Object.keys(btHostTable.rows).map(Number)) {
      if (key > n) delete btHostTable.rows[key];
    }
    renderHostList();
    const row = $('btHostSummaryRow');
    const el = $('btHostSummary');
    if (row) row.hidden = n === 0;
    if (el) el.textContent = n === 1 ? '1 paired host' : `${n} paired hosts`;
  }
}

/** Apply one host row ("<i>:<name>:<active>"). Rows arrive in enumeration
 * order; the last one seen for each index wins. */
export function applyHostRow(value) {
  const row = parseHostRow(value);
  if (!row) {
    noisyLineLog('BT,0 row parse failed: ' + value);
    return;
  }
  btHostTable.rows[row.i] = row;
  renderHostList();
}

/** Apply a MANUAL push — a device-initiated list/active change (a physical
 * forget on the Hub, or a host connecting). cmd is "BT,4" (count) or "BT,5"
 * (active row); value is the bare integer. Same initiator contract as CH,5:
 * it cannot resolve a pending command waiter, but it keeps the visible mirror
 * in sync with what the user did on the device. */
export function applyBluetoothPush(cmd, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    noisyLineLog('BT push not an integer: ' + value);
    return;
  }
  if (cmd === 'BT,4') {
    applyHostCount(value);
  } else if (cmd === 'BT,5') {
    // Active row changed: clear every marker and set the new one. Row n may
    // not have arrived yet (a pair landed and the first connect raced the
    // refetch) — the poller's count-change refetch fills it in.
    for (const r of Object.values(btHostTable.rows)) r.active = 0;
    const row = btHostTable.rows[n];
    if (row) row.active = 1;
    renderHostList();
    if (n === 0) log('Disconnected from the Bluetooth host', 'log-info');
    else log(`Connected to Bluetooth host ${n}${row?.name ? ' (' + row.name + ')' : ''}`, 'log-info');
  }
}

/** Fetch the full host table from the firmware. Returns the rows in
 * enumeration order, or [] when the endpoint is unavailable (firmware <
 * 4.8.0) or the port is gone. */
export async function loadBluetoothHostTable() {
  if (!serialSession.port || !deviceFirmwareAtLeast(...BT_HOSTS_MIN_FIRMWARE)) return [];
  try {
    // sendCommand returns the ALREADY-PARSED response ({type, ok, cmd, value}).
    const countResp = await sendCommand('BT,0:0');
    const count = Number(countResp.value);
    if (!Number.isInteger(count) || count < 0) return [];
    btHostTable.rows = {};
    btHostTable.count = count;
    for (let i = 1; i <= count; i++) {
      const p = await sendCommand(`BT,0:${i}`);
      applyHostRow(p.value);
    }
    applyHostCount(String(count));
    return Object.keys(btHostTable.rows)
      .map(Number)
      .sort((a, b) => a - b)
      .map((i) => btHostTable.rows[i]);
  } catch (e) {
    noisyLineLog('BT host table load failed: ' + e.message);
    return [];
  }
}

/** Switch to host i (BT,1:<i>): the firmware disconnects the current host and
 * re-advertises; the target reconnects on its own schedule. Never resets
 * OM/CM — the deliberate-reset semantics are untouched. Throws with the
 * firmware's refusal context on FAIL. */
export async function switchBluetoothHost(i) {
  if (!serialSession.port || !deviceFirmwareAtLeast(...BT_HOSTS_MIN_FIRMWARE)) {
    throw new Error('Bluetooth host switching needs firmware ' + BT_HOSTS_MIN_FIRMWARE.join('.') + '+');
  }
  // sendCommand already throws a generic "Device rejected command." on a
  // FAIL line — translate it into the refusal the user can act on.
  let r;
  try {
    r = await sendCommand(`BT,1:${i}`);
  } catch (e) {
    if (/rejected/.test(e.message)) {
      throw new Error('The device refused the switch — it was busy or the host list changed. Try again.');
    }
    throw e;
  }
  const ack = Number(r.value);
  if (ack !== i) throw new Error('Switch ack ' + ack + ' does not match target ' + i);
  for (const row of Object.values(btHostTable.rows)) row.active = row.i === i ? 1 : 0;
  renderHostList();
  // The firmware pushes BT,5 on the connection transition; a manual refetch
  // keeps the card honest even if that push is missed.
  void refetchSoon();
  log(`Switched to Bluetooth host ${i}`, 'log-info');
  return r;
}

/** Forget (remove) one bonded host by row (BT,2:<i>). Forgetting the active
 * host disconnects it first; a refused forget is a FAIL, never a reset. */
export async function forgetBluetoothHost(i) {
  if (!serialSession.port || !deviceFirmwareAtLeast(...BT_HOSTS_MIN_FIRMWARE)) {
    throw new Error('Bluetooth host forgetting needs firmware ' + BT_HOSTS_MIN_FIRMWARE.join('.') + '+');
  }
  let r;
  try {
    r = await sendCommand(`BT,2:${i}`);
  } catch (e) {
    if (/rejected/.test(e.message)) {
      throw new Error('The device refused the forget — it was busy or the host list changed. Try again.');
    }
    throw e;
  }
  const ack = Number(r.value);
  if (ack !== i) throw new Error('Forget ack ' + ack + ' does not match target ' + i);
  // Forget renumbers every row at or above i: rebuild from the device (the
  // golden path) — the local touch below is only for the moment before the
  // refetch lands.
  for (const key of Object.keys(btHostTable.rows).map(Number)) {
    if (key >= i) delete btHostTable.rows[key];
  }
  btHostTable.count = Math.max(0, btHostTable.count - 1);
  renderHostList();
  void refetchSoon();
  log(`Forgot Bluetooth host ${i}`, 'log-info');
  return r;
}

/** Make sure the device is advertising so a NEW host can pair with it
 * (BT,3:1). Refuses while a host is connected — a new pairing needs
 * advertising, advertising needs no connection. */
export async function pairNewBluetoothHost() {
  if (!serialSession.port || !deviceFirmwareAtLeast(...BT_HOSTS_MIN_FIRMWARE)) {
    throw new Error('Pairing a new host needs firmware ' + BT_HOSTS_MIN_FIRMWARE.join('.') + '+');
  }
  let r;
  try {
    r = await sendCommand('BT,3:1');
  } catch (e) {
    if (/rejected/.test(e.message)) {
      throw new Error('Cannot pair now — a host is connected. Switch to the host you want or forget it first.');
    }
    throw e;
  }
  if (Number(r.value) !== 1) throw new Error('The device did not confirm advertising');
  log('Pairing is on — open Bluetooth settings on the new host and select the LipSync', 'log-info');
  return r;
}

/** Queue a single refetch shortly after a mutation so the card reflects the
 * device's renumbered truth (forget) even if the BT,4/5 push is missed. */
let refetchTimer = null;
function refetchSoon() {
  if (refetchTimer) return;
  refetchTimer = setTimeout(() => {
    refetchTimer = null;
    void loadBluetoothHostTable();
  }, 250);
}

// ---- UI ----

/** Render the card's host list (device cap: the lowest 4 by MAC, matching the
 * Hub page). The full table still exists in btHostTable for forget math. */
function renderHostList() {
  const listEl = $('btHostList');
  if (!listEl) return;
  listEl.innerHTML = '';
  const rows = Object.keys(btHostTable.rows)
    .map(Number)
    .sort((a, b) => a - b)
    .slice(0, 4)
    .map((i) => btHostTable.rows[i])
    .filter(Boolean);

  if (rows.length === 0) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = serialSession.port
      ? 'No paired hosts yet. Use “Pair new…” and add the LipSync from your computer’s Bluetooth settings.'
      : 'Connect to see the device’s paired Bluetooth hosts.';
    listEl.appendChild(p);
    return;
  }
  for (const row of rows) {
    const item = document.createElement('div');
    item.className = 'bt-host-row' + (row.active ? ' active' : '');
    item.setAttribute('role', 'listitem');

    const name = document.createElement('span');
    name.className = 'bt-host-name';
    name.textContent = (row.active ? '● ' : '') + (row.name || `paired (${row.mac})`);

    const status = document.createElement('span');
    status.className = 'bt-host-status';
    status.textContent = row.active ? 'connected' : '';
    status.setAttribute('aria-live', 'polite');

    item.appendChild(name);
    item.appendChild(status);

    if (!row.active) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'btn-small';
      sw.textContent = 'Switch';
      sw.addEventListener('click', async () => {
        sw.disabled = true;
        sw.textContent = 'Switching…';
        try {
          await switchBluetoothHost(row.i);
        } catch (e) {
          log(e.message, 'log-err');
        } finally {
          sw.disabled = false;
          sw.textContent = 'Switch';
        }
      });
      item.appendChild(sw);
    }

    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'btn-small';
    forget.textContent = 'Forget';
    forget.addEventListener('click', async () => {
      const label = row.name || row.mac;
      if (!confirm(`Forget ${label}? It is removed from the device and must pair again.`)) return;
      forget.disabled = true;
      forget.textContent = 'Forgetting…';
      try {
        await forgetBluetoothHost(row.i);
      } catch (e) {
        log(e.message, 'log-err');
      } finally {
        forget.disabled = false;
        forget.textContent = 'Forget';
      }
    });
    item.appendChild(forget);

    listEl.appendChild(item);
  }
}

/** Wire the card's Pair new / Forget all controls and do the first load.
 * Called once per connect (after the settings load identified the firmware).
 * Older firmware keeps the host list hidden — nothing to show, nothing to
 * send. */
export function bindBluetoothHosts() {
  const listEl = $('btHostList');
  const controls = $('btCardControls');
  const gated = !!(serialSession.port && deviceFirmwareAtLeast(...BT_HOSTS_MIN_FIRMWARE));
  if (listEl) listEl.hidden = !gated;
  if (controls) controls.hidden = !gated;
  if (!gated) return;

  bindBluetoothControls();
  void loadBluetoothHostTable();
}

function bindBluetoothControls() {
  const pairBtn = $('btPairNew');
  const forgetBtn = $('btForgetAll');
  if (pairBtn && !pairBtn.dataset.bound) {
    pairBtn.dataset.bound = '1';
    pairBtn.addEventListener('click', async () => {
      pairBtn.disabled = true;
      pairBtn.textContent = 'Pairing…';
      try {
        await pairNewBluetoothHost();
      } catch (e) {
        log(e.message, 'log-err');
      } finally {
        pairBtn.disabled = false;
        pairBtn.textContent = 'Pair new…';
      }
    });
  }
  if (forgetBtn && !forgetBtn.dataset.bound) {
    forgetBtn.dataset.bound = '1';
    forgetBtn.addEventListener('click', async () => {
      const n = btHostTable.count;
      if (n < 1) return;
      if (!confirm(`Forget all ${n} paired host${n === 1 ? '' : 's'} on this device? Each must pair again.`)) return;
      forgetBtn.disabled = true;
      forgetBtn.textContent = 'Forgetting…';
      try {
        // Highest row first: renumbering after each forget never mis-targets.
        for (let i = n; i >= 1; i--) await forgetBluetoothHost(i);
      } catch (e) {
        log(e.message, 'log-err');
      } finally {
        forgetBtn.disabled = false;
        forgetBtn.textContent = 'Forget all…';
      }
    });
  }
}

/** Session-scoped reset: drop the mirror and hide the UI so a stale table
 * never survives into a new session. */
export function resetBluetoothHostsUi() {
  btHostTable.count = 0;
  btHostTable.rows = {};
  const listEl = $('btHostList');
  if (listEl) {
    listEl.innerHTML = '';
    listEl.hidden = true;
  }
  const summaryRow = $('btHostSummaryRow');
  if (summaryRow) summaryRow.hidden = true;
  const controls = $('btCardControls');
  if (controls) controls.hidden = true;
}

/** Poll BT,0:0 once per second while a gated session is live and refetch the
 * rows whenever the count changes (a pair or forget elsewhere). The push
 * paths (BT,4/BT,5) make this a backstop, not the primary sync. */
export function startBtHostsPoller() {
  if (!serialSession.port || !deviceFirmwareAtLeast(...BT_HOSTS_MIN_FIRMWARE)) return;
  let lastCount = btHostTable.count;
  let inFlight = false;
  const tick = async () => {
    if (!serialSession.port || inFlight) return;
    inFlight = true;
    try {
      const r = await sendCommand('BT,0:0');
      if (r && r.ok) {
        const count = Number(r.value);
        if (count !== lastCount) {
          lastCount = count;
          await loadBluetoothHostTable();
          lastCount = btHostTable.count;
        }
      }
    } catch {
      // Port died mid-poll (an active host was forgotten and the link
      // dropped): the next session re-arms this poller; stay quiet.
    } finally {
      inFlight = false;
    }
  };
  tick();
  const timer = setInterval(tick, 1000);
  // Node test runs must not hang on the poller's interval.
  if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
}
