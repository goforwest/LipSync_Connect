// ESM evaluation-order helper: installs the stateful gating DOM, imports
// app/app.js, and fires the stored DOMContentLoaded handler. Anything that
// statically imports this module runs after all of the above.

import { installGatingDom } from './dom-stub.mjs';

const { document, windowListeners } = installGatingDom();
export const app = await import('../../app/js/main.js');
// Fire the stored DOMContentLoaded handler exactly once, as the browser would.
(windowListeners['DOMContentLoaded'] || []).forEach((fn) => fn());
export { document, windowListeners };
