import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { openapi } from '../src/openapi.js';
import { parseItem } from '../src/items.js';

process.env.NODE_ENV = 'test';

describe('items', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = createApp(openDatabase(':memory:'));
  });

  it('starts empty and lists what was created, newest first', async () => {
    expect(await (await app.request('/items')).json()).toEqual({ items: [] });
    const a = await app.request('/items', { method: 'POST', body: JSON.stringify({ name: 'first', quantity: 2 }), headers: { 'content-type': 'application/json' } });
    expect(a.status).toBe(201);
    await app.request('/items', { method: 'POST', body: JSON.stringify({ name: 'second' }), headers: { 'content-type': 'application/json' } });
    const { items } = await (await app.request('/items')).json() as { items: Array<{ name: string; quantity: number }> };
    expect(items.map(i => i.name)).toEqual(['second', 'first']);
    expect(items[0]?.quantity).toBe(0);
  });

  it('answers 400 with field errors, not a stack trace', async () => {
    const res = await app.request('/items', { method: 'POST', body: JSON.stringify({ name: '  ', quantity: -1 }), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; fields: Record<string, string> };
    expect(body.error).toBe('invalid');
    expect(Object.keys(body.fields).sort()).toEqual(['name', 'quantity']);
  });

  it('gets, updates and deletes by id; 404 for the rest', async () => {
    const created = await (await app.request('/items', { method: 'POST', body: JSON.stringify({ name: 'x' }), headers: { 'content-type': 'application/json' } })).json() as { id: number };
    expect((await app.request(`/items/${created.id}`)).status).toBe(200);
    const put = await app.request(`/items/${created.id}`, { method: 'PUT', body: JSON.stringify({ name: 'y', quantity: 5 }), headers: { 'content-type': 'application/json' } });
    expect((await put.json() as { name: string }).name).toBe('y');
    expect((await app.request(`/items/${created.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app.request(`/items/${created.id}`)).status).toBe(404);
    expect((await app.request('/items/not-a-number')).status).toBe(404);
  });

  it('is alive and ready', async () => {
    expect((await app.request('/healthz')).status).toBe(200);
    expect(await (await app.request('/readyz')).json()).toEqual({ ok: true, db: 'ok' });
  });

  it('documents every route it serves', async () => {
    const doc = await (await app.request('/openapi.json')).json() as typeof openapi;
    expect(Object.keys(doc.paths).sort()).toEqual(['/healthz', '/items', '/items/{id}', '/readyz']);
  });
});

describe('parseItem', () => {
  it('trims and defaults', () => {
    expect(parseItem({ name: '  pen ' })).toEqual({ value: { name: 'pen', quantity: 0 } });
  });
  it('rejects garbage bodies', () => {
    expect('errors' in parseItem(null)).toBe(true);
    expect('errors' in parseItem('string')).toBe(true);
  });
});
