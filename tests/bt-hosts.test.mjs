// Behavioral verification of services/bt-hosts.js (upstream #16, firmware
// 4.8.0+): the host-table mirror follows the BT,0 read answers and the
// MANUAL,0:BT,4/BT,5 pushes; switch/forget validate their acks against the
// target row and never act on a mismatched ack; refusals surface as errors
// and leave the table untouched. The count-vs-row discrimination lives in
// serial/device.js and is exercised through handleLine, not re-implemented.
//
// Wire note: the row value is "<i>:<name>:<active>" — the MAC is NOT on the
// wire. A row whose bond never cached a name carries the 12-hex MAC AS its
// name; parseHostRow recognizes that shape and records it as `mac`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';
import { createDeviceSimulator } from './harness/firmware-sim.mjs';

const { els } = installGatingDom();
const app = await import('../app/js/main.js');
const bt = await import('../app/js/services/bt-hosts.js');
const { noteDeviceVersion, resetWireNewlineFraming } = await import('../app/js/serial/commands.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const identify = (version) => {
  resetWireNewlineFraming();
  noteDeviceVersion(version ?? 'unknown');
};

// A 4.8.0 device answering SETTINGS + the BT family. rows are [name, active]
// pairs in enumeration order (row i = index+1); a 12-hex "name" means the
// bond never cached the host's GAP name.
function firmware48(rows) {
  return (text) => {
    if (text === 'SETTINGS') return [{ delay: 2, line: 'SUCCESS,0:SETTINGS' }];
    if (text === 'BT,0:0') return [{ delay: 2, line: `SUCCESS,0:BT,0:${rows.length}` }];
    const m = text.match(/^BT,0:(\d+)$/);
    if (m) {
      const i = Number(m[1]);
      const row = rows[i - 1];
      if (!row) return [{ delay: 2, line: 'FAIL,3:BT,0' }];
      return [{ delay: 2, line: `SUCCESS,0:BT,0:${i}:${row[0]}:${row[1]}` }];
    }
    // BT,1:<i> / BT,2:<i> / BT,3:1 echo the target back.
    return [{ delay: 2, line: `SUCCESS,0:${text}` }];
  };
}

test('host rows parse, land in the table, and renumber on a count shrink', async () => {
  identify('4.8.0');
  bt.resetBluetoothHostsUi();
  // Through the app's own line dispatcher — the count/row split lives there.
  app.handleLine('SUCCESS,0:BT,0:2');
  app.handleLine('SUCCESS,0:BT,0:1:AABBCCDDEEFF:1');
  app.handleLine('SUCCESS,0:BT,0:2:112233445566:0');
  assert.equal(bt.btHostTable.count, 2);
  assert.equal(bt.btHostTable.rows[1].mac, 'AABBCCDDEEFF'); // MAC-as-name captured
  assert.equal(bt.btHostTable.rows[1].name, null);
  assert.equal(bt.btHostTable.rows[1].active, 1);
  assert.equal(bt.btHostTable.rows[2].mac, '112233445566');
  assert.equal(bt.btHostTable.rows[2].active, 0);

  // A forget on the device pushes the new count: rows above it are gone.
  app.handleLine('MANUAL,0:BT,4:1');
  assert.equal(bt.btHostTable.count, 1);
  assert.equal(bt.btHostTable.rows[2], undefined);
  assert.equal(bt.btHostTable.rows[1].mac, 'AABBCCDDEEFF');
});

