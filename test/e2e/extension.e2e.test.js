/*
 * Real-browser end-to-end test. Headless Chrome loads the unpacked extension;
 * www.irctc.co.in and timeapi.io are mapped to a local HTTPS server that
 * serves the offline mock. Skipped automatically when Chrome is not installed.
 *
 *   npm run test:e2e
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { start } = require('./mock-server');
const { findChrome, launch, waitUntil, sleep } = require('./chrome');
const S = require('../../src/shared/storage.js');

const EXT = path.resolve(__dirname, '..', '..');

function seedSettings() {
  const s = S.clone(S.DEFAULTS);
  s.credentials.userId = 'kppsingh';
  s.credentials.password = 'Secr3t!';
  s.journey = { from: 'NDLS', to: 'BPL', date: '2026-10-01', quota: 'TQ', cls: 'CC', trainNo: '12002', boardingStation: '' };
  s.passengers = [
    { name: 'Rahul Sharma', age: 31, gender: 'M', berth: 'LB', food: 'V', nationality: 'IN' },
    { name: 'Priya Sharma', age: 29, gender: 'F', berth: 'UB', food: 'N', nationality: 'IN' },
  ];
  s.contact.mobile = '9876543210';
  s.automation.targetTime = '';
  s.acknowledgedRisk = true;
  return s;
}

test('extension drives the mock IRCTC flow inside real Chrome', { skip: !findChrome() && 'Chrome not installed', timeout: 120000 }, async (t) => {
  const server = await start();
  t.after(() => server.close());
  const rules = `MAP www.irctc.co.in 127.0.0.1:${server.port},MAP timeapi.io 127.0.0.1:${server.port}`;
  const browser = await launch({ extensionPath: EXT, hostRules: rules, headless: process.env.E2E_HEADFUL !== '1' });
  t.after(() => browser.close());

  // seed settings through the extension's own storage API
  const seeded = await browser.evalInWorker(`chrome.storage.local.set({ settings: ${JSON.stringify(seedSettings())} }).then(() => 'ok')`);
  assert.equal(seeded, 'ok');

  const page = await browser.openPage('https://www.irctc.co.in/nget/train-search');
  await browser.cdp.send('Page.bringToFront', {}, page.sessionId);

  // content script injected: the panel host is in the shared DOM (shadow root is open)
  await waitUntil(() => page.eval(`!!(document.getElementById('tatkal-sahayak-root') && document.getElementById('tatkal-sahayak-root').shadowRoot)`), { what: 'panel mount' });
  const panelButtons = await page.eval(`Array.from(document.getElementById('tatkal-sahayak-root').shadowRoot.querySelectorAll('button')).map(b => b.textContent)`);
  assert.ok(panelButtons.includes('Arm (live)'), `panel buttons: ${panelButtons}`);
  assert.ok(panelButtons.includes('Field check'));

  const panelText = () => page.eval(`document.getElementById('tatkal-sahayak-root').shadowRoot.textContent`);
  assert.match(await panelText(), /nget/);
  assert.match(await panelText(), /search/);

  // arm from the panel (the click listener lives in the isolated world; the DOM is shared)
  await page.eval(`Array.from(document.getElementById('tatkal-sahayak-root').shadowRoot.querySelectorAll('button')).find(b => b.textContent === 'Arm (live)').click()`);
  await waitUntil(() => page.eval(`/armed/.test(document.getElementById('tatkal-sahayak-root').shadowRoot.textContent)`), { what: 'armed badge' });

  // search → train list → Book Now → login demanded by the site
  const st = (expr) => page.eval(`window.__mockState.${expr}`);
  await waitUntil(() => st('searches > 0'), { what: 'search submitted' });
  const search = await st('lastSearch');
  assert.match(search.from, /NDLS/);
  assert.match(search.to, /BPL/);
  assert.equal(search.date, '01/10/2026');
  assert.equal(search.quota, 'TATKAL');
  assert.equal(search.cls, 'All Classes', 'class is picked on the card, never in the search form');

  await waitUntil(() => st('loginShown === 1'), { what: 'login modal' });
  assert.equal(await st('bookedTrain'), '12002');
  assert.equal(await st('filtersApplied'), 0, 'no filter checkbox toggled');
  assert.match(await page.eval(`document.querySelector('[data-train="12002"]').dataset.cls`), /\(CC\)/);
  assert.equal(await page.eval(`document.querySelector('[data-train="12002"]').dataset.date`), 'Wed, 01 Oct');
  await waitUntil(() => page.eval(`(document.querySelector('app-login input[formcontrolname="userid"]') || {}).value === 'kppsingh'`), { what: 'login autofill' });
  assert.equal(await page.eval(`document.querySelector('app-login input[formcontrolname="password"]').value`), 'Secr3t!');
  await waitUntil(async () => /YOU: Type the captcha/.test(await panelText()), { what: 'captcha hand-off in panel' });
  assert.equal(await page.eval(`document.activeElement === document.querySelector('app-login #captcha')`), true, 'captcha box focused');

  // clock sync went through the worker to (mock) timeapi.io
  const timeSync = await browser.evalInWorker(`chrome.storage.session.get('run').then(r => r.run && r.run.timeSync)`);
  assert.ok(timeSync && timeSync.ok, `timeSync: ${JSON.stringify(timeSync)}`);
  assert.equal(timeSync.source, 'timeapi.io');
  assert.ok(Math.abs(timeSync.offsetMs) < 2000, `offset ${timeSync.offsetMs}ms should be ~0 against a local server`);

  // the human types the captcha and signs in
  await page.eval(`document.querySelector('app-login #captcha').value = 'AB12CD'; document.querySelector('app-login button').click(); true`);
  assert.equal(await st('loggedIn'), true);

  // resumes: Book Now → passengers → Continue → review
  await waitUntil(() => page.eval(`location.pathname === '/nget/booking/reviewBooking'`), { what: 'review page', timeoutMs: 30000 });
  assert.deepEqual(await st('paxSubmitted'), [
    { name: 'Rahul Sharma', age: '31', gender: 'M', berth: 'LB', food: 'V' },
    { name: 'Priya Sharma', age: '29', gender: 'F', berth: 'UB', food: 'N' },
  ]);
  assert.equal(await page.eval(`document.querySelector('#mobileNumber').value`), '9876543210');
  assert.equal(await page.eval(`document.querySelector('#autoUpgradation .ui-chkbox-box').classList.contains('ui-state-active')`), true);
  assert.equal(await page.eval(`document.querySelector('#travelInsuranceOptno .ui-radiobutton-box').classList.contains('ui-state-active')`), true);
  assert.equal(await page.eval(`document.querySelector('#paymode-upi .ui-radiobutton-box').classList.contains('ui-state-active')`), true);

  await waitUntil(async () => /YOU: Type the captcha/.test(await panelText()), { what: 'review captcha hand-off' });
  await page.eval(`document.querySelector('#reviewPage #captcha').value = 'ZZ99YY'; document.querySelector('#reviewPage button').click(); true`);

  // payment: UPI → gateway by regex → Pay & Book → auto-disarm
  await waitUntil(() => st('paid'), { what: 'Pay & Book' });
  assert.match(await st('methodPicked'), /UPI/);
  assert.match(await st('gatewayPicked'), /PAYTM/);
  await waitUntil(() => page.eval(`/idle/.test(document.getElementById('tatkal-sahayak-root').shadowRoot.textContent)`), { what: 'auto disarm' });
  const badge = await browser.evalInWorker(`chrome.action.getBadgeText({})`);
  assert.equal(badge, '');
  await sleep(100);
});
