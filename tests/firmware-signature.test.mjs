// Manifest signature verification (services/firmware-signature.js): the
// source-trust layer above the sha256 pipe check. The checksum proves the
// downloaded bytes match the manifest; the signature proves the manifest is
// ours — verified against a public key pinned in app code, not in the repo
// it vouches for. These tests sign with ephemeral keypairs through the test
// seam: the production private key never exists in CI (that is the point).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  manifestSignaturePayload,
  verifyManifestSignature,
  setManifestSigningKeyForTests,
  setRequireSignedManifestForTests,
  resetManifestSignatureForTests,
} from '../app/js/services/firmware-signature.js';
import {
  FW_MANIFEST_SIGNING_PUBLIC_KEY_B64,
  FW_MANIFEST_SIGNATURE_ALGORITHM,
  FW_MANIFEST_SIGNATURE_PREFIX,
  FW_REQUIRE_SIGNED_MANIFEST,
} from '../app/js/config/constants.js';

const encoder = new TextEncoder();

const MANIFEST = {
  firmwareVersion: '4.2.0',
  files: {
    dfu: { fileName: 'LipSync_Firmware_4.2.0_dfu.zip', size: 257566, sha256: 'a'.repeat(64) },
  },
};

const bytesToB64 = (bytes) => btoa(String.fromCharCode(...bytes));

/** An ephemeral Ed25519 pair the test signs with (seam swaps the pinned key). */
async function ephemeralKeyPair() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
  return { kp, spkiB64: bytesToB64(spki) };
}

async function signManifest(kp, manifest) {
  const sig = new Uint8Array(
    await crypto.subtle.sign('Ed25519', kp.privateKey, encoder.encode(manifestSignaturePayload(manifest))),
  );
  return { algorithm: FW_MANIFEST_SIGNATURE_ALGORITHM, value: bytesToB64(sig) };
}

test('manifestSignaturePayload pins the line-oriented canonical string', () => {
  // The release pipeline reproduces this exact string in one printf; any
  // change here is a breaking change to both sides at once.
  assert.equal(
    manifestSignaturePayload(MANIFEST),
    [FW_MANIFEST_SIGNATURE_PREFIX, '4.2.0', 'LipSync_Firmware_4.2.0_dfu.zip', '257566', 'a'.repeat(64)].join('\n') +
      '\n',
  );
});

test('manifestSignaturePayload refuses fields it cannot canonicalize unambiguously', () => {
  assert.throws(() => manifestSignaturePayload({}), /no DFU package entry/);
  assert.throws(() => manifestSignaturePayload({ ...MANIFEST, firmwareVersion: '' }), /firmware version/);
  assert.throws(() => manifestSignaturePayload({ ...MANIFEST, firmwareVersion: '4.2\n.0' }), /malformed/);
  assert.throws(
    () => manifestSignaturePayload({ ...MANIFEST, files: { dfu: { ...MANIFEST.files.dfu, fileName: 'a\nb.zip' } } }),
    /file name/,
  );
  // Only the lowercase-hex shape the pipeline publishes is signable: an
  // odd checksum is not worth vouching for.
  assert.throws(
    () => manifestSignaturePayload({ ...MANIFEST, files: { dfu: { ...MANIFEST.files.dfu, sha256: 'A'.repeat(64) } } }),
    /checksum is malformed/,
  );
  assert.throws(
    () => manifestSignaturePayload({ ...MANIFEST, files: { dfu: { ...MANIFEST.files.dfu, sha256: 'short' } } }),
    /checksum is malformed/,
  );
  assert.throws(
    () => manifestSignaturePayload({ ...MANIFEST, files: { dfu: { ...MANIFEST.files.dfu, sha256: null } } }),
    /checksum/,
  );
});

