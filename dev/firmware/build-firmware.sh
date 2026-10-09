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
  --build-cache-path "$cache_dir" \
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

echo "==> Done: $OUT_DIR"
ls -l "$OUT_DIR"
