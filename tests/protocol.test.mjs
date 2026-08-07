// LipSync Connect serial-protocol regression tests.
// Imports the real js/main.js as an ES module and drives it with a simulated
// LipSync 4.1 device, so protocol regressions (MRs !5/!6/!7) are caught
// without hardware. No dependencies; run with: node protocol.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeviceSimulator, firmware41 } from './harness/firmware-sim.mjs';
import { testHooks } from './harness/test-hooks.mjs';
import { app } from './harness/setup-protocol.mjs';

const { attachDevice } = createDeviceSimulator({ handleLine: app.handleLine });

const dir = path.dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(path.join(dir, '..', 'app', 'index.html'), 'utf8');
const appSource = readFileSync(path.join(dir, '..', 'app', 'js', 'main.js'), 'utf8');
const formattingSource = readFileSync(path.join(dir, '..', 'app', 'js', 'ui', 'formatting.js'), 'utf8');
const constantsSource = readFileSync(path.join(dir, '..', 'app', 'js', 'config', 'constants.js'), 'utf8');
// VALUE_LABELS may live in js/main.js (pre-migration) or config/constants.js (post-migration).
const labelSource = constantsSource.includes('VALUE_LABELS') ? constantsSource : appSource;
// The unknownTag guard lives in ui/formatting.js (post-migration) or js/main.js (pre-migration).
const guardSource = formattingSource.includes('const unknownTag =') ? formattingSource : appSource;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Static cross-file checks (fail here so CI catches label drift; app must not pay the cost) ----
test('VALUE_LABELS cross-file consistency', async (t) => {
  await t.test('covers all loadable values', () => {
    const m = labelSource.match(/VALUE_LABELS = \{([\s\S]*?)\};/);
    // matchAll results must be mapped to groups — raw match arrays are [full, key, value],
    // and Object.fromEntries on them uses the WRONG pair ([0]/[1]).
    const labelPairs = m ? [...m[1].matchAll(/(\w+): '([^']+)'/g)].map((mm) => [mm[1], mm[2]]) : [];
    const labels = Object.fromEntries(labelPairs);
    assert.ok(Object.keys(labels).length >= 14);
  });
  await t.test('text matches index.html labels (drift check)', () => {
    const m = labelSource.match(/VALUE_LABELS = \{([\s\S]*?)\};/);
    const labelPairs = m ? [...m[1].matchAll(/(\w+): '([^']+)'/g)].map((mm) => [mm[1], mm[2]]) : [];
    const labels = Object.fromEntries(labelPairs);
    // Sip/puff labels intentionally include the range in HTML ("(2–150 hPa)") —
    // strip the parenthetical before comparing to the accessible label used in
    // the failure announcement ("Sip threshold failed to load").
    const drift = Object.entries(labels).filter(
      ([, label]) => !indexHtml.includes('>' + label + '<') && !indexHtml.includes('>' + label + ' ('),
    );
    assert.deepEqual(drift, [], 'drift: ' + drift.map(([k, v]) => k + '=' + JSON.stringify(v)).join(', '));
  });
});

// ---- parseResponse ----
test('parseResponse accepts SETTINGS handshake (regression !7)', () => {
  const p = app.parseResponse('SUCCESS,0:SETTINGS');
  assert.ok(p && p.ok === true && p.cmd === 'SETTINGS' && p.value === null);
});

test('parseResponse accepts FAIL settings handshake', () => {
  const p = app.parseResponse('FAIL,0:SETTINGS');
  assert.ok(p && p.ok === false && p.cmd === 'SETTINGS');
});

test('parseResponse parses endpoint responses', () => {
  const p = app.parseResponse('SUCCESS,0:MN,0:1');
  assert.ok(p && p.ok === true && p.cmd === 'MN,0' && p.value === '1');
});

test('parseResponse parses MANUAL device notifications', () => {
  const p = app.parseResponse('MANUAL,0:SS,1:6');
  assert.ok(p && p.type === 'MANUAL' && p.ok === true && p.cmd === 'SS,1' && p.value === '6');
});

test('parseResponse keeps multi-point calibration payloads intact', () => {
  const p = app.parseResponse('SUCCESS,0:CA,0:0.69|1.14,-13.00|13.00,13.00|13.00,13.00|-13.00,-13.00|-13.00');
  assert.ok(p && p.cmd === 'CA,0' && p.value.split(',').length === 5);
});

