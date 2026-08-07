// Operating/communication mode state reported by the device (OM/CM endpoints).
// Explicitly owned here so every reader/writer shares one source of truth —
// mode switching logic (services/mode-switch.js) and the OM/CM response
// renderers both mutate through these bindings.
// Sealed: { currentOpMode, currentComMode } is the fixed contract.
export const modeState = Object.seal({
  /** @type {string|null} */ currentOpMode: null,
  /** @type {string|null} */ currentComMode: null,
});
