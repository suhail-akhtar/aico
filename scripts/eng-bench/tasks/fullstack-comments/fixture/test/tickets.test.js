import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';

let server, base, dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helpdesk-test-'));
  server = createServer({ dbPath: path.join(dir, 'test.db') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const api = async (method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};

test('creates and lists tickets, newest first', async () => {
  const a = await api('POST', '/api/tickets', { title: 'Printer on fire' });
  const b = await api('POST', '/api/tickets', { title: 'VPN drops', priority: 'high' });
  assert.equal(a.status, 201);
  assert.equal(b.body.priority, 'high');
  const list = await api('GET', '/api/tickets');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.slice(0, 2).map((t) => t.title), ['VPN drops', 'Printer on fire']);
});

test('validates a new ticket', async () => {
  const r = await api('POST', '/api/tickets', { title: '   ' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'validation_error');
});

test('updates status', async () => {
  const t = await api('POST', '/api/tickets', { title: 'Reset password' });
  const r = await api('PATCH', `/api/tickets/${t.body.id}`, { status: 'closed' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'closed');
  assert.equal((await api('PATCH', `/api/tickets/${t.body.id}`, { status: 'done' })).status, 400);
});

test('unknown ticket is a 404', async () => {
  const r = await api('GET', '/api/tickets/99999');
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'not_found');
});
