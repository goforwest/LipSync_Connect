// DOM lookup helpers. Deliberately typed `any` — callers choose purposefully-
// typed IDs and ergonomics matter more than exhaustive per-callback casts.
/** @type {(id: string) => any} */
export const $ = (id) => document.getElementById(id);
// Typed selector for of-the-moment utility lookups (meta tags etc.) where the
// element class is certain but querySelector loses the narrowing.
/** @type {(selector: string) => any} */
export const $$ = (selector) => document.querySelector(selector);
