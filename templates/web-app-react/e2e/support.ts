/**
 * Helpers shared by the specs: signing in through whatever identity page the
 * stack has, and seeding or clearing items through the API as the signed-in user.
 *
 * The sign-in page is driven by the element ids Keycloak's login form uses
 * (`#username`, `#password`, `#kc-login`); the mock identity page uses the same
 * ids on purpose, so one set of specs covers both stacks.
 */

import { type APIRequestContext, test as base, expect, type Page } from '@playwright/test';

export const USER = process.env.E2E_USER || 'dev@example.com';
// The mock gateway's test credential (overridden for a real stack). standards-allow: secret
export const PASSWORD = process.env.E2E_PASSWORD || 'dev-password'; // standards-allow: secret

export const CSRF = { 'X-Requested-With': 'fetch' };

/** From a signed-out browser: through the landing page's button to the identity page and back. */
export async function signIn(page: Page, start = '/'): Promise<void> {
  await page.goto(start);
  const username = page.locator('#username');
  const cta = page.getByRole('link', { name: 'Sign in to continue' });
  // Either the landing page (click through) or the identity provider already (a protected start URL).
  await expect(username.or(cta)).toBeVisible();
  if (await cta.isVisible()) await cta.click();
  await username.fill(USER);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('#kc-login').click();
  await expect(page.getByRole('link', { name: 'Sign out' })).toBeVisible();
}

interface ListedItem {
  id: string;
}

/** Delete every item of the signed-in user, so each spec starts from an empty list. */
export async function clearItems(request: APIRequestContext): Promise<void> {
  for (let round = 0; round < 20; round++) {
    const response = await request.get('/api/v1/items?limit=100');
    if (!response.ok()) return;
    const page = (await response.json()) as { items: ListedItem[] };
    if (page.items.length === 0) return;
    for (const item of page.items)
      await request.delete(`/api/v1/items/${item.id}`, { headers: CSRF });
  }
}

export async function seed(
  request: APIRequestContext,
  names: string[],
  extra: { description?: string; quantity?: number } = {},
): Promise<void> {
  for (const name of names) {
    const response = await request.post('/api/v1/items', {
      headers: CSRF,
      data: { name, ...extra },
    });
    expect(response.status(), `seeding ${name}`).toBe(201);
  }
}

/** A test that starts signed in with an empty item list, and leaves it empty. */
export const test = base.extend<{ signedIn: Page }>({
  signedIn: async ({ page }, use) => {
    await signIn(page);
    await clearItems(page.request);
    await use(page);
    await clearItems(page.request);
  },
});

export { expect };
