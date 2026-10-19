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

/**
 * @param {string} title
 * @param {string} bodyHTML
 * @param {{danger?: boolean}} [opts] danger: a destructive action — focus
 *   lands on Cancel so a reflexive Enter press cannot trigger it, and the
 *   user must move to confirm.
 */
export function showConfirm(title, bodyHTML, opts = {}) {
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
    // A click that lands on the dialog element itself (its padding or the
    // ::backdrop) reads as "click away" — resolve as a cancel, like almost
    // every native dialog the user has met.
    const onBackdrop = (e) => {
      if (e.target === dialog) dialog.close();
    };
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      dialog.removeEventListener('keydown', onKeydown);
      dialog.removeEventListener('click', onBackdrop);
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
    // The dialog's close event dispatches as a task, not synchronously — a
    // close queued by a previous confirm must not settle this one the instant
    // it opens. Only a close of the actually-open dialog resolves here.
    const onClose = () => {
      if (!dialog.open) done(false);
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    dialog.addEventListener('close', onClose);
    dialog.addEventListener('keydown', onKeydown);
    dialog.addEventListener('click', onBackdrop);
    dialog.showModal();
    (opts.danger ? cancelBtn : okBtn).focus();
  });
}
