import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeRedirect } from './index.js';

test('allows site paths', () => {
  assert.equal(isSafeRedirect('/dashboard'), true);
  assert.equal(isSafeRedirect('/orders/42?tab=items#top'), true);
});

test('rejects absolute URLs', () => {
  assert.equal(isSafeRedirect('https://example.org/'), false);
});

test('rejects non-strings and empty', () => {
  assert.equal(isSafeRedirect(''), false);
  assert.equal(isSafeRedirect(null), false);
});
