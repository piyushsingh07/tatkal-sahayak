/*
 * End-to-end test of the content-script engine against the offline mock of
 * the classic IRCTC flow (test/helpers/mock-site.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, waitUntil, sleep } = require('./helpers/env');
const mock = require('./helpers/mock-site');

function settings(overrides = {}) {
  const S = require('../src/shared/storage.js');
  const s = S.clone(S.DEFAULTS);
  s.credentials.userId = 'kppsingh';
  s.credentials.password = 'Secr3t!';
  s.journey = { from: 'NDLS', to: 'BPL', date: '2026-10-01', quota: 'TQ', cls: 'CC', trainNo: '12002', boardingStation: '' };
  s.passengers = [
    { name: 'Rahul Sharma', age: 31, gender: 'M', berth: 'LB', food: 'V', nationality: 'IN' },
    { name: 'Priya Sharma', age: 29, gender: 'F', berth: 'UB', food: 'N', nationality: 'IN' },
  ];
  s.contact.mobile = '9876543210';
  s.preferences.autoUpgrade = true;
  s.preferences.travelInsurance = 'no';
  s.automation.targetTime = ''; // click immediately in tests
  s.automation.reloginCooldownMs = 200;
  s.acknowledgedRisk = true;
  return S.mergeDeep(s, overrides);
}

function boot(overrides) {
  const env = createEnv({ url: 'https://www.irctc.co.in/nget/train-search', html: mock.HTML, settings: settings(overrides) });
  const state = mock.install(env.window);
  return { ...env, state };
}

test('full flow: search → train → Book Now → forced re-login → passengers → review → payment', async (t) => {
  const { window, document, TA, state } = boot();
  const engine = new TA.Engine();
  t.after(() => { engine.destroy(); window.close(); });
  await engine.init();
  assert.equal(engine.page, 'SEARCH');
  await engine.setArmed(true, 'live');

  // 1. Search is filled and submitted, train list appears
  await waitUntil(() => state.searches > 0, { what: 'search click' });
  assert.match(state.lastSearch.from, /NDLS/);
  assert.match(state.lastSearch.to, /BPL/);
  assert.equal(state.lastSearch.date, '01/10/2026');
  assert.equal(state.lastSearch.quota, 'TATKAL');
  assert.equal(state.lastSearch.cls, 'All Classes', 'class must NOT be picked in the search form (it applies a Journey Class filter)');

  // 2. Right train + class tab + date cell, Book Now clicked, site demands login (simulated session expiry)
  await waitUntil(() => state.loginShown === 1, { what: 'login modal after Book Now' });
  assert.equal(state.bookedTrain, '12002');
  assert.match(document.querySelector('[data-train="12002"]').dataset.cls, /\(CC\)/);
  assert.match(document.querySelector('[data-train="12002"]').dataset.date, /01 Oct/);
  assert.equal(state.filtersApplied, 0, 'no sidebar filter may be toggled');
  assert.equal(document.querySelectorAll('#searchForm .ui-chkbox-box.ui-state-active').length, 0, 'no search-form checkbox may be toggled');
  assert.equal(document.querySelector('.no-trains').hidden, true);

  // 3. Login form is pre-filled instantly; captcha is left to the human
  await waitUntil(() => document.querySelector('app-login input[formcontrolname="userid"]').value === 'kppsingh', { what: 'login autofill' });
  assert.equal(document.querySelector('app-login input[formcontrolname="password"]').value, 'Secr3t!');
  await waitUntil(() => /YOU: Type the captcha/.test(engine.statusText), { what: 'captcha hand-off' });
  assert.equal(document.activeElement, document.querySelector('app-login #captcha'));
  assert.equal(state.loggedIn, false);

  // human types the captcha and signs in
  document.querySelector('app-login #captcha').value = 'AB12CD';
  document.querySelector('app-login button').click();
  assert.equal(state.loggedIn, true);

  // 4. Flow resumes on the train list: Book Now again → passenger page → filled → Continue → review
  await waitUntil(() => window.location.pathname === '/nget/booking/reviewBooking', { timeoutMs: 15000, what: 'review page' });
  assert.equal(state.bookNowClicks, 2);
  assert.deepEqual(state.paxSubmitted, [
    { name: 'Rahul Sharma', age: '31', gender: 'M', berth: 'LB', food: 'V' },
    { name: 'Priya Sharma', age: '29', gender: 'F', berth: 'UB', food: 'N' },
  ]);
  assert.equal(document.querySelector('#mobileNumber').value, '9876543210');
  assert.ok(document.querySelector('#autoUpgradation .ui-chkbox-box').classList.contains('ui-state-active'), 'auto upgrade ticked');
  assert.ok(!document.querySelector('#confirmberths .ui-chkbox-box').classList.contains('ui-state-active'), 'confirm-berths left unticked');
  assert.ok(document.querySelector('#travelInsuranceOptno .ui-radiobutton-box').classList.contains('ui-state-active'), 'insurance = No');
  assert.ok(document.querySelector('#paymode-upi .ui-radiobutton-box').classList.contains('ui-state-active'), 'UPI payment mode');

  // 5. Review: captcha focused, waits for the human
  await waitUntil(() => /YOU: Type the captcha/.test(engine.statusText), { what: 'review captcha hand-off' });
  assert.equal(document.activeElement, document.querySelector('#reviewPage #captcha'));
  document.querySelector('#reviewPage #captcha').value = 'ZZ99YY';
  document.querySelector('#reviewPage button').click();

  // 6. Payment: UPI section, gateway by regex, Pay & Book, then auto-disarm
  await waitUntil(() => state.paid, { what: 'Pay & Book' });
  assert.match(state.methodPicked, /UPI/);
  assert.match(state.gatewayPicked, /PAYTM/);
  await waitUntil(() => !engine.armed, { what: 'auto disarm' });

  const log = engine.log.map((e) => e.message).join('\n');
  assert.match(log, /Login fields filled/);
  assert.match(log, /Book Now clicked \(attempt 1\)/);
  assert.match(log, /Passenger 2: Priya Sharma filled/);
  assert.match(log, /Flow complete/);
});

test('dry run stops before Continue on the passenger page', async (t) => {
  const { window, document, TA, state } = boot();
  state.loggedIn = true; // already logged in
  const engine = new TA.Engine();
  t.after(() => { engine.destroy(); window.close(); });
  await engine.init();
  await engine.setArmed(true, 'dryrun');
  await waitUntil(() => /DRY RUN/.test(engine.statusText), { timeoutMs: 15000, what: 'dry-run stop' });
  assert.equal(window.location.pathname, '/nget/booking/psgninput');
  assert.equal(document.querySelectorAll('#paxRows app-passenger').length, 2);
  assert.equal(document.querySelector('#paxRows app-passenger input[formcontrolname="passengerName"]').value, 'Rahul Sharma');
  assert.equal(state.paxSubmitted, undefined);
  await sleep(700); // make sure nothing else fires
  assert.equal(window.location.pathname, '/nget/booking/psgninput');
  assert.ok(engine.armed);
});

test('re-login is not re-run while the same modal stays open (no captcha spam) and honours the cap', async (t) => {
  const { window, document, TA, state } = boot({ automation: { maxRelogins: 2, reloginCooldownMs: 50 } });
  const engine = new TA.Engine();
  t.after(() => { engine.destroy(); window.close(); });
  await engine.init();
  await engine.setArmed(true, 'live');
  await waitUntil(() => state.loginShown === 1, { what: 'first login modal' });
  await waitUntil(() => /YOU: Type the captcha/.test(engine.statusText), { what: 'hand-off' });
  const fills = () => engine.log.filter((e) => /Login fields filled/.test(e.message)).length;
  assert.equal(fills(), 1);
  await sleep(600); // several cooldown periods
  assert.equal(fills(), 1, 'the open modal must not be re-filled repeatedly');
  assert.equal(engine.reloginCount, 1);

  // wrong captcha: IRCTC destroys the modal and renders a fresh one (new elements)
  state.hideLogin();
  await sleep(250);
  state.showLogin();
  await waitUntil(() => fills() === 2, { what: 'second fill' });
  assert.equal(engine.reloginCount, 2);
  await sleep(600);
  assert.equal(fills(), 2, 'the second modal must not be re-filled repeatedly either');

  state.hideLogin();
  await sleep(250);
  state.showLogin();
  await waitUntil(() => !engine.armed, { what: 'disarm at cap' });
  assert.equal(fills(), 2, 'cap reached: no third fill');
  assert.match(engine.statusText, /Re-login cap/);
});

test('detectPage recognises each page of the mock and Field Check reports missing fields', async (t) => {
  const { window, document, TA, state } = boot();
  const engine = new TA.Engine();
  t.after(() => { engine.destroy(); window.close(); });
  await engine.init();
  assert.equal(engine.detectPage(), 'SEARCH');
  const report = engine.fieldReport('SEARCH');
  assert.ok(report.every((f) => f.count > 0), `all search fields resolve: ${JSON.stringify(report.map((f) => [f.key, f.count]))}`);

  state.showLogin();
  assert.equal(engine.detectPage(), 'LOGIN');
  state.hideLogin();

  document.querySelector('app-jp-input').hidden = true;
  document.querySelector('#trainList').hidden = false;
  window.history.pushState({}, '', '/nget/booking/train-list');
  assert.equal(engine.detectPage(), 'TRAINLIST');
  const tl = engine.fieldReport('TRAINLIST').filter((f) => !f.count && !f.optional);
  assert.equal(tl.length, 0, `train-list fields resolve, missing: ${tl.map((f) => f.key).join(', ')}`);

  document.querySelector('#trainList').hidden = true;
  document.querySelector('#paxPage').hidden = false;
  window.history.pushState({}, '', '/nget/booking/psgninput');
  assert.equal(engine.detectPage(), 'PASSENGERS');
  const missing = engine.fieldReport('PASSENGERS').filter((f) => !f.count && !f.optional);
  assert.equal(missing.length, 0, `all required passenger fields resolve, missing: ${missing.map((f) => f.key).join(', ')}`);

  document.querySelector('#paxPage').hidden = true;
  document.querySelector('#reviewPage').hidden = false;
  window.history.pushState({}, '', '/nget/booking/reviewBooking');
  assert.equal(engine.detectPage(), 'REVIEW');

  document.querySelector('#reviewPage').hidden = true;
  document.querySelector('#paymentPage').hidden = false;
  window.history.pushState({}, '', '/nget/payment/bkgPaymentOptions');
  assert.equal(engine.detectPage(), 'PAYMENT');
});

test('selector override from the Pick tool wins over built-in locators and cssPath is stable', async (t) => {
  const { window, document, TA, stores } = boot();
  const engine = new TA.Engine();
  t.after(() => { engine.destroy(); window.close(); });
  await engine.init();
  const decoy = document.createElement('input');
  decoy.id = 'myFromBox';
  document.querySelector('#searchForm').appendChild(decoy);
  assert.equal(TA.dom.cssPath(decoy), '#myFromBox');
  await engine.saveOverride('search.from', '#myFromBox');
  assert.equal(engine.get('search.from'), decoy);
  assert.equal(stores.local.settings.selectorsOverride.nget['search.from'], '#myFromBox');
  await engine.saveOverride('search.from', '');
  assert.equal(engine.get('search.from'), document.querySelector('#origin input'));
});

test('panel mounts in a shadow root and renders arm controls', async (t) => {
  const { window, document, TA } = boot();
  const engine = new TA.Engine();
  t.after(() => { engine.destroy(); window.close(); });
  await engine.init();
  const panel = new TA.Panel(engine);
  const host = document.getElementById('tatkal-sahayak-root');
  assert.ok(host && host.shadowRoot);
  const labels = Array.from(host.shadowRoot.querySelectorAll('button')).map((b) => b.textContent);
  assert.ok(labels.includes('Arm (live)') && labels.includes('Dry run') && labels.includes('Field check'));
  panel.view = 'fields';
  panel.render();
  assert.ok(host.shadowRoot.querySelectorAll('.field').length >= 6);
});

test('train list: resumes on a pre-searched list, picks class tab + date cell, waits for the availability strip', async (t) => {
  const { window, document, TA, state } = boot();
  const engine = new TA.Engine();
  t.after(() => { engine.destroy(); window.close(); });
  state.loggedIn = true;
  // user searched manually (All Classes) and lands on the list
  document.querySelector('app-jp-input').hidden = true;
  document.querySelector('#trainList').hidden = false;
  window.history.pushState({}, '', '/nget/booking/train-list');
  await engine.init();
  assert.equal(engine.page, 'TRAINLIST');
  await engine.setArmed(true, 'live');
  await waitUntil(() => state.bookNowClicks > 0, { what: 'Book Now' });
  const card = document.querySelector('[data-train="12002"]');
  assert.match(card.dataset.cls, /\(CC\)/, 'CC tab clicked on the right card');
  assert.equal(card.dataset.date, 'Wed, 01 Oct');
  assert.equal(document.querySelector('[data-train="12001"]').dataset.cls, undefined, 'other card untouched');
  assert.ok(state.stripRenders >= 1, 'availability strip rendered before Book Now');
  assert.equal(state.filtersApplied, 0);
  const log = engine.log.map((e) => e.message).join('\n');
  assert.match(log, /Train located: BHOPAL SHATABDI \(12002\)/);
  assert.match(log, /Class CC selected; 2 availability cells/);
});

test('train list: a class the train does not offer stops with a clear message and touches nothing', async (t) => {
  const { window, document, TA, state } = boot({ journey: { cls: 'SL' } });
  const engine = new TA.Engine();
  t.after(() => { engine.destroy(); window.close(); });
  state.loggedIn = true;
  document.querySelector('app-jp-input').hidden = true;
  document.querySelector('#trainList').hidden = false;
  window.history.pushState({}, '', '/nget/booking/train-list');
  await engine.init();
  await engine.setArmed(true, 'live');
  await waitUntil(() => /YOU: Class SL not offered/.test(engine.statusText), { what: 'class hand-off' });
  assert.equal(state.filtersApplied, 0, 'the sidebar "Sleeper (SL)" filter checkbox must not be clicked');
  assert.equal(state.bookNowClicks, 0);
});

test('debug report describes the train list without leaking secrets', async (t) => {
  const { window, document, TA, state } = boot();
  const engine = new TA.Engine();
  t.after(() => { engine.destroy(); window.close(); });
  state.loggedIn = true;
  document.querySelector('app-jp-input').hidden = true;
  document.querySelector('#trainList').hidden = false;
  window.history.pushState({}, '', '/nget/booking/train-list');
  await engine.init();
  engine.tick();
  const report = engine.debugReport();
  assert.match(report, /site=nget page=TRAINLIST/);
  assert.match(report, /2 card\(s\) via trains\.box/);
  assert.match(report, /heading="BHOPAL SHATABDI \(12002\)"/);
  assert.match(report, /classCells=\["AC Chair car \(CC\)/);
  assert.match(report, /\[ \] AC Chair car \(CC\)/, 'filter checkboxes listed with state');
  assert.match(report, /R\*\*\* S\*\*\*/, 'passenger names masked');
  assert.ok(!report.includes('Secr3t!'), 'password never in the report');
  assert.ok(!report.includes('9876543210'), 'mobile masked');
  assert.match(report, /\[log\]/);
});


test('search: a class left over from an earlier manual search is reset to All Classes', async (t) => {
  const { window, document, TA, state } = boot();
  const engine = new TA.Engine();
  t.after(() => { engine.destroy(); window.close(); });
  state.loggedIn = true;
  const dd = document.querySelector('#journeyClass');
  dd.querySelector('.ui-dropdown-label').textContent = 'AC 3 Tier (3A)';
  dd.dataset.value = 'AC 3 Tier (3A)';
  await engine.init();
  await engine.setArmed(true, 'live');
  await waitUntil(() => state.searches > 0, { what: 'search' });
  assert.equal(state.lastSearch.cls, 'All Classes');
  assert.equal(state.filtersApplied, 0, 'no Journey Class filter pre-applied by the search');
  assert.match(engine.log.map((e) => e.message).join('\n'), /Search class reset to All Classes \(was "AC 3 Tier \(3A\)"\)/);
  await waitUntil(() => state.bookNowClicks > 0, { what: 'Book Now after clean search' });
});
