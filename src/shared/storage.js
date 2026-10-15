/*
 * Settings schema, defaults, validation and thin wrappers over
 * chrome.storage. UMD-style so the pure parts (defaults, mergeDeep,
 * validateSettings) are unit-testable under node.
 *
 * Storage layout:
 *   chrome.storage.local.settings  -> user configuration (see DEFAULTS)
 *   chrome.storage.session.run     -> volatile run state (armed, phase, log,
 *                                     unlocked password, time offset). Falls
 *                                     back to local when session storage is
 *                                     not reachable from the content script.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TA = root.TA || {};
  root.TA.storage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const CLASS_CODES = ['SL', '3A', '3E', '2A', '1A', 'CC', 'EC', '2S', 'FC', 'EA', 'EV', 'VC', 'VS'];
  const AC_CLASSES = ['3A', '3E', '2A', '1A', 'CC', 'EC', 'EA', 'EV', 'VC'];
  const QUOTAS = ['GN', 'TQ', 'PT', 'LD', 'SS', 'HP', 'DF', 'PH'];
  const QUOTA_LABELS = {
    GN: 'General', TQ: 'Tatkal', PT: 'Premium Tatkal', LD: 'Ladies',
    SS: 'Lower Berth/Sr.Citizen', HP: 'Person With Disability', DF: 'Duty Pass', PH: 'Parliament House',
  };
  const BERTHS = ['NP', 'LB', 'MB', 'UB', 'SL', 'SU', 'WS'];
  const BERTH_LABELS = {
    NP: 'No Preference', LB: 'Lower', MB: 'Middle', UB: 'Upper',
    SL: 'Side Lower', SU: 'Side Upper', WS: 'Window Side',
  };
  const FOODS = ['', 'V', 'N', 'J', 'D', 'E'];
  const FOOD_LABELS = { '': 'Site default', V: 'Veg', N: 'Non Veg', J: 'Jain', D: 'No Food', E: 'Vegan/Diabetic' };

  const DEFAULTS = {
    version: 1,
    credentials: {
      userId: '',
      password: '',        // plaintext (only when no passphrase is used)
      passwordEnc: null,   // {v, salt, iv, ct} when encrypted with a passphrase
    },
    journey: {
      from: '',            // station code, e.g. NDLS
      to: '',
      date: '',            // YYYY-MM-DD
      quota: 'TQ',
      cls: '3A',
      trainNo: '',
      boardingStation: '', // optional station code
    },
    passengers: [
      // { name, age, gender: 'M'|'F'|'T', berth: 'LB'..., food: 'V'|..., nationality: 'IN' }
    ],
    infants: [
      // { name, age (0-4), gender }
    ],
    contact: { mobile: '' },
    preferences: {
      autoUpgrade: true,
      confirmBerthsOnly: false,
      travelInsurance: 'no', // 'yes' | 'no' | 'skip'
      coachPreference: '',
    },
    payment: {
      // 'UPI' -> BHIM/UPI section on the payment page, then gatewayRegex picks the option.
      // 'EWALLET' -> IRCTC eWallet. 'MANUAL' -> stop on the payment page and do nothing.
      method: 'UPI',
      gatewayRegex: 'paytm|phonepe|bhim|upi',
      autoPayAndBook: true,
    },
    automation: {
      targetTime: '10:00:00',   // IST wall clock for the Book Now click; '' = click as soon as possible
      clickOffsetMs: 300,       // fire this many ms after the boundary (server enables at :00.000)
      preLoginLeadSec: 90,      // panel nags to be logged in this long before the window
      autoSubmitLogin: true,    // click Sign In automatically ONLY when no captcha is present
      captchaAutoSubmitLength: 0, // >0: click Sign In / Continue once you have typed N captcha chars
      autoContinueReview: true, // review page without captcha/OTP -> click Continue
      reloginEnabled: true,
      reloginCooldownMs: 3000,
      maxRelogins: 10,
      bookNowRetries: 20,       // 1/sec retries of class-refresh + Book Now after the window opens
      selectClassInSearch: false, // pick the class in the search form too (applies IRCTC's Journey Class filter!)
      autoAcceptPopup: false,   // click OK on IRCTC's confirm popup after Book Now (otherwise you read & click)
      tickMs: 300,
    },
    // Selector overrides captured with the Pick tool: { nget: {field: css}, eticket: {field: css} }
    selectorsOverride: { nget: {}, eticket: {} },
    acknowledgedRisk: false,
  };

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  /** Deep merge `src` onto a clone of `base`; arrays are replaced, not merged. */
  function mergeDeep(base, src) {
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (!isPlainObject(src)) return out;
    for (const k of Object.keys(src)) {
      const b = out[k], s = src[k];
      out[k] = isPlainObject(b) && isPlainObject(s) ? mergeDeep(b, s) : (Array.isArray(s) ? s.slice() : s);
    }
    return out;
  }

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  /**
   * Validate settings for a booking run. Returns {errors:[], warnings:[]}.
   * Errors block arming; warnings are shown but do not block.
   */
  function validateSettings(s) {
    const errors = [], warnings = [];
    const j = s.journey || {};
    if (!s.credentials || !s.credentials.userId) errors.push('IRCTC user ID missing');
    if (!s.credentials || (!s.credentials.password && !s.credentials.passwordEnc)) errors.push('IRCTC password missing');
    if (!/^[A-Z]{2,5}$/i.test(j.from || '')) errors.push('From station code invalid (e.g. NDLS)');
    if (!/^[A-Z]{2,5}$/i.test(j.to || '')) errors.push('To station code invalid (e.g. BPL)');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(j.date || '')) errors.push('Journey date must be YYYY-MM-DD');
    if (!CLASS_CODES.includes(j.cls)) errors.push('Class code invalid');
    if (!QUOTAS.includes(j.quota)) errors.push('Quota invalid');
    if (!/^\d{5}$/.test(j.trainNo || '')) errors.push('Train number must be 5 digits');
    const pax = Array.isArray(s.passengers) ? s.passengers : [];
    if (!pax.length) errors.push('Add at least one passenger');
    pax.forEach((p, i) => {
      const n = i + 1;
      if (!p.name || p.name.trim().length < 3) errors.push(`Passenger ${n}: name too short`);
      if (!/^[A-Za-z .'-]+$/.test(p.name || '')) errors.push(`Passenger ${n}: name may only contain letters/spaces`);
      const age = Number(p.age);
      if (!Number.isInteger(age) || age < 5 || age > 125) errors.push(`Passenger ${n}: age must be 5-125 (under 5 -> infant)`);
      if (!['M', 'F', 'T'].includes(p.gender)) errors.push(`Passenger ${n}: gender invalid`);
      if (p.berth && !BERTHS.includes(p.berth)) errors.push(`Passenger ${n}: berth invalid`);
    });
    (s.infants || []).forEach((p, i) => {
      const age = Number(p.age);
      if (!p.name || p.name.trim().length < 3) errors.push(`Infant ${i + 1}: name too short`);
      if (!Number.isInteger(age) || age < 0 || age > 4) errors.push(`Infant ${i + 1}: age must be 0-4`);
      if (!['M', 'F', 'T'].includes(p.gender)) errors.push(`Infant ${i + 1}: gender invalid`);
    });
    if ((j.quota === 'TQ' || j.quota === 'PT') && pax.length > 4) errors.push('Tatkal allows at most 4 passengers per ticket');
    if (pax.length > 6) errors.push('IRCTC allows at most 6 passengers per ticket');
    if (!/^\d{10}$/.test((s.contact && s.contact.mobile) || '')) warnings.push('Mobile number is not 10 digits (site default will be kept)');
    if ((j.quota === 'TQ' || j.quota === 'PT') && s.automation && s.automation.targetTime) {
      const isAc = AC_CLASSES.includes(j.cls);
      const expected = isAc ? '10:00' : '11:00';
      if (!String(s.automation.targetTime).startsWith(expected)) {
        warnings.push(`Tatkal for ${j.cls} opens at ${expected} IST but target time is ${s.automation.targetTime}`);
      }
    }
    if (j.quota === 'TQ' && j.cls === '1A') warnings.push('Tatkal quota is not available in 1A');
    if (s.credentials && s.credentials.password && !s.credentials.passwordEnc) {
      warnings.push('Password is stored unencrypted in extension storage (set a passphrase to encrypt)');
    }
    return { errors, warnings };
  }

  /** Convert YYYY-MM-DD to the DD/MM/YYYY IRCTC form. */
  function toIrctcDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  }

  // ---- chrome.storage wrappers (no-ops under node) ---------------------

  const chromeApi = root.chrome && root.chrome.storage ? root.chrome : null;
  let sessionUsable = true;

  function runArea() {
    if (!chromeApi) return null;
    // session storage is only visible to content scripts after the worker
    // called setAccessLevel(TRUSTED_AND_UNTRUSTED_CONTEXTS); fall back to local
    // (key 'run') if that has not happened yet or the API is missing.
    return (sessionUsable && chromeApi.storage.session) || chromeApi.storage.local;
  }

  /** Run a storage op against the session area, degrading to local on access errors. */
  async function withRunArea(op) {
    const area = runArea();
    if (!area) return undefined;
    try {
      return await op(area);
    } catch (e) {
      if (area !== chromeApi.storage.local) {
        sessionUsable = false;
        return op(chromeApi.storage.local);
      }
      throw e;
    }
  }

  async function getSettings() {
    if (!chromeApi) return clone(DEFAULTS);
    const { settings } = await chromeApi.storage.local.get('settings');
    return mergeDeep(DEFAULTS, settings || {});
  }

  async function saveSettings(settings) {
    if (!chromeApi) return;
    await chromeApi.storage.local.set({ settings });
  }

  async function getRun() {
    if (!chromeApi) return {};
    const res = await withRunArea((area) => area.get('run'));
    return (res && res.run) || {};
  }

  async function patchRun(patch) {
    if (!chromeApi) return patch;
    const current = await getRun();
    const next = Object.assign({}, current, patch);
    await withRunArea((area) => area.set({ run: next }));
    return next;
  }

  async function clearRun() {
    if (!chromeApi) return;
    await withRunArea((area) => area.remove('run'));
  }

  return {
    CLASS_CODES, AC_CLASSES, QUOTAS, QUOTA_LABELS, BERTHS, BERTH_LABELS, FOODS, FOOD_LABELS,
    DEFAULTS, mergeDeep, clone, validateSettings, toIrctcDate,
    getSettings, saveSettings, getRun, patchRun, clearRun, runArea,
  };
});
