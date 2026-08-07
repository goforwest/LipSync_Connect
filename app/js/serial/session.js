// Centralized serial session state. Owns the physical connection and the
// command-bus state that both app.js and js/serial/commands.js mutate.
// Kept as mutable exported containers (not getters/classes) so the migration
// stays 1:1 with the previous script-global semantics.
// The exported containers are sealed: their field sets are the public
// contract — extending state means adding a declared field here, which keeps
// shape-by-typo (a classic monolith failure mode) a hard error at write time.
export const serialSession = Object.seal({
  /** @type {any} */ port: null,
  /** @type {any} */ writer: null,
  /** @type {any} */ currentReader: null,
  disconnecting: false,
  readerGeneration: 0,
});

export const serialBus = Object.seal({
  /** @type {{predicate: (line: string) => boolean, resolve: Function, reject: Function, timer?: any}[]} */
  lineWaiters: [],
  /** @type {Promise<any>} */
  cmdQueue: Promise.resolve(),
});

export const pendingSteps = new Set();

// Read-activity watchdog (session-scoped, generation-safe). If no serial data
// arrives for READ_TIMEOUT we surface an advisory (idle is normal). The timer
// lives outside readLoop so writes can reset it without a dead no-op in the
// gap between reader generations. The generation guard ensures a stale
// reader's timer never fires on a new session.
export const readWatchdog = Object.seal({
  /** @type {any} */ timer: null,
  gen: 0,
});

// The settings-service owns the "done" fade-out timer; disconnect clears it
// through this reference so the timer never fires against a dead session.
// Lives here (not in settings-service or connection) because both modules
// import session.js, so the reference is reachable without a module cycle.
export const loadDoneTimerRef = { current: null };

// ---- Test / simulated-transport seam ----
// The firmware simulator in tests/harness/ attaches a fake port through these
// named functions instead of reaching into module state. Production code never
// calls them; they exist so tests don't need an app-wide backdoor. They are
// guarded to the Node test runtime so nothing shipped to a browser can reach
// in and fabricate a session (e.g. from the console).
// The seams only exist for the Node test runtime. `globalThis['process']`
// (bracket form) keeps the check working under the DOM lib in typecheck.
function isNodeRuntime() {
  const nodeProcess = globalThis['process'];
  return typeof nodeProcess !== 'undefined' && !!nodeProcess?.versions?.node;
}
export function injectSerialPort(port, writer) {
  if (!isNodeRuntime()) throw new Error('injectSerialPort is a test-only seam');
  serialSession.port = port;
  serialSession.writer = writer;
}
export function detachSerialPort() {
  if (!isNodeRuntime()) throw new Error('detachSerialPort is a test-only seam');
  serialSession.port = null;
  serialSession.writer = null;
}
export function injectSerialWriter(writeFn) {
  if (!isNodeRuntime()) throw new Error('injectSerialWriter is a test-only seam');
  serialSession.writer = { write: writeFn };
  serialSession.port = serialSession.port || { sim: true };
}
