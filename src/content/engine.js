/*
 * The engine watches the page (URL + DOM) and decides which step to run.
 * Design rules:
 *   - one step at a time; a running step is aborted the moment the detected
 *     page changes (login modal appearing mid-wait is the classic case),
 *   - a step runs once per "page instance" (page + signature); it re-runs
 *     when the instance changes (e.g. we come back to SEARCH after re-login),
 *   - failures retry a bounded number of times, then hand over to the human,
 *   - re-login has a cooldown and a hard cap so a wrong password can never
 *     turn into hammering the server.
 */
(function (root) {
  'use strict';

  const TA = (root.TA = root.TA || {});
  const D = TA.dom;
  const P = TA.profiles;
  const S = TA.storage;

  const MAX_STEP_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 2500;
  const LOG_LIMIT = 60;

  class Engine {
    constructor() {
      this.settings = S.clone(S.DEFAULTS);
      this.run = {};
      this.site = P.detectSite();
      this.page = 'UNKNOWN';
      this.signature = '';
      this.current = null;       // {page, key, controller}
      this.attempts = new Map(); // key -> {count, nextAt, state}
      this.lastLoginAt = 0;
      this.reloginCount = 0;
      this.loginEpoch = 0;
      this.listeners = new Set();
      this.log = [];
      this.statusText = '';
      this.lastTick = 0;
      this.pendingTick = null;
      this.timeResyncDone = false;
    }

    // ---- lifecycle -------------------------------------------------------
    async init() {
      this.settings = await S.getSettings();
      this.run = await S.getRun();
      this.log = Array.isArray(this.run.log) ? this.run.log.slice(-LOG_LIMIT) : [];
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.settings) {
          this.settings = S.mergeDeep(S.DEFAULTS, changes.settings.newValue || {});
          this.attempts.clear();
          this.emit();
        }
        if (changes.run && (area === 'session' || area === 'local')) {
          const next = changes.run.newValue || {};
          const wasArmed = !!this.run.armed;
          this.run = next;
          if (!next.armed && wasArmed) this.abortCurrent('disarmed');
          this.emit();
        }
      });
      this.observer = new MutationObserver(() => this.scheduleTick(120));
      this.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'disabled', 'hidden', 'aria-hidden'] });
      this.timer = setInterval(() => this.tick(), this.settings.automation.tickMs || 300);
      this.tick();
    }

    onChange(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }

    /** Stop timers/observers (used by tests and when the extension is reloaded). */
    destroy() {
      this.abortCurrent('destroyed');
      clearInterval(this.timer);
      clearTimeout(this.pendingTick);
      if (this.observer) this.observer.disconnect();
      this.listeners.clear();
    }

    emit() {
      for (const fn of this.listeners) {
        try { fn(this); } catch (_) { /* panel error must not break the engine */ }
      }
    }

    scheduleTick(delay) {
      if (this.pendingTick) return;
      this.pendingTick = setTimeout(() => { this.pendingTick = null; this.tick(); }, delay);
    }

    // ---- state helpers ---------------------------------------------------
    get armed() { return !!this.run.armed; }
    get mode() { return this.run.mode || 'live'; }
    get offsetMs() { return (this.run.timeSync && this.run.timeSync.offsetMs) || 0; }
    serverNow() { return Date.now() + this.offsetMs; }
    get password() { return this.run.password || this.settings.credentials.password || ''; }

    async setArmed(armed, mode = 'live') {
      const patch = { armed, mode };
      if (armed) {
        patch.armedAt = Date.now();
        this.reloginCount = 0;
        this.attempts.clear();
        this.timeResyncDone = false;
        this.addLog(`Armed (${mode}) on ${this.site} site`);
        this.syncTime();
      } else {
        this.abortCurrent('disarmed');
        this.addLog('Disarmed');
      }
      this.run = await S.patchRun(patch);
      this.badge();
      this.emit();
    }

    badge() {
      const text = this.armed ? (this.mode === 'dryrun' ? 'DRY' : 'ON') : '';
      chrome.runtime.sendMessage({ type: 'SET_BADGE', text, color: this.mode === 'dryrun' ? '#f59e0b' : '#16a34a' }, () => chrome.runtime.lastError);
    }

    syncTime() {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'SYNC_TIME', samples: 3 }, (res) => {
          if (chrome.runtime.lastError || !res) return resolve(null);
          if (res.ok) this.addLog(`Clock synced: offset ${res.offsetMs}ms (rtt ${res.rttMs}ms)`);
          else this.addLog(`Clock sync failed (${res.error}) — using local clock`, 'warn');
          resolve(res);
        });
      });
    }

    addLog(message, level = 'info') {
      const entry = { t: Date.now(), message, level };
      this.log.push(entry);
      if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
      S.patchRun({ log: this.log }).catch(() => {});
      this.emit();
    }

    setStatus(text) {
      if (text === this.statusText) return;
      this.statusText = text;
      this.emit();
    }

    // ---- field resolution ------------------------------------------------
    get(key, opts = {}) {
      return P.resolve(key, Object.assign({ site: this.site, overrides: this.settings.selectorsOverride }, opts));
    }

    getAll(key, opts = {}) {
      return P.resolve(key, Object.assign({ site: this.site, overrides: this.settings.selectorsOverride, all: true }, opts));
    }

    // ---- page detection --------------------------------------------------
    detectPage() {
      const url = location.href;
      if (this.get('login.password')) return 'LOGIN';
      if (/payment|bkgPaymentOptions/i.test(url)) return 'PAYMENT';
      if (/review/i.test(url)) return 'REVIEW';
      if (/psgninput|passenger/i.test(url) || this.get('pax.addLink')) return 'PASSENGERS';
      if (this.get('review.captchaInput') && !this.get('search.from')) return 'REVIEW';
      const payBtn = this.get('payment.payAndBook');
      if (payBtn && /pay\s*(&|and)\s*book|pay\s*now/i.test(D.textOf(payBtn))) return 'PAYMENT';
      if (/train-list|trainlist|train_list/i.test(url) || this.getAll('trains.box').length) return 'TRAINLIST';
      if (/train-search|\/(nget|eticket)\/?(\?|#|$)/i.test(url) || (this.get('search.from') && this.get('search.to'))) return 'SEARCH';
      return 'UNKNOWN';
    }

    pageSignature(page) {
      switch (page) {
        case 'REVIEW': return `${location.pathname}|c${!!this.get('review.captchaInput')}|o${!!this.get('review.otpInput')}`;
        case 'LOGIN': return `${location.pathname}|${this.loginEpoch || 0}`;
        default: return location.pathname;
      }
    }

    /** Forget attempt bookkeeping for a page so re-entering it re-runs the step. */
    resetPage(page) {
      for (const k of Array.from(this.attempts.keys())) if (k.startsWith(`${page}|`)) this.attempts.delete(k);
    }

    // ---- main loop -------------------------------------------------------
    tick() {
      const now = Date.now();
      if (now - this.lastTick < 80) return; // coalesce bursts of mutations
      this.lastTick = now;
      this.site = P.detectSite();

      let page;
      try { page = this.detectPage(); } catch (_) { page = 'UNKNOWN'; }
      if (page === 'LOGIN') {
        // A fresh modal = we were not on LOGIN before, or Angular re-created the
        // form (new input elements). Either way the step must run again.
        const pwEl = this.get('login.password');
        if (this.page !== 'LOGIN' || pwEl !== this.lastLoginEl) {
          this.loginEpoch = (this.loginEpoch || 0) + 1;
          this.lastLoginEl = pwEl;
        }
      }
      const sig = this.pageSignature(page);
      const changed = page !== this.page || sig !== this.signature;
      if (changed) {
        if (page !== this.page && this.page !== 'UNKNOWN' && page !== 'UNKNOWN') {
          // genuine transition between known pages: the new page is a fresh instance
          this.resetPage(page);
          if (this.page === 'LOGIN') this.addLog(`Login modal gone — resuming on ${page}`);
        }
        this.page = page;
        this.signature = sig;
        if (this.current && this.current.page !== page) this.abortCurrent(`page changed to ${page}`);
        this.emit();
      }
      if (!this.armed || this.current || page === 'UNKNOWN') return;

      if (this.armed && this.settings.automation.targetTime && !this.timeResyncDone) {
        const target = TA.time.nextTargetEpoch(this.settings.automation.targetTime, this.serverNow());
        const remaining = target - this.serverNow();
        if (remaining > 0 && remaining < 75000) { this.timeResyncDone = true; this.syncTime(); }
      }

      const key = `${page}|${sig}`;
      const att = this.attempts.get(key) || { count: 0, nextAt: 0, state: 'idle' };
      if (att.state === 'done' || att.state === 'human') return;
      if (att.count >= MAX_STEP_ATTEMPTS) {
        if (att.state !== 'gaveup') {
          att.state = 'gaveup';
          this.attempts.set(key, att);
          this.setStatus(`Step ${page} failed ${att.count}× — please continue manually`);
        }
        return;
      }
      if (now < att.nextAt) return;

      if (page === 'LOGIN') {
        if (!this.settings.automation.reloginEnabled) return;
        if (now - this.lastLoginAt < this.settings.automation.reloginCooldownMs) return;
        if (this.reloginCount >= this.settings.automation.maxRelogins) {
          this.setStatus(`Re-login cap (${this.settings.automation.maxRelogins}) reached — disarmed`);
          this.setArmed(false);
          return;
        }
        this.lastLoginAt = now;
        this.reloginCount += 1;
      }
      this.runStep(page, key, att);
    }

    abortCurrent(reason) {
      if (!this.current) return;
      this.current.controller.abort();
      this.addLog(`Step ${this.current.page} aborted (${reason})`, 'warn');
      this.current = null;
    }

    async runStep(page, key, att) {
      const handler = TA.steps[page];
      if (!handler) return;
      const controller = new AbortController();
      this.current = { page, key, controller };
      att.count += 1;
      att.state = 'running';
      this.attempts.set(key, att);
      this.setStatus(`Running ${page} (${att.count}/${MAX_STEP_ATTEMPTS})`);
      const ctx = {
        settings: this.settings,
        password: this.password,
        mode: this.mode,
        site: this.site,
        signal: controller.signal,
        get: (k, o) => this.get(k, o),
        getAll: (k, o) => this.getAll(k, o),
        log: (m, l) => this.addLog(`[${page}] ${m}`, l),
        status: (t) => this.setStatus(t),
        serverNow: () => this.serverNow(),
      };
      try {
        const res = (await handler(ctx)) || { result: 'done' };
        if (this.current && this.current.controller === controller) this.current = null;
        if (res.result === 'done') {
          att.state = 'done';
          this.addLog(`[${page}] ✓ ${res.message || 'done'}`);
          this.setStatus(res.message || `${page} done`);
          if (page === 'PAYMENT') {
            this.addLog('Flow complete — disarming');
            this.setArmed(false);
          }
        } else if (res.result === 'human') {
          att.state = 'human';
          this.addLog(`[${page}] ⏸ ${res.message}`, 'human');
          this.setStatus(`YOU: ${res.message}`);
          this.notifyHuman();
        } else {
          att.state = 'failed';
          att.nextAt = Date.now() + RETRY_DELAY_MS;
          this.addLog(`[${page}] ✗ ${res.message}`, 'error');
          this.setStatus(`${page} failed: ${res.message}`);
        }
      } catch (e) {
        if (this.current && this.current.controller === controller) this.current = null;
        if (e && e.name === 'AbortError') {
          att.state = 'idle';
          att.count = Math.max(0, att.count - 1); // an aborted run does not count
        } else {
          att.state = 'failed';
          att.nextAt = Date.now() + RETRY_DELAY_MS;
          this.addLog(`[${page}] ✗ ${e && e.message ? e.message : e}`, 'error');
        }
      }
      this.attempts.set(key, att);
      this.emit();
      this.scheduleTick(50);
    }

    notifyHuman() {
      // A short beep so you can look away from the screen while it works.
      try {
        const AC = root.AudioContext || root.webkitAudioContext;
        if (!AC) return;
        const ac = new AC();
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.frequency.value = 880;
        gain.gain.value = 0.08;
        osc.connect(gain).connect(ac.destination);
        osc.start();
        osc.stop(ac.currentTime + 0.18);
        setTimeout(() => ac.close().catch(() => {}), 400);
      } catch (_) { /* autoplay policy may block; ignore */ }
    }

    /** Field Check: resolve every field belonging to the current page. */
    fieldReport(page = this.page) {
      const keys = P.fieldsForPage(page === 'LOGIN' ? 'LOGIN' : page);
      return keys.map((key) => {
        const f = P.FIELDS[key];
        let els = [];
        try { els = this.getAll(key); } catch (_) { els = []; }
        const override = (this.settings.selectorsOverride[this.site] || {})[key];
        return { key, label: f.label, optional: !!f.optional, multi: !!f.multi, row: !!f.row, count: els.length, el: els[0] || null, override };
      });
    }

    async saveOverride(key, css) {
      const so = S.clone(this.settings.selectorsOverride || {});
      so[this.site] = so[this.site] || {};
      if (css) so[this.site][key] = css; else delete so[this.site][key];
      this.settings.selectorsOverride = so;
      const stored = await S.getSettings();
      stored.selectorsOverride = so;
      await S.saveSettings(stored);
      this.addLog(css ? `Selector saved for ${key}: ${css}` : `Selector override removed for ${key}`);
    }

    /**
     * Plain-text diagnostic dump for bug reports: what the engine sees on this
     * page (resolved fields, train cards, filter controls, IRCTC messages) plus
     * the recent log. Contains no credentials; passenger names/mobile are masked.
     */
    debugReport() {
      const lines = [];
      const short = (el) => {
        if (!el) return '—';
        const id = el.id ? `#${el.id}` : '';
        const cls = (el.className && typeof el.className === 'string') ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : '';
        const attrs = ['formcontrolname', 'name', 'placeholder', 'role', 'aria-selected', 'type'].map((a) => (el.getAttribute(a) ? `${a}=${el.getAttribute(a)}` : '')).filter(Boolean).join(' ');
        const txt = D.textOf(el).slice(0, 60);
        return `<${el.tagName.toLowerCase()}${id}${cls}${attrs ? ' ' + attrs : ''}> "${txt}"`;
      };
      const mask = (name) => String(name || '').split(/\s+/).map((w) => (w ? w[0] + '***' : '')).join(' ');
      const s = this.settings;
      lines.push(`Tatkal Sahayak debug report — ${TA.time.istClock(this.serverNow())} IST`);
      lines.push(`site=${this.site} page=${this.page} armed=${this.armed} mode=${this.mode} url=${location.href}`);
      lines.push(`journey=${JSON.stringify(s.journey)} passengers=${(s.passengers || []).length} (${(s.passengers || []).map((p) => mask(p.name)).join(', ')}) mobile=${s.contact.mobile ? '******' + String(s.contact.mobile).slice(-4) : '—'}`);
      lines.push(`automation=${JSON.stringify(s.automation)}`);
      lines.push(`overrides(${this.site})=${JSON.stringify((s.selectorsOverride || {})[this.site] || {})}`);
      const ts = this.run.timeSync;
      lines.push(`timeSync=${ts ? `${ts.source} offset=${ts.offsetMs}ms rtt=${ts.rttMs}ms` : 'none'}`);
      const headerClock = D.$('app-header .h_head1 > span strong, app-header .h_head1 strong');
      if (headerClock) lines.push(`IRCTC header clock: "${D.textOf(headerClock)}" (local IST now ${TA.time.istClock(Date.now(), false)})`);

      lines.push('', `[fields for ${this.page}]`);
      for (const f of this.fieldReport(this.page === 'UNKNOWN' ? 'SEARCH' : this.page)) {
        lines.push(`${f.count ? '✓' : (f.optional ? '○' : '✗')} ${f.key} ×${f.count}${f.override ? ` (override ${f.override})` : ''} ${f.el ? short(f.el) : ''}`);
      }

      if (this.page === 'TRAINLIST' || this.getAll('trains.box').length) {
        lines.push('', '[train cards]');
        const cards = this.getAll('trains.box');
        lines.push(`${cards.length} card(s) via trains.box`);
        for (const card of cards.slice(0, 12)) {
          const heading = this.get('trains.heading', { root: card });
          const classCells = this.getAll('trains.classCell', { root: card }).map((c) => D.textOf(c).slice(0, 28));
          const avail = this.getAll('trains.availCell', { root: card }).map((c) => D.textOf(c).slice(0, 40));
          const btn = this.get('trains.bookNow', { root: card });
          lines.push(`- ${short(card)} heading=${heading ? JSON.stringify(D.textOf(heading).slice(0, 60)) : '—'}`);
          lines.push(`    classCells=${JSON.stringify(classCells)}`);
          lines.push(`    availCells=${JSON.stringify(avail.slice(0, 12))}`);
          lines.push(`    bookNow=${btn ? `${short(btn)} disabled=${btn.disabled} class="${btn.className}"` : '—'}`);
        }
        const wanted = this.settings.journey.trainNo;
        const mentions = D.findAllByText(new RegExp(`(^|\\D)${wanted}(\\D|$)`), { tags: 'strong, b, span, div, td, h1, h2, h3, h4, h5, h6, a, p', maxLen: 120 });
        lines.push(`elements mentioning train ${wanted}: ${mentions.length}`, ...mentions.slice(0, 4).map((el) => `  ${short(el)} parent=${short(el.parentElement)} grandparent=${short(el.parentElement && el.parentElement.parentElement)}`));
      }

      const filters = D.visible(D.$$('input[type="checkbox"], input[type="radio"], p-checkbox, p-radiobutton, p-inputswitch, [role="checkbox"], [role="radio"], [role="switch"]'))
        .slice(0, 40)
        .map((el) => {
          const labelEl = (el.id && D.$(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label') || el.parentElement;
          return `${D.isChecked(el) ? '[x]' : '[ ]'} ${D.textOf(labelEl).slice(0, 50) || short(el)}`;
        });
      lines.push('', `[checkbox/radio controls visible: ${filters.length}]`, ...filters);

      const msgs = D.findAllByText(/no\s*trains?|not\s*found|no\s*result|filter|clear\s*all|reset|sorry|error|try\s*again/i, { tags: 'div, span, p, h1, h2, h3, h4, h5, li, b, strong, button, a', maxLen: 140 })
        .slice(0, 12).map((el) => `  ${short(el)}`);
      lines.push('', `[messages / filter-ish text: ${msgs.length}]`, ...msgs);

      lines.push('', '[log]', ...this.log.slice(-30).map((e) => `${TA.time.istClock(e.t, false)} ${e.level === 'info' ? '' : e.level.toUpperCase() + ' '}${e.message}`));
      return lines.join('\n');
    }
  }

  TA.Engine = Engine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