test('parseResponse keeps negative acceleration values (v0.6)', () => {
  const p = app.parseResponse('SUCCESS,0:AV,0:-5');
  assert.ok(p && p.ok === true && p.cmd === 'AV,0' && p.value === '-5');
});

test('JV/PV/IN/CA visualization handlers run safely without a DOM (v0.7)', () => {
  app.handleLine('SUCCESS,0:JV,0:1.23,-0.50,10,-4,0,0');
  app.handleLine('SUCCESS,0:PV,0:1010.10,1011.20,-1.10');
  app.handleLine('SUCCESS,0:IN,0:0.12|-0.08');
  app.handleLine('SUCCESS,0:CA,2:13.00|13.00');
  assert.ok(true);
});

test('OM/CM mode-preset sync runs safely without a DOM (v0.8)', () => {
  app.handleLine('SUCCESS,0:OM,0:2');
  app.handleLine('SUCCESS,0:CM,0:1');
  assert.ok(true);
});

test('parseResponse parses live diagnostic joystick stream (v0.8)', () => {
  const p = app.parseResponse('SUCCESS,0:DEBUG,1:1.23|-0.50,10|-4,0|0');
  assert.ok(p && p.ok === true && p.cmd === 'DEBUG,1' && p.value.split(',').length === 3);
});

test('parseResponse parses live diagnostic pressure stream (v0.8)', () => {
  const p = app.parseResponse('SUCCESS,0:DEBUG,2:1010.10,1011.20,-1.10,0.05');
  assert.ok(p && p.cmd === 'DEBUG,2' && p.value.split(',').length === 4);
});

test('DEBUG visualization handlers run safely without a DOM (v0.8)', () => {
  app.handleLine('SUCCESS,0:DEBUG,1:1.23|-0.50,10|-4,0|0');
  app.handleLine('SUCCESS,0:DEBUG,2:1010.10,1011.20,-1.10,0.05');
  app.handleLine('SUCCESS,0:DEBUG,3:2,0,150');
  app.handleLine('SUCCESS,0:DEBUG,4:5,0,300');
  app.handleLine('SUCCESS,0:DEBUG,5:1,0,250');
  assert.ok(true);
});

test('concatenated desync line never matches SETTINGS (regression !5)', () => {
  const p = app.parseResponse('FAIL,0:MN,0:0SETTINGS');
  assert.ok(p === null || p.cmd === 'MN,0');
});

test('parseResponse rejects unrecognized lines', () => {
  assert.equal(app.parseResponse('garbage line'), null);
});

// parseResponse edge cases: empty/missing values
test('parseResponse handles empty value after colon', () => {
  const p = app.parseResponse('SUCCESS,0:SS,1:');
  assert.ok(p && p.value === '');
});

test('parseResponse returns null value when no colon-value present', () => {
  const p = app.parseResponse('SUCCESS,0:MN,0');
  assert.ok(p && p.value === null);
});

test('parseResponse captures colon inside value greedily', () => {
  const p = app.parseResponse('SUCCESS,0:SS,1:5:extra');
  assert.ok(p && p.value === '5:extra');
});

test('parseResponse accepts DEBUG mode >= 10 (multi-digit regex)', () => {
  const p = app.parseResponse('SUCCESS,0:DEBUG,10:data');
  assert.ok(p && p.ok && p.cmd === 'DEBUG,10' && p.value === 'data');
});

test('parseResponse rejects leading whitespace', () => {
  assert.equal(app.parseResponse(' SUCCESS,0:SS,1:5'), null);
});

test('parseResponse accepts trailing whitespace (readLoop trims upstream)', () => {
  const p = app.parseResponse('SUCCESS,0:SS,1:5 ');
  assert.ok(p && p.value === '5 ');
});

// ---- sendCommand round-trips against the simulated device ----
test('sendCommand completes SETTINGS handshake then endpoint command', async () => {
  const dev = attachDevice(firmware41());
  const mn = await app.sendCommand('MN,0:0', 500, 500);
  assert.ok(mn.ok && mn.cmd === 'MN,0' && mn.value === '1');
  dev.detach();
});

test('sendCommand returns firmware version value', async () => {
  const dev = attachDevice(firmware41());
  const vn = await app.sendCommand('VN,0:0', 500, 500);
  assert.equal(vn.value, '4.1.0');
  dev.detach();
});

test('sendCommand round-trips negative acceleration level (v0.6)', async () => {
  const dev = attachDevice(firmware41());
  const av = await app.sendCommand('AV,1:-3', 500, 500);
  assert.ok(av.ok && av.cmd === 'AV,1' && av.value === '-3');
  dev.detach();
});

