// prefers-reduced-motion check, shared by the section-open animations and the
// self-test panel scroll.
export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
