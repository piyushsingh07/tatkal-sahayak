/*
 * Optional passphrase encryption for the stored IRCTC password.
 * PBKDF2-SHA256 (210k iterations) -> AES-256-GCM. Uses WebCrypto, which is
 * available in the extension pages, content scripts and node >= 19.
 *
 * Threat model: this only protects the password at rest inside the Chrome
 * profile directory. Anything that can run inside the unlocked browser can
 * still read the decrypted value from session storage while a run is armed.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TA = root.TA || {};
  root.TA.crypto = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const subtle = root.crypto && root.crypto.subtle;
  const ITERATIONS = 210000;

  function b64(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }

  function unb64(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function deriveKey(passphrase, salt) {
    const enc = new TextEncoder();
    const base = await subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /** Returns a JSON-serialisable blob {v, salt, iv, ct}. */
  async function encryptString(passphrase, plaintext) {
    if (!subtle) throw new Error('WebCrypto unavailable');
    if (!passphrase) throw new Error('Passphrase required');
    const salt = root.crypto.getRandomValues(new Uint8Array(16));
    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase, salt);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
    return { v: 1, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) };
  }

  /** Throws on a wrong passphrase (GCM authentication fails). */
  async function decryptString(passphrase, blob) {
    if (!subtle) throw new Error('WebCrypto unavailable');
    if (!blob || blob.v !== 1) throw new Error('Unsupported blob');
    const key = await deriveKey(passphrase, unb64(blob.salt));
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.ct));
    return new TextDecoder().decode(pt);
  }

  return { encryptString, decryptString };
});
