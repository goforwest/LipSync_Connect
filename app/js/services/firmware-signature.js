// Release-manifest signature verification: the trust layer above the sha256
// checksum. The checksum proves the bytes that arrived are the bytes the
// manifest describes; it cannot prove the manifest itself is ours — the
// manifest travels in the same repo it vouches for, so a compromised
// upstream repo or release workflow could publish arbitrary firmware with a
// perfectly valid checksum. A signature closes that: the release pipeline
// signs the manifest with an Ed25519 private key that exists only in CI
// secrets, and the app verifies against the public key pinned in app code
// (config/constants.js) — key material that ships with the app, out of
// reach of the repo it vouches for.
//
// Staged rollout: signed manifests are verified and enforced now; unsigned
// manifests are still accepted while FW_REQUIRE_SIGNED_MANIFEST is false,
// so today's releases keep installing. Once the pipeline signs every
// release, the flag flips (an app release) and unsigned manifests are
// refused too.
//
// The signed payload is deliberately line-oriented so the pipeline can
// reproduce it in one printf: prefix, firmwareVersion, dfu.fileName,
// dfu.size, dfu.sha256 — one per line, trailing newline, UTF-8. Only the
// fields the app actually trusts for an install are bound; release notes
// and URLs are display-only and already rendered through the sanitizer.
import {
  FW_MANIFEST_SIGNATURE_ALGORITHM,
  FW_MANIFEST_SIGNATURE_PREFIX,
  FW_MANIFEST_SIGNING_PUBLIC_KEY_B64,
  FW_REQUIRE_SIGNED_MANIFEST,
} from '../config/constants.js';

/** @type {string} SPKI (base64) of the public key verifies are made against. */
let signingKeyB64 = FW_MANIFEST_SIGNING_PUBLIC_KEY_B64;
/** @type {boolean} Mirror of the production flag; tests may flip it. */
let requireSigned = FW_REQUIRE_SIGNED_MANIFEST;

/** Test seam: swaps the pinned public key (tests sign with their own pair). */
export function setManifestSigningKeyForTests(spkiBase64) {
  signingKeyB64 = spkiBase64;
}

/** Test seam: flips the unsigned-manifest requirement. */
export function setRequireSignedManifestForTests(required) {
  requireSigned = required;
}

/** Restores the production key and requirement flag (test teardown). */
export function resetManifestSignatureForTests() {
  signingKeyB64 = FW_MANIFEST_SIGNING_PUBLIC_KEY_B64;
  requireSigned = FW_REQUIRE_SIGNED_MANIFEST;
}

/** @param {string} s */
function requireLineField(s, what) {
  if (typeof s !== 'string' || s.length === 0) {
    throw new Error(`The firmware manifest is missing ${what}.`);
  }
  if (s.includes('\n')) throw new Error(`The firmware manifest's ${what} is malformed.`);
  return s;
}

/**
 * The exact string the release pipeline signs and the app verifies:
 *   <prefix>\n<firmwareVersion>\n<dfu.fileName>\n<dfu.size>\n<dfu.sha256>\n
 * The strict sha256 shape mirrors what the release pipeline publishes; a
 * manifest too odd to canonicalize is a manifest too odd to vouch for.
 * (The input shape is deliberately tolerant — the manifest is untrusted
 * until verified, and the runtime validation below is the gate.)
 * @param {{ firmwareVersion?: string, files?: { dfu?: { fileName?: string, size?: number, sha256?: string } } }} manifest
 * @returns {string}
 */
export function manifestSignaturePayload(manifest) {
  const dfu = manifest?.files?.dfu;
  if (!dfu) throw new Error('The firmware manifest has no DFU package entry.');
  const sha256 = requireLineField(dfu.sha256, 'DFU checksum');
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('The firmware manifest DFU checksum is malformed.');
  return (
    [
      FW_MANIFEST_SIGNATURE_PREFIX,
      requireLineField(manifest?.firmwareVersion, 'firmware version'),
      requireLineField(dfu.fileName, 'DFU file name'),
      String(dfu.size ?? ''),
      sha256,
    ].join('\n') + '\n'
  );
}

/** @param {string} b64 */
function base64ToBytes(b64) {
  const clean = String(b64).replace(/\s+/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Verifies the manifest's signature (when present) against the pinned key.
 * Everything that can go wrong — a missing required signature, a format we
 * do not recognize, a key/signature we cannot parse, a browser without the
 * crypto primitive — fails CLOSED: the install is refused, never waved
 * through on the theory that the bytes probably came from GitHub anyway.
 * @param {{ firmwareVersion?: string, files?: { dfu?: { fileName?: string, size?: number, sha256?: string } }, signature?: { algorithm?: string, value?: string } }} manifest
 * @returns {Promise<{ signed: boolean, ok: boolean, message?: string }>}
 */
export async function verifyManifestSignature(manifest) {
  const signature = manifest?.signature;
  if (!signature) {
    if (requireSigned) {
      return {
        signed: false,
        ok: false,
        message: 'The latest release does not publish a firmware signature — refusing to install it.',
      };
    }
    return { signed: false, ok: true };
  }
  // A manifest claiming a signature in any other shape is not one of ours.
  if (
    typeof signature !== 'object' ||
    signature.algorithm !== FW_MANIFEST_SIGNATURE_ALGORITHM ||
    typeof signature.value !== 'string' ||
    signature.value.length === 0
  ) {
    return {
      signed: true,
      ok: false,
      message: 'The latest release carries a firmware signature in an unrecognized format — refusing to install it.',
    };
  }
  let payload;
  try {
    payload = manifestSignaturePayload(manifest);
  } catch (e) {
    return { signed: true, ok: false, message: /** @type {Error} */ (e).message };
  }
  try {
    const key = await crypto.subtle.importKey(
      'spki',
      base64ToBytes(signingKeyB64),
      { name: FW_MANIFEST_SIGNATURE_ALGORITHM },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      FW_MANIFEST_SIGNATURE_ALGORITHM,
      key,
      base64ToBytes(signature.value),
      new TextEncoder().encode(payload),
    );
    if (!valid) {
      return {
        signed: true,
        ok: false,
        message: 'The latest release did not verify against its firmware signature — refusing to install it.',
      };
    }
    return { signed: true, ok: true };
  } catch {
    // Unparsable key/signature, or a browser without Ed25519 in Web Crypto.
    return {
      signed: true,
      ok: false,
      message:
        'The latest release\u2019s firmware signature could not be checked by this browser — refusing to install it.',
    };
  }
}