test('named rows carry the sanitized wire name; corrupt shapes are dropped', async () => {
  identify('4.8.0');
  bt.resetBluetoothHostsUi();
  app.handleLine('SUCCESS,0:BT,0:2');
  app.handleLine('SUCCESS,0:BT,0:1:DEADBEEF1234:0');
  app.handleLine('SUCCESS,0:BT,0:2:Hamoudi_s iPhone:0');
  assert.equal(bt.btHostTable.rows[2].name, 'Hamoudi_s iPhone'); // ':' sanitized by the firmware
  assert.equal(bt.btHostTable.rows[2].mac, null); // a named row has no MAC on the wire
  assert.equal(bt.btHostTable.rows[1].mac, 'DEADBEEF1234'); // 12-hex name = MAC-as-name

  // Garbage rows never poison the table.
  const before = JSON.stringify(bt.btHostTable.rows);
  app.handleLine('SUCCESS,0:BT,0:3:only-two-parts');
  app.handleLine('SUCCESS,0:BT,0:x:name:1');
  assert.equal(JSON.stringify(bt.btHostTable.rows), before);
  assert.equal(bt.btHostTable.count, 2); // the garbage "3:" count never lands either
});

test('BT,5 push moves the active marker; row 0 clears it', async () => {
  identify('4.8.0');
  bt.resetBluetoothHostsUi();
  app.handleLine('SUCCESS,0:BT,0:2');
  app.handleLine('SUCCESS,0:BT,0:1:AABBCCDDEEFF:0');
  app.handleLine('SUCCESS,0:BT,0:2:112233445566:0');
  app.handleLine('MANUAL,0:BT,5:2');
  assert.equal(bt.btHostTable.rows[2].active, 1);
  assert.equal(bt.btHostTable.rows[1].active, 0);
  app.handleLine('MANUAL,0:BT,5:0');
  assert.equal(bt.btHostTable.rows[2].active, 0);
});

test('switch validates the ack against the target row', async () => {
  identify('4.8.0');
  bt.resetBluetoothHostsUi();
  // A device that acks BT,1:2 with a DIFFERENT row number is lying — refuse.
  const dev = createDeviceSimulator({ handleLine: app.handleLine }).attachDevice((text) => {
    if (text === 'SETTINGS') return [{ delay: 2, line: 'SUCCESS,0:SETTINGS' }];
    if (text === 'BT,1:2') return [{ delay: 2, line: 'SUCCESS,0:BT,1:1' }];
    return firmware48([
      ['AABBCCDDEEFF', 1],
      ['112233445566', 0],
    ])(text);
  });
  try {
    const loaded = await bt.loadBluetoothHostTable();
    assert.equal(loaded.length, 2);
    await assert.rejects(() => bt.switchBluetoothHost(2), /confirmed switching to the wrong host/);
    assert.equal(bt.btHostTable.rows[2].active, 0); // no marker moved on a bad ack
  } finally {
    dev.detach();
  }
});

test('switch on a good ack moves the active marker and refetches', async () => {
  identify('4.8.0');
  bt.resetBluetoothHostsUi();
  let switched = 0;
  const dev = createDeviceSimulator({ handleLine: app.handleLine }).attachDevice((text) => {
    if (text === 'BT,1:2') {
      switched = 1;
      return [{ delay: 2, line: 'SUCCESS,0:BT,1:2' }];
    }
    return firmware48(
      switched === 0
        ? [
            ['AABBCCDDEEFF', 1],
            ['112233445566', 0],
          ]
        : [
            ['AABBCCDDEEFF', 0],
            ['112233445566', 1],
          ],
    )(text);
  });
  try {
    await bt.loadBluetoothHostTable();
    await bt.switchBluetoothHost(2);
    assert.equal(bt.btHostTable.rows[2].active, 1); // optimistic marker
    assert.equal(bt.btHostTable.rows[1].active, 0);
    await sleep(400); // the queued refetch confirms from device truth
    assert.equal(bt.btHostTable.rows[2].active, 1);
    assert.equal(bt.btHostTable.rows[1].active, 0);
  } finally {
    dev.detach();
  }
});

