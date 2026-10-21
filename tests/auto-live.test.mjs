// Auto-live sections (main.js's syncAutoLive behind ui/sections.js's change
// subscription): opening Sip & Puff or Joystick while connected starts their
// live stream when the device is idle, closing/leaving stops what the app
// started, a user-started stream is never touched, and a user REPLACING the
// auto stream (Watch holds over the pressure stream) makes it theirs.
//
// Assertions poll observed state (waitFor) instead of racing fixed sleeps:
// the first queued command of a fresh process lands 10–50 ms after the
// section opens (JIT/GC/event-loop alignment), which a fixed 40 ms sleep
// lost on slower CI runners. Negative assertions still use a settle window —
// enough for the (now always-detached, so never cross-contaminating)
// command chain to fire if it were going to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

const { document: doc, windowListeners } = installGatingDom();
const app = await import('../app/js/main.js');
(windowListeners['DOMContentLoaded'] || []).forEach((fn) => fn());
const { openSectionById, closeCurrentSection } = await import('../app/js/ui/sections.js');
const { testHooks } = await import('./harness/test-hooks.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls until `fn()` is true; fails with `desc` after 2 s instead of hanging. */
const waitFor = async (fn, desc, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for: ' + desc);
    await sleep(5);
  }
};

const launch = (replies = {}) => {
  const sent = [];
  const writer = {
    write(bytes) {
      const text = Buffer.from(bytes).toString('utf8').replace(/\r?\n$/, '');
      sent.push(text);
      const reply = replies[text];
      if (reply) setTimeout(() => app.handleLine(reply), 3);
    },
  };
  testHooks.attach({ simulated: true }, writer);
  // A real connect undims the nav via updateConnectionGating; the stub stays
  // dimmed from the pre-connect DOMContentLoaded pass otherwise, and
  // openSectionById's dimmed guard (correctly) refuses to open cards.
  doc
    .querySelectorAll('.circle-trigger')
    .forEach((b) => {
      b.classList.remove('dimmed');
      b.removeAttribute('aria-disabled');
      b.removeAttribute('title');
    });
  return sent;
};

/** Runs `body` with the guarantee that the injected port detaches even when
 *  an assertion throws — a leaked writer would deliver a previous test's
 *  queued writes into the next test's `sent` array. */
const withPort = async (body) => {
  try {
    await body();
  } finally {
    testHooks.detach();
  }
};

const dmSent = (sent) => sent.filter((s) => s.startsWith('DM,'));

test('opening Sip & Puff while connected auto-starts the pressure stream; closing stops it', async () => {
  await withPort(async () => {
    const sent = launch({
      SETTINGS: 'SUCCESS,0:SETTINGS',
      'DM,1:2': 'SUCCESS,0:DM,1:2',
      'DM,1:0': 'SUCCESS,0:DM,1:0',
    });
    doc.getElementById('debugMode').value = '0';
    openSectionById('sec-sip');
    await waitFor(() => dmSent(sent).length === 1, 'the auto DM,1:2 start');
    assert.deepEqual(dmSent(sent), ['DM,1:2']);
    closeCurrentSection();
    await waitFor(() => dmSent(sent).length === 2, 'the auto DM,1:0 stop');
    assert.deepEqual(dmSent(sent), ['DM,1:2', 'DM,1:0']);
  });
});

test('a busy device is left alone — no auto-start over a user stream, no auto-stop after', async () => {
  await withPort(async () => {
    const sent = launch({
      SETTINGS: 'SUCCESS,0:SETTINGS',
      'DM,1:1': 'SUCCESS,0:DM,1:1',
    });
    doc.getElementById('debugMode').value = '1'; // the user's own stream is running
    openSectionById('sec-sip');
    await sleep(150);
    assert.deepEqual(dmSent(sent), [], 'no auto DM writes over the user stream: ' + JSON.stringify(sent));
    closeCurrentSection();
    await sleep(150);
    assert.deepEqual(dmSent(sent), [], 'the user stream survives the section close');
  });
});

test('replacing the auto stream makes it the user\u2019s — leaving never stops it', async () => {
  await withPort(async () => {
    const sent = launch({
      SETTINGS: 'SUCCESS,0:SETTINGS',
      'DM,1:2': 'SUCCESS,0:DM,1:2',
      'DM,1:5': 'SUCCESS,0:DM,1:5',
      'DM,1:0': 'SUCCESS,0:DM,1:0', // a real device acks everything
    });
    doc.getElementById('debugMode').value = '0';
    openSectionById('sec-sip');
    await waitFor(() => dmSent(sent).length === 1, 'the auto DM,1:2 start'); // the app auto-started mode 2
    assert.deepEqual(dmSent(sent), ['DM,1:2']);
    // The user presses Watch holds (mode 5); the DM response renderer syncs
    // the select exactly like this.
    doc.getElementById('debugMode').value = '5';
    openSectionById('sec-log'); // leaving must NOT stop the user's stream
    await sleep(150);
    assert.ok(!dmSent(sent).includes('DM,1:0'), 'a replaced stream is the user\u2019s, never auto-stopped');
  });
});

test('sections without a live mapping change nothing', async () => {
  await withPort(async () => {
    const sent = launch({ SETTINGS: 'SUCCESS,0:SETTINGS' });
    doc.getElementById('debugMode').value = '0';
    openSectionById('sec-switches');
    await sleep(150);
    assert.deepEqual(dmSent(sent), [], JSON.stringify(sent));
  });
});

test('before the settings load lands (select disabled), no auto-start is sent', async () => {
  await withPort(async () => {
    const sent = launch({ SETTINGS: 'SUCCESS,0:SETTINGS' });
    const dmEl = doc.getElementById('debugMode');
    dmEl.disabled = true; // the pre-load state clearSessionUi establishes
    dmEl.value = '0'; // the markup default that must not be trusted
    openSectionById('sec-sip');
    await sleep(150);
    assert.deepEqual(dmSent(sent), [], JSON.stringify(sent));
    // Once the DM read lands (the renderer enables the select), the next
    // transition may start the stream under the normal rules.
    dmEl.disabled = false;
    closeCurrentSection();
    openSectionById('sec-sip');
    await waitFor(() => dmSent(sent).length === 1, 'the post-load auto DM,1:2 start');
    assert.deepEqual(dmSent(sent), ['DM,1:2']);
    closeCurrentSection();
  });
});
