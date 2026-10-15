/*
 * A tiny fake of the classic IRCTC (Angular/PrimeNG) booking flow, good enough
 * to exercise the step logic end to end: search -> train list -> Book Now
 * (which forces a login the first time, like a session expiry) -> passenger
 * form -> review captcha -> payment -> Pay & Book.
 *
 * It is NOT a faithful copy of IRCTC's DOM; it documents the shapes the
 * built-in locators expect and lets us test the engine offline.
 */

const HTML = `<!doctype html><html><body>
<div id="app">
  <a class="loginText">LOGIN</a>

  <app-jp-input>
  <form id="searchForm">
    <p-autocomplete id="origin"><span class="ui-autocomplete"><input type="text" placeholder="From*"></span></p-autocomplete>
    <p-autocomplete id="destination"><span class="ui-autocomplete"><input type="text" placeholder="To*"></span></p-autocomplete>
    <p-calendar id="jDate"><span class="ui-calendar"><input type="text" placeholder="Journey Date(dd-mm-yyyy)*"></span></p-calendar>
    <p-dropdown id="journeyClass" data-options="All Classes|Sleeper (SL)|AC 3 Tier (3A)|AC Chair car (CC)|Exec. Chair Car (EC)">
      <div class="ui-dropdown"><label class="ui-dropdown-label">All Classes</label><div class="ui-dropdown-trigger"><span class="ui-dropdown-trigger-icon"></span></div></div>
    </p-dropdown>
    <p-dropdown id="journeyQuota" data-options="GENERAL|LADIES|TATKAL|PREMIUM TATKAL">
      <div class="ui-dropdown"><label class="ui-dropdown-label">GENERAL</label><div class="ui-dropdown-trigger"><span class="ui-dropdown-trigger-icon"></span></div></div>
    </p-dropdown>
    <div class="extras">
      <p-checkbox id="availableBerth"><div class="ui-chkbox"><div class="ui-chkbox-box"></div></div></p-checkbox><label>Train with Available Berth</label>
      <p-checkbox id="flexibleDate"><div class="ui-chkbox"><div class="ui-chkbox-box"></div></div></p-checkbox><label>Flexible With Date</label>
    </div>
    <button type="submit" class="search_btn train_Search">Search</button>
  </form>
  </app-jp-input>

  <app-train-list id="trainList" hidden>
    <div class="filter-panel">
      <h4>Journey Class</h4>
      <div class="jclass"><p-checkbox class="jc" data-cls="CC"><div class="ui-chkbox"><div class="ui-chkbox-box"></div></div></p-checkbox><label>AC Chair car (CC)</label></div>
      <div class="jclass"><p-checkbox class="jc" data-cls="EC"><div class="ui-chkbox"><div class="ui-chkbox-box"></div></div></p-checkbox><label>Exec. Chair Car (EC)</label></div>
      <div class="jclass"><p-checkbox class="jc" data-cls="SL"><div class="ui-chkbox"><div class="ui-chkbox-box"></div></div></p-checkbox><label>Sleeper (SL)</label></div>
      <h4>Train Type</h4>
      <div class="ttype"><p-checkbox class="tt" data-type="RAJ"><div class="ui-chkbox"><div class="ui-chkbox-box"></div></div></p-checkbox><label>Rajdhani</label></div>
      <div class="ttype"><p-checkbox class="tt" data-type="SHT"><div class="ui-chkbox"><div class="ui-chkbox-box"></div></div></p-checkbox><label>Shatabdi</label></div>
      <h4>Departure time from NDLS</h4>
      <div class="dtime"><p-checkbox class="tt" data-type="T1"><div class="ui-chkbox"><div class="ui-chkbox-box"></div></div></p-checkbox><label>00:00 - 06:00</label></div>
      <div class="dtime"><p-checkbox class="tt" data-type="T2"><div class="ui-chkbox"><div class="ui-chkbox-box"></div></div></p-checkbox><label>06:00 - 12:00</label></div>
    </div>
    <div class="results">
      <div class="no-trains" hidden>No trains found. Please remove the applied filters.</div>
      <app-train-avl-enq data-train="12001" data-classes="CC" data-type="SHT">
        <div class="train_avl_enq_box">
          <div class="train-heading"><strong>SHATABDI EXP (12001)</strong></div>
          <p-tabmenu><ul role="tablist">
            <li role="tab" aria-selected="false"><a><div class="pre-avl"><strong>AC Chair car (CC)</strong><div class="link ng-star-inserted">Refresh</div></div></a></li>
          </ul></p-tabmenu>
          <div class="avail-strip"></div>
          <button type="button" class="btnDefault train_Search disable-book">Book Now</button>
        </div>
      </app-train-avl-enq>
      <app-train-avl-enq data-train="12002" data-classes="CC EC" data-type="SHT">
        <div class="train_avl_enq_box">
          <div class="train-heading"><strong>BHOPAL SHATABDI (12002)</strong></div>
          <p-tabmenu><ul role="tablist">
            <li role="tab" aria-selected="false"><a><div class="pre-avl"><strong>AC Chair car (CC)</strong><div class="link ng-star-inserted">Refresh</div></div></a></li>
            <li role="tab" aria-selected="false"><a><div class="pre-avl"><strong>Exec. Chair Car (EC)</strong><div class="link ng-star-inserted">Refresh</div></div></a></li>
          </ul></p-tabmenu>
          <div class="avail-strip"></div>
          <button type="button" class="btnDefault train_Search disable-book">Book Now</button>
        </div>
      </app-train-avl-enq>
    </div>
  </app-train-list>

  <div id="paxPage" hidden>
    <div id="paxRows">
      <app-passenger>
        <p-autocomplete><span class="ui-autocomplete"><input type="text" placeholder="Name" formcontrolname="passengerName"></span></p-autocomplete>
        <input type="text" placeholder="Age" formcontrolname="passengerAge">
        <select formcontrolname="passengerGender"><option value="">Select</option><option value="M">Male</option><option value="F">Female</option><option value="T">Transgender</option></select>
        <select formcontrolname="passengerBerthChoice"><option value="">No Preference</option><option value="LB">Lower</option><option value="MB">Middle</option><option value="UB">Upper</option><option value="SL">Side Lower</option><option value="SU">Side Upper</option></select>
        <select formcontrolname="passengerFoodChoice"><option value="">Select</option><option value="V">Veg</option><option value="N">Non Veg</option><option value="D">No Food</option></select>
      </app-passenger>
    </div>
    <a class="prenext">+ Add Passenger</a>
    <a class="prenext">+ Add Infant Without Berth</a>
    <div><label for="mobileNumber">Mobile Number</label><input id="mobileNumber" formcontrolname="mobileNumber" value="9999999999"></div>
    <div class="pref">
      <p-checkbox id="autoUpgradation"><div class="ui-chkbox"><div class="ui-chkbox-box"></div></div></p-checkbox><label>Consider for Auto Upgradation</label>
    </div>
    <div class="pref">
      <p-checkbox id="confirmberths"><div class="ui-chkbox"><div class="ui-chkbox-box"></div></div></p-checkbox><label>Book only if confirm berths are allotted</label>
    </div>
    <div class="insurance">
      <span>Travel Insurance (Incl. of GST)</span>
      <p-radiobutton id="travelInsuranceOptyes"><div class="ui-radiobutton"><div class="ui-radiobutton-box"></div></div><label>Yes, and I accept the terms</label></p-radiobutton>
      <p-radiobutton id="travelInsuranceOptno"><div class="ui-radiobutton"><div class="ui-radiobutton-box"></div></div><label>No, I don't want travel insurance</label></p-radiobutton>
    </div>
    <div class="paymode">
      <div><p-radiobutton id="paymode-upi"><div class="ui-radiobutton"><div class="ui-radiobutton-box"></div></div></p-radiobutton><label>Pay through BHIM/UPI</label></div>
      <div><p-radiobutton id="paymode-other"><div class="ui-radiobutton"><div class="ui-radiobutton-box"></div></div></p-radiobutton><label>Pay through Credit &amp; Debit cards / Net Banking / Wallets / EMI</label></div>
    </div>
    <button type="button" class="train_Search btnDefault">Continue</button>
  </div>

  <div id="reviewPage" hidden>
    <h4>Review Booking</h4>
    <img class="captcha-img" src="data:,">
    <input id="captcha" formcontrolname="captcha" placeholder="Enter Captcha">
    <button type="button" class="btnDefault train_Search">Continue</button>
  </div>

  <div id="paymentPage" hidden>
    <div class="bank-type">BHIM/ UPI/ USSD</div>
    <div class="bank-type">Credit &amp; Debit Cards</div>
    <div id="gateways" hidden>
      <div class="border-all">Pay using BHIM (Powered by PAYTM ) also accepts UPI</div>
      <div class="border-all">PhonePe UPI</div>
    </div>
    <button type="button" class="btn btn-primary hidden-xs">Pay &amp; Book</button>
  </div>

  <app-login hidden>
    <div class="modal-dialog">
      <input type="text" formcontrolname="userid" placeholder="User Name">
      <input type="password" formcontrolname="password" placeholder="Password">
      <img class="captcha-img" src="data:,">
      <input type="text" id="captcha" formcontrolname="captcha" placeholder="Enter Captcha">
      <button type="submit">SIGN IN</button>
      <div class="login-error" hidden>Invalid captcha</div>
    </div>
  </app-login>
</div>
</body></html>`;

