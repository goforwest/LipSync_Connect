// Accessible confirmation dialog (replaces native confirm()).
// WARNING: only call with hardcoded strings — no user data.
import { $ } from './dom.js';

export function renderSafeFormatting(html) {
  // Guard: only allow the tag allowlist below to appear as literal markup;
  // everything else must be authored as escaped text. Rejects anything that
  // looks like a real tag we don't recognize (catches typos and script tags).
  const unknownTag = /<\/?(?!(?:strong|em|b|i|br|p)\s*\/?>)[a-zA-Z0-9][^>]*>/;
  if (unknownTag.test(html)) throw new Error('renderSafeFormatting: unexpected HTML content');
  const safe = document.createElement('div');
  safe.innerHTML = html;
  const allowed = { STRONG: true, B: true, EM: true, I: true, BR: true, P: true };
  const walk = (node) => {
    const frag = document.createDocumentFragment();
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        frag.appendChild(document.createTextNode(child.textContent));
      } else if (child.nodeType === 1 && allowed[child.tagName]) {
        const el = document.createElement(child.tagName);
        el.textContent = child.textContent;
        frag.appendChild(el);
      } else {
        frag.appendChild(document.createTextNode(child.textContent));
      }
    }
    return frag;
  };
  return walk(safe);
}

export function showConfirm(title, bodyHTML) {
  const dialog = $('confirmDialog');
  const titleEl = $('confirmTitle');
  const bodyEl = $('confirmBody');
  const okBtn = $('confirmOk');
  const cancelBtn = $('confirmCancel');
  const lastFocus = document.activeElement;
  titleEl.textContent = title;
  bodyEl.innerHTML = '';
  bodyEl.appendChild(renderSafeFormatting(bodyHTML));
  return new Promise((resolve) => {
    let resolved = false;
    // A-1 accessibility: trap Tab inside the modal so keyboard / AT focus can't
    // wander to content behind the blocking dialog.
    const onKeydown = (e) => {
      if (e.key !== 'Tab') return;
      const focusables = [okBtn, cancelBtn];
      const idx = focusables.indexOf(document.activeElement);
      const next = e.shiftKey
        ? idx <= 0
          ? focusables.length - 1
          : idx - 1
        : idx >= focusables.length - 1
          ? 0
          : idx + 1;
      e.preventDefault();
      focusables[next].focus();
    };
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      dialog.removeEventListener('keydown', onKeydown);
      dialog.close();
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      dialog.removeEventListener('close', onClose);
      if (lastFocus && typeof (/** @type {any} */ (lastFocus).focus) === 'function')
        /** @type {any} */ (lastFocus).focus();
      resolve(result);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onClose = () => done(false);
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    dialog.addEventListener('close', onClose);
    dialog.addEventListener('keydown', onKeydown);
    dialog.showModal();
    okBtn.focus();
  });
}
