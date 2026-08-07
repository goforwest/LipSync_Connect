// Small timing shim so debounce/announce scheduling is testable and DOM-free
// builds (Node tests) work without requestAnimationFrame/cancelAnimationFrame.
export const timers = {
  cancel: (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id)),
  afterFrame: (fn) =>
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(() => fn(Date.now()), 16),
};