test('forget removes the row and the refetch follows the renumbered device', async () => {
  identify('4.8.0');
  bt.resetBluetoothHostsUi();
  let forgot = 0;
  const dev = createDeviceSimulator({ handleLine: app.handleLine }).attachDevice((text) => {
    if (text === 'BT,2:1') {
      forgot = 1;
      return [{ delay: 2, line: 'SUCCESS,0:BT,2:1' }];
    }
    return firmware48(forgot === 0 ? [['AABBCCDDEEFF', 1], ['112233445566', 0]] : [['112233445566', 1]])(text);
  });
  try {
    await bt.loadBluetoothHostTable();
    assert.equal(bt.btHostTable.count, 2);
    await bt.forgetBluetoothHost(1);
    assert.equal(bt.btHostTable.count, 1); // local touch: row 1 dropped, count shrunk
    await sleep(400); // the queued refetch lands with the device's renumbered list
    assert.equal(bt.btHostTable.count, 1);
    assert.equal(bt.btHostTable.rows[1].mac, '112233445566');
    assert.equal(bt.btHostTable.rows[2], undefined);
  } finally {
    dev.detach();
  }
});

test('refusals surface as errors and never mutate the table', async () => {
  identify('4.8.0');
  bt.resetBluetoothHostsUi();
  const dev = createDeviceSimulator({ handleLine: app.handleLine }).attachDevice((text) => {
    if (text === 'SETTINGS') return [{ delay: 2, line: 'SUCCESS,0:SETTINGS' }];
    if (text === 'BT,1:2') return [{ delay: 2, line: 'FAIL,3:BT,1:2' }];
    return firmware48([['AABBCCDDEEFF', 1]])(text);
  });
  try {
    await bt.loadBluetoothHostTable();
    const snapshot = JSON.stringify({ c: bt.btHostTable.count, r: bt.btHostTable.rows });
    await assert.rejects(() => bt.switchBluetoothHost(2), /refused/);
    assert.equal(JSON.stringify({ c: bt.btHostTable.count, r: bt.btHostTable.rows }), snapshot);
  } finally {
    dev.detach();
  }
});

test('a pre-4.8.0 device keeps the mirror empty and the card surface hidden', async () => {
  identify('4.7.0');
  bt.resetBluetoothHostsUi();
  bt.bindBluetoothHosts();
  assert.equal(els.get('btHostList').hidden, true);
  assert.equal(els.get('btCardControls').hidden, true);
  assert.deepEqual(await bt.loadBluetoothHostTable(), []);
  assert.equal(bt.btHostTable.count, 0);
});

test('4.9.1: a failed row read leaves the PREVIOUS table intact (commit-atomic load)', async () => {
  identify('4.8.0');
  bt.resetBluetoothHostsUi();
  // Load a healthy 2-host table first.
  const good = createDeviceSimulator({ handleLine: app.handleLine }).attachDevice(
    firmware48([
      ['AABBCCDDEEFF', 1],
      ['112233445566', 0],
    ]),
  );
  await bt.loadBluetoothHostTable();
  assert.equal(bt.btHostTable.count, 2);
  assert.equal(bt.btHostTable.rows[2].mac, '112233445566'); // MAC-as-name: parseHostRow records it as mac
  good.detach();
  // Now a row read FAILS mid-load (a forget shrank the bond set between the
  // count read and BT,0:2). The old shape had already committed
  // count-without-rows and the poller would not repair it; the load must
  // leave the previous CONSISTENT table standing.
  const flaky = createDeviceSimulator({ handleLine: app.handleLine }).attachDevice((text) => {
    if (text === 'BT,0:2') return [{ delay: 2, line: 'FAIL,3:BT,0' }];
    return firmware48([
      ['AABBCCDDEEFF', 1],
      ['112233445566', 0],
    ])(text);
  });
  try {
    const loaded = await bt.loadBluetoothHostTable();
    assert.equal(loaded.length, 0, 'the failed load reports no rows');
    assert.equal(bt.btHostTable.count, 2, 'the previous count stands');
    assert.equal(bt.btHostTable.rows[2].mac, '112233445566', 'the previous row stands');
  } finally {
    flaky.detach();
  }
});