test('the production pins: a parsable Ed25519 key and a documented staged flag', async () => {
  // The pinned public key must import as the algorithm the verifier uses —
  // a mistyped or truncated constant would otherwise surface only as a
  // fail-closed mystery at install time.
  await crypto.subtle.importKey(
    'spki',
    Uint8Array.from(atob(FW_MANIFEST_SIGNING_PUBLIC_KEY_B64), (c) => c.charCodeAt(0)),
    { name: FW_MANIFEST_SIGNATURE_ALGORITHM },
    false,
    ['verify'],
  );
  // Staged rollout state: unsigned manifests are still installable. Flip
  // this pin (with the README and future-improvements notes) in the same
  // change that makes the release pipeline sign every manifest.
  assert.equal(FW_REQUIRE_SIGNED_MANIFEST, false);
});

test('an unsigned manifest installs only while the staged require flag is off', async (t) => {
  setRequireSignedManifestForTests(false);
  t.after(() => resetManifestSignatureForTests());
  assert.deepEqual(await verifyManifestSignature(MANIFEST), { signed: false, ok: true });

  setRequireSignedManifestForTests(true);
  const refused = await verifyManifestSignature(MANIFEST);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /does not publish a firmware signature/);
});

test('a manifest signed by the pinned key verifies', async (t) => {
  const { kp, spkiB64 } = await ephemeralKeyPair();
  setManifestSigningKeyForTests(spkiB64);
  t.after(() => resetManifestSignatureForTests());

  const signature = await signManifest(kp, MANIFEST);
  const r = await verifyManifestSignature({ ...MANIFEST, signature });
  assert.deepEqual(r, { signed: true, ok: true });

  // The signature also satisfies the required mode — a signed ecosystem
  // must keep working once the staged flag flips.
  setRequireSignedManifestForTests(true);
  const required = await verifyManifestSignature({ ...MANIFEST, signature });
  assert.deepEqual(required, { signed: true, ok: true });
});

test('a signature does not vouch for bytes it was not made over', async (t) => {
  // Sign MANIFEST, then present modified manifests carrying that
  // signature: every security-relevant field is bound by the payload.
  const { kp, spkiB64 } = await ephemeralKeyPair();
  setManifestSigningKeyForTests(spkiB64);
  t.after(() => resetManifestSignatureForTests());
  const signature = await signManifest(kp, MANIFEST);

  const swaps = {
    'a swapped firmwareVersion': { ...MANIFEST, firmwareVersion: '9.9.9' },
    'a swapped DFU file name': {
      ...MANIFEST,
      files: { dfu: { ...MANIFEST.files.dfu, fileName: 'Other_Firmware_dfu.zip' } },
    },
    'a swapped checksum': {
      ...MANIFEST,
      files: { dfu: { ...MANIFEST.files.dfu, sha256: 'b'.repeat(64) } },
    },
  };
  for (const [what, manifest] of Object.entries(swaps)) {
    const r = await verifyManifestSignature({ ...manifest, signature });
    assert.equal(r.ok, false, what);
    assert.match(r.message, /did not verify against its firmware signature/);
  }
});

test('unrecognized or unparsable signature shapes fail closed', async (t) => {
  setRequireSignedManifestForTests(false);
  t.after(() => resetManifestSignatureForTests());
  const shapes = [
    { what: 'a wrong algorithm', signature: { algorithm: 'ecdsa-p256', value: 'AAAA' } },
    { what: 'a missing value', signature: { algorithm: FW_MANIFEST_SIGNATURE_ALGORITHM } },
    { what: 'a bare string', signature: 'AAAA' },
    { what: 'non-base64 garbage', signature: { algorithm: FW_MANIFEST_SIGNATURE_ALGORITHM, value: '!!not base64!!' } },
    {
      what: 'a signature of the wrong length',
      signature: { algorithm: FW_MANIFEST_SIGNATURE_ALGORITHM, value: bytesToB64(new Uint8Array(10)) },
    },
  ];
  for (const { what, signature } of shapes) {
    const r = await verifyManifestSignature({ ...MANIFEST, signature });
    assert.equal(r.ok, false, what);
    assert.match(r.message, /refusing to install it/);
  }
});
