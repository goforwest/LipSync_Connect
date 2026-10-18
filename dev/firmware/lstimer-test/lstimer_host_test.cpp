// Host-side unit test for LSTimer<T> — the firmware's header-only timer
// pool, compiled and run on the development machine with a controllable
// millis() shim (bench follow-up 2026-10-18, pool hygiene).
//
// LSTimer is pure logic over (millis(), an array of timer_t slots): no
// Arduino APIs beyond millis()/Serial/memset, so the REAL header from the
// paired firmware checkout compiles as-is under a host C++ compiler. That
// buys three things the bench cannot:
//   1. Semantic lock-down: interval cadence, startDelay offsets, disable/
//      enable, delete, RUN_ONCE/RUN_FOREVER/n-run — with VIRTUAL time, so a
//      10-minute soak costs microseconds.
//   2. Regression tests for every bug fixed in the hygiene pass: the
//      immediate-first-fire of startDelay=0 intervals, the stopwatch slot
//      stealing, the out-of-bounds -1 timer-id operations (which the
//      AddressSanitizer build turns from "silent corruption" into a hard
//      test failure), the single-static method-timer collision, and the
//      mid-response deleteTimer prints.
//   3. A REPRODUCTION ATTEMPT for the safe-mode interval death (bench
//      2026-10-18): the heartbeat capture proved the watchdog feed's 5 s
//      interval on the shared pollTimer pool fired once after boot, then
//      never again while the main loop kept running. The soak below sets up
//      the exact boot pool (9 registrations, ids 0..8), disables the exact
//      ids toggleSafeMode disables (PRESSURE=1, JOYSTICK=0, SCROLL=5,
//      DEBUG=4, BLUETOOTH=3) plus the setup-disabled USB timer (7), and
//      runs 10 minutes of virtual time — if the pool's own logic can kill
//      an interval, this finds it.
//
// Build/run: dev/firmware/lstimer-test/run.sh (clang++ or g++, with
// AddressSanitizer + UBSan when the toolchain supports them).

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>

// ---- Arduino shims ----------------------------------------------------------
typedef bool boolean;  // The Arduino boolean alias LSTimer.h is written against.

static unsigned long g_mockMillis = 0;
unsigned long millis() { return g_mockMillis; }

// Serial shim: captures everything so tests can assert the production
// behavior of the rate-limited prints (exactly one refusal line per window,
// nothing at all from deleteTimer / invalid-id paths — the old prints
// corrupted live serial responses mid-line during the LK remote walk).
struct SerialShim {
  std::string out;
  SerialShim& print(const char* s) {
    out += s;
    return *this;
  }
  SerialShim& print(int v) {
    char buf[24];
    snprintf(buf, sizeof(buf), "%d", v);
    out += buf;
    return *this;
  }
  SerialShim& print(unsigned v) {
    char buf[24];
    snprintf(buf, sizeof(buf), "%u", v);
    out += buf;
    return *this;
  }
  SerialShim& print(unsigned long v) {
    char buf[24];
    snprintf(buf, sizeof(buf), "%lu", v);
    out += buf;
    return *this;
  }
  SerialShim& println(const char* s) {
    out += s;
    out += '\n';
    return *this;
  }
  SerialShim& println(int v) {
    print(v);
    out += '\n';
    return *this;
  }
};
static SerialShim Serial;

#include "LSTimer.h"  // The real firmware header, under test

// ---- Tiny assert harness ------------------------------------------------------
static int g_failures = 0;
static int g_checks = 0;
#define CHECK(cond)                                                                                                 \
  do {                                                                                                              \
    g_checks++;                                                                                                    \
    if (!(cond)) {                                                                                                 \
      g_failures++;                                                                                                 \
      printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);                                                       \
    }                                                                                                              \
  } while (0)
