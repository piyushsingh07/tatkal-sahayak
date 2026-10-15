/*
 * jsdom harness: loads the content scripts into a window with layout
 * polyfills (jsdom has no layout, so getClientRects() is always empty) and a
 * minimal chrome.* stub backed by in-memory stores.
 */
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', '..', 'src');
const CONTENT_SCRIPTS = [
  'shared/time.js', 'shared/storage.js', 'shared/crypto.js',
  'content/dom.js', 'content/profiles.js', 'content/steps.js', 'content/engine.js', 'content/panel.js',
];

function hiddenInTree(el) {
  for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
    if (cur.hidden || cur.getAttribute('hidden') !== null) return true;
    if (cur.style && cur.style.display === 'none') return true;
  }
  return false;
}

function makeArea(store, name, listeners) {
  return {
    async get(key) { return { [key]: store[key] }; },
    async set(obj) {
      Object.assign(store, JSON.parse(JSON.stringify(obj)));
      const changes = Object.fromEntries(Object.keys(obj).map((k) => [k, { newValue: obj[k] }]));
      for (const fn of listeners) fn(changes, name);
    },
    async remove(key) { delete store[key]; },
  };
}

function createEnv({ url, html, settings, run = {} }) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  // ---- layout polyfills -------------------------------------------------
  window.Element.prototype.getClientRects = function () {
    return hiddenInTree(this) ? [] : [{ top: 0, left: 0, width: 100, height: 20 }];
  };
  window.Element.prototype.getBoundingClientRect = function () {
    const vis = !hiddenInTree(this);
    return { top: 0, left: 0, right: vis ? 100 : 0, bottom: vis ? 20 : 0, width: vis ? 100 : 0, height: vis ? 20 : 0, x: 0, y: 0 };
  };
  window.Element.prototype.scrollIntoView = function () {};
  if (!window.CSS) window.CSS = { escape: (s) => String(s).replace(/([^\w-])/g, '\\$1') };
  // jsdom has no SubtleCrypto; bridge Node's WebCrypto (Chrome provides this natively)
  Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true });

  // ---- chrome stub ------------------------------------------------------
  const listeners = [];
  const stores = { local: { settings }, session: { run } };
  const messages = [];
  window.chrome = {
    storage: {
      local: makeArea(stores.local, 'local', listeners),
      session: makeArea(stores.session, 'session', listeners),
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
    runtime: {
      lastError: undefined,
      sendMessage(msg, cb) {
        messages.push(msg);
        if (msg.type === 'SYNC_TIME' && cb) cb({ ok: true, offsetMs: 0, rttMs: 12, source: 'stub' });
        else if (cb) cb({ ok: true });
      },
    },
  };

  for (const f of CONTENT_SCRIPTS) window.eval(fs.readFileSync(path.join(SRC, f), 'utf8'));
  return { dom, window, document: window.document, TA: window.TA, stores, messages };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(fn, { timeoutMs = 8000, intervalMs = 40, what = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    let v;
    try { v = fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(intervalMs);
  }
}

module.exports = { createEnv, sleep, waitUntil };
