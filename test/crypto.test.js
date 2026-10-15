const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/shared/crypto.js');

test('encrypt/decrypt round trip', async () => {
  const blob = await C.encryptString('my-passphrase', 'Irctc@Secret#123');
  assert.equal(blob.v, 1);
  assert.ok(blob.salt && blob.iv && blob.ct);
  assert.ok(!JSON.stringify(blob).includes('Irctc@Secret'));
  assert.equal(await C.decryptString('my-passphrase', blob), 'Irctc@Secret#123');
});

test('wrong passphrase fails authentication', async () => {
  const blob = await C.encryptString('right', 'pw');
  await assert.rejects(() => C.decryptString('wrong', blob));
});

test('each encryption uses a fresh salt/iv', async () => {
  const a = await C.encryptString('p', 'same');
  const b = await C.encryptString('p', 'same');
  assert.notEqual(a.ct, b.ct);
  assert.notEqual(a.iv, b.iv);
});

test('empty passphrase is rejected', async () => {
  await assert.rejects(() => C.encryptString('', 'pw'), /Passphrase required/);
});
