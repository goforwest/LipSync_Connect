// Adapter for the old __test surface onto the named session seams.
// Tests call attachDevice()/etc. through here so the production entry point
// (main.js) doesn't have to export a mutable test backdoor at all.
//
// attach/detach/injectSerialWriter live in serial/session.js; self-test lock
// queries go through services/selftest.js's public accessors; the pending-
// waiter count reads serialBus directly.
import { injectSerialPort, detachSerialPort, injectSerialWriter } from '../../app/js/serial/session.js';
import { serialBus } from '../../app/js/serial/session.js';
import { isSelfTestLocked, getSelfTestState } from '../../app/js/services/selftest.js';

export const testHooks = {
  attach: injectSerialPort,
  detach: detachSerialPort,
  attachWriter: injectSerialWriter,
  pendingWaiters: () => serialBus.lineWaiters.length,
  isLocked: isSelfTestLocked,
  selfTestState: getSelfTestState,
};
