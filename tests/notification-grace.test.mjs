// Toast minimum-on-screen grace (ui/notification.js): a message that just
// appeared stays readable for MIN_VISIBLE_MS before a successor may replace
// it — two events landing together must not erase the first unread. Only the
// latest deferred successor wins, and a call arriving after the grace window
// replaces immediately.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { installGatingDom } from './harness/dom-stub.mjs';

installGatingDom();

const { showNotification } = await import('../app/js/ui/notification.js');

const msgText = () => {
  const el = globalThis.document.getElementById('notification');
  const m = el?.querySelector?.('.notif-msg');
  return m?.textContent ?? '';
};

test('a successor arriving inside the grace window is deferred; the first message stays readable', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    mock.timers.setTime(1_000_000);
    showNotification('First');
    assert.equal(msgText(), 'First');
    mock.timers.tick(100); // 100 ms after "First" appeared
    showNotification('Second');
    assert.equal(msgText(), 'First', 'the first message must survive the grace window');
    mock.timers.tick(1_400); // past the 1500 ms grace
    assert.equal(msgText(), 'Second', 'the deferred successor renders once the grace elapses');
  } finally {
    mock.timers.reset();
  }
});

test('a call arriving after the grace window replaces the toast immediately', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    mock.timers.setTime(5_000_000);
    showNotification('A');
    mock.timers.tick(2_000); // well past the grace window
    showNotification('B');
    assert.equal(msgText(), 'B', 'no deferral once the current message has been readable');
  } finally {
    mock.timers.reset();
  }
});

test('rapid successors collapse — only the latest deferred message renders', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    mock.timers.setTime(9_000_000);
    showNotification('A');
    mock.timers.tick(100);
    showNotification('B');
    mock.timers.tick(100);
    showNotification('C');
    assert.equal(msgText(), 'A');
    mock.timers.tick(1_400);
    assert.equal(msgText(), 'C', 'the superseded "B" never flashes on screen');
  } finally {
    mock.timers.reset();
  }
});
