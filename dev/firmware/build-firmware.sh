#!/bin/sh
# Builds the LipSync firmware and produces flashable artifacts for the
# browser updater:
#   LipSync_Firmware_<version>_dfu.zip   adafruit-nrfutil serial-DFU package (desktop Web Serial)
#   LipSync_Firmware_<version>.uf2       UF2 image (Android WebUSB / bootloader drag-drop)
#   LipSync_Firmware_<version>.hex        raw Intel HEX
#   manifest.json                        version + sha256 + sizes (update-check source of truth)
#
# Usage: dev/firmware/build-firmware.sh
# Env overrides: FIRMWARE_REPO (default ~/lipsync), OUT_DIR, FQBN
#
# This script is the local twin of the lipsync repo's CI workflow; keep the
# compile/package steps identical so local artifacts match release artifacts.
#
# Optional manifest signing (mirrors the release pipeline's signing step):
#   FW_MANIFEST_SIGNING_KEY=/path/to/private.pem dev/firmware/build-firmware.sh
# signs manifest.json with Ed25519; the app verifies signatures against the
# public key pinned in app/js/config/constants.js. The private key must never
# live in either repo — locally it is whatever PEM path you pass, in CI it is
# a secrets-store entry.
#
# uf2conv.py + uf2families.json are vendored byte-identical from
# https://github.com/microsoft/uf2 (utils/, MIT license) so the build has no
# network dependency; re-vendor deliberately and note the source here if
# they are ever refreshed.

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
FIRMWARE_REPO=${FIRMWARE_REPO:-$HOME/lipsync}
SKETCH_DIR="$FIRMWARE_REPO/Build_Files/Firmware_Files/LipSync_Firmware"
FQBN=${FQBN:-Seeeduino:nrf52:xiaonRF52840}
OUT_DIR=${OUT_DIR:-$script_dir/dist}
cache_dir="$script_dir/.cache"

if [ ! -f "$SKETCH_DIR/LipSync_Firmware.ino" ]; then
  echo "Sketch not found at: $SKETCH_DIR" >&2
  echo "Set FIRMWARE_REPO to your lipsync checkout." >&2
  exit 1
fi
command -v arduino-cli >/dev/null 2>&1 || {
  echo "arduino-cli not found. Install it first (brew install arduino-cli)." >&2
  exit 1
}

version=$(
  awk '/^#define[ \t]+CONF_LIPSYNC_VERSION_MAJOR/{printf "%s.", $3}
       /^#define[ \t]+CONF_LIPSYNC_VERSION_MINOR/{printf "%s.", $3}
       /^#define[ \t]+CONF_LIPSYNC_VERSION_REV/{printf "%s", $3}' \
    "$SKETCH_DIR/LSConfig.h"
)
if [ -z "$version" ]; then
  echo "Could not read CONF_LIPSYNC_VERSION_* from $SKETCH_DIR/LSConfig.h" >&2
  exit 1
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR" "$cache_dir"

echo "==> Compiling LipSync firmware $version ($FQBN)"
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT
arduino-cli compile \
  --fqbn "$FQBN" \
  --build-path "$build_dir" \
  --libraries "$FIRMWARE_REPO/Build_Files/Firmware_Files/Libraries" \
  "$SKETCH_DIR"

dfu_zip="$OUT_DIR/LipSync_Firmware_${version}_dfu.zip"
hex_file="$OUT_DIR/LipSync_Firmware_${version}.hex"
uf2_file="$OUT_DIR/LipSync_Firmware_${version}.uf2"

cp "$build_dir/LipSync_Firmware.ino.zip" "$dfu_zip"
cp "$build_dir/LipSync_Firmware.ino.hex" "$hex_file"
echo "==> Generating UF2"
python3 "$script_dir/uf2conv.py" -c -f 0xADA52840 -o "$uf2_file" "$hex_file" >/dev/null

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1; fi
}

echo "==> Writing manifest"
python3 - "$version" "$FQBN" "$OUT_DIR" "$dfu_zip" "$uf2_file" "$hex_file" <<'EOF'
import datetime
import hashlib
import json
import os
import sys

version, fqbn, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
files = {"dfu": sys.argv[4], "uf2": sys.argv[5], "hex": sys.argv[6]}
entry = {}
for kind, path in files.items():
    with open(path, "rb") as f:
        entry[kind] = {
            "fileName": os.path.basename(path),
            "size": os.path.getsize(path),
            "sha256": hashlib.sha256(f.read()).hexdigest(),
        }
manifest = {
    "firmwareVersion": version,
    "fqbn": fqbn,
    "builtAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "files": entry,
}
with open(os.path.join(out_dir, "manifest.json"), "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
EOF

# Optional signing: canonicalize exactly like the app's
# manifestSignaturePayload() (config/constants.js — prefix, version, DFU file
# name, size, sha256, one per line, trailing newline), sign with openssl, and
# embed the base64 signature the app expects.
if [ -n "${FW_MANIFEST_SIGNING_KEY:-}" ]; then
  if [ ! -r "$FW_MANIFEST_SIGNING_KEY" ]; then
    echo "FW_MANIFEST_SIGNING_KEY is not a readable PEM file: $FW_MANIFEST_SIGNING_KEY" >&2
    exit 1
  fi
  command -v openssl >/dev/null 2>&1 || {
    echo "openssl not found — cannot sign the manifest." >&2
    exit 1
  }
  echo "==> Signing manifest (Ed25519)"
  sign_dir=$(mktemp -d)
  python3 - "$OUT_DIR" > "$sign_dir/payload" <<'EOF'
import json, os, sys
with open(os.path.join(sys.argv[1], "manifest.json")) as f:
    m = json.load(f)
sys.stdout.write(
    "lipsync-firmware-manifest-v1\n"
    + m["firmwareVersion"] + "\n"
    + m["files"]["dfu"]["fileName"] + "\n"
    + str(m["files"]["dfu"]["size"]) + "\n"
    + m["files"]["dfu"]["sha256"] + "\n"
)
EOF
  # -rawin: Ed25519 signs the raw message (no pre-hash). OpenSSL 3.5 defaults
  # to raw for Ed25519, but 3.0 runners (ubuntu-latest) require the flag for
  # non-digest-size input — explicit keeps local and CI identical.
  openssl pkeyutl -sign -rawin -inkey "$FW_MANIFEST_SIGNING_KEY" -in "$sign_dir/payload" -out "$sign_dir/sig"
  python3 - "$OUT_DIR" "$sign_dir/sig" <<'EOF'
import base64, json, os, sys
out_dir, sig_path = sys.argv[1], sys.argv[2]
with open(sig_path, "rb") as f:
    value = base64.b64encode(f.read()).decode()
with open(os.path.join(out_dir, "manifest.json")) as f:
    m = json.load(f)
m["signature"] = {"algorithm": "ed25519", "value": value}
with open(os.path.join(out_dir, "manifest.json"), "w") as f:
    json.dump(m, f, indent=2)
    f.write("\n")
EOF
  rm -rf "$sign_dir"
else
  echo "==> Manifest left unsigned (set FW_MANIFEST_SIGNING_KEY=<private.pem> to sign it)"
fi

echo "==> Done: $OUT_DIR"
ls -l "$OUT_DIR"
