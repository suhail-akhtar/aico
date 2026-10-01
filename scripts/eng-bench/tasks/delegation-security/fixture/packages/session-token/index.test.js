import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken } from './index.js';

const secret = 'unit-test-only-not-a-real-key';

test('round trip', () => {
  const t = signToken({ sub: 'u1', role: 'member' }, secret);
  const p = verifyToken(t, secret);
  assert.equal(p.sub, 'u1');
  assert.equal(p.role, 'member');
});

test('rejects a wrong secret', () => {
  const t = signToken({ sub: 'u1' }, secret);
  assert.equal(verifyToken(t, 'other-secret'), null);
});

test('rejects garbage', () => {
  assert.equal(verifyToken('nope', secret), null);
  assert.equal(verifyToken(undefined, secret), null);
});
