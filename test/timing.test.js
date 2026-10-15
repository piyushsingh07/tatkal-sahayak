/*
 * The Book Now click must wait for the configured IST wall-clock target
 * (+ click offset) and use the synced server offset, not the raw local clock.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, waitUntil } = require('./helpers/env');
const mock = require('./helpers/mock-site');
const S = require('../src/shared/storage.js');
const T = require('../src/shared/time.js');

function settingsWithTarget(targetHms, clickOffsetMs) {
  const s = S.clone(S.DEFAULTS);
  s.credentials.userId = 'u';
  s.credentials.password = 'p';
  s.journey = { from: 'NDLS', to: 'BPL', date: '2026-10-01', quota: 'TQ', cls: 'CC', trainNo: '12002', boardingStation: '' };
  s.passengers = [{ name: 'Rahul Sharma', age: 31, gender: 'M', berth: 'LB', food: 'V', nationality: 'IN' }];
  s.automation.targetTime = targetHms;
  s.automation.clickOffsetMs = clickOffsetMs;
  s.acknowledgedRisk = true;
  return s;
}

test('Book Now waits for the target second (+offset) on the server-corrected clock', async (t) => {
  const SERVER_OFFSET = -700; // pretend our machine is 700ms ahead of true time
  const now = Date.now();
  const serverNow = now + SERVER_OFFSET;
  // target: the next whole server second at least 1.6s away
  const targetEpoch = Math.ceil((serverNow + 1600) / 1000) * 1000;
  const hms = T.istClock(targetEpoch, false);
  const CLICK_OFFSET = 250;

  const env = createEnv({
    url: 'https://www.irctc.co.in/nget/train-search',
    html: mock.HTML,
    settings: settingsWithTarget(hms, CLICK_OFFSET),
    run: { timeSync: { ok: true, offsetMs: SERVER_OFFSET } },
  });
  // keep the stubbed SYNC_TIME answer consistent with the pre-seeded offset
  env.window.chrome.runtime.sendMessage = (msg, cb) => { if (cb) cb({ ok: true, offsetMs: SERVER_OFFSET, rttMs: 10 }); };
  const state = mock.install(env.window);
  state.loggedIn = true;
  let clickedAtLocal = 0;
  env.document.querySelector('[data-train="12002"] button').addEventListener('click', () => { clickedAtLocal = Date.now(); }, true);

  const engine = new env.TA.Engine();
  t.after(() => { engine.destroy(); env.window.close(); });
  await engine.init();
  await engine.setArmed(true, 'live');

  await waitUntil(() => state.bookNowClicks > 0, { timeoutMs: 20000, what: 'Book Now' });
  const clickedAtServer = clickedAtLocal + SERVER_OFFSET;
  assert.ok(clickedAtServer >= targetEpoch + CLICK_OFFSET - 5, `clicked ${clickedAtServer - targetEpoch}ms after boundary, expected >= ${CLICK_OFFSET}`);
  assert.ok(clickedAtServer < targetEpoch + CLICK_OFFSET + 600, `clicked too late: ${clickedAtServer - targetEpoch}ms after boundary`);
  const log = engine.log.map((e) => e.message).join('\n');
  assert.match(log, new RegExp(`Waiting for ${hms} IST`));
  assert.match(log, /Window open @/);
});
