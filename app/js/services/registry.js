// One-place registry for the per-endpoint value renderers. Producers
// (plotting modules, ui/values) register their entry at import time; the
// consumer (serial/device.js) reads them. This is what keeps the module
// graph acyclic — serial/ never imports plotting/ directly.
/** @type {Record<string, (v: any) => void>} */
export const ENDPOINT_RENDERERS = {};

/** @param {string} key @param {(v: any) => void} fn */
export function registerEndpointRenderer(key, fn) {
  ENDPOINT_RENDERERS[key] = fn;
}
