#!/bin/sh
# Compiles and runs the LSTimer host test against the REAL firmware header.
#
# Usage: dev/firmware/lstimer-test/run.sh
# Env:   FIRMWARE_REPO (default ~/LipSync) — the lipsync checkout whose
#        LSTimer.h is under test. AddressSanitizer + UBSan are enabled when
#        the compiler supports them: the timer-id bugs this suite guards
#        (out-of-bounds timer[-1] writes) are exactly the class of defect
#        that only a sanitizer can turn into a hard, located failure.
#
# Exit status: 0 = all checks pass, non-zero = a check failed (or the
# toolchain could not build the test).
set -eu

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
FIRMWARE_REPO=${FIRMWARE_REPO:-$HOME/LipSync}
HEADER_DIR="$FIRMWARE_REPO/Build_Files/Firmware_Files/LipSync_Firmware"

if [ ! -f "$HEADER_DIR/LSTimer.h" ]; then
  echo "LSTimer.h not found at: $HEADER_DIR" >&2
  echo "Set FIRMWARE_REPO to your lipsync checkout." >&2
  exit 1
fi

# Pick a compiler.
if command -v clang++ >/dev/null 2>&1; then
  CXX=clang++
elif command -v g++ >/dev/null 2>&1; then
  CXX=g++
else
  echo "No C++ compiler found (clang++/g++). Install one to run this gate." >&2
  exit 1
fi

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

san_flags=""
# Sanitizers first: a link failure (or an unsupported platform) falls back
# to a plain build — the suite is still meaningful without them, just less
# likely to catch a regression of the out-of-bounds class.
if echo 'int main(){return 0;}' | $CXX -fsanitize=address,undefined -x c++ - -o "$work_dir/probe" >/dev/null 2>&1; then
  san_flags="-fsanitize=address,undefined -fno-sanitize-recover=all"
fi

echo "==> Building LSTimer host test ($CXX $san_flags)"
$CXX -std=c++17 -Wall -Wextra $san_flags \
  -I"$HEADER_DIR" \
  "$script_dir/lstimer_host_test.cpp" \
  -o "$work_dir/lstimer_host_test"

echo "==> Running"
"$work_dir/lstimer_host_test"
