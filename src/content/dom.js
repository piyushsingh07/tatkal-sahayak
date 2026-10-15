/*
 * DOM toolkit for driving an Angular/PrimeNG (old site) or unknown (new beta
 * site) UI from a content script. Every helper is framework-agnostic:
 *   - values are set through the native setter + `input`/`change` events so
 *     Angular reactive forms pick them up,
 *   - dropdowns/autocompletes are handled via "click, wait for new visible
 *     options, click the matching option" with PrimeNG-specific fast paths,
 *   - text/label based lookups let the same logical field resolve on both
 *     sites even when ids differ.
 */
(function (root) {
  'use strict';

  const TA = (root.TA = root.TA || {});

  const CLICKABLE = 'button, a, [role="button"], [role="tab"], [role="option"], [role="menuitem"], label, li, summary, .btn, input[type="button"], input[type="submit"]';
  const OPTION_ITEMS = '[role="option"], li.ui-dropdown-item, li.p-dropdown-item, li.ui-autocomplete-list-item, li.p-autocomplete-item, .dropdown-item, .mat-option, mat-option, .ng-option, li';

  function norm(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  function $(sel, rootEl = document) {
    try { return rootEl.querySelector(sel); } catch (_) { return null; }
  }

  function $$(sel, rootEl = document) {
    try { return Array.from(rootEl.querySelectorAll(sel)); } catch (_) { return []; }
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    if (el.closest('[hidden], [aria-hidden="true"]')) return false;
    const rects = el.getClientRects();
    if (!rects.length) return false;
    const style = root.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (style.opacity !== '' && Number(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0 || el.tagName === 'OPTION';
  }

  function visible(list) {
    return list.filter(isVisible);
  }

  function textOf(el) {
    return norm(el && (el.innerText != null && el.getClientRects().length ? el.innerText : el.textContent));
  }

  function toRegex(matcher) {
    if (matcher instanceof RegExp) return matcher;
    return new RegExp(String(matcher).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  /** Innermost visible elements (document order) whose text matches `re`. */
  function findAllByText(matcher, opts = {}) {
    const re = toRegex(matcher);
    const rootEl = opts.root || document;
    const tags = opts.tags || 'button, a, label, span, div, li, td, th, strong, b, p, h1, h2, h3, h4, h5, h6, small, option, legend';
    const visibleOnly = opts.visibleOnly !== false;
    const maxLen = opts.maxLen || 200;
    // cheap text filter first, visibility (getComputedStyle) only for the survivors
    const candidates = $$(tags, rootEl).filter((el) => {
      const raw = el.textContent;
      if (!raw || raw.length > maxLen * 3) return false;
      const t = norm(raw);
      if (!t || t.length > maxLen || !re.test(t)) return false;
      return !visibleOnly || isVisible(el);
    });
    // keep only innermost matches
    return candidates.filter((el) => !candidates.some((other) => other !== el && el.contains(other)));
  }

  function findByText(matcher, opts) {
    return findAllByText(matcher, opts)[0] || null;
  }

  /** Text match, then climb to the nearest clickable ancestor (max 4 levels). */
  function findClickableByText(matcher, opts = {}) {
    const hits = findAllByText(matcher, opts);
    for (const hit of hits) {
      let el = hit;
      for (let i = 0; i < 5 && el && el !== document.body; i++) {
        if (el.matches(CLICKABLE)) return el;
        el = el.parentElement;
      }
    }
    return hits[0] || null;
  }

  const ATTRS = ['placeholder', 'aria-label', 'title', 'name', 'id', 'formcontrolname', 'data-testid', 'data-test', 'autocomplete'];

  function attrMatches(el, re) {
    return ATTRS.some((a) => {
      const v = el.getAttribute(a);
      return v && re.test(v);
    });
  }

  /**
   * Find form controls by <label> text, aria-labelledby, or by descriptive
   * attributes (placeholder/aria-label/name/formcontrolname/...).
   */
  function findAllByLabel(matcher, opts = {}) {
    const re = toRegex(matcher);
    const rootEl = opts.root || document;
    const controls = opts.controls || 'input:not([type="hidden"]), select, textarea, [contenteditable="true"], [role="combobox"], p-dropdown, p-autocomplete, p-calendar, .ui-dropdown, .p-dropdown';
    const out = [];
    const push = (el) => { if (el && !out.includes(el) && (opts.visibleOnly === false || isVisible(el))) out.push(el); };

    for (const label of $$('label', rootEl)) {
      if (!re.test(textOf(label))) continue;
      if (label.htmlFor) push(document.getElementById(label.htmlFor));
      push($(controls, label));
      // label followed by the control (common in grid layouts)
      let sib = label.nextElementSibling;
      for (let i = 0; sib && i < 3; i++, sib = sib.nextElementSibling) {
        if (sib.matches(controls)) { push(sib); break; }
        const inner = $(controls, sib);
        if (inner) { push(inner); break; }
      }
      // control inside the same parent cell
      const parent = label.parentElement;
      if (parent) push($(controls, parent));
    }
    for (const el of $$(controls, rootEl)) {
      if (attrMatches(el, re)) push(el);
      const lb = el.getAttribute('aria-labelledby');
      if (lb) {
        const txt = lb.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(' ');
        if (re.test(txt)) push(el);
      }
    }
    return out;
  }

  function findByLabel(matcher, opts) {
    return findAllByLabel(matcher, opts)[0] || null;
  }

  // ---- interaction -------------------------------------------------------

  function nativeSetValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  }

  function fire(el, type, init = {}) {
    let ev;
    if (type === 'input' && typeof InputEvent === 'function') {
      ev = new InputEvent(type, Object.assign({ bubbles: true, cancelable: false, inputType: 'insertText' }, init));
    } else if (/^key/.test(type)) {
      ev = new KeyboardEvent(type, Object.assign({ bubbles: true, cancelable: true }, init));
    } else if (/^(mouse|click|dblclick|contextmenu)/.test(type)) {
      ev = new MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, view: root }, init));
    } else if (/^pointer/.test(type) && typeof PointerEvent === 'function') {
      ev = new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true }, init));
    } else if (/^(focus|blur)/.test(type)) {
      ev = new FocusEvent(type, Object.assign({ bubbles: type.endsWith('in') || type.endsWith('out') }, init));
    } else {
      ev = new Event(type, Object.assign({ bubbles: true, cancelable: true }, init));
    }
    el.dispatchEvent(ev);
    return ev;
  }

  /** Set a text/number input the way a user typing would, for Angular forms. */
  function setInputValue(el, value, opts = {}) {
    if (!el) return false;
    const str = String(value == null ? '' : value);
    if (el.isContentEditable) {
      el.focus();
      el.textContent = str;
      fire(el, 'input');
      return true;
    }
    el.focus();
    fire(el, 'focus');
    if (el.value !== str) {
      nativeSetValue(el, str);
      fire(el, 'input', { data: str });
      fire(el, 'change');
    }
    fire(el, 'keyup', { key: str.slice(-1) });
    if (opts.blur !== false) {
      fire(el, 'blur');
      fire(el, 'focusout');
    }
    return true;
  }

  function clickEl(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) { /* ignore */ }
    const r = el.getBoundingClientRect();
    const init = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: 1 };
    fire(el, 'pointerdown', init);
    fire(el, 'mousedown', init);
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    fire(el, 'pointerup', Object.assign({}, init, { buttons: 0 }));
    fire(el, 'mouseup', Object.assign({}, init, { buttons: 0 }));
    if (typeof el.click === 'function') el.click(); else fire(el, 'click', init);
    return true;
  }

  const KEYS = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, Tab: 9, ' ': 32 };

  function pressKey(el, key) {
    const code = key === ' ' ? 'Space' : key;
    const init = { key, code, keyCode: KEYS[key] || 0, which: KEYS[key] || 0 };
    fire(el, 'keydown', init);
    fire(el, 'keypress', init);
    fire(el, 'keyup', init);
  }

  /** Native <select>: match option by value (exact, case-insensitive) or text regex. */
  function selectNativeOption(select, matcher) {
    if (!(select instanceof HTMLSelectElement)) return false;
    const opts = Array.from(select.options);
    let found = null;
    if (typeof matcher === 'string') {
      found = opts.find((o) => o.value.toLowerCase() === matcher.toLowerCase())
        || opts.find((o) => norm(o.textContent).toLowerCase() === matcher.toLowerCase());
    }
    if (!found) {
      const re = toRegex(matcher);
      found = opts.find((o) => re.test(norm(o.textContent))) || opts.find((o) => re.test(o.value));
    }
    if (!found) return false;
    if (select.value !== found.value) {
      nativeSetValue(select, found.value);
      fire(select, 'input');
      fire(select, 'change');
    }
    return true;
  }

  function isChecked(el) {
    if (!el) return false;
    if (el instanceof HTMLInputElement) return el.checked;
    const inner = $('input[type="checkbox"], input[type="radio"]', el);
    if (inner) return inner.checked;
    if (el.getAttribute('aria-checked')) return el.getAttribute('aria-checked') === 'true';
    return !!$('.ui-state-active, .p-highlight, .checked, .active', el) || /\b(ui-state-active|p-highlight|checked)\b/.test(el.className || '');
  }

  /** Toggle a checkbox/radio (native or PrimeNG) to the desired state. */
  function setChecked(el, desired) {
    if (!el) return false;
    if (isChecked(el) === !!desired) return true;
    // Prefer the visible box / label for PrimeNG which hides the real input
    const target = $('.ui-chkbox-box, .p-checkbox-box, .ui-radiobutton-box, .p-radiobutton-box', el)
      || (el instanceof HTMLInputElement && !isVisible(el) && el.id && $(`label[for="${CSS.escape(el.id)}"]`)) || el;
    clickEl(target);
    return true;
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError());
      const t = setTimeout(() => { cleanup(); resolve(); }, ms);
      const onAbort = () => { clearTimeout(t); cleanup(); reject(abortError()); };
      const cleanup = () => signal && signal.removeEventListener('abort', onAbort);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function abortError() {
    const e = new Error('aborted');
    e.name = 'AbortError';
    return e;
  }

  /** Poll `fn` until truthy. Resolves with the value; rejects on timeout/abort. */
  function waitFor(fn, opts = {}) {
    const timeoutMs = opts.timeoutMs == null ? 8000 : opts.timeoutMs;
    const intervalMs = opts.intervalMs || 100;
    const signal = opts.signal;
    const started = Date.now();
    return new Promise((resolve, reject) => {
      let timer = null;
      const onAbort = () => { clearTimeout(timer); reject(abortError()); };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const tick = () => {
        let v = null;
        try { v = fn(); } catch (_) { v = null; }
        if (v) {
          if (signal) signal.removeEventListener('abort', onAbort);
          return resolve(v);
        }
        if (Date.now() - started >= timeoutMs) {
          if (signal) signal.removeEventListener('abort', onAbort);
          const e = new Error(opts.what ? `timeout waiting for ${opts.what}` : 'timeout');
          e.name = 'TimeoutError';
          return reject(e);
        }
        timer = setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  /** Visible option-like items currently on the page (for snapshot diffing). */
  function visibleOptionItems() {
    return visible($$(OPTION_ITEMS));
  }

  /**
   * Open a dropdown-ish control and choose the option matching `matcher`.
   * Works for PrimeNG p-dropdown (old site) and for generic listboxes by
   * diffing the visible option items before/after the click.
   */
  async function openAndPick(control, matcher, opts = {}) {
    if (!control) return false;
    if (control instanceof HTMLSelectElement) return selectNativeOption(control, matcher);
    const nativeInside = $('select', control);
    if (nativeInside && !$('.ui-dropdown, .p-dropdown', control)) return selectNativeOption(nativeInside, matcher);

    const re = toRegex(matcher);
    const before = new Set(visibleOptionItems());
    const trigger = $('.ui-dropdown-trigger, .p-dropdown-trigger, .ui-dropdown-label, .p-dropdown-label', control) || control;
    clickEl(trigger);
    let items;
    try {
      items = await waitFor(() => {
        const now = visibleOptionItems().filter((el) => !before.has(el));
        const scoped = now.filter((el) => el.matches('[role="option"], .ui-dropdown-item, .p-dropdown-item, .dropdown-item, .mat-option, mat-option, .ng-option'));
        const list = scoped.length ? scoped : now;
        return list.length ? list : null;
      }, { timeoutMs: opts.timeoutMs || 3000, intervalMs: 50, signal: opts.signal, what: 'dropdown options' });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      pressKey(trigger, 'Escape');
      return false;
    }
    const match = items.find((el) => re.test(textOf(el)));
    if (!match) {
      pressKey(trigger, 'Escape');
      return false;
    }
    clickEl(match);
    return true;
  }

  /**
   * Type into an autocomplete input and pick the suggestion that matches
   * `pick` (regex/string, tested against the suggestion text). Falls back to
   * ArrowDown+Enter when the suggestion list cannot be identified.
   */
  async function autocompletePick(input, typed, pick, opts = {}) {
    if (!input) return false;
    const re = toRegex(pick);
    const before = new Set(visibleOptionItems());
    setInputValue(input, typed, { blur: false });
    let items = null;
    try {
      items = await waitFor(() => {
        const now = visibleOptionItems().filter((el) => !before.has(el));
        return now.length ? now : null;
      }, { timeoutMs: opts.timeoutMs || 4000, intervalMs: 50, signal: opts.signal, what: 'suggestions' });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
    }
    if (items) {
      const match = items.find((el) => re.test(textOf(el))) || items[0];
      clickEl(match);
    } else {
      pressKey(input, 'ArrowDown');
      pressKey(input, 'Enter');
    }
    await sleep(80, opts.signal);
    return !!input.value;
  }

  // ---- selector generation for the Pick tool -----------------------------

  function isUnique(sel) {
    return $$(sel).length === 1;
  }

  function cssPath(el) {
    if (!(el instanceof Element)) return '';
    if (el.id && !/\d{3,}/.test(el.id)) {
      const s = `#${CSS.escape(el.id)}`;
      if (isUnique(s)) return s;
    }
    const tag = el.tagName.toLowerCase();
    for (const a of ['formcontrolname', 'name', 'placeholder', 'aria-label', 'data-testid', 'data-test', 'title', 'type']) {
      const v = el.getAttribute(a);
      if (!v) continue;
      const s = `${tag}[${a}="${v.replace(/"/g, '\\"')}"]`;
      if (isUnique(s)) return s;
    }
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && cur.nodeType === 1) {
      let part = cur.tagName.toLowerCase();
      if (cur.id && !/\d{3,}/.test(cur.id)) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      const candidate = parts.join(' > ');
      if (isUnique(candidate)) return candidate;
      cur = parent;
    }
    return parts.join(' > ');
  }

  function flash(el, color = '#ff9800') {
    if (!el || !el.style) return;
    const prev = el.style.outline;
    el.style.outline = `3px solid ${color}`;
    setTimeout(() => { el.style.outline = prev; }, 700);
  }

  TA.dom = {
    norm, $, $$, isVisible, visible, textOf, toRegex,
    findAllByText, findByText, findClickableByText, findAllByLabel, findByLabel,
    setInputValue, clickEl, pressKey, selectNativeOption, isChecked, setChecked,
    sleep, waitFor, openAndPick, autocompletePick, visibleOptionItems,
    cssPath, flash, fire, abortError,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
