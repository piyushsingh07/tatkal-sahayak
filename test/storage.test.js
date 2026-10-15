const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/shared/storage.js');

function validSettings() {
  const s = S.clone(S.DEFAULTS);
  s.credentials.userId = 'kppsingh';
  s.credentials.password = 'secret';
  s.journey = { from: 'NDLS', to: 'BPL', date: '2026-10-01', quota: 'TQ', cls: '3A', trainNo: '12002', boardingStation: '' };
  s.passengers = [{ name: 'Test Person', age: 30, gender: 'M', berth: 'LB', food: 'V', nationality: 'IN' }];
  s.contact.mobile = '9876543210';
  return s;
}

test('mergeDeep fills defaults, replaces arrays, does not mutate inputs', () => {
  const base = { a: { b: 1, c: 2 }, list: [1, 2], keep: 'x' };
  const src = { a: { c: 3 }, list: [9] };
  const out = S.mergeDeep(base, src);
  assert.deepEqual(out, { a: { b: 1, c: 3 }, list: [9], keep: 'x' });
  assert.deepEqual(base, { a: { b: 1, c: 2 }, list: [1, 2], keep: 'x' });
});

test('mergeDeep over DEFAULTS tolerates partial/legacy stored settings', () => {
  const out = S.mergeDeep(S.DEFAULTS, { journey: { from: 'ndls' }, automation: { targetTime: '11:00:00' } });
  assert.equal(out.journey.from, 'ndls');
  assert.equal(out.journey.quota, 'TQ');
  assert.equal(out.automation.targetTime, '11:00:00');
  assert.equal(out.automation.clickOffsetMs, 300);
  assert.deepEqual(out.selectorsOverride, { nget: {}, eticket: {} });
});

test('validateSettings: a complete config has no errors (only the plaintext warning)', () => {
  const { errors, warnings } = S.validateSettings(validSettings());
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => /unencrypted/.test(w)));
});

test('validateSettings: catches the common mistakes', () => {
  const s = validSettings();
  s.credentials.userId = '';
  s.journey.from = 'New Delhi';
  s.journey.trainNo = '1200';
  s.journey.date = '01/10/2026';
  s.passengers = [];
  const { errors } = S.validateSettings(s);
  assert.ok(errors.some((e) => /user ID/i.test(e)));
  assert.ok(errors.some((e) => /From station/.test(e)));
  assert.ok(errors.some((e) => /Train number/.test(e)));
  assert.ok(errors.some((e) => /YYYY-MM-DD/.test(e)));
  assert.ok(errors.some((e) => /at least one passenger/.test(e)));
});

test('validateSettings: Tatkal caps passengers at 4 and flags infants as passengers', () => {
  const s = validSettings();
  const p = s.passengers[0];
  s.passengers = [p, p, p, p, { ...p, name: 'Fifth Person' }];
  let res = S.validateSettings(s);
  assert.ok(res.errors.some((e) => /at most 4/.test(e)));
  s.passengers = [{ ...p, age: 3 }];
  res = S.validateSettings(s);
  assert.ok(res.errors.some((e) => /under 5 -> infant/.test(e)));
});

test('validateSettings: warns when the target time does not match the class window', () => {
  const s = validSettings();
  s.journey.cls = 'SL';
  s.automation.targetTime = '10:00:00';
  const { warnings } = S.validateSettings(s);
  assert.ok(warnings.some((w) => /opens at 11:00/.test(w)));
  s.automation.targetTime = '11:00:00';
  assert.ok(!S.validateSettings(s).warnings.some((w) => /opens at/.test(w)));
});

test('validateSettings: encrypted password counts as present and has no plaintext warning', () => {
  const s = validSettings();
  s.credentials.password = '';
  s.credentials.passwordEnc = { v: 1, salt: 'a', iv: 'b', ct: 'c' };
  const { errors, warnings } = S.validateSettings(s);
  assert.deepEqual(errors, []);
  assert.ok(!warnings.some((w) => /unencrypted/.test(w)));
});

test('toIrctcDate converts ISO to DD/MM/YYYY', () => {
  assert.equal(S.toIrctcDate('2026-10-01'), '01/10/2026');
  assert.equal(S.toIrctcDate('garbage'), '');
});

test('chrome wrappers are safe no-ops under node', async () => {
  assert.deepEqual(await S.getSettings(), S.DEFAULTS);
  assert.deepEqual(await S.getRun(), {});
  assert.equal(S.runArea(), null);
});