const STATIONS = ['NEW DELHI - NDLS', 'NEW DELHI - NZM (HAZRAT NIZAMUDDIN)', 'BHOPAL JN - BPL', 'BHOPAL HABIBGANJ - RKMP', 'BENGALURU - SBC'];

function install(window) {
  const { document } = window;
  const state = { loggedIn: false, loginShown: 0, bookNowClicks: 0, searches: 0, paid: false, lastLogin: null, gatewayPicked: null, methodPicked: null, filtersApplied: 0, stripRenders: 0 };
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const show = (el) => { el.hidden = false; };
  const hide = (el) => { el.hidden = true; };
  const nav = (p) => window.history.pushState({}, '', p);

  // autocomplete
  for (const ac of $$('p-autocomplete')) {
    const input = $('input', ac);
    input.addEventListener('input', () => {
      setTimeout(() => {
        $$('ul.ui-autocomplete-items', ac).forEach((u) => u.remove());
        const q = input.value.trim().toUpperCase();
        if (!q) return;
        const list = ac.closest('app-jp-input') ? STATIONS : ['Saved: RAHUL SHARMA', 'Saved: PRIYA SHARMA'];
        const items = list.filter((s) => s.toUpperCase().includes(q));
        if (!items.length) return;
        const ul = document.createElement('ul');
        ul.className = 'ui-autocomplete-items';
        for (const s of items) {
          const li = document.createElement('li');
          li.className = 'ui-autocomplete-list-item';
          li.textContent = s;
          li.addEventListener('click', () => { input.value = s; ul.remove(); });
          ul.appendChild(li);
        }
        ac.appendChild(ul);
      }, 40);
    });
  }

  // dropdowns
  for (const dd of $$('p-dropdown')) {
    const label = $('.ui-dropdown-label', dd);
    const open = () => {
      if ($('.ui-dropdown-panel', dd)) return;
      const panel = document.createElement('div');
      panel.className = 'ui-dropdown-panel';
      const ul = document.createElement('ul');
      ul.className = 'ui-dropdown-items';
      for (const opt of dd.dataset.options.split('|')) {
        const li = document.createElement('li');
        li.className = 'ui-dropdown-item';
        li.textContent = opt;
        li.addEventListener('click', () => { label.textContent = opt; dd.dataset.value = opt; panel.remove(); });
        ul.appendChild(li);
      }
      panel.appendChild(ul);
      dd.appendChild(panel);
    };
    $('.ui-dropdown-trigger', dd).addEventListener('click', open);
    label.addEventListener('click', open);
    dd.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.ui-dropdown-panel', dd).forEach((p) => p.remove()); });
  }

  // search
  $('#searchForm .train_Search').addEventListener('click', (ev) => {
    ev.preventDefault();
    const from = $('#origin input').value, to = $('#destination input').value, date = $('#jDate input').value;
    state.searches += 1;
    state.lastSearch = { from, to, date, cls: $('#journeyClass').dataset.value || 'All Classes', quota: $('#journeyQuota').dataset.value };
    if (!from || !to || !date) return;
    hide($('app-jp-input'));
    show($('#trainList'));
    // a class picked in the search form pre-applies the Journey Class filter (like IRCTC)
    const m = /\((\w+)\)/.exec(state.lastSearch.cls);
    if (m) { const f = $(`.filter-panel .jc[data-cls="${m[1]}"] .ui-chkbox-box`); if (f) f.classList.add('ui-state-active'); }
    applyFilters();
    nav('/nget/booking/train-list');
  });
  for (const box of $$('#searchForm .ui-chkbox-box')) box.addEventListener('click', () => box.classList.toggle('ui-state-active'));

  // train list filters (sidebar): any train-type / time filter hides every train in this fixture
  function applyFilters() {
    const classFilters = $$('.filter-panel .jc .ui-chkbox-box.ui-state-active').map((b) => b.closest('.jc').dataset.cls);
    const typeFilters = $$('.filter-panel .tt .ui-chkbox-box.ui-state-active').map((b) => b.closest('.tt').dataset.type);
    let shown = 0;
    for (const card of $$('app-train-avl-enq')) {
      const classes = card.dataset.classes.split(' ');
      let visible = !classFilters.length || classFilters.every((c) => classes.includes(c));
      if (typeFilters.length && !typeFilters.includes(card.dataset.type)) visible = false;
      card.hidden = !visible;
      if (visible) shown += 1;
    }
    $('.no-trains').hidden = shown > 0;
    state.filtersApplied = classFilters.length + typeFilters.length;
  }
  for (const box of $$('.filter-panel .ui-chkbox-box')) box.addEventListener('click', () => { box.classList.toggle('ui-state-active'); applyFilters(); });
  state.applyFilters = applyFilters;

  // train cards: class tab -> availability strip renders asynchronously -> date cell enables Book Now
  const AVAIL = { 12001: [['Wed, 01 Oct', 'AVAILABLE-0010', 'AVAILABLE'], ['Thu, 02 Oct', 'REGRET', 'REGRET']], 12002: [['Wed, 01 Oct', 'AVAILABLE-0045', 'AVAILABLE'], ['Thu, 02 Oct', 'WL 12', 'WL']] };
  for (const card of $$('app-train-avl-enq')) {
    const strip = $('.avail-strip', card);
    const btn = $('button', card);
    const renderStrip = () => {
      strip.replaceChildren();
      state.stripRenders = (state.stripRenders || 0) + 1;
      for (const [d, txt, cls] of AVAIL[card.dataset.train]) {
        const cell = document.createElement('div');
        cell.className = 'pre-avl';
        cell.innerHTML = `<strong>${d}</strong><div class="${cls}">${txt}</div>`;
        cell.addEventListener('click', () => { btn.classList.remove('disable-book'); card.dataset.date = d; });
        strip.appendChild(cell);
      }
    };
    for (const tab of $$('li[role="tab"]', card)) {
      $('a', tab).addEventListener('click', () => {
        $$('li[role="tab"]', card).forEach((t) => t.setAttribute('aria-selected', 'false'));
        tab.setAttribute('aria-selected', 'true');
        card.dataset.cls = $('strong', tab).textContent.trim();
        btn.classList.add('disable-book');
        strip.replaceChildren();
        setTimeout(renderStrip, 300); // availability API latency
      });
    }
    btn.addEventListener('click', () => {
      if (btn.classList.contains('disable-book')) return;
      state.bookNowClicks += 1;
      state.bookedTrain = card.dataset.train;
      if (!state.loggedIn) { showLogin(); return; }
      hide($('#trainList'));
      show($('#paxPage'));
      nav('/nget/booking/psgninput');
    });
  }

  // login — like Angular's *ngIf, every appearance of the modal is a fresh element
  const loginTemplate = $('app-login');
  loginTemplate.remove();
  function showLogin() {
    hideLogin();
    const modal = loginTemplate.cloneNode(true);
    modal.hidden = false;
    $('button', modal).addEventListener('click', () => {
      const u = $('input[formcontrolname="userid"]', modal).value;
      const p = $('input[formcontrolname="password"]', modal).value;
      const c = $('#captcha', modal).value;
      if (u && p && c) { state.loggedIn = true; state.lastLogin = { u, p, c }; hideLogin(); }
      else show($('.login-error', modal));
    });
    $('#app').appendChild(modal);
    state.loginShown += 1;
  }
  function hideLogin() {
    $$('app-login').forEach((m) => m.remove());
  }
  state.showLogin = showLogin;
  state.hideLogin = hideLogin;

  // passenger page
  const template = $('#paxRows app-passenger').cloneNode(true);
  const addLinks = $$('#paxPage a.prenext');
  addLinks[0].addEventListener('click', () => { if ($$('#paxRows app-passenger').length < 6) $('#paxRows').appendChild(template.cloneNode(true)); });
  for (const box of $$('#paxPage .ui-chkbox-box, #paxPage .ui-radiobutton-box')) {
    box.addEventListener('click', () => {
      if (box.classList.contains('ui-radiobutton-box')) {
        const group = box.closest('.insurance, .paymode') || box.parentElement;
        $$('.ui-radiobutton-box', group).forEach((b) => b.classList.remove('ui-state-active'));
        box.classList.add('ui-state-active');
      } else {
        box.classList.toggle('ui-state-active');
      }
    });
  }
  $('#paxPage button.train_Search').addEventListener('click', () => {
    state.paxSubmitted = $$('#paxRows app-passenger').map((r) => ({
      name: $('input[formcontrolname="passengerName"]', r).value,
      age: $('input[formcontrolname="passengerAge"]', r).value,
      gender: $('select[formcontrolname="passengerGender"]', r).value,
      berth: $('select[formcontrolname="passengerBerthChoice"]', r).value,
      food: $('select[formcontrolname="passengerFoodChoice"]', r).value,
    }));
    hide($('#paxPage'));
    show($('#reviewPage'));
    nav('/nget/booking/reviewBooking');
  });

  // review
  $('#reviewPage button').addEventListener('click', () => {
    if (!$('#reviewPage #captcha').value) return;
    hide($('#reviewPage'));
    show($('#paymentPage'));
    nav('/nget/payment/bkgPaymentOptions');
  });

  // payment
  for (const m of $$('#paymentPage .bank-type')) m.addEventListener('click', () => { state.methodPicked = m.textContent; if (/UPI/.test(m.textContent)) show($('#gateways')); });
  for (const g of $$('#paymentPage .border-all')) g.addEventListener('click', () => { state.gatewayPicked = g.textContent; });
  $('#paymentPage .btn-primary').addEventListener('click', () => { if (state.gatewayPicked) state.paid = true; });

  return state;
}

module.exports = { HTML, install };
