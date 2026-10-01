// Reference tests (grader self-test only).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';

let server, base, dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helpdesk-comments-'));
  server = createServer({ dbPath: path.join(dir, 'test.db') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

const api = async (method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};

test('adds and lists comments', async () => {
  const t = await api('POST', '/api/tickets', { title: 'x' });
  assert.equal((await api('POST', `/api/tickets/${t.body.id}/comments`, { author: 'a', body: 'one' })).status, 201);
  const list = await api('GET', `/api/tickets/${t.body.id}/comments`);
  assert.deepEqual(list.body.map((c) => c.body), ['one']);
  assert.equal((await api('GET', `/api/tickets/${t.body.id}`)).body.comment_count, 1);
  assert.equal((await api('POST', `/api/tickets/${t.body.id}/comments`, { author: 'a', body: ' ' })).status, 400);
  assert.equal((await api('POST', '/api/tickets/9999/comments', { author: 'a', body: 'b' })).status, 404);
});
