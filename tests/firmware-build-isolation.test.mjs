// The local firmware builder must not inherit arbitrary Arduino libraries from
// a developer's sketchbook. A user-installed TinyUSB 3.7.3 once overrode the
// Seeed 1.1.13 core's bundled 1.7.0, so the hardware-tested local image and CI
// release were different binaries despite identical LipSync source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = readFileSync(path.join(root, 'dev/firmware/build-firmware.sh'), 'utf8');

test('local firmware build uses an isolated Arduino sketchbook and proves TinyUSB provenance', () => {
  const isolateAt = script.indexOf('export ARDUINO_DIRECTORIES_USER="$isolated_user_dir"');
  const compileAt = script.indexOf('arduino-cli compile');
  assert.ok(isolateAt >= 0 && isolateAt < compileAt, 'the isolated user directory must be active before compilation');
  assert.match(script, /libraries\.cache/);
  assert.match(script, /expected Seeed core TinyUSB 1\.7\.0/);
  assert.match(script, /libraries outside the core\/vendored\/isolated roots leaked into the build/);
});

test('local firmware build pins the complete release external-library set', () => {
  const pins = [...script.matchAll(/"([^"\n]+@\d+\.\d+\.\d+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(pins, [
    'Adafruit BusIO@1.17.4',
    'Adafruit GFX Library@1.12.6',
    'Adafruit LPS2X@2.0.6',
    'Adafruit LPS35HW@1.0.6',
    'Adafruit SSD1306@2.5.17',
    'Adafruit Unified Sensor@1.1.15',
    'ArduinoJson@7.4.3',
  ]);
  assert.match(script, /arduino-cli lib install --no-deps/);
});
