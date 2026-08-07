// prefers-reduced-motion check, shared by the section-open animations and the
// self-test panel scroll. Guards matchMedia (like ui/theme.js) so headless
// test environments without a media-query API default to "no preference".
export function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
}
