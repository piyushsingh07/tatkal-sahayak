const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/shared/time.js');

const IST = T.IST_OFFSET_MS;
// helper: epoch for an IST wall clock on a given date
const ist = (y, m, d, h, mi, s = 0, ms = 0) => Date.UTC(y, m - 1, d, h, mi, s, ms) - IST;

test('parseHms accepts HH:MM and HH:MM:SS, rejects garbage', () => {
  assert.deepEqual(T.parseHms('10:00'), { h: 10, m: 0, s: 0 });
  assert.deepEqual(T.parseHms('11:00:30'), { h: 11, m: 0, s: 30 });
  assert.equal(T.parseHms('25:00'), null);
  assert.equal(T.parseHms('abc'), null);
  assert.equal(T.parseHms(''), null);
});

test('istDateString/istClock use IST regardless of host timezone', () => {
  // 2026-09-29 03:07:45.565 IST == 2026-09-28 21:37:45.565 UTC
  const t = Date.UTC(2026, 8, 28, 21, 37, 45, 565);
  assert.equal(T.istDateString(t), '2026-09-29');
  assert.equal(T.istClock(t), '03:07:45.565');
  assert.equal(T.istClock(t, false), '03:07:45');
});

test('nextTargetEpoch: today at 10:00 IST when it is 09:55 IST', () => {
  const now = ist(2026, 10, 1, 9, 55);
  assert.equal(T.nextTargetEpoch('10:00:00', now), ist(2026, 10, 1, 10, 0));
});

test('nextTargetEpoch: within grace period returns the (past) target for immediate action', () => {
  const now = ist(2026, 10, 1, 10, 5); // 5 minutes late
  assert.equal(T.nextTargetEpoch('10:00:00', now), ist(2026, 10, 1, 10, 0));
});

test('nextTargetEpoch: beyond grace rolls over to tomorrow', () => {
  const now = ist(2026, 10, 1, 15, 0);
  assert.equal(T.nextTargetEpoch('10:00:00', now), ist(2026, 10, 2, 10, 0));
});

test('nextTargetEpoch: works across the UTC date boundary (IST evening)', () => {
  // 23:30 IST on Oct 1 == 18:00 UTC Oct 1; next 10:00 IST is Oct 2
  const now = ist(2026, 10, 1, 23, 30);
  assert.equal(T.istDateString(now), '2026-10-01');
  assert.equal(T.nextTargetEpoch('10:00:00', now), ist(2026, 10, 2, 10, 0));
  // 02:00 IST Oct 2 == 20:30 UTC Oct 1; today (IST) is Oct 2, so target is Oct 2 10:00
  const late = ist(2026, 10, 2, 2, 0);
  assert.equal(T.nextTargetEpoch('10:00:00', late), ist(2026, 10, 2, 10, 0));
});

test('nextTargetEpoch returns null for malformed input', () => {
  assert.equal(T.nextTargetEpoch('bogus', Date.now()), null);
});

test('formatCountdown', () => {
  assert.equal(T.formatCountdown(5 * 60000 + 3000 + 400), '-05:03.4');
  assert.equal(T.formatCountdown(-1500), '+00:01.5');
  assert.equal(T.formatCountdown(3600000 + 61000), '-1:01:01.0');
});

test('offsetFromSample uses the midpoint of the round trip', () => {
  const r = T.offsetFromSample({ t0: 1000, t1: 1200, serverMs: 1600 });
  assert.equal(r.offsetMs, 500);
  assert.equal(r.rttMs, 200);
});

test('bestOffset picks the lowest-RTT sample and ignores broken ones', () => {
  const best = T.bestOffset([
    { t0: 0, t1: 400, serverMs: 1000 },
    { t0: 0, t1: 100, serverMs: 1000 },
    { t0: 0, t1: 300, serverMs: NaN },
  ]);
  assert.equal(best.rttMs, 100);
  assert.equal(best.offsetMs, 950);
  assert.equal(T.bestOffset([]), null);
});

test('parseTimeApiResponse treats dateTime as IST and truncates to ms', () => {
  const json = { dateTime: '2026-09-29T03:07:45.5652342', timeZone: 'Asia/Kolkata' };
  assert.equal(T.parseTimeApiResponse(json), Date.UTC(2026, 8, 28, 21, 37, 45, 565));
  assert.equal(T.parseTimeApiResponse({ dateTime: '2026-09-29T03:07:45' }), Date.UTC(2026, 8, 28, 21, 37, 45, 0));
  assert.ok(Number.isNaN(T.parseTimeApiResponse({})));
  assert.ok(Number.isNaN(T.parseTimeApiResponse(null)));
});

test('parseHttpDate', () => {
  assert.equal(T.parseHttpDate('Mon, 28 Sep 2026 21:37:46 GMT'), Date.UTC(2026, 8, 28, 21, 37, 46));
  assert.ok(Number.isNaN(T.parseHttpDate('nope')));
});
