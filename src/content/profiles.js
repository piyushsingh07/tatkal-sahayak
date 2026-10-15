/*
 * Logical field catalogue. Every field the steps need is resolved through
 * an ordered list of candidate locators:
 *   1. a user override captured with the Pick tool (settings.selectorsOverride)
 *   2. site-specific candidates ('nget' = classic Angular/PrimeNG site,
 *      'eticket' = 2026 CRIS beta site)
 *   3. site-agnostic semantic candidates (labels, placeholders, button text)
 *
 * Candidate shapes:
 *   {css: 'selector'}                      querySelectorAll, visible only unless hiddenOk
 *   {label: /regex/}                       findAllByLabel
 *   {text: /regex/, clickable: true}       findAllByText / findClickableByText
 *   {near: /regex/, kind: 'checkbox'|'radio'}  control adjacent to a piece of text
 *   {fn: (root) => Element[] }             custom
 */
(function (root) {
  'use strict';

  const TA = (root.TA = root.TA || {});
  const D = TA.dom;

  function detectSite(url = location.href) {
    if (/\/eticket(\/|$|\?)/.test(url)) return 'eticket';
    if (/\/nget(\/|$|\?)/.test(url)) return 'nget';
    return 'unknown';
  }

  /** Checkbox/radio sitting next to a text label such as "Consider for Auto Upgradation". */
  function controlNearText(re, kind, rootEl) {
    const prime = kind === 'radio'
      ? 'p-radiobutton, .ui-radiobutton, .p-radiobutton, [role="radio"]'
      : 'p-checkbox, .ui-chkbox, .p-checkbox, [role="checkbox"], .ui-chkbox-box, .p-checkbox-box';
    const nativeSel = `input[type="${kind}"]`;
    const out = [];
    for (const hit of D.findAllByText(re, { root: rootEl, tags: 'label, span, div, td, p, li, strong, b' })) {
      let el = hit;
      for (let i = 0; i < 5 && el && el !== document.body; i++) {
        if (el.matches(nativeSel) || el.matches(prime)) { out.push(el); break; }
        const inner = el.querySelector(`${nativeSel}, ${prime}`);
        if (inner) { out.push(inner); break; }
        if (hit instanceof HTMLLabelElement && hit.htmlFor) {
          const byFor = document.getElementById(hit.htmlFor);
          if (byFor) { out.push(byFor); break; }
        }
        el = el.parentElement;
      }
    }
    return out;
  }

  const CLASS_LABELS = {
    SL: 'Sleeper', '3A': 'AC 3 Tier', '3E': 'AC 3 Economy', '2A': 'AC 2 Tier', '1A': 'AC First Class',
    CC: 'AC Chair car', EC: 'Exec. Chair Car', '2S': 'Second Sitting', FC: 'First Class',
    EA: 'Anubhuti', EV: 'Vistadome AC', VC: 'Vistadome Chair', VS: 'Vistadome Non AC',
  };

  /**
   * Anything that looks like a list FILTER rather than booking content:
   * checkboxes/radios/switches, their labels, and the filter sidebar / the
   * "modify search" form that IRCTC repeats on the train-list page. The train
   * list step must never click these — a stray click here hides every train.
   */
  const FILTER_CONTROL = 'input[type="checkbox"], input[type="radio"], p-checkbox, p-radiobutton, p-inputswitch, p-togglebutton, p-selectbutton, p-slider, p-dropdown, p-multiselect, '
    + '.ui-chkbox, .ui-radiobutton, .p-checkbox, .p-radiobutton, [role="checkbox"], [role="radio"], [role="switch"], [role="menuitemcheckbox"], label[for], '
    + '[class*="filter" i], [id*="filter" i], [class*="sidebar" i], [class*="side-bar" i], aside, app-modify-search, app-jp-input';

  function isFilterControl(el) {
    if (!(el instanceof Element)) return false;
    try {
      if (el.closest(FILTER_CONTROL)) return true;
      return !!el.querySelector('input[type="checkbox"], input[type="radio"], p-checkbox, p-radiobutton, [role="checkbox"], [role="radio"], [role="switch"]');
    } catch (_) {
      return false;
    }
  }

  const FIELDS = {
    // ---- login ---------------------------------------------------------
    'login.userId': {
      page: 'LOGIN', label: 'User ID input',
      nget: [{ css: 'app-login input[formcontrolname="userid"]' }, { css: 'input[formcontrolname="userid"]' }],
      any: [{ label: /user\s*(name|id)|username|login\s*id/i }, { css: 'input[type="text"][name*="user" i], input#username, input#userId, input#userid' }],
    },
    'login.password': {
      page: 'LOGIN', label: 'Password input',
      nget: [{ css: 'app-login input[formcontrolname="password"]' }, { css: 'input[formcontrolname="password"]' }],
      any: [{ css: 'input[type="password"]' }, { label: /password/i }],
    },
    'login.captchaInput': {
      page: 'LOGIN', label: 'Login captcha input (you type this)',
      nget: [{ css: 'app-login app-captcha #captcha' }, { css: 'app-login input#captcha' }, { css: 'app-login input[formcontrolname="captcha"]' }],
      any: [{ label: /captcha/i }],
    },
    'login.captchaImage': {
      page: 'LOGIN', label: 'Login captcha image', optional: true,
      nget: [{ css: 'app-login app-captcha .captcha-img' }, { css: 'app-login img.captcha-img' }],
      any: [{ css: 'img[src*="captcha" i], img.captcha-img, img[alt*="captcha" i]' }],
    },
    'login.submit': {
      page: 'LOGIN', label: 'Sign In button',
      nget: [{ css: 'app-login button[type="submit"]' }],
      any: [{ text: /^(sign\s*in|log\s*in|login)$/i, clickable: true }, { css: 'form button[type="submit"]' }],
    },
    'login.openLink': {
      page: 'ANY', label: 'Header LOGIN link (opens modal)', optional: true,
      nget: [{ css: 'app-header a.loginText' }, { css: 'a.loginText, .loginText' }],
      any: [{ text: /^(login|log\s*in|sign\s*in)$/i, clickable: true }],
    },

    // ---- search --------------------------------------------------------
    // Verified against the live site (Sept 2026): the search form is
    // <app-jp-input>; the train-list page repeats it as <app-modify-search>.
    'search.from': {
      page: 'SEARCH', label: 'From station input',
      nget: [{ css: 'app-jp-input #origin input' }, { css: '#origin input' }, { css: 'p-autocomplete#origin input' }],
      any: [{ label: /^from\b|from\s*station|source|boarding|origin/i }],
    },
    'search.to': {
      page: 'SEARCH', label: 'To station input',
      nget: [{ css: 'app-jp-input #destination input' }, { css: '#destination input' }, { css: 'p-autocomplete#destination input' }],
      any: [{ label: /^to\b|to\s*station|destination/i }],
    },
    'search.date': {
      page: 'SEARCH', label: 'Journey date input',
      nget: [{ css: 'app-jp-input #jDate input' }, { css: '#jDate input' }, { css: 'app-modify-search #journeyDate input' }, { css: 'p-calendar input' }],
      any: [{ label: /journey\s*date|date\s*of\s*journey|^date\b|travel\s*date/i }, { css: 'input[type="date"]' }],
    },
    'search.cls': {
      // Only used when automation.selectClassInSearch is on. Picking a class
      // here makes IRCTC apply a "Journey Class" filter to the result list;
      // the class is normally chosen on the train card instead.
      page: 'SEARCH', label: 'Class dropdown (optional, off by default)', optional: true,
      nget: [{ css: 'p-dropdown#journeyClass' }, { css: '#journeyClass' }],
      any: [{ label: /\bclass\b/i }],
    },
    'search.quota': {
      page: 'SEARCH', label: 'Quota dropdown',
      nget: [{ css: 'p-dropdown#journeyQuota' }, { css: '#journeyQuota' }],
      any: [{ label: /quota/i }],
    },
    'search.submit': {
      page: 'SEARCH', label: 'Search button',
      nget: [{ css: 'app-jp-input button[type="submit"].search_btn' }, { css: 'button.search_btn.train_Search' }, { css: 'app-jp-input button[type="submit"]' }],
      any: [{ text: /^search(\s*trains?)?$/i, clickable: true }, { css: 'button[type="submit"]' }],
    },

    // ---- train list ----------------------------------------------------
    // Verified structure: <app-train-avl-enq> card; train number in
    // .train-heading; class tabs are a p-tabmenu (li[role=tab] > a > .pre-avl >
    // strong "Sleeper (SL)"); after a class is selected the availability strip
    // loads asynchronously as more .pre-avl cells ("Wed, 01 Oct" + AVAILABLE/WL
    // /REGRET); Book Now is button.btnDefault.train_Search, disabled via the
    // "disable-book" class until a date cell is picked.
    'trains.box': {
      page: 'TRAINLIST', label: 'Train result cards', multi: true,
      nget: [{ css: 'app-train-avl-enq' }, { css: 'div.train_avl_enq_box' }],
      // Unknown layout: a visible card-ish element that names a 5-digit train,
      // shows a class code or availability and owns a Book control.
      any: [{ fn: (r) => D.visible(D.$$('[class*="train" i], [class*="card" i], article, li', r)).filter((el) => {
        const t = el.textContent || '';
        return t.length < 3000 && /(^|\D)\d{5}(\D|$)/.test(t) && /book/i.test(t)
          && /\((SL|3A|2A|1A|CC|EC|2S|3E|FC|EA|EV|VC|VS)\)|avail|regret|\bWL\b|\bRAC\b/i.test(t)
          && el.querySelector('button, a[role="button"], [role="button"]');
      }) }],
    },
    'trains.heading': {
      page: 'TRAINLIST', label: 'Train name/number heading (inside a card)', optional: true,
      nget: [{ css: '.train-heading' }],
      any: [{ css: 'h1, h2, h3, h4, h5, h6, strong, b, [class*="heading" i], [class*="title" i], [class*="name" i]' }],
    },
    'trains.classCell': {
      page: 'TRAINLIST', label: 'Class tab cells (inside a card)', multi: true,
      nget: [{ css: 'p-tabmenu li[role="tab"] .pre-avl' }, { css: '.pre-avl' }],
      any: [{ fn: (r) => D.visible(D.$$('[role="tab"], .pre-avl, td, div, span, a, button', r)).filter((el) => /\((SL|3A|2A|1A|CC|EC|2S|3E|FC|EA|EV|VC|VS)\)/i.test(el.textContent || '') && (el.textContent || '').length < 80 && !isFilterControl(el)) }],
    },
    'trains.selectedClassTab': {
      page: 'TRAINLIST', label: 'Selected class tab (refresh target, inside a card)', optional: true,
      nget: [{ css: 'p-tabmenu li[role="tab"][aria-selected="true"] a' }],
      any: [{ css: '[role="tab"][aria-selected="true"]' }],
    },
    'trains.bookNow': {
      page: 'TRAINLIST', label: 'Book Now button (inside a train card)',
      nget: [{ css: 'button.btnDefault.train_Search' }, { css: 'button.train_Search' }],
      any: [{ text: /book\s*now|^book$/i, clickable: true }],
    },
    'trains.availCell': {
      page: 'TRAINLIST', label: 'Availability/date cells (inside a card, after class click)', multi: true, optional: true,
      nget: [{ css: '.pre-avl' }],
      any: [{ fn: (r) => D.visible(D.$$('td, div, li, span, button', r)).filter((el) => /available|wl|waitlist|regret|rac|not\s*available|curr_avbl|departed/i.test(el.textContent || '') && (el.textContent || '').length < 80 && !isFilterControl(el)) }],
    },
    'trains.popupAccept': {
      page: 'TRAINLIST', label: 'Confirm popup accept button (after Book Now)', optional: true,
      nget: [{ css: 'p-confirmdialog .ui-confirmdialog-acceptbutton' }],
      any: [{ fn: (r) => D.visible(D.$$('[role="dialog"] button, [role="alertdialog"] button, .modal button', r)).filter((el) => /^(ok|yes|confirm|continue|proceed)$/i.test(D.textOf(el))) }],
    },

    // ---- passengers ----------------------------------------------------
    'pax.addLink': {
      page: 'PASSENGERS', label: '+ Add Passenger link',
      nget: [{ fn: (r) => D.visible(D.$$('app-passenger-input p-panel .prenext, app-passenger-input .prenext', r)).filter((el) => /add\s*passenger/i.test(D.textOf(el))) }, { text: /add\s*passenger/i, clickable: true }],
      any: [{ text: /add\s*(another\s*)?passenger/i, clickable: true }],
    },
    'pax.row': {
      page: 'PASSENGERS', label: 'Passenger row container', multi: true,
      nget: [{ css: 'app-passenger' }],
      any: [{ css: '[class*="passenger" i][class*="row" i], .passenger-row, .passenger-card, [data-passenger-index]' }],
    },
    'pax.name': {
      page: 'PASSENGERS', label: 'Passenger name input', row: true,
      nget: [{ css: 'app-passenger p-autocomplete input' }, { css: 'input#psgn-name, input[placeholder="Name"]' }],
      any: [{ label: /passenger\s*name|^name\b|full\s*name/i }],
    },
    'pax.age': {
      page: 'PASSENGERS', label: 'Passenger age input', row: true,
      nget: [{ css: 'input[formcontrolname="passengerAge"]' }, { css: 'input#psgn-age, input[placeholder="Age"]' }],
      any: [{ label: /\bage\b/i }],
    },
    'pax.gender': {
      page: 'PASSENGERS', label: 'Passenger gender select', row: true,
      nget: [{ css: 'select[formcontrolname="passengerGender"]' }, { css: 'select#psgn-gender' }],
      any: [{ label: /gender|sex/i }],
    },
    'pax.berth': {
      page: 'PASSENGERS', label: 'Berth preference select', row: true, optional: true,
      nget: [{ css: 'select[formcontrolname="passengerBerthChoice"]' }, { css: 'select#psgn-berth-choice' }],
      any: [{ label: /berth|seat\s*pref/i }],
    },
    'pax.food': {
      page: 'PASSENGERS', label: 'Food choice select', row: true, optional: true,
      nget: [{ css: 'select[formcontrolname="passengerFoodChoice"]' }, { css: 'select#psgn-food-choice' }],
      any: [{ label: /food|meal|catering/i }],
    },
    'pax.nationality': {
      page: 'PASSENGERS', label: 'Nationality select', row: true, optional: true,
      nget: [{ css: 'select[formcontrolname="passengerNationality"]' }],
      any: [{ label: /nationality|country/i }],
    },
    'infant.addLink': {
      page: 'PASSENGERS', label: '+ Add Infant link', optional: true,
      nget: [{ fn: (r) => D.visible(D.$$('app-passenger-input p-panel .prenext, app-passenger-input .prenext', r)).filter((el) => /add\s*infant/i.test(D.textOf(el))) }],
      any: [{ text: /add\s*infant/i, clickable: true }],
    },
    'infant.row': {
      page: 'PASSENGERS', label: 'Infant row container', multi: true, optional: true,
      nget: [{ css: 'app-infant' }],
      any: [{ css: '[class*="infant" i]' }],
    },
    'infant.name': { page: 'PASSENGERS', label: 'Infant name', row: true, optional: true, nget: [{ css: 'input[formcontrolname="name"]' }], any: [{ label: /name/i }] },
    'infant.age': { page: 'PASSENGERS', label: 'Infant age', row: true, optional: true, nget: [{ css: 'select[formcontrolname="age"]' }], any: [{ label: /age/i }] },
    'infant.gender': { page: 'PASSENGERS', label: 'Infant gender', row: true, optional: true, nget: [{ css: 'select[formcontrolname="gender"]' }], any: [{ label: /gender|sex/i }] },
    'contact.mobile': {
      page: 'PASSENGERS', label: 'Mobile number input',
      nget: [{ css: 'input#mobileNumber' }, { css: 'input[formcontrolname="mobileNumber"]' }],
      any: [{ label: /mobile|phone/i }],
    },
    'prefs.autoUpgrade': {
      page: 'PASSENGERS', label: 'Auto upgradation checkbox', optional: true,
      nget: [{ css: 'p-checkbox#autoUpgradation, #autoUpgradation' }],
      any: [{ near: /auto\s*upgrad/i, kind: 'checkbox' }],
    },
    'prefs.confirmBerths': {
      page: 'PASSENGERS', label: '"Book only if confirm berths" checkbox', optional: true,
      nget: [{ css: 'p-checkbox#confirmberths, #confirmberths' }],
      any: [{ near: /confirm(ed)?\s*berth/i, kind: 'checkbox' }],
    },
    'prefs.insuranceYes': {
      page: 'PASSENGERS', label: 'Travel insurance: Yes', optional: true,
      nget: [{ css: 'p-radiobutton#travelInsuranceOptyes, #travelInsuranceOptyes' }],
      any: [{ fn: (r) => insuranceRadio(/^yes/i, r) }],
    },
    'prefs.insuranceNo': {
      page: 'PASSENGERS', label: 'Travel insurance: No', optional: true,
      nget: [{ css: 'p-radiobutton#travelInsuranceOptno, #travelInsuranceOptno' }],
      any: [{ fn: (r) => insuranceRadio(/^no/i, r) }],
    },
    'prefs.coach': {
      page: 'PASSENGERS', label: 'Preferred coach input', optional: true,
      any: [{ label: /coach/i }],
    },
    'pay.upiRadio': {
      page: 'PASSENGERS', label: 'Payment mode: BHIM/UPI radio', optional: true,
      any: [{ near: /bhim|upi/i, kind: 'radio' }],
    },
    'pay.otherRadio': {
      page: 'PASSENGERS', label: 'Payment mode: cards/netbanking radio', optional: true,
      any: [{ near: /credit|debit|net\s*banking|wallet/i, kind: 'radio' }],
    },
    'pax.continue': {
      page: 'PASSENGERS', label: 'Continue button',
      nget: [{ css: 'app-passenger-input button.btnDefault.train_Search' }, { css: 'button.train_Search.btnDefault' }],
      any: [{ text: /^continue$|^next$|^proceed$/i, clickable: true }],
    },

    // ---- review --------------------------------------------------------
    'review.captchaInput': {
      page: 'REVIEW', label: 'Review captcha input (you type this)', optional: true,
      nget: [{ css: 'app-review-booking app-captcha #captcha' }, { css: 'app-captcha #captcha' }, { css: 'input#captcha' }, { css: 'input[formcontrolname="captcha"]' }],
      any: [{ label: /captcha/i }],
    },
    'review.otpInput': {
      page: 'REVIEW', label: 'Aadhaar OTP input (you type this)', optional: true,
      any: [{ label: /\botp\b|one\s*time\s*password/i }],
    },
    'review.continue': {
      page: 'REVIEW', label: 'Continue / Proceed to pay button',
      nget: [{ css: 'app-review-booking button.btnDefault.train_Search' }, { css: 'button.btnDefault.train_Search' }],
      any: [{ text: /^continue$|proceed\s*to\s*pay|make\s*payment|^pay$/i, clickable: true }],
    },

    // ---- payment -------------------------------------------------------
    'payment.methodUpi': {
      page: 'PAYMENT', label: 'Payment method: BHIM/UPI',
      nget: [{ fn: (r) => D.visible(D.$$('#pay-type .bank-type, app-payment-options .bank-type, .bank-type', r)).filter((el) => /bhim|upi/i.test(D.textOf(el))) },
        { fn: (r) => D.findAllByText(/bhim|upi/i, { root: r, tags: '.bank-type, .bank-type *, li, a, div, span' }).map((el) => el.closest('.bank-type') || el) }],
      any: [{ text: /bhim|upi/i, clickable: true }],
    },
    'payment.methodEwallet': {
      page: 'PAYMENT', label: 'Payment method: IRCTC eWallet', optional: true,
      any: [{ text: /e-?wallet/i, clickable: true }],
    },
    'payment.gateway': {
      page: 'PAYMENT', label: 'Gateway option (matched by your regex)', multi: true, optional: true,
      nget: [{ css: '#bank-type .bank-text, #bank-type .pay_tax_text' }, { css: '#bank-type .border-all, .border-all' }],
      any: [{ fn: (r) => D.visible(D.$$('[class*="bank" i], [class*="gateway" i], [class*="option" i], li, label', r)) }],
    },
    'payment.payAndBook': {
      page: 'PAYMENT', label: 'Pay & Book button',
      nget: [{ fn: (r) => D.visible(D.$$('app-payment-options button.btn-primary, button.btn-primary.ng-star-inserted, button.btn.btn-primary.hidden-xs', r)).filter((el) => /pay\s*(&|and)\s*book/i.test(D.textOf(el))) }, { css: 'button.btn.btn-primary.hidden-xs' }],
      any: [{ text: /pay\s*(&|and)\s*book|^pay\s*now$/i, clickable: true }],
    },
  };

  /** Travel-insurance Yes/No radio: scoped to the container that mentions insurance. */
  function insuranceRadio(re, rootEl) {
    const anchors = D.findAllByText(/travel\s*insurance/i, { root: rootEl, tags: 'label, span, div, td, p, strong, b, h4, h5' });
    for (const a of anchors) {
      let el = a;
      for (let i = 0; i < 5 && el && el !== document.body; i++) {
        const radios = controlNearText(re, 'radio', el);
        if (radios.length) return radios;
        el = el.parentElement;
      }
    }
    return [];
  }

  function evalCandidate(c, rootEl) {
    try {
      if (c.css) {
        const els = D.$$(c.css, rootEl);
        return c.hiddenOk ? els : D.visible(els);
      }
      if (c.label) return D.findAllByLabel(c.label, { root: rootEl });
      if (c.text) {
        if (c.clickable) {
          const el = D.findClickableByText(c.text, { root: rootEl });
          return el ? [el] : [];
        }
        return D.findAllByText(c.text, { root: rootEl });
      }
      if (c.near) return controlNearText(c.near, c.kind || 'checkbox', rootEl);
      if (c.fn) return c.fn(rootEl) || [];
    } catch (_) { /* candidate failed */ }
    return [];
  }

  /**
   * Resolve a logical field to element(s).
   * opts: {site, root, all, overrides}
   */
  function resolve(key, opts = {}) {
    const field = FIELDS[key];
    if (!field) throw new Error(`unknown field ${key}`);
    const site = opts.site || detectSite();
    const rootEl = opts.root || document;
    const overrides = (opts.overrides && opts.overrides[site]) || {};
    const chain = [];
    if (overrides[key]) chain.push({ css: overrides[key] });
    if (field[site]) chain.push(...field[site]);
    if (field.any) chain.push(...field.any);
    for (const c of chain) {
      const els = evalCandidate(c, rootEl);
      if (els && els.length) return opts.all ? els : els[0];
    }
    return opts.all ? [] : null;
  }

  function fieldsForPage(page) {
    return Object.keys(FIELDS).filter((k) => FIELDS[k].page === page);
  }

  TA.profiles = { FIELDS, CLASS_LABELS, detectSite, resolve, fieldsForPage, controlNearText, isFilterControl };
})(typeof globalThis !== 'undefined' ? globalThis : this);
