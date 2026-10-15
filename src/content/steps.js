/*
 * Step handlers, one per page of the booking flow. Each receives a `ctx`
 * built by the engine:
 *   ctx.settings / ctx.password / ctx.mode ('live'|'dryrun') / ctx.site
 *   ctx.get(fieldKey, {root}) / ctx.getAll(fieldKey, {root})  -> profiles.resolve
 *   ctx.signal   AbortSignal - the engine aborts a step when the page changes
 *                (e.g. the login modal pops up mid-step)
 *   ctx.log(msg, level) / ctx.status(text)
 *   ctx.serverNow()  epoch ms corrected by the synced clock offset
 *
 * Steps return {result: 'done'|'human'|'failed', message}. 'human' means the
 * step intentionally stopped for the user (captcha, OTP, payment).
 */
(function (root) {
  'use strict';

  const TA = (root.TA = root.TA || {});
  const D = TA.dom;
  const S = TA.storage;

  const done = (message) => ({ result: 'done', message });
  const human = (message) => ({ result: 'human', message });
  const failed = (message) => ({ result: 'failed', message });

  const QUOTA_MATCHERS = {
    GN: /^general$/i, TQ: /^tatkal$/i, PT: /premium\s*tatkal/i, LD: /ladies/i,
    SS: /senior|lower\s*berth/i, HP: /disab|divyang|physically/i, DF: /duty/i, PH: /parliament/i,
  };
  const GENDER_MATCHERS = { M: /^m(ale)?$/i, F: /^f(emale)?$/i, T: /^t(ransgender)?$/i };
  const BERTH_MATCHERS = {
    NP: /no\s*pref/i, LB: /^lower|lower\s*berth|^LB$/i, MB: /^middle|^MB$/i, UB: /^upper|^UB$/i,
    SL: /side\s*lower|^SL$/i, SU: /side\s*upper|^SU$/i, WS: /window/i,
  };
  const FOOD_MATCHERS = {
    V: /^veg(etarian)?$|^V$/i, N: /non[\s-]*veg|^N$/i, J: /jain|^J$/i, D: /no\s*food|^D$/i, E: /vegan|diabetic|^E$/i,
  };

  function esc(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Select in a native <select> or custom dropdown; tries the code first, then the label regex. */
  async function pickOption(control, code, matchers, ctx) {
    if (!control) return false;
    if (control instanceof HTMLSelectElement) {
      return D.selectNativeOption(control, code) || D.selectNativeOption(control, matchers[code] || code);
    }
    return D.openAndPick(control, matchers[code] || code, { signal: ctx.signal });
  }

  function urlChangedSince(startUrl) {
    return location.href !== startUrl;
  }

  // ------------------------------------------------------------------ LOGIN
  async function login(ctx) {
    const creds = ctx.settings.credentials;
    const user = ctx.get('login.userId');
    const pass = ctx.get('login.password');
    if (!user || !pass) return failed('Login form fields not found (use Field Check → Pick)');
    if (!creds.userId || !ctx.password) return human('Credentials missing/locked — set them in Options or unlock in the panel');

    if (user.value !== creds.userId) D.setInputValue(user, creds.userId);
    if (pass.value !== ctx.password) D.setInputValue(pass, ctx.password);
    ctx.log('Login fields filled');

    const captcha = ctx.get('login.captchaInput');
    const submit = ctx.get('login.submit');
    if (captcha) {
      captcha.focus();
      try { captcha.select(); } catch (_) { /* not selectable */ }
      const n = ctx.settings.automation.captchaAutoSubmitLength;
      if (n > 0 && submit) {
        ctx.status(`Type the captcha — Sign In fires at ${n} chars`);
        await D.waitFor(() => captcha.value.length >= n, { timeoutMs: 180000, intervalMs: 60, signal: ctx.signal, what: 'captcha' });
        D.clickEl(submit);
        return done('Sign In clicked after captcha');
      }
      return human('Type the captcha and press Enter');
    }
    if (ctx.settings.automation.autoSubmitLogin && submit) {
      D.clickEl(submit);
      return done('No captcha on form — Sign In clicked');
    }
    return human('Click Sign In');
  }

  // ----------------------------------------------------------------- SEARCH
  async function search(ctx) {
    const j = ctx.settings.journey;
    const from = ctx.get('search.from');
    const to = ctx.get('search.to');
    const date = ctx.get('search.date');
    if (!from || !to || !date) return failed('Search form fields not found (From/To/Date)');

    const stationRe = (code) => new RegExp(`\\(${esc(code)}\\)|(^|[^A-Z])${esc(code)}([^A-Z]|$)`, 'i');
    if (!new RegExp(`\\b${esc(j.from)}\\b`, 'i').test(from.value)) {
      await D.autocompletePick(from, j.from, stationRe(j.from), { signal: ctx.signal });
    }
    if (!new RegExp(`\\b${esc(j.to)}\\b`, 'i').test(to.value)) {
      await D.autocompletePick(to, j.to, stationRe(j.to), { signal: ctx.signal });
    }
    if (!from.value || !to.value) return failed('Station autocomplete did not accept a value');

    const wanted = S.toIrctcDate(j.date);
    if (date.type === 'date') {
      D.setInputValue(date, j.date);
    } else if (date.value !== wanted) {
      D.setInputValue(date, wanted);
      await D.sleep(120, ctx.signal);
      if (date.value !== wanted && !date.value.includes(wanted.slice(0, 2))) {
        // typing was rejected (read-only calendar) – try the popup calendar
        const ok = await pickCalendarDate(date, j.date, ctx);
        if (!ok) return failed(`Could not set journey date ${wanted}`);
      }
      D.pressKey(date, 'Escape');
    }

    const quota = ctx.get('search.quota');
    if (quota) {
      const ok = await pickOption(quota, j.quota, QUOTA_MATCHERS, ctx);
      if (!ok) ctx.log(`Quota ${j.quota} could not be selected`, 'warn');
    }
    // The class is chosen on the train card. Selecting it here makes IRCTC
    // apply a "Journey Class" filter to the results, which can leave the list
    // empty — so this is opt-in only.
    if (ctx.settings.automation.selectClassInSearch) {
      const cls = ctx.get('search.cls');
      if (cls) {
        const re = new RegExp(`\\(${esc(j.cls)}\\)|^${esc(j.cls)}$|${esc(TA.profiles.CLASS_LABELS[j.cls] || j.cls)}`, 'i');
        const ok = await pickOption(cls, j.cls, { [j.cls]: re }, ctx);
        if (!ok) ctx.log(`Class ${j.cls} not in dropdown (fine if the site shows all classes)`, 'warn');
      }
    } else {
      // IRCTC remembers the last search: if a class is still selected from an
      // earlier manual search, reset it so no Journey Class filter is applied.
      const cls = ctx.get('search.cls');
      const current = cls ? D.textOf(cls) : '';
      if (cls && current && !/all\s*class/i.test(current)) {
        const ok = await pickOption(cls, 'ALL', { ALL: /all\s*class/i }, ctx);
        ctx.log(ok ? `Search class reset to All Classes (was "${current}")` : `Could not reset the class dropdown (shows "${current}") — a Journey Class filter may apply`, ok ? 'info' : 'warn');
      } else {
        ctx.log('Search form class left at All Classes (class is picked on the train card)');
      }
    }

    const submit = ctx.get('search.submit');
    if (!submit) return failed('Search button not found');
    const startUrl = location.href;
    D.clickEl(submit);
    ctx.log(`Searching ${j.from} → ${j.to} on ${wanted} (${j.quota}, class ${j.cls} on the card)`);
    try {
      await D.waitFor(() => urlChangedSince(startUrl) || ctx.getAll('trains.box').length, { timeoutMs: 12000, signal: ctx.signal, what: 'train list' });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      return failed('Train list did not load after Search');
    }
    return done('Search submitted');
  }

  /** PrimeNG / generic calendar popup: navigate to the month, click the day. */
  async function pickCalendarDate(input, iso, ctx) {
    const [y, m, d] = iso.split('-').map(Number);
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    D.clickEl(input);
    let panel;
    try {
      panel = await D.waitFor(() => D.visible(D.$$('.ui-datepicker, .p-datepicker, [role="dialog"] table, .calendar, .datepicker'))[0], { timeoutMs: 2500, signal: ctx.signal, what: 'calendar' });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      return false;
    }
    for (let hop = 0; hop < 6; hop++) {
      const header = D.textOf(panel);
      if (new RegExp(`${monthNames[m - 1].slice(0, 3)}[a-z]*\\s*${y}|${y}.*${monthNames[m - 1].slice(0, 3)}`, 'i').test(header)) break;
      const next = D.$('.ui-datepicker-next, .p-datepicker-next, [aria-label*="next" i], .next', panel);
      if (!next) return false;
      D.clickEl(next);
      await D.sleep(120, ctx.signal);
    }
    const days = D.visible(D.$$('td, td > a, td > span, button', panel)).filter((el) => D.textOf(el) === String(d)
      && !el.closest('.ui-datepicker-other-month, .p-datepicker-other-month, .ui-state-disabled, .p-disabled, [aria-disabled="true"], .disabled'));
    const target = days.find((el) => el.tagName !== 'TD') || days[0];
    if (!target) return false;
    D.clickEl(target);
    await D.sleep(100, ctx.signal);
    return true;
  }

  // -------------------------------------------------------------- TRAINLIST
  const CLASS_CODES_RE = /\((SL|3A|2A|1A|CC|EC|2S|3E|FC|EA|EV|VC|VS)\)/i;
  const DATE_TEXT_RE = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s*\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\b\d{1,2}[-/ ](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{2})\b/i;
  const AVAIL_TEXT_RE = /available|\bwl\b|waitlist|\brac\b|regret|not\s*available|curr_avbl|departed|charting|\bnosb\b|\brlwl\b|\bpqwl\b|\bgnwl\b|\btqwl\b|\bcurr\b/i;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const isFilter = (el) => TA.profiles.isFilterControl(el);

  /** Does this element mention exactly our train number (and no other train)? */
  function trainNoRe(trainNo) {
    return new RegExp(`(^|\\D)${esc(trainNo)}(\\D|$)`);
  }

  /** Standalone 5-digit numbers (train numbers) in the text other than ours. */
  function otherTrainNumbers(el, trainNo) {
    const text = el.textContent || '';
    const found = new Set();
    for (const m of text.matchAll(/(?:^|[\s(])(\d{5})(?=[\s)]|$)/g)) if (m[1] !== trainNo) found.add(m[1]);
    return Array.from(found);
  }

  /**
   * Locate the card for our train. Priority:
   *   1. a known card element whose heading (or text) names the train;
   *   2. (unknown layout) climb from the train-number text to the *innermost*
   *      ancestor that owns a Book control — but never past an ancestor that
   *      also names another train or contains filter controls, so we can never
   *      end up holding a wrapper around the whole list or the sidebar.
   */
  function findTrainBox(ctx, trainNo) {
    const re = trainNoRe(trainNo);
    const cards = ctx.getAll('trains.box');
    for (const card of cards) {
      const heading = ctx.get('trains.heading', { root: card });
      const haystack = heading ? D.textOf(heading) : (card.textContent || '');
      if (re.test(haystack)) return card;
    }
    if (cards.length) {
      // headings exist but none matched: fall back to the whole card text
      const byText = cards.find((c) => re.test(c.textContent || ''));
      if (byText) return byText;
    }
    const hits = D.findAllByText(re, { tags: 'strong, b, span, div, td, h1, h2, h3, h4, h5, h6, a, p', maxLen: 120 })
      .filter((el) => !isFilter(el));
    for (const hit of hits) {
      let el = hit.parentElement;
      for (let i = 0; i < 10 && el && el !== document.body; i++) {
        if (otherTrainNumbers(el, trainNo).length) break; // grew past our card
        if (el.querySelector('input[type="checkbox"], input[type="radio"], p-checkbox, p-radiobutton, [role="checkbox"], [role="radio"]')) break; // filters live here
        const book = Array.from(el.querySelectorAll('button, a, [role="button"]')).find((b) => /book/i.test(D.textOf(b)));
        if (book) return el;
        el = el.parentElement;
      }
    }
    return null;
  }

  /** Cells that are class tabs (name a class code) vs. date/availability cells. */
  function classCellsIn(ctx, box) {
    return ctx.getAll('trains.classCell', { root: box }).filter((el) => CLASS_CODES_RE.test(D.textOf(el)) && !DATE_TEXT_RE.test(D.textOf(el)) && !isFilter(el));
  }

  function dateCellsIn(ctx, box) {
    const cells = ctx.getAll('trains.availCell', { root: box }).filter((el) => !isFilter(el));
    const dated = cells.filter((el) => DATE_TEXT_RE.test(D.textOf(el)) && !CLASS_CODES_RE.test(D.textOf(el)));
    if (dated.length) return dated;
    // layouts without a date label: availability text only
    return cells.filter((el) => AVAIL_TEXT_RE.test(D.textOf(el)) && !CLASS_CODES_RE.test(D.textOf(el)));
  }

  function classCellIn(ctx, box, cls) {
    const cells = classCellsIn(ctx, box);
    const exact = cells.find((el) => new RegExp(`\\(${esc(cls)}\\)`, 'i').test(D.textOf(el)));
    if (exact) return exact;
    const label = TA.profiles.CLASS_LABELS[cls];
    return (label && cells.find((el) => new RegExp(esc(label), 'i').test(D.textOf(el)))) || null;
  }

  function dateCellIn(ctx, box, iso) {
    const [, m, d] = iso.split('-').map(Number);
    const mon = MONTHS[m - 1];
    const dd = String(d).padStart(2, '0');
    const cells = dateCellsIn(ctx, box);
    const re = new RegExp(`\\b0?${d}\\b[^0-9]{0,4}${mon}|${mon}[^0-9]{0,4}\\b0?${d}\\b|\\b${dd}[-/]${String(m).padStart(2, '0')}\\b`, 'i');
    return cells.find((c) => re.test(D.textOf(c))) || null;
  }

  function bookNowIn(ctx, box) {
    const btn = ctx.get('trains.bookNow', { root: box });
    if (!btn) return { btn: null, enabled: false };
    const enabled = !(btn.disabled || btn.getAttribute('aria-disabled') === 'true' || /\b(disabled|disable-book|disable)\b/i.test(btn.className || ''));
    return { btn, enabled };
  }

  /** Click a class tab and wait (briefly) for the availability strip to render. */
  async function selectClass(ctx, box, cls) {
    const cell = classCellIn(ctx, box, cls);
    if (!cell) return false;
    const before = dateCellsIn(ctx, box).length;
    D.clickEl(cell); // bubbles up to the tab anchor
    try {
      await D.waitFor(() => {
        const now = dateCellsIn(ctx, box);
        return now.length && (now.length !== before || now.some((c) => AVAIL_TEXT_RE.test(D.textOf(c)))) ? now : null;
      }, { timeoutMs: 4000, intervalMs: 80, signal: ctx.signal, what: 'availability strip' });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      ctx.log('Availability strip did not render within 4s', 'warn');
    }
    return true;
  }

  /** Re-fetch availability: click the selected class tab again (or the class cell). */
  async function refreshAvailability(ctx, box, cls) {
    const tab = ctx.get('trains.selectedClassTab', { root: box });
    if (tab && !isFilter(tab)) {
      const before = dateCellsIn(ctx, box).map((c) => D.textOf(c)).join('|');
      D.clickEl(tab);
      try {
        await D.waitFor(() => dateCellsIn(ctx, box).map((c) => D.textOf(c)).join('|') !== before || bookNowIn(ctx, box).enabled ? true : null,
          { timeoutMs: 3000, intervalMs: 80, signal: ctx.signal });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
      return;
    }
    await selectClass(ctx, box, cls);
  }

  /** Pick our date cell (enables Book Now on the classic site). */
  async function selectDate(ctx, box, iso) {
    const cell = dateCellIn(ctx, box, iso);
    if (!cell) return false;
    D.clickEl(cell);
    try {
      await D.waitFor(() => bookNowIn(ctx, box).enabled ? true : null, { timeoutMs: 1500, intervalMs: 50, signal: ctx.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
    }
    return true;
  }

  async function trainlist(ctx) {
    const j = ctx.settings.journey;
    const a = ctx.settings.automation;
    let box;
    try {
      box = await D.waitFor(() => findTrainBox(ctx, j.trainNo), { timeoutMs: 15000, intervalMs: 200, signal: ctx.signal, what: `train ${j.trainNo}` });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      const cards = ctx.getAll('trains.box').length;
      return human(`Train ${j.trainNo} not found (${cards} cards on page) — check date/stations, or Copy debug`);
    }
    D.flash(box, '#4caf50');
    const heading = ctx.get('trains.heading', { root: box });
    ctx.log(`Train located: ${heading ? D.textOf(heading).slice(0, 50) : j.trainNo}`);

    const classes = classCellsIn(ctx, box).map((c) => D.textOf(c).slice(0, 30));
    if (!(await selectClass(ctx, box, j.cls))) {
      return human(`Class ${j.cls} not offered on this train (cards shows: ${classes.join(' | ') || 'no class cells found'})`);
    }
    ctx.log(`Class ${j.cls} selected; ${dateCellsIn(ctx, box).length} availability cells`);
    if (!(await selectDate(ctx, box, j.date))) {
      const seen = dateCellsIn(ctx, box).map((c) => D.textOf(c).slice(0, 40));
      ctx.log(`Date cell for ${j.date} not found yet (cells: ${seen.join(' | ') || 'none'})`, 'warn');
    }

    // Wait for the Tatkal window (server-corrected clock)
    const target = a.targetTime ? TA.time.nextTargetEpoch(a.targetTime, ctx.serverNow()) + (a.clickOffsetMs || 0) : 0;
    if (target && target > ctx.serverNow()) {
      ctx.log(`Waiting for ${a.targetTime} IST (+${a.clickOffsetMs}ms)`);
      let lastRefresh = Date.now();
      while (target - ctx.serverNow() > 0) {
        const remaining = target - ctx.serverNow();
        ctx.status(`Book Now in ${TA.time.formatCountdown(remaining)}`);
        // keep the session warm while waiting, but stop touching the page in the last 3s
        if (remaining > 3000 && Date.now() - lastRefresh > 45000) {
          lastRefresh = Date.now();
          await refreshAvailability(ctx, box, j.cls);
          await selectDate(ctx, box, j.date);
        }
        await D.sleep(remaining > 1500 ? 250 : Math.min(remaining, 15), ctx.signal);
      }
      ctx.log(`Window open @ ${TA.time.istClock(ctx.serverNow())} IST`);
    }

    const startUrl = location.href;
    for (let attempt = 1; attempt <= Math.max(1, a.bookNowRetries); attempt++) {
      ctx.status(`Book Now attempt ${attempt}`);
      let { btn, enabled } = bookNowIn(ctx, box);
      if (!enabled) {
        await selectDate(ctx, box, j.date);
        ({ btn, enabled } = bookNowIn(ctx, box));
      }
      if (!enabled) {
        await refreshAvailability(ctx, box, j.cls);
        await selectDate(ctx, box, j.date);
        ({ btn, enabled } = bookNowIn(ctx, box));
      }
      if (enabled && btn) {
        D.clickEl(btn);
        ctx.log(`Book Now clicked (attempt ${attempt}) @ ${TA.time.istClock(ctx.serverNow())}`);
        try {
          await D.waitFor(() => urlChangedSince(startUrl) || ctx.get('pax.addLink') || ctx.get('login.password') || ctx.get('trains.popupAccept'),
            { timeoutMs: 3000, intervalMs: 50, signal: ctx.signal });
          const popup = ctx.get('trains.popupAccept');
          if (popup && !urlChangedSince(startUrl)) {
            const dialog = popup.closest('p-confirmdialog, [role="dialog"], [role="alertdialog"], .modal') || popup.parentElement;
            const text = D.textOf(dialog).slice(0, 160);
            if (a.autoAcceptPopup) {
              D.clickEl(popup);
              ctx.log(`Popup accepted: "${text}"`);
            } else {
              return human(`IRCTC popup: "${text}" — read it and click`);
            }
          }
          return done('Book Now accepted');
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          // no navigation: probably "not yet open" — loop and retry
        }
      } else {
        ctx.log(`Book Now ${btn ? 'still disabled' : 'button not found'} (attempt ${attempt})`, 'warn');
        await D.sleep(700, ctx.signal);
      }
    }
    return human('Book Now did not go through — click it manually (Copy debug in the panel helps me fix this)');
  }

  // ------------------------------------------------------------- PASSENGERS
  function rowsOf(ctx, rowKey, nameKey) {
    const rows = ctx.getAll(rowKey);
    if (rows.length) return rows;
    return ctx.getAll(nameKey).map((inp) => inp); // indexed mode: use the inputs themselves as anchors
  }

  function rowField(ctx, rows, index, key, indexedMode) {
    if (indexedMode) return ctx.getAll(key)[index] || null;
    return rows[index] ? ctx.get(key, { root: rows[index] }) : null;
  }

  async function ensureRows(ctx, wanted, rowKey, nameKey, addKey, what) {
    let rows = rowsOf(ctx, rowKey, nameKey);
    let guard = 0;
    while (rows.length < wanted && guard++ < wanted + 2) {
      const add = ctx.get(addKey);
      if (!add) return rows;
      const before = rows.length;
      D.clickEl(add);
      try {
        await D.waitFor(() => rowsOf(ctx, rowKey, nameKey).length > before, { timeoutMs: 2500, intervalMs: 60, signal: ctx.signal, what: `${what} row` });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        break;
      }
      rows = rowsOf(ctx, rowKey, nameKey);
    }
    return rows;
  }

  async function fillNameInput(input, name, ctx) {
    const before = new Set(D.visibleOptionItems());
    D.setInputValue(input, name, { blur: false });
    await D.sleep(350, ctx.signal); // master-list autocomplete debounce
    const fresh = D.visibleOptionItems().filter((el) => !before.has(el));
    const exact = fresh.find((el) => D.textOf(el).toLowerCase() === name.toLowerCase());
    if (exact) D.clickEl(exact); else if (fresh.length) D.pressKey(input, 'Escape');
    D.fire(input, 'blur');
    if (input.value.trim().toLowerCase() !== name.toLowerCase()) D.setInputValue(input, name);
  }

  async function passengers(ctx) {
    const s = ctx.settings;
    try {
      await D.waitFor(() => ctx.get('pax.name') || ctx.get('pax.addLink'), { timeoutMs: 10000, signal: ctx.signal, what: 'passenger form' });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      return failed('Passenger form not found');
    }

    const rows = await ensureRows(ctx, s.passengers.length, 'pax.row', 'pax.name', 'pax.addLink', 'passenger');
    const indexed = !ctx.getAll('pax.row').length;
    if (rows.length < s.passengers.length) ctx.log(`Only ${rows.length} passenger rows available`, 'warn');

    for (let i = 0; i < Math.min(rows.length, s.passengers.length); i++) {
      const p = s.passengers[i];
      const name = rowField(ctx, rows, i, 'pax.name', indexed);
      const age = rowField(ctx, rows, i, 'pax.age', indexed);
      const gender = rowField(ctx, rows, i, 'pax.gender', indexed);
      const berth = rowField(ctx, rows, i, 'pax.berth', indexed);
      const food = rowField(ctx, rows, i, 'pax.food', indexed);
      if (!name || !age || !gender) {
        ctx.log(`Row ${i + 1}: some fields missing (name:${!!name} age:${!!age} gender:${!!gender})`, 'warn');
      }
      if (name) await fillNameInput(name, p.name, ctx);
      if (age) D.setInputValue(age, String(p.age));
      if (gender) await pickOption(gender, p.gender, GENDER_MATCHERS, ctx);
      if (berth && p.berth && p.berth !== 'NP') await pickOption(berth, p.berth, BERTH_MATCHERS, ctx);
      if (food && p.food) await pickOption(food, p.food, FOOD_MATCHERS, ctx);
      ctx.log(`Passenger ${i + 1}: ${p.name} filled`);
    }

    if (s.infants && s.infants.length) {
      const irows = await ensureRows(ctx, s.infants.length, 'infant.row', 'infant.name', 'infant.addLink', 'infant');
      const iIndexed = !ctx.getAll('infant.row').length;
      for (let i = 0; i < Math.min(irows.length, s.infants.length); i++) {
        const inf = s.infants[i];
        const name = rowField(ctx, irows, i, 'infant.name', iIndexed);
        const age = rowField(ctx, irows, i, 'infant.age', iIndexed);
        const gender = rowField(ctx, irows, i, 'infant.gender', iIndexed);
        if (name) D.setInputValue(name, inf.name);
        if (age) await pickOption(age, String(inf.age), {}, ctx).catch(() => D.setInputValue(age, String(inf.age)));
        if (gender) await pickOption(gender, inf.gender, GENDER_MATCHERS, ctx);
      }
    }

    const mobile = ctx.get('contact.mobile');
    if (mobile && s.contact.mobile && mobile.value !== s.contact.mobile) D.setInputValue(mobile, s.contact.mobile);

    const pref = s.preferences;
    const au = ctx.get('prefs.autoUpgrade');
    if (au) D.setChecked(au, !!pref.autoUpgrade);
    const cb = ctx.get('prefs.confirmBerths');
    if (cb) D.setChecked(cb, !!pref.confirmBerthsOnly);
    if (pref.travelInsurance !== 'skip') {
      const radio = ctx.get(pref.travelInsurance === 'yes' ? 'prefs.insuranceYes' : 'prefs.insuranceNo');
      if (radio) D.setChecked(radio, true);
    }
    if (pref.coachPreference) {
      const coach = ctx.get('prefs.coach');
      if (coach) D.setInputValue(coach, pref.coachPreference);
    }
    if (s.payment.method === 'UPI') {
      const r = ctx.get('pay.upiRadio');
      if (r) D.setChecked(r, true);
    } else if (s.payment.method === 'EWALLET' || s.payment.method === 'CARDS') {
      const r = ctx.get('pay.otherRadio');
      if (r) D.setChecked(r, true);
    }

    if (ctx.mode === 'dryrun') return human('DRY RUN: form filled, stopped before Continue');
    const cont = ctx.get('pax.continue');
    if (!cont) return human('Continue button not found — click it manually');
    await D.sleep(150, ctx.signal);
    D.clickEl(cont);
    return done('Passenger details submitted');
  }

  // ----------------------------------------------------------------- REVIEW
  async function review(ctx) {
    const otp = ctx.get('review.otpInput');
    if (otp) {
      otp.focus();
      return human('Enter the Aadhaar OTP from your phone');
    }
    const captcha = ctx.get('review.captchaInput');
    const cont = ctx.get('review.continue');
    if (captcha) {
      captcha.focus();
      const n = ctx.settings.automation.captchaAutoSubmitLength;
      if (n > 0 && cont) {
        ctx.status(`Type the captcha — Continue fires at ${n} chars`);
        await D.waitFor(() => captcha.value.length >= n, { timeoutMs: 180000, intervalMs: 60, signal: ctx.signal, what: 'captcha' });
        D.clickEl(cont);
        return done('Continue clicked after captcha');
      }
      return human('Type the captcha and press Enter');
    }
    if (ctx.settings.automation.autoContinueReview && cont) {
      D.clickEl(cont);
      return done('Review page: Continue clicked');
    }
    return human('Review the booking and click Continue');
  }

  // ---------------------------------------------------------------- PAYMENT
  async function payment(ctx) {
    const pay = ctx.settings.payment;
    if (ctx.mode === 'dryrun' || pay.method === 'MANUAL') return human('Choose your payment option');

    if (pay.method === 'UPI') {
      const m = ctx.get('payment.methodUpi');
      if (m) {
        D.clickEl(m);
        await D.sleep(500, ctx.signal);
      } else {
        ctx.log('UPI section not found', 'warn');
      }
      let gwRe;
      try { gwRe = new RegExp(pay.gatewayRegex || 'upi', 'i'); } catch (_) { gwRe = /upi/i; }
      const options = ctx.getAll('payment.gateway').filter((el) => gwRe.test(D.textOf(el)));
      if (options.length) {
        D.clickEl(options[0]);
        ctx.log(`Gateway selected: ${D.textOf(options[0]).slice(0, 60)}`);
        await D.sleep(300, ctx.signal);
      } else {
        ctx.log('No gateway matched your regex — pick one manually', 'warn');
      }
    } else if (pay.method === 'EWALLET') {
      const m = ctx.get('payment.methodEwallet');
      if (m) {
        D.clickEl(m);
        await D.sleep(500, ctx.signal);
      }
    }

    if (!pay.autoPayAndBook) return human('Click Pay & Book when ready');
    const btn = ctx.get('payment.payAndBook');
    if (!btn) return human('Pay & Book button not found — click it manually');
    D.clickEl(btn);
    return done('Pay & Book clicked — scan the QR / approve on your phone');
  }

  TA.steps = { LOGIN: login, SEARCH: search, TRAINLIST: trainlist, PASSENGERS: passengers, REVIEW: review, PAYMENT: payment };
})(typeof globalThis !== 'undefined' ? globalThis : this);
