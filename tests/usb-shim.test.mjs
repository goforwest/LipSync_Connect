// The WebUSB connect shim (serial/transport.js usbSerialShim): the device
// request filters must carry the LipSync's CURRENT USB identity (Seeed XIAO
// nRF52840, vendor 0x2886 — app or bootloader PIDs). The original filter was
// the V3-era 0x1209:0x4c53 identity, which left the current hardware
// ungrantable on Android (the picker shows no compatible device and the
// unfiltered fallback never fires because requestDevice does not throw).
// The shim is chosen at transport.js module scope, so navigator.usb must
// exist before the import.
import test from 'node:test';
import assert from 'node:assert/strict';

const seenRequests = [];
Object.defineProperty(globalThis, 'navigator', {
  value: {
    usb: {
      requestDevice: async (opts) => {
        seenRequests.push(opts);
        return { vendorId: 0x2886, productId: 0x8044, opened: false };
      },
    },
  },
  writable: true,
  configurable: true,
});

const { serialApi } = await import('../app/js/serial/transport.js');

test('the WebUSB connect shim filters to the LipSync XIAO USB identity', async () => {
  assert.ok(serialApi, 'the shim is selected when only navigator.usb exists');
  const port = await serialApi.requestPort();
  assert.ok(port, 'a shim port is returned for the picked device');
  assert.equal(seenRequests.length, 1, 'exactly one device request was made');

  const filters = seenRequests[0].filters;
  assert.equal(filters.length, 4, 'all four LipSync PIDs are offered');
  for (const f of filters) {
    assert.equal(f.vendorId, 0x2886, 'every filter carries the Seeed vendor ID');
  }
  assert.deepEqual(
    filters.map((f) => f.productId).sort(),
    [0x0044, 0x0045, 0x8044, 0x8045].sort(),
    'app and bootloader PIDs are both grantable (bootloader picks hit the connect guard)',
  );
  assert.equal(
    filters.some((f) => f.vendorId === 0x1209),
    false,
    'the stale V3-era identity no longer filters out the current hardware',
  );
});
