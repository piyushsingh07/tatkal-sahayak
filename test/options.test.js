/*
 * Smoke test for the options page: renders from stored settings, saves the
 * form back (with passphrase encryption) and reports validation problems.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const S = require('../src/shared/storage.js');
const C = require('../src/shared/crypto.js');

const OPTIONS_DIR = path.join(__dirname, '..', 'src', 'options');

function loadOptionsPage(storedSettings) {
  const html = fs.readFileSync(path.join(OPTIONS_DIR, 'options.html'), 'utf8')
    .replace(/<script src="[^"]+"><\/script>\s*/g, ''); // scripts are evaluated manually below
  const dom = new JSDOM(html, { url: 'chrome-extension://abc/src/options/options.html', runScripts: 'outside-only' });
  const { window } = dom;
  // jsdom ships getRandomValues but no SubtleCrypto; the real extension runs in Chrome which has it.
  Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true });
  const store = { settings: storedSettings };
  window.chrome = {
    storage: {
      local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); } },
      onChanged: { addListener() {} },
    },
  };
  window.URL.createObjectURL = () => 'blob:x';
  for (const f of ['../shared/time.js', '../shared/storage.js', '../shared/crypto.js', 'options.js']) {
    window.eval(fs.readFileSync(path.join(OPTIONS_DIR, f), 'utf8'));
  }
  return { window, document: window.document, store };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

test('options page renders stored settings and saves edits with encryption', async () => {
  const stored = S.clone(S.DEFAULTS);
  stored.credentials.userId = 'kppsingh';
  stored.journey.from = 'NDLS';
  stored.passengers = [{ name: 'Rahul Sharma', age: 31, gender: 'M', berth: 'LB', food: 'V', nationality: 'IN' }];
  const { document, store } = loadOptionsPage(stored);
  await tick();

  const form = document.getElementById('form');
  assert.equal(form.elements['credentials.userId'].value, 'kppsingh');
  assert.equal(form.elements['journey.from'].value, 'NDLS');
  assert.equal(form.elements['journey.quota'].value, 'TQ');
  assert.equal(document.querySelectorAll('#paxTable tbody tr').length, 1);
  assert.equal(document.querySelector('#paxTable tbody input[name="p.name"]').value, 'Rahul Sharma');
  assert.ok(document.querySelectorAll('#clsSelect option').length >= 10);

  // edit: journey, second passenger, password + passphrase
  form.elements['journey.to'].value = 'bpl';
  form.elements['journey.date'].value = '2026-10-01';
  form.elements['journey.trainNo'].value = '12002';
  form.elements['contact.mobile'].value = '9876543210';
  document.getElementById('addPax').click();
  const rows = document.querySelectorAll('#paxTable tbody tr');
  assert.equal(rows.length, 2);
  rows[1].querySelector('[name="p.name"]').value = 'Priya Sharma';
  rows[1].querySelector('[name="p.age"]').value = '29';
  rows[1].querySelector('[name="p.gender"]').value = 'F';
  form.elements['credentials.password'].value = 'Secr3t!';
  form.elements.passphrase.value = 'open-sesame';

  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 1500)); // PBKDF2 210k iterations

  const saved = store.settings;
  assert.equal(saved.journey.to, 'BPL', 'station codes are upper-cased');
  assert.equal(saved.journey.trainNo, '12002');
  assert.equal(saved.passengers.length, 2);
  assert.equal(saved.passengers[1].gender, 'F');
  assert.equal(saved.credentials.password, '', 'plaintext cleared when a passphrase is used');
  assert.ok(saved.credentials.passwordEnc && saved.credentials.passwordEnc.ct);
  assert.equal(await C.decryptString('open-sesame', saved.credentials.passwordEnc), 'Secr3t!');
  assert.equal(S.validateSettings(saved).errors.length, 0);
  assert.match(document.getElementById('messages').textContent, /Saved\./);
  assert.match(document.getElementById('credStatus').textContent, /encrypted/);
});

test('options page surfaces validation errors after save', async () => {
  const { document, store } = loadOptionsPage(S.clone(S.DEFAULTS));
  await tick();
  const form = document.getElementById('form');
  form.elements['journey.trainNo'].value = '12';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 200));
  const msgs = Array.from(document.querySelectorAll('#messages .msg.err')).map((m) => m.textContent);
  assert.ok(msgs.some((m) => /Train number/.test(m)), msgs.join('|'));
  assert.ok(msgs.some((m) => /user ID/i.test(m)));
  assert.equal(store.settings.journey.trainNo, '12', 'settings are still saved so partial progress is kept');
});
