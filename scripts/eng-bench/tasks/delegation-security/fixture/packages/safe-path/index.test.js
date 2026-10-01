import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveUserFile } from './index.js';

const root = path.resolve('/srv/attachments');

test('resolves a plain file name inside the root', () => {
  assert.equal(resolveUserFile(root, 'invoice-2024.pdf'), path.join(root, 'invoice-2024.pdf'));
});

test('allows sub-folders', () => {
  assert.equal(resolveUserFile(root, 'receipts/march.png'), path.join(root, 'receipts', 'march.png'));
});

test('rejects empty and oversized names', () => {
  assert.equal(resolveUserFile(root, ''), null);
  assert.equal(resolveUserFile(root, 'a'.repeat(300)), null);
});
