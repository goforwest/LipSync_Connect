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

// localStorage stand-in with an in-memory backing store; the returned object is
// the store itself so tests can seed/assert state (theme persistence tests).
function createStorage() {
  const store = new Map();
  const storage = {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
    _store: store,
  };
  return storage;
}

// Real CSS defaults are silent for the contrast guard (5.89:1 on white), so
// pre-existing tests don't start logging contrast warnings; theme tests
// override entries per case.
const CONTRAST_DEFAULTS = { '--accent': '#BE2A32', '--btn-text': '#ffffff' };

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
    // contains() must exist (not just add/remove/toggle): updateMeter branches
    // on it for the bipolar meter, and a missing method throws inside the
    // endpoint renderers, killing the line-waiter for the whole response.
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
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

// The stub document currently holding focus (set by each installer); makeEl's
// focus() records into it so tests can assert focus behavior — the popups,
// confirm dialogs, and wizard panels all move focus on purpose.
let currentStubDocument = null;
export function makeEl(tag) {
  const classes = new Set();
  const attrs = {};
  const listeners = {};
  const el = {
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
    // String-assigning className must feed the classList Set (real-DOM
    // semantics): renderers assign className strings, interaction code later
    // asks classList.contains — both paths have to see the same classes.
    get className() {
      return Array.from(classes).join(' ');
    },
    set className(v) {
      classes.clear();
      String(v)
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => classes.add(c));
    },
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
    style: { setProperty() {} },
    textContent: '',
    hidden: false,
    offsetHeight: 10,
    focus() {
      if (currentStubDocument) currentStubDocument.activeElement = this;
    },
    click() {},
    select() {},
    remove() {},
    id: '',
  };
  return el;
}

