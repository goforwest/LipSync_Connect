#!/bin/sh
# Builds the LipSync firmware and produces flashable artifacts for the
# browser updater:
#   LipSync_Firmware_<version>_dfu.zip   adafruit-nrfutil serial-DFU package (desktop Web Serial)
#   LipSync_Firmware_<version>.uf2       UF2 image (Android WebUSB / bootloader drag-drop)
#   LipSync_Firmware_<version>.hex        raw Intel HEX
#   manifest.json                        version + sha256 + sizes (update-check source of truth)
#
# Usage: dev/firmware/build-firmware.sh
# Env overrides: FIRMWARE_REPO (default ~/lipsync), OUT_DIR, FQBN,
#                ARDUINO_CLI_VERSION, SEEED_CORE_VERSION
#
# This script is the local twin of the lipsync repo's CI workflow; keep the
# compile/package steps identical so local artifacts use the same dependency
# set as release artifacts. The isolated sketchbook below is essential:
# Arduino otherwise gives ~/Documents/Arduino/libraries priority over the
# board core, which let a user-installed TinyUSB 3.7.3 silently replace the
# Seeed 1.1.13 core's bundled and release-canonical TinyUSB 1.7.0.
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
isolated_user_dir="$cache_dir/arduino-user"
ARDUINO_CLI_VERSION=${ARDUINO_CLI_VERSION:-1.3.1}
SEEED_CORE_VERSION=${SEEED_CORE_VERSION:-1.1.13}

if [ ! -f "$SKETCH_DIR/LipSync_Firmware.ino" ]; then
  echo "Sketch not found at: $SKETCH_DIR" >&2
  echo "Set FIRMWARE_REPO to your lipsync checkout." >&2
  exit 1
fi
command -v arduino-cli >/dev/null 2>&1 || {
  echo "arduino-cli not found. Install it first (brew install arduino-cli)." >&2
  exit 1
}

actual_cli_version=$(arduino-cli version | sed -n 's/.*Version: \([^ ]*\).*/\1/p')
if [ "$actual_cli_version" != "$ARDUINO_CLI_VERSION" ]; then
  echo "arduino-cli $ARDUINO_CLI_VERSION is required to match release CI (found ${actual_cli_version:-unknown})." >&2
  exit 1
fi
actual_core_version=$(arduino-cli core list | awk '$1 == "Seeeduino:nrf52" { print $2; exit }')
if [ "$actual_core_version" != "$SEEED_CORE_VERSION" ]; then
  echo "Seeeduino:nrf52@$SEEED_CORE_VERSION is required to match release CI (found ${actual_core_version:-not installed})." >&2
  exit 1
fi

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
mkdir -p "$OUT_DIR" "$isolated_user_dir"

# Use a script-owned Arduino sketchbook. ARDUINO_DIRECTORIES_USER changes only
# the user-library/sketch directory; the board core remains in Arduino's normal
# data directory. Therefore global libraries can neither override core copies
# (especially TinyUSB) nor make a local build differ silently from clean CI.
export ARDUINO_DIRECTORIES_USER="$isolated_user_dir"

echo "==> Preparing isolated CI-pinned libraries"
arduino-cli lib install --no-deps \
  "Adafruit BusIO@1.17.4" \
  "Adafruit GFX Library@1.12.6" \
  "Adafruit LPS2X@2.0.6" \
  "Adafruit LPS35HW@1.0.6" \
  "Adafruit SSD1306@2.5.17" \
  "Adafruit Unified Sensor@1.1.15" \
  "ArduinoJson@7.4.3"

python3 - "$isolated_user_dir/libraries" <<'PY'
import pathlib
import sys

expected = {
    "Adafruit BusIO": "1.17.4",
    "Adafruit GFX Library": "1.12.6",
    "Adafruit LPS2X": "2.0.6",
    "Adafruit LPS35HW": "1.0.6",
    "Adafruit SSD1306": "2.5.17",
    "Adafruit Unified Sensor": "1.1.15",
    "ArduinoJson": "7.4.3",
}
found = {}
for properties in pathlib.Path(sys.argv[1]).glob("*/library.properties"):
    values = {}
    for line in properties.read_text(errors="replace").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    if values.get("name"):
        found[values["name"]] = values.get("version")
for name, version in expected.items():
    if found.get(name) != version:
        raise SystemExit(f"isolated library mismatch: {name} expected {version}, found {found.get(name)!r}")
if "Adafruit TinyUSB Library" in found:
    raise SystemExit("isolated sketchbook must not install TinyUSB; the pinned Seeed core owns it")
print("Pinned external libraries verified in isolated sketchbook.")
PY

echo "==> Compiling LipSync firmware $version ($FQBN)"
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT
arduino-cli compile \
  --fqbn "$FQBN" \
  --build-path "$build_dir" \
  --libraries "$FIRMWARE_REPO/Build_Files/Firmware_Files/Libraries" \
  "$SKETCH_DIR"

# Prove which copy the resolver actually compiled. This fails closed if a
# future Arduino CLI ignores the isolated sketchbook or the Seeed core changes
# its bundled TinyUSB unexpectedly.
python3 - "$build_dir/libraries.cache" "$SEEED_CORE_VERSION" "$isolated_user_dir" "$FIRMWARE_REPO" <<'PY'
import json
import pathlib
import sys

paths = json.loads(pathlib.Path(sys.argv[1]).read_text())
core_version = sys.argv[2]
isolated_libraries = pathlib.Path(sys.argv[3]) / "libraries"
vendored_libraries = pathlib.Path(sys.argv[4]) / "Build_Files" / "Firmware_Files" / "Libraries"
core_fragment = f"/packages/Seeeduino/hardware/nrf52/{core_version}/"
leaks = [
    p
    for p in paths
    if core_fragment not in p.replace("\\", "/")
    and not pathlib.Path(p).is_relative_to(isolated_libraries)
    and not pathlib.Path(p).is_relative_to(vendored_libraries)
]
if leaks:
    raise SystemExit("libraries outside the core/vendored/isolated roots leaked into the build: " + ", ".join(leaks))
tinyusb = [p for p in paths if "Adafruit_TinyUSB" in p]
expected_fragment = f"/Seeeduino/hardware/nrf52/{core_version}/libraries/Adafruit_TinyUSB_Arduino/src"
if len(tinyusb) != 1 or expected_fragment not in tinyusb[0].replace("\\", "/"):
    raise SystemExit(f"expected the Seeed core TinyUSB at {expected_fragment}, resolved {tinyusb}")
properties = pathlib.Path(tinyusb[0]).parent / "library.properties"
version = next(
    (line.split("=", 1)[1].strip() for line in properties.read_text().splitlines() if line.startswith("version=")),
    "unknown",
)
if version != "1.7.0":
    raise SystemExit(f"expected Seeed core TinyUSB 1.7.0, resolved {version}")
print(f"TinyUSB provenance verified: {tinyusb[0]} (version {version}).")
PY

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
