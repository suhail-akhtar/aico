// Reference test (grader self-test only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';

test('health answers without auth', async () => {
  const server = createServer({ dbPath: ':memory:', secret: 's' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(res.status, 200);
  await new Promise((r) => server.close(r));
});
