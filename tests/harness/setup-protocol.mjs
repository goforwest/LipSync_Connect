// ESM evaluation-order helper: installs the protocol DOM stubs and then
// dynamically imports app/app.js. Because this module's top-level awaits run
// before any module that statically imports it, the DOM globals exist by the
// time app.js's top-level side effects execute.

import { installProtocolDom } from './dom-stub.mjs';

// DOM stubs must exist before the app module is evaluated (its top-level code
// attaches window error handlers and constructs UI lookups lazily via $()).
installProtocolDom();
export const app = await import('../../app/js/main.js');
