// ESM evaluation-order helper: installs the stateful gating DOM, imports
// app/app.js, and fires the stored DOMContentLoaded handler. Anything that
// statically imports this module runs after all of the above.

import { after } from 'node:test';
import { installGatingDom } from './dom-stub.mjs';

// Track setTimeout handles so the 8s notification auto-dismiss (now also
// fired by dimmed-trigger taps — see ui/sections.js) doesn't hold the test
// process open after the assertions finish. Same pattern as theme.test.mjs.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const pendingTimers = new Set();
globalThis.setTimeout = (fn, ms, ...args) => {
  const id = realSetTimeout(
    () => {
      pendingTimers.delete(id);
      fn(...args);
    },
    ms,
    ...args,
  );
  pendingTimers.add(id);
  return id;
};
globalThis.clearTimeout = (id) => {
  realClearTimeout(id);
  pendingTimers.delete(id);
};
after(() => {
  for (const id of pendingTimers) realClearTimeout(id);
  pendingTimers.clear();
});

const { document, windowListeners } = installGatingDom();
export const app = await import('../../app/js/main.js');
// Fire the stored DOMContentLoaded handler exactly once, as the browser would.
(windowListeners['DOMContentLoaded'] || []).forEach((fn) => fn());
export { document, windowListeners };