test('sendCommand sets Bluetooth communication mode (v0.6)', async () => {
  const dev = attachDevice(firmware41());
  const cm = await app.sendCommand('CM,1:2', 500, 500);
  assert.ok(cm.ok && cm.cmd === 'CM,1' && cm.value === '2');
  dev.detach();
});

// Exact matching: a response for a different endpoint must not satisfy the waiter.
test('wrong-endpoint response is not consumed (exact matching, !6)', async () => {
  const dev = attachDevice((text) => {
    if (text === 'SETTINGS') return [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }];
    return [{ delay: 5, line: 'SUCCESS,0:SL,0:5' }]; // wrong endpoint on purpose
  });
  await assert.rejects(app.sendCommand('SS,0:0', 150, 300), /Timed out/);
  dev.detach();
  await sleep(20);
});

// MANUAL notifications update the UI but must not complete a pending web command.
test('MANUAL same-endpoint notification does not complete a pending command', async () => {
  const dev = attachDevice((text) => {
    if (text === 'SETTINGS') return [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }];
    return [
      { delay: 5, line: 'MANUAL,0:SS,1:6' },
      { delay: 20, line: 'SUCCESS,0:SS,1:7' },
    ];
  });
  const manualThenSuccess = await app.sendCommand('SS,1:7', 300, 300);
  assert.equal(manualThenSuccess.value, '7');
  dev.detach();
  await sleep(20);
});

// A stale late response for the same write endpoint must not satisfy a newer write with a different value.
test('stale same-endpoint write response with a different value is ignored', async () => {
  const dev = attachDevice((text) => {
    if (text === 'SETTINGS') return [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }];
    return [
      { delay: 5, line: 'SUCCESS,0:SS,1:6' },
      { delay: 20, line: 'SUCCESS,0:SS,1:7' },
    ];
  });
  const staleThenFresh = await app.sendCommand('SS,1:7', 300, 300);
  assert.equal(staleThenFresh.value, '7');
  dev.detach();
  await sleep(20);
});

// Mode-change restart timing: SETTINGS ack is delayed while firmware applies OM.
test('default handshake timeout fails during post-OM busy window', async () => {
  const dev = attachDevice((text) => {
    if (text === 'SETTINGS') return [{ delay: 250, line: 'SUCCESS,0:SETTINGS' }];
    if (text.startsWith('SR,1')) return [{ delay: 5, line: 'SUCCESS,0:SR,1:1' }];
    return [];
  });
  await assert.rejects(app.sendCommand('SR,1:1', 400, 100), /Timed out/);
  dev.detach();
  await sleep(300); // drain stale delayed SETTINGS lines
});

test('extended settingsTimeoutMs delivers SR restart after mode change (regression !6)', async () => {
  const dev = attachDevice((text) => {
    if (text === 'SETTINGS') return [{ delay: 250, line: 'SUCCESS,0:SETTINGS' }];
    if (text.startsWith('SR,1')) return [{ delay: 5, line: 'SUCCESS,0:SR,1:1' }];
    return [];
  });
  const sr = await app.sendCommand('SR,1:1', 400, 600);
  assert.ok(sr.ok && sr.cmd === 'SR,1');
  dev.detach();
  await sleep(300); // drain stale delayed SETTINGS lines
});

// FAIL handling (use a write command to exercise the SETTINGS handshake path)
test('FAIL settings handshake rejects the command', async () => {
  const dev = attachDevice((text) => {
    if (text === 'SETTINGS') return [{ delay: 5, line: 'FAIL,0:SETTINGS' }];
    return [];
  });
  await assert.rejects(app.sendCommand('SS,1:5', 300, 300), /rejected settings handshake/);
  dev.detach();
});

test('FAIL endpoint response rejects with device error', async () => {
  const dev = attachDevice((text) => {
    if (text === 'SETTINGS') return [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }];
    return [{ delay: 5, line: 'FAIL,0:' + text.slice(0, 4) + ':0' }];
  });
  await assert.rejects(app.sendCommand('OM,1:9', 300, 300), /rejected command/);
  dev.detach();
});