// Section ids mirror index.html nav order.
const SECTION_IDS = [
  'sec-device',
  'sec-cursor',
  'sec-sip',
  'sec-restrictions',
  'sec-switches',
  'sec-joystick',
  'sec-feedback',
  'sec-bluetooth',
  'sec-diagnostics',
  'sec-maintenance',
  'sec-firmware',
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
  // Switch-mode tabs (index.html's sec-switches): three jacks × two modes.
  // The tab wiring in main.js drives these through querySelectorAll, so the
  // selector surface must exist for the toggle behavior to be testable.
  const switchTabs = [];
  const switchPanels = [];
  for (const jack of ['A', 'B', 'C']) {
    for (const mode of ['mouse', 'gamepad']) {
      const tab = makeEl('button');
      tab.classList.add('switch-tab');
      tab.dataset.jack = jack;
      tab.dataset.mode = mode;
      tab.setAttribute('aria-pressed', String(mode === 'mouse'));
      switchTabs.push(tab);
      const panel = makeEl('div');
      panel.classList.add('switch-mode');
      panel.dataset.jack = jack;
      panel.dataset.mode = mode;
      panel.hidden = mode !== 'mouse';
      switchPanels.push(panel);
    }
  }
  // Stepper buttons (index.html's data-step/data-target rows — the coarse
  // and fine steppers for every STEP_TARGETS entry). updateStepButtons
  // disables them by bounds and the stepper tests read that state by
  // selector, so both selector surfaces must resolve.
  // UI-scale buttons (index.html's appearance popup): theme.js binds them
  // through querySelectorAll and reads/writes aria-pressed; body.style.zoom
  // is where the applied scale lands.
  // Wizard step-list items (index.html's Help-card guided-setup panel).
  const wizStepLis = ['connect', 'calibrate', 'thresholds', 'verify'].map((step) => {
    const li = makeEl('li');
    li.dataset.step = step;
    return li;
  });
  // Task buttons (index.html's Help-card Common tasks): main.js binds them
  // through querySelectorAll('.task-btn') and drives section jumps.
  const taskButtons = ['setup', 'cursor', 'clicks', 'accidents', 'health', 'update', 'switches'].map((task) => {
    const b = makeEl('button');
    b.classList.add('task-btn');
    b.dataset.task = task;
    return b;
  });
  const scaleButtons = ['1', '1.25', '1.5'].map((scale) => {
    const b = makeEl('button');
    b.classList.add('scale-btn');
    b.dataset.scale = scale;
    b.setAttribute('aria-pressed', String(scale === '1'));
    return b;
  });
  const stepButtons = [
    ['speed', '-1'], ['speed', '1'],
    ['scroll', '-1'], ['scroll', '1'],
    ['accel', '-1'], ['accel', '1'],
    ['brightness', '-1'], ['brightness', '1'],
    ['st', '-4'], ['st', '-1'], ['st', '1'], ['st', '4'],
    ['pt', '-4'], ['pt', '-1'], ['pt', '1'], ['pt', '4'],
    ['iz', '-5'], ['iz', '-1'], ['iz', '1'], ['iz', '5'],
    ['oz', '-5'], ['oz', '-1'], ['oz', '1'], ['oz', '5'],
    ['ws', '-5'], ['ws', '-1'], ['ws', '1'], ['ws', '5'],
    ['wl', '-5'], ['wl', '-1'], ['wl', '1'], ['wl', '5'],
    ['wm', '-5'], ['wm', '-1'], ['wm', '1'], ['wm', '5'],
  ].map(([target, delta]) => {
    const b = makeEl('button');
    b.classList.add('cmd');
    b.dataset.target = target;
    b.dataset.step = delta;
    b.disabled = false;
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
  const cmdBtnCheckFw = makeEl('button');
  cmdBtnCheckFw.id = 'btnCheckUpdate';
  cmdBtnCheckFw.classList.add('cmd');
  cmdBtnCheckFw.disabled = true;
  els.set('btnCheckUpdate', cmdBtnCheckFw);

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
      if (sel === '.switch-tab') return switchTabs;
      const tabJack = sel.match(/^\.switch-tab\[data-jack="(.+)"\]$/);
      if (tabJack) return switchTabs.filter((t) => t.dataset.jack === tabJack[1]);
      const panelJack = sel.match(/^\.switch-mode\[data-jack="(.+)"\]$/);
      if (panelJack) return switchPanels.filter((p) => p.dataset.jack === panelJack[1]);
      if (sel === 'button.cmd') return [...els.values()].filter((e) => e && e.classList?.contains('cmd'));
      if (sel === 'button[data-step]') return stepButtons;
      if (sel === '.scale-btn') return scaleButtons;
      if (sel === '.task-btn') return taskButtons;
      if (sel === '.wiz-steps li') return wizStepLis;
      const stepSel = sel.match(/^button\[data-target="(.+)"\]\[data-step="(.+)"\]$/);
      if (stepSel)
        return (
          stepButtons.find(
            (b) => b.dataset.target === stepSel[1] && b.dataset.step === stepSel[2],
          ) ?? null
        );
      return [];
    },
    querySelector(sel) {
      const m = sel.match(/^\.circle-trigger\[data-section="(.+)"\]$/);
      if (m) return navs.find((b) => b.dataset.section === m[1]) || null;
      const stepSel = sel.match(/^button\[data-target="(.+)"\]\[data-step="(.+)"\]$/);
      if (stepSel)
        return stepButtons.find((b) => b.dataset.target === stepSel[1] && b.dataset.step === stepSel[2]) ?? null;
      const wizSel = sel.match(/^\.wiz-steps li\[data-step="(.+)"\]$/);
      if (wizSel) return wizStepLis.find((li) => li.dataset.step === wizSel[1]) ?? null;
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
    // Legacy-clipboard + download-fallback surfaces (share-log tests).
    body: { appendChild() {}, style: {} },
    execCommand() {
      return true;
    },
  };
  currentStubDocument = documentStub;

  const windowListeners = {};
  const storage = createStorage();
  const computedStyles = {};
  setGlobal('window', {
    addEventListener(type, fn) {
      (windowListeners[type] ||= []).push(fn);
    },
    removeEventListener() {},
    // reduced-motion => instant class changes in the app's animation helpers
    matchMedia: () => ({ matches: true }),
    // mailto navigation target; share-log tests read/replace this
    location: { href: '' },
  });
  setGlobal('document', documentStub);
  // Pretend Web Serial exists so main.js proceeds down the "supported" path;
  // connection itself is simulated through testHooks, never this stub.
  setGlobal('navigator', { serial: {} });
  // Theme module surfaces: localStorage for persistence, getComputedStyle for
  // the contrast guard (defaults above; tests mutate computedStyles).
  setGlobal('localStorage', storage);
  // sessionStorage: a separate backing store — the firmware update's
  // pending-state persistence rides it, and its JSON round-trip must be
  // exercised against a real (stubbed) storage, not the pendingMemory cache.
  const sessionStore = createStorage();
  setGlobal('sessionStorage', sessionStore);
  setGlobal('getComputedStyle', () => ({
    getPropertyValue(prop) {
      return computedStyles[prop] ?? CONTRAST_DEFAULTS[prop] ?? '';
    },
  }));

  return {
    document: documentStub,
    windowListeners,
    sections,
    navs,
    els,
    storage,
    sessionStorage: sessionStore,
    computedStyles,
  };
}
