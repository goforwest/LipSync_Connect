// Shared DOM stubs for ESM tests. Installs `window`, `document`, and `navigator`
// on globalThis so app modules (which reference those globals directly) run in Node.
// installProtocolDom() mirrors the permissive protocol-test stub (Proxy elements that
// accept anything); installGatingDom() mirrors the stateful gating-test stub.

// Node ≥21 exposes globalThis.navigator as a getter-only accessor, and
// globalThis.window does not exist at all; assign through defineProperty so
// both the protocol and gating installers work across Node versions.
function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

// ---- Protocol-test stub: forgiving elements, no listener wiring ----
function stubElement() {
  const attrs = {};
  const children = [];
  const target = {
    appendChild(el) {
      children.push(el);
    },
    removeChild(el) {
      const i = children.indexOf(el);
      if (i >= 0) children.splice(i, 1);
    },
    get lastElementChild() {
      return children[children.length - 1] ?? null;
    },
    addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelectorAll(sel) {
      return sel === 'span' ? children.filter((c) => c.tagName === 'SPAN') : [];
    },
    style: {},
    textContent: '',
    value: '',
    scrollTop: 0,
    scrollHeight: 0,
    hidden: false,
    setAttribute(k, v) {
      attrs[k] = v;
    },
    hasAttribute(k) {
      return k in attrs;
    },
    getAttribute(k) {
      return attrs[k] ?? null;
    },
    reportValidity() {},
  };
  return new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      t[key] = '';
      return t[key];
    },
    set(t, key, v) {
      t[key] = v;
      return true;
    },
  });
}

/** Installs the protocol-test window/document/navigator stubs. Returns { elements }. */
export function installProtocolDom() {
  const elements = new Map();
  const documentStub = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, stubElement());
      return elements.get(id);
    },
    querySelectorAll() {
      return [];
    },
    createElement(tag) {
      const el = stubElement();
      el.tagName = (tag || '').toUpperCase();
      return el;
    },
    addEventListener() {},
  };
  setGlobal('window', { addEventListener() {}, removeEventListener() {} });
  setGlobal('document', documentStub);
  setGlobal('navigator', {});
  return { elements, document: documentStub };
}

// makeEl's innerHTML parser reads text nodes via this shared helper (kept
// before makeEl so the parse loop can reference it).
function makeText(text) {
  return { nodeType: 3, textContent: String(text) };
}

// ---- Gating-test stub: stateful elements with classes/attrs/listeners ----
export function makeEl(tag) {
  const classes = new Set();
  const attrs = {};
  const listeners = {};
  return {
    tagName: (tag || 'div').toUpperCase(),
    nodeType: 1,
    // form-control state — declared so reads/writes behave like real elements
    disabled: false,
    value: '',
    childNodes: [],
    classList: {
      _set: classes,
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        on ? classes.add(c) : classes.delete(c);
        return on;
      },
    },
    dataset: {},
    querySelectorAll(sel) {
      if (sel === 'li') return this.children.filter((c) => c.tagName === 'LI' || c.nodeType === 3 || true);
      return this.children.slice();
    },
    get childNodes() {
      // alias of children so the formatting module's walk() sees content.
      return this.children;
    },
    set innerHTML(html) {
      // Minimal parser for ui/formatting.js: turns its allowlisted tags
      // (strong/em/b/i/br/p) and text into child nodes — anything else is
      // escaped text. Enough for showConfirm body rendering in tests.
      this.children.length = 0;
      let rest = String(html);
      const tagRe = /<(strong|em|b|i|br|p)>([\s\S]*?)<\/\1>/i;
      while (rest.length) {
        const m = rest.match(tagRe);
        if (!m) {
          if (rest) this.children.push(makeText(rest));
          break;
        }
        if (m.index > 0) this.children.push(makeText(rest.slice(0, m.index)));
        const child = makeEl(m[1].toLowerCase());
        child.textContent = m[2];
        child.innerHTML = m[2]; // recurse for nested allowlisted tags
        this.children.push(child);
        rest = rest.slice(m.index + m[0].length);
      }
    },
    get innerHTML() {
      return this.children
        .map((c) =>
          c.nodeType === 3 ? c.textContent : `<${c.tagName.toLowerCase()}>${c.innerHTML}</${c.tagName.toLowerCase()}>`,
        )
        .join('');
    },
    // Controls that get synthesized by the app's error/notification paths.
    querySelector(sel) {
      if (sel === '.notif-msg' || sel === '.notif-close') {
        if (!this._queries) this._queries = {};
        if (!this._queries[sel]) this._queries[sel] = makeEl(sel === '.notif-close' ? 'button' : 'span');
        return this._queries[sel];
      }
      // showConfirm: dialog body and its action buttons
      if (sel === '#confirmTitle' || sel === '#confirmBody' || sel === '#confirmOk' || sel === '#confirmCancel') {
        if (!this._queries) this._queries = {};
        if (!this._queries[sel]) this._queries[sel] = makeEl(sel.endsWith('k') || sel.includes('l') ? 'button' : 'p');
        return this._queries[sel];
      }
      return null;
    },
    cloneNode() {
      // The connection-banner retry/dismiss buttons are cloned-and-replaced;
      // a shallow twin that shares the same sink is sufficient for tests.
      return this;
    },
    replaceWith() {},
    showModal() {
      this._open = true;
    },
    close() {
      this._open = false;
    },
    scrollIntoView() {},
    title: '',
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 100,
    children: [],
    appendChild(el) {
      this.children.push(el);
    },
    removeChild(el) {
      const i = this.children.indexOf(el);
      if (i >= 0) this.children.splice(i, 1);
    },
    get firstElementChild() {
      return this.children[0] ?? null;
    },
    setAttribute(k, v) {
      attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in attrs ? attrs[k] : null;
    },
    hasAttribute(k) {
      return k in attrs;
    },
    removeAttribute(k) {
      delete attrs[k];
    },
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners[type];
      if (arr) {
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      }
    },
    dispatch(type) {
      (listeners[type] || []).forEach((f) =>
        f({ currentTarget: this, target: this, key: '', preventDefault() {}, stopPropagation() {} }),
      );
    },
    style: {},
    textContent: '',
    hidden: false,
    offsetHeight: 10,
    focus() {},
    id: '',
  };
  return el;
}