// Queue serialization: second command must not start before the first finishes.
test('command queue serializes handshake/command pairs', async () => {
  const order = [];
  const dev = attachDevice((text) => {
    order.push(text);
    if (text === 'SETTINGS') return [{ delay: 20, line: 'SUCCESS,0:SETTINGS' }];
    return [{ delay: 20, line: `SUCCESS,0:${text.slice(0, 4)}:${text.slice(5)}` }];
  });
  await Promise.all([app.sendCommand('SS,1:6', 500, 500), app.sendCommand('SL,1:7', 500, 500)]);
  assert.equal(order.join('|'), 'SETTINGS|SS,1:6|SETTINGS|SL,1:7');
  dev.detach();
});

// Disconnected safety
test('sendCommand rejects immediately when no port is attached', async () => {
  await assert.rejects(app.sendCommand('MN,0:0', 200, 200), /Not connected/);
});

// Complete silence: device never responds at all
test('complete silence times out waiting for SETTINGS', async () => {
  const dev = attachDevice(() => []); // returns nothing — no SETTINGS ack, no command response
  await assert.rejects(app.sendCommand('SS,0:0', 150, 150), /Timed out/);
  dev.detach();
  await sleep(20);
});

// Mid-command disconnect: SETTINGS ack arrives, then port drops before command response
test('mid-command disconnect rejects the pending command', async () => {
  const dev = attachDevice((text) => {
    if (text === 'SETTINGS') return [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }];
    // Command is sent but no response — simulate disconnect after a short delay
    setTimeout(() => dev.detach(), 20);
    return [];
  });
  await assert.rejects(app.sendCommand('SS,0:0', 300, 300));
  dev.detach();
  await sleep(50);
});

// Sequential timeouts: first times out, second succeeds
test('first sequential command times out', async () => {
  const dev = attachDevice((text) => {
    if (text === 'SETTINGS') return [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }];
    return []; // Command gets no response
  });
  await assert.rejects(app.sendCommand('SS,0:0', 150, 150), /Timed out/);
  dev.detach();
  await sleep(50); // drain stale timers from the first device
});

test('queue recovers after a timeout — second command succeeds', async () => {
  const dev = attachDevice(firmware41());
  const afterTimeout = await app.sendCommand('SS,0:0', 500, 500);
  assert.ok(afterTimeout.ok);
  dev.detach();
  await sleep(20);
});

test('no leaked line waiters after all tests', async () => {
  assert.equal(testHooks.pendingWaiters(), 0);
});

// Orphaned garbage line (timeout handler unreachable mid-test): must not
// throw, must log through the corrupt-drop path without crashing.
test('orphaned unparsable line dropped safely (corrupt-drop log path)', () => {
  app.handleLine('reading=12,EXTRA');
  assert.ok(true);
});

// renderSafeFormatting guard: every confirm body used by the app must pass,
// and obviously-hostile markup must still be rejected (regression on the
// previous accidental over-broad character class).
const confirmBodies = [
  'Switch to <strong>Mouse</strong>? The LipSync will save the setting, restart, and disconnect. After the restart, reconnect to continue.',
  'Switch to <strong>Mouse (Bluetooth)</strong>? The LipSync will save the setting, restart, and disconnect. After the restart, open Bluetooth settings on your computer to pair with it.',
  'Reset the LipSync? The device will restart and disconnect. You will need to reconnect afterwards.',
  '<strong>This restores ALL settings to defaults.</strong> The device will restart with default settings. Reconnect afterwards.',
];

// Guard check without the DOM walk (test env lacks a real createDocumentFragment/tree).
// Pull the guard regex out of js/main.js source so the test can't drift from it.
test('confirm-guard regex located in formatting source', () => {
  const guardMatch = guardSource.match(/const unknownTag = (\/[^\n]+\/);/);
  assert.ok(guardMatch, 'unknownTag regex found in source');
  const unknownTag = eval(guardMatch[1]);
  assert.ok(unknownTag instanceof RegExp);
});

test('confirm-guard accepts all dialog bodies in use', () => {
  const guardMatch = guardSource.match(/const unknownTag = (\/[^\n]+\/);/);
  const unknownTag = eval(guardMatch[1]);
  const guardPassCount = confirmBodies.filter((b) => !unknownTag.test(b)).length;
  assert.equal(guardPassCount, confirmBodies.length);
});

test('confirm-guard refuses script/img/attribute-bearing tags', () => {
  const guardMatch = guardSource.match(/const unknownTag = (\/[^\n]+\/);/);
  const unknownTag = eval(guardMatch[1]);
  const guardBlockCount = ['<script>alert(1)</script>', '<img src="x">', '<strong onclick="x()">x</strong>'].filter(
    (b) => unknownTag.test(b),
  ).length;
  assert.equal(guardBlockCount, 3);
});
