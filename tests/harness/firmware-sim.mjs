// Simulated LipSync 4.1 firmware for protocol tests.
// createDeviceSimulator(bindings) takes { handleLine } plus the named session
// seams; tests/harness/test-hooks.mjs bridges the two.
//
// The simulator used to reach the app's mutable state through the ad-hoc
// __test export; it now uses the named inject/detach functions in
// serial/session.js via test-hooks.mjs.

import { testHooks } from './test-hooks.mjs';

/**
 * @param {{ handleLine: (line: string) => void }} bindings
 * @returns {{ attachDevice: (behavior: (text: string) => Array<{delay?: number, line: string}>) => { sent: string[], detach: () => void } }}
 */
export function createDeviceSimulator({ handleLine }) {
  /**
   * Attach a simulated device. Returns { sent, detach } where `sent` is the
   * ordered list of command strings the app wrote.
   */
  function attachDevice(behavior) {
    const sent = [];
    const writer = {
      write(bytes) {
        const text = Buffer.from(bytes).toString('utf8');
        sent.push(text);
        for (const reply of behavior(text) || []) {
          setTimeout(() => handleLine(reply.line), reply.delay ?? 5);
        }
      },
    };
    testHooks.attach({ simulated: true }, writer);
    return {
      sent,
      detach() {
        testHooks.detach();
      },
    };
  }
  return { attachDevice };
}

/** Standard firmware 4.1 behavior: ack SETTINGS, then answer one command. */
export function firmware41(values = { 'MN,0': '1', 'VN,0': '4.1.0', 'SS,1': null }) {
  return (text) => {
    if (text === 'SETTINGS') return [{ delay: 5, line: 'SUCCESS,0:SETTINGS' }];
    const cmd = text.slice(0, 4);
    const value = values[cmd] !== undefined && values[cmd] !== null ? values[cmd] : text.slice(5);
    return [{ delay: 5, line: `SUCCESS,0:${cmd}:${value}` }];
  };
}