// Section ids mirror index.html nav order.
const SECTION_IDS = [
  'sec-device',
  'sec-cursor',
  'sec-sip',
  'sec-joystick',
  'sec-feedback',
  'sec-bluetooth',
  'sec-diagnostics',
  'sec-maintenance',
  'sec-help',
  'sec-log',
];

/**
 * Installs the gating-test DOM and returns handles the tests drive:
 * { document, windowListeners, sections, navs, els }.
 *
 * @param {Map<string, any>|null} [existingEls] - if provided, this map is used
 *   as the getElementById store. Everything that cares about a control's
 *   pre-existing state (`.cmd` class, `disabled`) must already be in this map
 *   BEFORE main.js's DOMContentLoaded runs.
 */
export function installGatingDom(existingEls = null) {
  // The element map where getElementById stores everything the test and app
  // both need to see. Tests that wire their own controls must pass this in.
  const els =
    existingEls ??
    new Map([
      ['btnTestLeds', null],
      ['btnTestBuzzer', null],
    ]);
  const sections = SECTION_IDS.map((id) => {
    const s = makeEl('section');
    s.id = id;
    s.classList.add('section-card');
    els.set(id, s);
    return s;
  });
  const navs = SECTION_IDS.map((id) => {
    const b = makeEl('button');
    b.classList.add('circle-trigger');
    b.dataset.section = id;
    return b;
  });
  // RT buttons are class="cmd" (disabled-by-default until connected), like real markup.
  const cmdBtnLeds = makeEl('button');
  cmdBtnLeds.id = 'btnTestLeds';
  cmdBtnLeds.classList.add('cmd');
  cmdBtnLeds.disabled = true;
  const cmdBtnBuzz = makeEl('button');
  cmdBtnBuzz.id = 'btnTestBuzzer';
  cmdBtnBuzz.classList.add('cmd');
  cmdBtnBuzz.disabled = true;
  els.set('btnTestLeds', cmdBtnLeds);
  els.set('btnTestBuzzer', cmdBtnBuzz);

  const documentStub = {
    _ready: null,
    documentElement: makeEl('html'),
    getElementById(id) {
      if (!els.has(id)) {
        const e = makeEl('div');
        e.id = id;
        els.set(id, e);
      }
      return els.get(id);
    },
    querySelectorAll(sel) {
      if (sel === '.section-card') return sections;
      if (sel === '.section-card.needs-conn') return sections.filter((s) => s.classList.contains('needs-conn'));
      if (sel === '.circle-trigger' || sel === '.circle-trigger[data-section]') return navs;
      if (sel === 'button.cmd') return [...els.values()].filter((e) => e && e.classList?.contains('cmd'));
      return [];
    },
    querySelector(sel) {
      const m = sel.match(/^\.circle-trigger\[data-section="(.+)"\]$/);
      if (m) return navs.find((b) => b.dataset.section === m[1]) || null;
      if (sel === 'header .logo') return null;
      return null;
    },
    createElement(t) {
      return makeEl(t);
    },
    // Text-node/fabric support for ui/formatting.js (the confirm dialog's
    // tag-stripping walker) and any code constructing content nodes.
    createTextNode(text) {
      return { nodeType: 3, textContent: String(text) };
    },
    createDocumentFragment() {
      const frag = makeEl('#fragment');
      frag.nodeType = 11;
      return frag;
    },
    addEventListener(type, fn) {
      if (type === 'DOMContentLoaded') this._ready = fn;
    },
    activeElement: null,
  };

  const windowListeners = {};
  setGlobal('window', {
    addEventListener(type, fn) {
      (windowListeners[type] ||= []).push(fn);
    },
    removeEventListener() {},
    // reduced-motion => instant class changes in the app's animation helpers
    matchMedia: () => ({ matches: true }),
  });
  setGlobal('document', documentStub);
  // Pretend Web Serial exists so main.js proceeds down the "supported" path;
  // connection itself is simulated through testHooks, never this stub.
  setGlobal('navigator', { serial: {} });

  return { document: documentStub, windowListeners, sections, navs, els };
}
