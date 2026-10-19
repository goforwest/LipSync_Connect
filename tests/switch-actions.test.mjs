// External switch actions (firmware 4.5.0+, upstream #20): the version-gated
// load (never sent to older firmware), the two wire value shapes (the GET's
// "short,long,max" triple and the SET's packed echo), the write path with
// revert-on-FAIL, the factory-mapping reset flow, the update snapshot/
// restore round-trip, the settings-export coverage, and the wire-length
// contract of the packed SET value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc, windowListeners } = installGatingDom();
const app = await import('../app/js/main.js');
const {
  loadDeviceInfo,
  applySwitchActionValue,
  resetSwitchActionsUi,
  setSwitchAction,
  resetSwitchActions,
  populateSwitchActionSelects,
} = await import('../app/js/services/settings-service.js');
const { captureSettingsSnapshot, restoreSettingsSnapshot } = await import('../app/js/services/firmware-update.js');
const { collectSettingsExport } = await import('../app/js/services/settings-export.js');
const { testHooks } = await import('./harness/test-hooks.mjs');
const { resetWireNewlineFraming } = await import('../app/js/serial/commands.js');
const { SWITCH_SETTINGS, SWITCH_ACTION_PACK_BASE } = await import('../app/js/config/constants.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byId = (id) => doc.getElementById(id);

const BASE_RESPONSES = {
  'MN,0': '1',
  'VN,0': '4.5.0',
  'ID,0': 'a1b2c3d4',
  'OM,0': '1',
  'CM,0': '1',
  'SS,0': '5',
  'SL,0': '5',
  'AV,0': '0',
  'ST,0': '3.00',
  'PT,0': '3.00',
  'IZ,0': '0.07',
  'OZ,0': '0.95',
  'IN,0': '0.00|0.00',
  'CA,0': '0.00|0.00,-13.00|13.00,13.00|13.00,13.00|-13.00,-13.00|-13.00',
  'SM,0': '1',
  'LM,0': '1',
  'LL,0': '5',
  'DM,0': '0',
  'SD,0': '0',
  'MA,0': '0',
  'LK,0': '0',
  'CF,0': '0',
  'WS,0': '1000',
  'WL,0': '3000',
  'WM,0': '8000',
  // The compiled factory mappings (LSConfig.h's switchActionProperty).
  'SA,0': '1,4,19',
  'SB,0': '3,0,14',
  'SC,0': '2,5,3',
  'GA,0': '6,8,19',
  'GB,0': '10,11,14',
  'GC,0': '7,9,0',
};

// Loads the whole settings surface; switchValues override the six mapping
// reads. writeFailures maps "SA,1:110419"-style write commands to FAIL.
function launchDevice({ version = '4.5.0', switchValues = {}, writeFailures = {} } = {}) {
  const sent = [];
  const responses = { ...BASE_RESPONSES, 'VN,0': version, ...switchValues };
  const writer = {
    write(bytes) {
      const text = Buffer.from(bytes)
        .toString('utf8')
        .replace(/\r?\n$/, '');
      sent.push(text);
      const reply = (line) => setTimeout(() => app.handleLine(line), 3);
      if (text === 'SETTINGS') {
        reply('SUCCESS,0:SETTINGS');
        return;
      }
      if (writeFailures[text]) {
        reply(`FAIL,3:${text}`);
        return;
      }
      const write = text.match(/^([A-Z]{2}),1:/);
      if (write) {
        // The firmware echoes the packed SET value verbatim.
        reply(`SUCCESS,0:${text}`);
        return;
      }
      const cmd = text.slice(0, 4);
      if (cmd in responses) reply(`SUCCESS,0:${cmd}:${responses[cmd]}`);
    },
  };
  testHooks.attach({ simulated: true }, writer);
  return sent;
}

const selectValues = (endpoint) => {
  const s = SWITCH_SETTINGS.find((x) => x.endpoint === endpoint);
  return s.windowLabels.map((_, i) => byId(s.selectPrefix + i).value);
};

const setSelects = (endpoint, cells) => {
  const s = SWITCH_SETTINGS.find((x) => x.endpoint === endpoint);
  cells.forEach((c, i) => {
    byId(s.selectPrefix + i).value = String(c);
  });
};

// Fire DOMContentLoaded as the browser would (flows.test.mjs's pattern): the
// tab-toggle listeners bind inside it, so the tab test needs the real wiring.
(windowListeners['DOMContentLoaded'] || []).forEach((fn) => fn());

populateSwitchActionSelects();

test('a 4.5.0 device loads the six switch mappings into the selects', async () => {
  resetWireNewlineFraming();
  resetSwitchActionsUi();
  const sent = launchDevice({ switchValues: { 'SA,0': '1,4,19', 'GA,0': '6,8,19', 'GC,0': '7,9,0' } });
  await loadDeviceInfo();
  await sleep(40);
  for (const ep of ['SA,0:0', 'SB,0:0', 'SC,0:0', 'GA,0:0', 'GB,0:0', 'GC,0:0'])
    assert.ok(sent.includes(ep), ep + ' read after VN identified 4.5.0');
  assert.deepEqual(selectValues('SA'), ['1', '4', '19']);
  assert.deepEqual(selectValues('GA'), ['6', '8', '19']);
  assert.deepEqual(selectValues('GC'), ['7', '9', '0']);
  assert.equal(byId('swSA0').disabled, false);
  assert.equal(byId('btnResetSwitchActions').disabled, false);
  assert.equal(byId('switchActionsNote').textContent, '');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('older firmware never sees the switch endpoints — the card says why', async () => {
  resetWireNewlineFraming();
  resetSwitchActionsUi();
  const sent = launchDevice({ version: '4.4.0' });
  await loadDeviceInfo();
  await sleep(40);
  for (const ep of ['SA,0:0', 'SB,0:0', 'SC,0:0', 'GA,0:0', 'GB,0:0', 'GC,0:0'])
    assert.ok(!sent.includes(ep), ep + ' must not be sent to pre-4.5.0 firmware');
  assert.equal(byId('swSA0').disabled, true);
  assert.match(byId('switchActionsNote').textContent, /4\.5\.0/);
  assert.equal(byId('btnResetSwitchActions').disabled, true);
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('the two wire value shapes both land: the GET triple and the SET packed echo', () => {
  resetSwitchActionsUi();
  applySwitchActionValue('SA', '1,4,19'); // GET shape
  assert.deepEqual(selectValues('SA'), ['1', '4', '19']);
  applySwitchActionValue('SA', SWITCH_ACTION_PACK_BASE + 2 * 10000 + 5 * 100 + 3); // SET echo shape
  assert.deepEqual(selectValues('SA'), ['2', '5', '3']);
  // All-nothing maps to packed 0 but wire 100000 — never confused with the
  // whole-endpoint factory reset (wire 0).
  applySwitchActionValue('SA', SWITCH_ACTION_PACK_BASE + 0);
  assert.deepEqual(selectValues('SA'), ['0', '0', '0']);
  // A factory-reset ack (0) carries no triple — the reset flow re-reads.
  applySwitchActionValue('SA', '0');
  assert.deepEqual(selectValues('SA'), ['0', '0', '0']);
});

test('a write packs the three picks into one 11-char command; a FAIL reverts to device truth', async () => {
  resetWireNewlineFraming();
  resetSwitchActionsUi();
  const sent = launchDevice({ writeFailures: { 'SA,1:150403': true } });
  applySwitchActionValue('SA', '1,4,19'); // last device-confirmed mapping
  setSelects('SA', [8, 4, 3]); // caregiver picks: short hold → Gamepad B3
  await setSwitchAction('SA');
  // 8*10000 + 4*100 + 3 = 80403; wire = BASE + packed → SA,1:180403 (11 chars).
  assert.ok(sent.includes('SA,1:180403'), 'the packed write reached the wire');
  assert.equal('SA,1:180403'.length, 11, 'the packed write is the 6-digit command shape');
  assert.deepEqual(selectValues('SA'), ['8', '4', '3'], 'the echo re-synced the picks');

  // A device-side rejection (FAIL) throws and reverts to the last confirmed.
  setSelects('SA', [5, 4, 3]);
  await assert.rejects(() => setSwitchAction('SA'), /rejected/);
  assert.deepEqual(selectValues('SA'), ['8', '4', '3'], 'reverted to the device truth');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('every plausible packed write lands on the 6-digit command shape the firmware accepts', () => {
  const min = [0, 0, 0];
  const max = [19, 19, 19];
  const wire = (cells) => `${'SA'},1:${SWITCH_ACTION_PACK_BASE + cells[0] * 10000 + cells[1] * 100 + cells[2]}`;
  assert.equal(wire(min).length, 11);
  assert.equal(wire(max).length, 11);
  assert.equal('SA,1:0'.length, 6, 'the factory-mapping reset stays the 1-digit shape');
});

test('the factory-mapping reset writes 0 to all six, then re-reads the device truth', async () => {
  resetWireNewlineFraming();
  resetSwitchActionsUi();
  const sent = launchDevice({});
  applySwitchActionValue('SA', '8,4,3');
  await resetSwitchActions();
  for (const s of SWITCH_SETTINGS) {
    assert.ok(sent.includes(`${s.endpoint},1:0`), s.endpoint + ' reset');
    assert.ok(sent.includes(`${s.endpoint},0:0`), s.endpoint + ' re-read');
  }
  assert.deepEqual(selectValues('SA'), ['1', '4', '19'], 're-synced from the re-read');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('the update snapshot round-trips the mappings; old firmware snapshots without them', async () => {
  resetWireNewlineFraming();
  resetSwitchActionsUi();
  launchDevice({ switchValues: { 'SA,0': '8,4,3', 'GB,0': '10,11,14' } });
  await loadDeviceInfo();
  await sleep(40);
  const snapshot = captureSettingsSnapshot();
  assert.equal(snapshot.SA, String(SWITCH_ACTION_PACK_BASE + 8 * 10000 + 4 * 100 + 3));
  assert.equal(snapshot.GB, String(SWITCH_ACTION_PACK_BASE + 10 * 10000 + 11 * 100 + 14));
  assert.equal(snapshot.SB, String(SWITCH_ACTION_PACK_BASE + 3 * 10000 + 0 * 100 + 14));
  await app.disconnect({ quiet: true });
  testHooks.detach();

  const sent = [];
  testHooks.attach(
    { simulated: true },
    {
      write(bytes) {
        const text = Buffer.from(bytes)
          .toString('utf8')
          .replace(/\r?\n$/, '');
        sent.push(text);
        const reply = (line) => setTimeout(() => app.handleLine(line), 3);
        reply(text === 'SETTINGS' ? 'SUCCESS,0:SETTINGS' : `SUCCESS,0:${text}`);
      },
    },
  );
  await restoreSettingsSnapshot(snapshot);
  for (const ep of ['SA', 'SB', 'SC', 'GA', 'GB', 'GC'])
    assert.ok(
      sent.some((s) => s.startsWith(`${ep},1:`)),
      ep + ' restored',
    );
  testHooks.detach();

  // Pre-4.5.0: no switch keys in the snapshot at all.
  resetWireNewlineFraming();
  resetSwitchActionsUi();
  launchDevice({ version: '4.4.0' });
  await loadDeviceInfo();
  await sleep(40);
  const oldSnapshot = captureSettingsSnapshot();
  for (const s of SWITCH_SETTINGS) assert.equal(oldSnapshot[s.endpoint], undefined, s.endpoint + ' absent pre-4.5.0');
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('the settings export carries the in-force mappings as labeled action arrays', async () => {
  resetWireNewlineFraming();
  resetSwitchActionsUi();
  launchDevice({ switchValues: { 'SA,0': '8,4,3', 'GC,0': '7,9,0' } });
  await loadDeviceInfo();
  await sleep(40);
  const { settings } = collectSettingsExport();
  assert.deepEqual(settings.switch1MouseActions, [8, 4, 3]);
  assert.deepEqual(settings.switch3GamepadActions, [7, 9, 0]);
  assert.deepEqual(settings.switch2MouseActions, [3, 0, 14]);
  await app.disconnect({ quiet: true });
  testHooks.detach();

  // Pre-4.5.0 firmware: the mappings are holes, never invented values.
  resetWireNewlineFraming();
  resetSwitchActionsUi();
  launchDevice({ version: '4.4.0' });
  await loadDeviceInfo();
  await sleep(40);
  const old = collectSettingsExport();
  for (const s of SWITCH_SETTINGS) {
    assert.equal(old.settings[s.jsonKey], undefined, s.jsonKey + ' not exported');
    assert.ok(old.notLoaded.includes(s.jsonKey), s.jsonKey + ' listed as a hole');
  }
  await app.disconnect({ quiet: true });
  testHooks.detach();
});

test('the disconnect reset clears stale mappings so they cannot leak into a new session', () => {
  applySwitchActionValue('SA', '8,4,3');
  assert.equal(byId('swSA0').disabled, false);
  resetSwitchActionsUi();
  assert.equal(byId('swSA0').disabled, true);
  assert.equal(byId('swSA0').value, '');
  assert.equal(byId('btnResetSwitchActions').disabled, true);
  assert.equal(byId('switchActionsNote').textContent, '');
});

test('the per-jack mode tabs swap the visible mapping grid independently', () => {
  const tabs = (jack) => doc.querySelectorAll(`.switch-tab[data-jack="${jack}"]`);
  const panels = (jack) => doc.querySelectorAll(`.switch-mode[data-jack="${jack}"]`);
  const find = (els, mode) => els.find((el) => el.dataset.mode === mode);

  // Default: Mouse pressed, its panel visible; Gamepad hidden.
  for (const jack of ['A', 'B', 'C']) {
    assert.equal(find(tabs(jack), 'mouse').getAttribute('aria-pressed'), 'true');
    assert.equal(find(tabs(jack), 'gamepad').getAttribute('aria-pressed'), 'false');
    assert.equal(find(panels(jack), 'mouse').hidden, false);
    assert.equal(find(panels(jack), 'gamepad').hidden, true);
  }

  // Switch jack 1 to Gamepad: only jack 1 flips.
  find(tabs('A'), 'gamepad').dispatch('click');
  assert.equal(find(tabs('A'), 'gamepad').getAttribute('aria-pressed'), 'true');
  assert.equal(find(tabs('A'), 'mouse').getAttribute('aria-pressed'), 'false');
  assert.equal(find(panels('A'), 'gamepad').hidden, false);
  assert.equal(find(panels('A'), 'mouse').hidden, true);
  assert.equal(find(panels('B'), 'mouse').hidden, false, 'jack 2 untouched');
  assert.equal(find(panels('C'), 'gamepad').hidden, true, 'jack 3 untouched');

  // Clicking the already-pressed tab is a no-op (state never desyncs).
  find(tabs('A'), 'gamepad').dispatch('click');
  assert.equal(find(panels('A'), 'gamepad').hidden, false);
  assert.equal(find(tabs('A'), 'gamepad').getAttribute('aria-pressed'), 'true');

  // Switching back restores Mouse.
  find(tabs('A'), 'mouse').dispatch('click');
  assert.equal(find(panels('A'), 'mouse').hidden, false);
  assert.equal(find(panels('A'), 'gamepad').hidden, true);
});
