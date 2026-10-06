/**
 * The mock gateway is the executable form of the contract, so it is held to the
 * contract: every response it produces must parse with the zod schemas
 * generated from openapi/openapi.json. If someone edits one and not the other,
 * this fails.
 */

import { describe, expect, it } from 'vitest';
import { zItem, zItemPage, zMe, zProblem } from '../src/api/generated/zod.gen';
import { createMockStack, safePath } from './api.ts';

const ORIGIN = 'http://localhost:3000';
const UNSAFE_HEADERS = { 'content-type': 'application/json', 'x-requested-with': 'fetch' };

function setup() {
  const stack = createMockStack();
  stack.impersonate('dev@example.com');
  const call = async (path: string, init?: RequestInit) => {
    const response = await stack.handle(new Request(`${ORIGIN}${path}`, init));
    if (!response) throw new Error(`not handled: ${path}`);
    return response;
  };
  const create = (body: unknown) =>
    call('/api/v1/items', { method: 'POST', headers: UNSAFE_HEADERS, body: JSON.stringify(body) });
  return { stack, call, create };
}

describe('mock gateway: session', () => {
  it('answers 401 problem+json without a session', async () => {
    const { stack, call } = setup();
    stack.impersonate(undefined);
    const response = await call('/api/v1/auth/me');
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(zProblem.safeParse(await response.json()).success).toBe(true);
  });

  it('runs the cookie flow: start, sign in at the identity page, me, sign out', async () => {
    const stack = createMockStack();
    const fetchPath = async (path: string, init: RequestInit = {}) =>
      (await stack.handle(new Request(`${ORIGIN}${path}`, init))) as Response;

    const start = await fetchPath('/api/auth/start?rd=/items');
    expect(start.status).toBe(302);
    expect(start.headers.get('location')).toBe('/mock-idp/login?rd=%2Fitems');

    const page = await fetchPath('/mock-idp/login?rd=%2Fitems');
    expect(await page.text()).toContain('id="kc-login"');
    expect((await fetchPath('/mock-idp/style.css')).headers.get('content-type')).toContain(
      'text/css',
    );

    const bad = await fetchPath('/mock-idp/login', {
      method: 'POST',
      body: new URLSearchParams({ username: 'dev@example.com', password: 'nope', rd: '/items' }),
    });
    expect(bad.status).toBe(401);
    expect(await bad.text()).toContain('Invalid username or password');

    const ok = await fetchPath('/mock-idp/login', {
      method: 'POST',
      body: new URLSearchParams({
        username: 'dev@example.com',
        password: 'dev-password', // standards-allow: secret
        rd: '/items',
      }),
    });
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('/items');
    const cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).toMatch(/^mock_session=.+/);
    expect(ok.headers.get('set-cookie')).toContain('HttpOnly');

    const me = await fetchPath('/api/v1/auth/me', { headers: { cookie } });
    expect(zMe.parse(await me.json()).email).toBe('dev@example.com');

    const out = await fetchPath('/api/auth/sign_out?rd=/', { headers: { cookie } });
    expect(out.status).toBe(302);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await fetchPath('/api/v1/auth/me', { headers: { cookie } })).status).toBe(401);
  });

  it('refuses to redirect anywhere but a path on this origin', () => {
    expect(safePath('/items?x=1')).toBe('/items?x=1');
    for (const bad of [
      '//evil.example',
      'https://evil.example',
      '/\\evil',
      'items',
      '/a\nb',
      '',
      null,
    ]) {
      expect(safePath(bad)).toBe('/');
    }
  });

  it('leaves static files to the dev server', async () => {
    const { stack } = setup();
    expect(await stack.handle(new Request(`${ORIGIN}/assets/app.js`))).toBeUndefined();
    expect((await stack.handle(new Request(`${ORIGIN}/api/nope`)))?.status).toBe(404);
  });
});

