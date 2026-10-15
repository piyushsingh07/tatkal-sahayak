/* Options page: loads/saves settings, manages passenger rows, encryption, import/export. */
(function () {
  'use strict';

  const S = TA.storage;
  const form = document.getElementById('form');
  const paxBody = document.querySelector('#paxTable tbody');
  const infBody = document.querySelector('#infTable tbody');
  const messages = document.getElementById('messages');
  let settings = S.clone(S.DEFAULTS);

  // ---- helpers -------------------------------------------------------------
  function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }

  function setPath(obj, path, value) {
    const keys = path.split('.');
    let cur = obj;
    for (const k of keys.slice(0, -1)) cur = cur[k] = cur[k] || {};
    cur[keys[keys.length - 1]] = value;
  }

  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') e.textContent = v;
      else if (k === 'onclick') e.addEventListener('click', v);
      else e.setAttribute(k, v);
    }
    for (const c of children) e.appendChild(c);
    return e;
  }

  function select(name, options, value) {
    const s = el('select', { name });
    for (const [v, label] of options) {
      const o = el('option', { value: v, text: label });
      if (v === value) o.selected = true;
      s.appendChild(o);
    }
    return s;
  }

  function showMessage(text, kind) {
    messages.appendChild(el('div', { class: `msg ${kind}`, text }));
  }

  // ---- static selects --------------------------------------------------------
  const CLASS_LABELS = {
    SL: 'Sleeper (SL)', '3A': 'AC 3 Tier (3A)', '3E': 'AC 3 Economy (3E)', '2A': 'AC 2 Tier (2A)', '1A': 'AC First Class (1A)',
    CC: 'AC Chair Car (CC)', EC: 'Exec. Chair Car (EC)', '2S': 'Second Sitting (2S)', FC: 'First Class (FC)',
    EA: 'Anubhuti (EA)', EV: 'Vistadome AC (EV)', VC: 'Vistadome Chair Car (VC)', VS: 'Vistadome Non AC (VS)',
  };
  const clsSelect = document.getElementById('clsSelect');
  const quotaSelect = document.getElementById('quotaSelect');
  for (const c of S.CLASS_CODES) clsSelect.appendChild(el('option', { value: c, text: CLASS_LABELS[c] || c }));
  for (const q of S.QUOTAS) quotaSelect.appendChild(el('option', { value: q, text: `${S.QUOTA_LABELS[q]} (${q})` }));

  // ---- passenger rows ----------------------------------------------------
  const GENDERS = [['M', 'Male'], ['F', 'Female'], ['T', 'Transgender']];

  function paxRow(p = {}) {
    const tr = el('tr');
    tr.appendChild(el('td', {}, [el('input', { name: 'p.name', value: p.name || '', placeholder: 'Name as on ID', maxlength: '16' })]));
    tr.appendChild(el('td', {}, [el('input', { name: 'p.age', type: 'number', min: '5', max: '125', value: p.age || '' })]));
    tr.appendChild(el('td', {}, [select('p.gender', GENDERS, p.gender || 'M')]));
    tr.appendChild(el('td', {}, [select('p.berth', S.BERTHS.map((b) => [b, S.BERTH_LABELS[b]]), p.berth || 'NP')]));
    tr.appendChild(el('td', {}, [select('p.food', S.FOODS.map((f) => [f, S.FOOD_LABELS[f]]), p.food || '')]));
    tr.appendChild(el('td', {}, [el('button', { type: 'button', class: 'icon', title: 'remove', text: '✕', onclick: () => tr.remove() })]));
    return tr;
  }

  function infRow(p = {}) {
    const tr = el('tr');
    tr.appendChild(el('td', {}, [el('input', { name: 'i.name', value: p.name || '', placeholder: 'Name', maxlength: '16' })]));
    tr.appendChild(el('td', {}, [el('input', { name: 'i.age', type: 'number', min: '0', max: '4', value: p.age == null ? '' : p.age })]));
    tr.appendChild(el('td', {}, [select('i.gender', GENDERS, p.gender || 'M')]));
    tr.appendChild(el('td', {}, [el('button', { type: 'button', class: 'icon', title: 'remove', text: '✕', onclick: () => tr.remove() })]));
    return tr;
  }

  document.getElementById('addPax').addEventListener('click', () => {
    if (paxBody.children.length >= 6) return showMessage('Maximum 6 passengers (4 for Tatkal).', 'warn');
    paxBody.appendChild(paxRow());
  });
  document.getElementById('addInf').addEventListener('click', () => {
    if (infBody.children.length >= 2) return showMessage('Maximum 2 infants.', 'warn');
    infBody.appendChild(infRow());
  });

  function readRows(tbody, prefix) {
    return Array.from(tbody.children).map((tr) => {
      const v = (n) => tr.querySelector(`[name="${prefix}.${n}"]`).value.trim();
      const row = { name: v('name'), age: Number(v('age')), gender: v('gender') };
      if (prefix === 'p') Object.assign(row, { berth: v('berth'), food: v('food'), nationality: 'IN' });
      return row;
    }).filter((r) => r.name || r.age);
  }

  // ---- load / render -----------------------------------------------------
  function render() {
    for (const input of form.querySelectorAll('[name]')) {
      const name = input.getAttribute('name');
      if (name === 'passphrase' || name.startsWith('p.') || name.startsWith('i.')) continue;
      if (name === 'credentials.password') { input.value = ''; continue; }
      if (name === 'selectorsOverride') { input.value = JSON.stringify(settings.selectorsOverride || {}, null, 2); continue; }
      const v = getPath(settings, name);
      if (input.type === 'checkbox') input.checked = !!v;
      else input.value = v == null ? '' : v;
    }
    paxBody.replaceChildren(...(settings.passengers.length ? settings.passengers : [{}]).map(paxRow));
    infBody.replaceChildren(...settings.infants.map(infRow));
    const cs = document.getElementById('credStatus');
    cs.textContent = settings.credentials.passwordEnc
      ? 'Password saved (encrypted with your passphrase). Enter the passphrase in the on-page panel before arming.'
      : settings.credentials.password ? 'Password saved in plain text in extension storage — add a passphrase to encrypt it.' : 'No password saved yet.';
  }

  async function load() {
    settings = await S.getSettings();
    render();
  }

  // ---- save ------------------------------------------------------------------
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    messages.replaceChildren();
    const next = S.clone(settings);
    for (const input of form.querySelectorAll('[name]')) {
      const name = input.getAttribute('name');
      if (['passphrase', 'credentials.password', 'selectorsOverride'].includes(name) || name.startsWith('p.') || name.startsWith('i.')) continue;
      let v = input.type === 'checkbox' ? input.checked : input.value.trim();
      if (input.type === 'number') v = v === '' ? 0 : Number(v);
      if (/^journey\.(from|to|boardingStation)$/.test(name)) v = String(v).toUpperCase();
      setPath(next, name, v);
    }
    next.passengers = readRows(paxBody, 'p');
    next.infants = readRows(infBody, 'i');

    try {
      const so = JSON.parse(form.elements.selectorsOverride.value || '{}');
      next.selectorsOverride = S.mergeDeep({ nget: {}, eticket: {} }, so);
    } catch (e) {
      return showMessage(`Selector overrides is not valid JSON: ${e.message}`, 'err');
    }

    const pw = form.elements['credentials.password'].value;
    const passphrase = form.elements.passphrase.value;
    if (pw) {
      if (passphrase) {
        next.credentials.passwordEnc = await TA.crypto.encryptString(passphrase, pw);
        next.credentials.password = '';
      } else {
        next.credentials.password = pw;
        next.credentials.passwordEnc = null;
      }
    } else if (passphrase && next.credentials.password) {
      // encrypt the previously stored plaintext password
      next.credentials.passwordEnc = await TA.crypto.encryptString(passphrase, next.credentials.password);
      next.credentials.password = '';
    }

    const { errors, warnings } = S.validateSettings(next);
    await S.saveSettings(next);
    settings = next;
    // any previously unlocked password is stale now
    if (pw && S.runArea()) await S.patchRun({ password: '' });
    render();
    form.elements.passphrase.value = '';
    showMessage('Saved.', 'ok');
    errors.forEach((m) => showMessage(m, 'err'));
    warnings.forEach((m) => showMessage(m, 'warn'));
  });

  document.getElementById('clearPw').addEventListener('click', async () => {
    settings.credentials.password = '';
    settings.credentials.passwordEnc = null;
    await S.saveSettings(settings);
    if (S.runArea()) await S.patchRun({ password: '' });
    render();
    showMessage('Password removed from storage.', 'ok');
  });

  // ---- import / export -------------------------------------------------------
  document.getElementById('exportBtn').addEventListener('click', () => {
    const out = S.clone(settings);
    out.credentials = { userId: out.credentials.userId, password: '', passwordEnc: null }; // never export secrets
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'tatkal-sahayak-settings.json' });
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  document.getElementById('importFile').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      const merged = S.mergeDeep(settings, imported);
      merged.credentials.password = settings.credentials.password;
      merged.credentials.passwordEnc = settings.credentials.passwordEnc;
      settings = merged;
      await S.saveSettings(settings);
      render();
      showMessage('Imported. Review and save.', 'ok');
    } catch (e) {
      showMessage(`Import failed: ${e.message}`, 'err');
    }
    ev.target.value = '';
  });

  load();
})();