#define CHECK_EQ(a, b)                                                                                              \
  do {                                                                                                             \
    g_checks++;                                                                                                    \
    if (!((a) == (b))) {                                                                                           \
      g_failures++;                                                                                                 \
      long long va_ = (long long)(a), vb_ = (long long)(b);                                                        \
      printf("FAIL %s:%d: %s == %s (got %lld, want %lld)\n", __FILE__, __LINE__, #a, #b, va_, vb_);                 \
    }                                                                                                              \
  } while (0)

// ---- Test state: LSTimer takes plain function pointers, so counters live at
// file scope (a capturing lambda cannot convert to a function pointer) and
// each test resets them. g_mockMillis resets per block because the pool
// anchors every previousTime to millis() at construction/registration.
static int g_fires = 0;
static unsigned long g_lastFire = 0;
static void bump() { g_fires++; }
static void bumpStamp() {
  g_fires++;
  g_lastFire = g_mockMillis;
}

// Run the pool at every t in [from, to] with the given step — the same call
// pattern loop() produces. With step < interval each interval fires at most
// once per boundary, so fire counts are exact.
static void soak(LSTimer<void>& pool, unsigned long from, unsigned long to, unsigned long step) {
  for (unsigned long t = from; t <= to; t += step) {
    g_mockMillis = t;
    pool.run();
  }
}

int main() {
  // ---- 1. Interval cadence: no immediate first fire (the semantic fix) ---
  // OLD behavior (startDelayEnabled=true even for startDelay=0): every
  // interval fired once at the FIRST run() pass — the watchdog feed ran at
  // t=0, the joystick/pressure polls read before their sensors settled, and
  // a timer disabled before its first tick never advanced its previousTime
  // (delay 0 adds 0). The fix: startDelay>0 enables the offset; 0 means a
  // clean interval-only cadence.
  {
    g_mockMillis = 0;
    LSTimer<void> pool;
    g_fires = 0;
    int id = pool.setInterval(100, 0, bump);
    CHECK(id >= 0);
    soak(pool, 0, 50, 5);
    CHECK_EQ(g_fires, 0);  // nothing at t=0 — the OLD code fired here
    soak(pool, 50, 1000, 5);
    CHECK_EQ(g_fires, 10);  // 100..1000, exactly on cadence
    CHECK_EQ(pool.getNumRuns(id), 10);
  }

  // ---- 2. startDelay > 0 keeps the offset semantics -------------------------
  // First fire at startDelay, then every interval (the LED blink offsets
  // rely on this).
  {
    g_mockMillis = 0;
    LSTimer<void> pool;
    g_fires = 0;
    g_lastFire = 0;
    pool.setInterval(100, 250, bumpStamp);
    soak(pool, 0, 1000, 5);
    CHECK_EQ(g_fires, 8);       // 250, 350, ..., 950
    CHECK_EQ(g_lastFire, 950);
    g_fires = 0;
    soak(pool, 1000, 1050, 5);
    CHECK_EQ(g_fires, 1);  // 1050: still on the 100 ms cadence
    CHECK_EQ(g_lastFire, 1050);
  }

  // ---- 3. setTimeout: RUN_ONCE, then the slot frees ---------------------------
  {
    g_mockMillis = 0;
    LSTimer<void> pool;
    g_fires = 0;
    int id = pool.setTimeout(150, bump);
    CHECK(id >= 0);
    soak(pool, 0, 149, 1);
    CHECK_EQ(g_fires, 0);
    soak(pool, 149, 1000, 1);
    CHECK_EQ(g_fires, 1);  // fired once...
    soak(pool, 1000, 2000, 1);
    CHECK_EQ(g_fires, 1);  // ...and never again (deleted itself)
    CHECK_EQ(pool.getNumTimers(), 0);
    CHECK(pool.timer[id].callback == NULL);  // slot reusable
  }

  // ---- 4. setTimer: n runs at the offset, then auto-delete --------------------
  {
    g_mockMillis = 0;
    LSTimer<void> pool;
    g_fires = 0;
    g_lastFire = 0;
    int id = pool.setTimer(100, 50, 3, bumpStamp);
    CHECK(id >= 0);
    soak(pool, 0, 1000, 5);
    CHECK_EQ(g_fires, 3);  // 50, 150, 250
    CHECK_EQ(g_lastFire, 250);
    CHECK_EQ(pool.getNumTimers(), 0);
    CHECK(pool.timer[id].callback == NULL);
  }

  // ---- 5. Disable / enable: cadence holds, no burst on resume -----------------
  // The OLD code froze a never-fired timer's previousTime (delay 0 adds 0
  // while disabled), so a later enable burst-fired the entire missed span
  // once per loop pass. The new code advances previousTime by the interval
  // while disabled, so enable resumes within ONE interval.
  {
    g_mockMillis = 0;
    LSTimer<void> pool;
    g_fires = 0;
    int id = pool.setInterval(100, 0, bump);
    pool.disable(id);
    soak(pool, 0, 60000, 5);
    CHECK_EQ(g_fires, 0);  // disabled: never fires
    pool.enable(id);
    g_fires = 0;
    soak(pool, 60000, 60100, 5);
    CHECK_EQ(g_fires, 1);  // resumes within one interval — not a burst
    g_fires = 0;
    soak(pool, 60100, 61000, 5);
    CHECK_EQ(g_fires, 9);  // then steady on cadence
    // While disabled mid-interval the anchor keeps advancing: disable for a
    // PARTIAL interval, re-enable, still one fire per interval.
    pool.disable(id);
    soak(pool, 61000, 61040, 5);  // 40 ms into a 100 ms interval
    pool.enable(id);
    g_fires = 0;
    soak(pool, 61040, 61100, 5);
    CHECK_EQ(g_fires, 1);  // the boundary lands inside, exactly once
  }

  // ---- 6. deleteTimer frees the slot, and delete is SILENT --------------------
  // The old "ERROR: No timers are in use." printed MID-RESPONSE during the
  // LK remote walk (deleteTimer runs inside run()'s callback pass and inside
  // the serial API). Production delete paths must not print at all.
  {
    g_mockMillis = 0;
    LSTimer<void> pool;
    Serial.out.clear();
    pool.deleteTimer(0);  // empty pool: silent no-op (the old code printed here)
    int id = pool.setInterval(100, 0, bump);
    g_fires = 0;
    pool.deleteTimer(id);
    soak(pool, 0, 1000, 5);
    CHECK_EQ(g_fires, 0);  // deleted: never fires
    CHECK_EQ(pool.getNumTimers(), 0);
    int id2 = pool.setInterval(100, 0, bump);
    CHECK_EQ(id2, id);  // first-free-slot reuse
    pool.deleteTimer(id2);
    CHECK_EQ(Serial.out.size(), 0);  // nothing printed by any of this
  }

  // ---- 7. Negative / out-of-range ids are safe, counted, silent ----------------
  // The old code checked only the upper bound: deleteTimer(-1) memset 44
  // bytes BEFORE the array (corrupting an adjacent global and numTimers),
  // restartTimer(-1) wrote out of bounds, getNumRuns(-1) read out of bounds
  // with NO check at all — all reachable via a refused registration's
  // stored -1 (LSInput/LSPressure state machines, LSScreen transitions). The
  // sanitizer build fails the process outright on any survivor of this class.
  {
    g_mockMillis = 0;
    LSTimer<void> pool;
    Serial.out.clear();
    pool.deleteTimer(-1);
    pool.enable(-1);
    pool.disable(-1);
    pool.toggle(-1);
    pool.restartTimer(-1);
    pool.deleteTimer(9999);
    CHECK_EQ(pool.elapsedTime(-1), 0);
    CHECK(!pool.isEnabled(-1));
    CHECK_EQ(pool.getNumRuns(-1), 0);
    CHECK_EQ(pool.getInvalidOperations(), 9);
    CHECK_EQ(Serial.out.size(), 0);  // every path silent in production
    // The pool still works after all of the above:
    g_fires = 0;
    pool.setInterval(100, 0, bump);
    soak(pool, 0, 500, 5);
    CHECK_EQ(g_fires, 5);
  }

  // ---- 8. Pool exhaustion: refused registrations are loud ONCE, counted -------
  {
    g_mockMillis = 0;
    LSTimer<void> pool;
    Serial.out.clear();
    int ids[20];
    for (int i = 0; i < 16; i++) {  // MAX_TIMERS == 16
      ids[i] = pool.setInterval(1000, 0, bump);
      CHECK(ids[i] >= 0);
    }
    CHECK_EQ(pool.getNumTimers(), 16);
    CHECK_EQ(pool.getNumAvailableTimers(), 0);
    for (int i = 16; i < 20; i++) ids[i] = pool.setInterval(1000, 0, bump);
    CHECK_EQ(ids[16], -1);
    CHECK_EQ(ids[17], -1);
    CHECK_EQ(pool.getRefusedRegistrations(), 4);
    // Rate-limited: 4 refusals in the same 30 s window printed ONE line
    // (and t=0 is handled — the first refusal prints immediately).
    CHECK_EQ(std::count(Serial.out.begin(), Serial.out.end(), '\n'), 1);
    // Outside the window, the next refusal prints again (still not per call).
    g_mockMillis = 31000;
    pool.setInterval(1000, 0, bump);
    CHECK_EQ(pool.getRefusedRegistrations(), 5);
    CHECK_EQ(std::count(Serial.out.begin(), Serial.out.end(), '\n'), 2);
    // Freeing one slot makes room again.
    pool.deleteTimer(ids[0]);
    CHECK_EQ(pool.setInterval(1000, 0, bump), ids[0]);
  }

  // ---- 9. Stopwatch slots are not stolen by later registrations ---------------
  // A startTimer() slot holds callback == NULL — the SAME marker the pool
  // uses for "free". The old findFirstFreeSlot handed that slot to the next
  // registration, silently repurposing the stopwatch (elapsedTime then
  // reported the new timer's schedule) while numTimers double-counted. The
  // stopwatch bitmap keeps the slot reserved.
  {
    g_mockMillis = 0;
    LSTimer<void> pool;
    Serial.out.clear();
    int watch = pool.startTimer();
    CHECK(watch >= 0);
    int other = pool.setInterval(100, 0, bump);
    CHECK(other != watch);  // THE regression: the old code returned watch's slot
    CHECK_EQ(pool.getNumTimers(), 2);
    g_mockMillis = 500;
    CHECK_EQ(pool.elapsedTime(watch), 500);  // stopwatch still anchored at ITS start
    pool.deleteTimer(other);
    g_mockMillis = 600;
    CHECK_EQ(pool.elapsedTime(watch), 600);  // deleting the other timer did not touch it
    CHECK_EQ(pool.getNumTimers(), 1);
    pool.deleteTimer(watch);
    CHECK_EQ(pool.getNumTimers(), 0);
    CHECK_EQ(Serial.out.size(), 0);
  }

  // ---- 10. Method timers: two pending methods on one class never collide ------
  // The old TimerCallbackHelper stored the method pointer in ONE static per
  // class, so the second registration redirected the first's continuation —
  // exactly what LSScreen's degraded-boot pages can schedule (safeModeMenu
  // pending while errorPageCable is, too). The trampoline bakes the method
  // into the callback's type, so each pending timer runs its own method.
  {
    g_mockMillis = 0;
    struct Page {
      int safeMenuFires = 0;
      int errorPageFires = 0;
      void safeMenuContinuation() { safeMenuFires++; }
      void errorPageContinuation() { errorPageFires++; }
    } page;
    LSTimer<void> pool;
    int t1 = pool.setTimeout<Page, &Page::safeMenuContinuation>(300, &page);
    int t2 = pool.setTimeout<Page, &Page::errorPageContinuation>(150, &page);
    CHECK(t1 >= 0);
    CHECK(t2 >= 0);
    soak(pool, 0, 1000, 5);
    CHECK_EQ(page.safeMenuFires, 1);    // each timer fired once...
    CHECK_EQ(page.errorPageFires, 1);  // ...running its OWN method, not the last-registered one
  }

  // ---- 11. numRuns wrap: the 16-bit wrap keeps the timer firing ----------------
  // The pool wraps numRuns at MAX_INT-1 to preserve even/odd blink parity
  // (the LED blink effect keys off it). A timer that crosses the wrap must
  // keep firing and reporting runs.
  {
    g_mockMillis = 0;
    LSTimer<void> pool;
    g_fires = 0;
    int id = pool.setInterval(1, 0, bump);
    soak(pool, 0, 70000, 1);  // 70001 runs > 65535: crosses the wrap
    CHECK(g_fires > 65535);
    CHECK(pool.isEnabled(id));
    g_fires = 0;
    soak(pool, 70000, 70500, 1);
    CHECK_EQ(g_fires, 500);  // still firing every ms after the wrap
  }

  // ---- 12. millis() rollover: NOT testable on the host --------------------------
  // The pool's arithmetic (`current - previousTime`, `previousTime += delay`)
  // is unsigned and therefore wrap-safe by construction ON THE TARGET, where
  // unsigned long is 32 bits. The host ABI (macOS arm64) makes unsigned long
  // 64 bits, so a "wrapped" millis() produces a 64-bit negative difference
  // that wraps to 2^64-scale — the pool would fire every pass — and the test
  // would assert target behavior it cannot actually emulate. Rather than a
  // test that lies, the wrap correctness rests on the arithmetic itself and
  // on the 32-bit target's bench soak; do not re-add a rollover case here
  // unless the shim can force 32-bit unsigned long semantics.

  // ---- 13. THE SAFE-MODE REPRODUCTION ATTEMPT -----------------------------------
  // The bench mystery (2026-10-18): in a safe-mode boot the watchdog feed's
  // 5 s interval on the shared pollTimer pool fired once after boot, then
  // never again while the main loop kept printing heartbeats — and the 30 s
  // hardware watchdog then reset the device, unbreakably, until the cable
  // was re-seated (fixed symptomatically by feeding the watchdog from
  // loop() in ac90b08; the underlying pool death stayed unexplained).
  // This soak reconstructs the exact pool state: all nine boot
  // registrations in setup() order with their real intervals, then
  // toggleSafeMode's disables (PRESSURE=1, JOYSTICK=0, SCROLL=5, DEBUG=4,
  // BLUETOOTH=3) plus the setup-time USB disable (7), then ten minutes of
  // virtual time at the loop's ~5 ms granularity. If the pool's own logic
  // can stop an interval, one of these checks fails.
  {
    g_mockMillis = 0;
    LSTimer<void> pool;
    Serial.out.clear();
    int idJoystick = pool.setInterval(20, 0, bump);    // 0 joystick (CONF_JOYSTICK_POLL_RATE)
    pool.setInterval(50, 0, bump);                     // 1 pressure (CONF_PRESSURE_POLL_RATE)
    int idInput = pool.setInterval(20, 0, bump);       // 2 input (CONF_INPUT_POLL_RATE)
    pool.setInterval(1000, 0, bump);                   // 3 bluetooth (CONF_BT_FEEDBACK_POLL_RATE)
    pool.setInterval(100, 0, bump);                   // 4 debug (CONF_DEBUG_POLL_RATE)
    pool.setInterval(30, 0, bump);                     // 5 scroll (CONF_SCROLL_POLL_RATE)
    int idScreen = pool.setInterval(20, 0, bump);      // 6 screen (CONF_SCREEN_POLL_RATE)
    pool.setInterval(1000, 0, bump);                   // 7 usb (CONF_USB_POLL_RATE)
    int idWatchdog = pool.setInterval(5000, 0, bump);  // 8 watchdog (CONF_WATCHDOG_POLL_RATE)
    CHECK_EQ(idJoystick, 0);   // Slot ids must match the CONF_TIMER_* constants —
    CHECK_EQ(idInput, 2);     // the .ino disables by CONSTANT, and a shifted
    CHECK_EQ(idScreen, 6);   // pool would disable the WRONG loop.
    CHECK_EQ(idWatchdog, 8);
    pool.disable(1);  // toggleSafeMode: PRESSURE
    pool.disable(0);  // JOYSTICK
    pool.disable(5);  // SCROLL
    pool.disable(4);  // DEBUG
    pool.disable(3);  // BLUETOOTH
    pool.disable(7);  // USB (disabled at setup, "until implemented")
    g_fires = 0;
    soak(pool, 0, 600000, 5);  // ten minutes
    CHECK_EQ(pool.getNumRuns(idWatchdog), 120);  // 600000/5000: the feed NEVER missed a beat
    CHECK_EQ(pool.getNumRuns(idInput), 30000);   // input at 20 ms, every tick
    CHECK_EQ(pool.getNumRuns(idScreen), 30000);  // screen at 20 ms
    CHECK_EQ(g_fires, 60120);                    // 120 + 30000 + 30000 — and nothing else
    CHECK_EQ(pool.getNumRuns(0), 0);  // the disabled set never fired...
    CHECK_EQ(pool.getNumRuns(1), 0);
    CHECK_EQ(pool.getNumRuns(3), 0);
    CHECK_EQ(pool.getNumRuns(4), 0);
    CHECK_EQ(pool.getNumRuns(5), 0);
    CHECK_EQ(pool.getNumRuns(7), 0);
    CHECK_EQ(pool.getRefusedRegistrations(), 0);  // pool never exhausted
    CHECK_EQ(pool.getInvalidOperations(), 0);    // no corrupt id traffic
    CHECK_EQ(Serial.out.size(), 0);               // and it never said a word
    CHECK(pool.isEnabled(idWatchdog));
    // Leaving safe mode: the disabled set resumes within one interval, no
    // burst (the old code could catch-up-fire the whole disabled span).
    pool.enable(0);
    unsigned int joystickRunsBefore = (unsigned int)pool.getNumRuns(0);
    soak(pool, 600000, 610000, 5);
    int joystickDelta = pool.getNumRuns(0) - (int)joystickRunsBefore;
    CHECK(joystickDelta >= 450 && joystickDelta <= 500);  // ~10 s at 20 ms — not a 30 000-fire burst
  }

  printf("LSTimer host test: %d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