describe('mock gateway: items', () => {
  it('creates, reads, replaces and deletes, matching the contract', async () => {
    const { call, create } = setup();
    const created = await create({ name: '  pen  ', description: 'blue', quantity: 3 });
    expect(created.status).toBe(201);
    const item = zItem.parse(await created.json());
    expect(item).toMatchObject({ name: 'pen', description: 'blue', quantity: 3 });
    expect(created.headers.get('location')).toBe(`/api/v1/items/${item.id}`);

    expect(zItem.parse(await (await call(`/api/v1/items/${item.id}`)).json()).id).toBe(item.id);

    const replaced = await call(`/api/v1/items/${item.id}`, {
      method: 'PUT',
      headers: UNSAFE_HEADERS,
      body: JSON.stringify({ name: 'pencil' }),
    });
    expect(zItem.parse(await replaced.json())).toMatchObject({
      name: 'pencil',
      description: null,
      quantity: 0,
    });

    const gone = await call(`/api/v1/items/${item.id}`, {
      method: 'DELETE',
      headers: UNSAFE_HEADERS,
    });
    expect(gone.status).toBe(204);
    expect((await call(`/api/v1/items/${item.id}`)).status).toBe(404);
  });

  it('pages newest first with an opaque cursor', async () => {
    const { call, create } = setup();
    for (const n of [1, 2, 3, 4, 5]) await create({ name: `item ${n}` });
    const first = zItemPage.parse(await (await call('/api/v1/items?limit=2')).json());
    expect(first.items.map((i) => i.name)).toEqual(['item 5', 'item 4']);
    expect(first.next_cursor).toBeTruthy();
    const second = zItemPage.parse(
      await (await call(`/api/v1/items?limit=2&cursor=${first.next_cursor}`)).json(),
    );
    expect(second.items.map((i) => i.name)).toEqual(['item 3', 'item 2']);
    const last = zItemPage.parse(
      await (await call(`/api/v1/items?limit=2&cursor=${second.next_cursor}`)).json(),
    );
    expect(last.items.map((i) => i.name)).toEqual(['item 1']);
    expect(last.next_cursor).toBeNull();
  });

  it('rejects a bad limit, a bad cursor and a bad body with a problem', async () => {
    const { call, create } = setup();
    for (const path of [
      '/api/v1/items?limit=0',
      '/api/v1/items?limit=101',
      '/api/v1/items?cursor=!!!',
    ]) {
      const response = await call(path);
      expect(response.status).toBe(400);
      expect(zProblem.safeParse(await response.json()).success).toBe(true);
    }
    for (const body of [
      {},
      { name: '' },
      { name: 'x'.repeat(121) },
      { name: 'a', quantity: -1 },
      { name: 'a', quantity: 1.5 },
      { name: 'a', extra: 1 },
      { name: 'a', description: 'd'.repeat(1001) },
      { name: 'a', description: 4 },
      [],
    ]) {
      const response = await create(body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      const problem = zProblem.parse(await response.json());
      expect(problem.errors).toBeDefined();
    }
    const malformed = await call('/api/v1/items', {
      method: 'POST',
      headers: UNSAFE_HEADERS,
      body: '{',
    });
    expect(malformed.status).toBe(400);
  });

  it('requires the CSRF header on unsafe methods only', async () => {
    const { call } = setup();
    const post = await call('/api/v1/items', { method: 'POST', body: '{"name":"a"}' });
    expect(post.status).toBe(403);
    expect((await call('/api/v1/items')).status).toBe(200);
  });

  it('keeps each user to their own items', async () => {
    const { stack, call, create } = setup();
    const mine = zItem.parse(await (await create({ name: 'mine' })).json());
    stack.impersonate('other@example.com');
    expect((await call(`/api/v1/items/${mine.id}`)).status).toBe(404);
    expect(zItemPage.parse(await (await call('/api/v1/items')).json()).items).toEqual([]);
    expect(
      (await call(`/api/v1/items/${mine.id}`, { method: 'DELETE', headers: UNSAFE_HEADERS }))
        .status,
    ).toBe(404);
  });

  it('answers 404 for a malformed id and 405 for an unsupported method', async () => {
    const { call } = setup();
    expect((await call('/api/v1/items/not-a-uuid')).status).toBe(404);
    expect((await call('/api/v1/items', { method: 'PATCH', headers: UNSAFE_HEADERS })).status).toBe(
      405,
    );
  });
});
