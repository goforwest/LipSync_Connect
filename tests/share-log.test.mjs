// Behavior of the log export/share fallback chain (services/log-export.js):
// native sheet when available, confirm gating, clipboard→mailto for short logs,
// clipboard-only for long logs, mailto marker when the clipboard refuses, and
// the download copy when even mailto navigation fails.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { installGatingDom } from './harness/dom-stub.mjs';

// Track timers so the 8s notification auto-dismiss (or anything else the app
// schedules) doesn't hold the test process open after the last assertion.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const pendingTimers = new Set();
globalThis.setTimeout = (fn, ms, ...args) => {
  const id = realSetTimeout(
    () => {
      pendingTimers.delete(id);
      fn(...args);
    },
    ms,
    ...args,
  );
  pendingTimers.add(id);
  return id;
};
after(() => {
  for (const id of pendingTimers) realClearTimeout(id);
  pendingTimers.clear();
});

const { els } = installGatingDom();
const { shareLog } = await import('../app/js/services/log-export.js');
const { getLogHistory } = await import('../app/js/services/log.js');

// requestAnimationFrame is absent in Node; the download path calls it directly
// (not through timers.js), so give it a no-op.
globalThis.requestAnimationFrame = () => 0;
const win = globalThis.window;

const ok = async () => true;
const cancelled = async () => false;
const notifMsg = () => els.get('notification').querySelector('.notif-msg').textContent;

function setClipboard(impl) {
  if (impl === undefined) delete globalThis.navigator.clipboard;
  else globalThis.navigator.clipboard = impl;
}

test('uses the native share sheet when available', async () => {
  const share = async () => {};
  const canShare = () => true;
  globalThis.navigator.share = share;
  globalThis.navigator.canShare = canShare;
  await shareLog(cancelled);
  assert.equal(win.location.href, ''); // sheet handled it; no fallback ran
  delete globalThis.navigator.share;
  delete globalThis.navigator.canShare;
});

test('cancel at the in-app confirm discloses nothing', async () => {
  setClipboard(undefined);
  win.location.href = '';
  await shareLog(cancelled);
  assert.equal(win.location.href, '');
  assert.ok(getLogHistory().some((entry) => entry.includes('Share cancelled.')));
});

test('short log copies to the clipboard and opens mailto', async () => {
  let copied = false;
  setClipboard({ writeText: async () => (copied = true) });
  win.location.href = '';
  await shareLog(ok);
  assert.equal(copied, true);
  assert.match(win.location.href, /^mailto:\?subject=LipSync%20Connect%20log&body=/);
});

test('long log settles on the clipboard with no mailto', async () => {
  let copied = false;
  setClipboard({ writeText: async () => (copied = true) });
  win.location.href = '';
  getLogHistory().push('L'.repeat(9000));
  await shareLog(ok);
  assert.equal(copied, true);
  assert.equal(win.location.href, '');
  assert.match(notifMsg(), /clipboard/i);
  getLogHistory().pop();
});

test('clipboard refuses → long log opens the mailto marker instead', async () => {
  setClipboard({ writeText: async () => Promise.reject(new Error('denied')) });
  document.execCommand = () => false; // legacy copy also unavailable
  win.location.href = '';
  getLogHistory().push('M'.repeat(9000));
  await shareLog(ok);
  assert.match(win.location.href, /mailto:/);
  assert.match(win.location.href, /Log%20was%20too%20long/);
  getLogHistory().pop();
  document.execCommand = () => true;
  setClipboard(undefined);
});

test('mailto navigation throws — download copy is the last resort', async () => {
  setClipboard(undefined);
  document.execCommand = () => false;
  const objectUrls = [];
  globalThis.URL.createObjectURL = () => {
    const url = `blob:${objectUrls.length}`;
    objectUrls.push(url);
    return url;
  };
  globalThis.URL.revokeObjectURL = () => {};
  const loc = {};
  Object.defineProperty(loc, 'href', {
    get: () => '',
    set: () => {
      throw new Error('no mail handler');
    },
  });
  win.location = loc;
  getLogHistory().push('N'.repeat(9000));
  await shareLog(ok);
  assert.equal(objectUrls.length, 1);
  assert.match(notifMsg(), /downloaded/i);
  getLogHistory().pop();
  document.execCommand = () => true;
});
