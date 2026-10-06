/**
 * Does the backend behind this gateway keep the promise in openapi/openapi.json?
 *
 * The typed client is generated from that file, so a backend that answers
 * differently breaks the app in ways a type checker cannot see. This spec calls
 * the live API as the signed-in user and parses every response with the zod
 * schemas generated from the same file. The full-stack bundles run it against
 * each of their four backends; it is how "the same frontend works against all
 * of them" is proved rather than asserted.
 */

import { zItem, zItemPage, zMe, zProblem } from '../src/api/generated/zod.gen';
import { CSRF, clearItems, expect, test, USER } from './support';

test.describe('the API keeps the contract', () => {
  test.skip(({ isMobile }) => isMobile, 'identical on every viewport; run once');

  test('auth/me, items CRUD and cursor paging parse against the generated schemas', async ({
    signedIn: page,
  }) => {
    const api = page.request;

    const me = zMe.parse(await (await api.get('/api/v1/auth/me')).json());
    expect(me.email.toLowerCase()).toBe(USER.toLowerCase());

    const created = await api.post('/api/v1/items', {
      headers: CSRF,
      data: { name: 'Contract', description: 'd', quantity: 2 },
    });
    expect(created.status()).toBe(201);
    expect(created.headers().location ?? '').toContain('/items/');
    const item = zItem.parse(await created.json());
    expect(item).toMatchObject({ name: 'Contract', description: 'd', quantity: 2 });

    const defaults = zItem.parse(
      await (await api.post('/api/v1/items', { headers: CSRF, data: { name: 'Defaults' } })).json(),
    );
    expect(defaults.quantity).toBe(0);

    expect(zItem.parse(await (await api.get(`/api/v1/items/${item.id}`)).json()).id).toBe(item.id);

    const replaced = zItem.parse(
      await (
        await api.put(`/api/v1/items/${item.id}`, {
          headers: CSRF,
          data: { name: 'Contract v2', description: null, quantity: 5 },
        })
      ).json(),
    );
    expect(replaced).toMatchObject({ name: 'Contract v2', description: null, quantity: 5 });

    for (let n = 0; n < 4; n++)
      await api.post('/api/v1/items', { headers: CSRF, data: { name: `Page ${n}` } });
    const first = zItemPage.parse(await (await api.get('/api/v1/items?limit=2')).json());
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).toBeTruthy();
    const seen = new Set(first.items.map((i) => i.id));
    let cursor = first.next_cursor;
    while (cursor) {
      const next = zItemPage.parse(
        await (await api.get(`/api/v1/items?limit=2&cursor=${encodeURIComponent(cursor)}`)).json(),
      );
      for (const i of next.items) {
        expect(seen.has(i.id), 'a page must not repeat an item').toBe(false);
        seen.add(i.id);
      }
      cursor = next.next_cursor;
    }
    expect(seen.size).toBe(6);
    // Newest first.
    expect(first.items[0]?.name).toMatch(/^Page/);

    expect((await api.delete(`/api/v1/items/${item.id}`, { headers: CSRF })).status()).toBe(204);
    expect((await api.get(`/api/v1/items/${item.id}`)).status()).toBe(404);
    await clearItems(api);
  });

  test('errors are problem documents the client can read', async ({ signedIn: page }) => {
    const api = page.request;
    const missing = await api.get('/api/v1/items/5c4b5d84-4ac0-45a1-8b8a-2b6bf0a5c2de');
    expect(missing.status()).toBe(404);
    expect(missing.headers()['content-type']).toContain('json');
    expect(zProblem.parse(await missing.json()).status).toBe(404);

    for (const data of [
      { name: '' },
      { name: 'x'.repeat(121) },
      { name: 'ok', quantity: -1 },
      { name: 'ok', quantity: 1000001 },
    ]) {
      const invalid = await api.post('/api/v1/items', { headers: CSRF, data });
      expect([400, 422], JSON.stringify(data)).toContain(invalid.status());
      const problem = zProblem.parse(await invalid.json());
      expect(problem.title.length).toBeGreaterThan(0);
    }
  });

  test('without a session the API answers 401', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL: baseURL as string });
    const response = await context.request.get('/api/v1/items');
    expect(response.status()).toBe(401);
    await context.close();
  });
});
