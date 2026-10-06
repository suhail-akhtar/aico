import { CSRF, clearItems, expect, PASSWORD, signIn, test, USER } from './support';

test.describe('sign-in and sign-out', () => {
  test('a visitor signs in through the identity provider and lands on their items', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Keep track of your items', level: 1 }),
    ).toBeVisible();
    await signIn(page);
    await expect(page).toHaveURL(/\/items$/);
    await expect(page.getByRole('heading', { name: 'Items', level: 1 })).toBeVisible();
    await expect(page.getByRole('banner')).toContainText(USER);
  });

  test('a protected page sends a signed-out visitor to sign in, then returns them to it', async ({
    page,
  }) => {
    await page.goto('/items?dialog=new');
    // Either the identity provider's form or (a moment before) the bridge page.
    await expect(page.locator('#username')).toBeVisible();
    await page.locator('#username').fill(USER);
    await page.locator('#password').fill(PASSWORD); // standards-allow: secret
    await page.locator('#kc-login').click();
    await expect(page).toHaveURL(/\/items\?dialog=new$/);
    await expect(page.getByRole('dialog', { name: 'New item' })).toBeVisible();
    await clearItems(page.request);
  });

  test('signing out ends the session: the API refuses and the app asks to sign in again', async ({
    page,
  }) => {
    await signIn(page);
    expect((await page.request.get('/api/v1/auth/me')).status()).toBe(200);
    await page.getByRole('link', { name: 'Sign out' }).click();
    await expect(
      page.getByRole('heading', { name: 'Keep track of your items', level: 1 }),
    ).toBeVisible();
    expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);
    await page.goto('/items');
    await expect(page.locator('#username')).toBeVisible();
  });

  test('a session that disappears mid-use sends the user to sign in', async ({ page, context }) => {
    await signIn(page);
    await clearItems(page.request);
    await page.getByRole('button', { name: 'New item' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New item' });
    await dialog.getByLabel('Name').fill('Too late');
    await context.clearCookies();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#username')).toBeVisible();
  });

  test('a foreign return address never leaves this origin', async ({ page, baseURL }) => {
    await page.goto('/login?returnTo=%2F%2Fevil.example%2Fpwn');
    await expect(page.locator('#username')).toBeVisible();
    await page.locator('#username').fill(USER);
    await page.locator('#password').fill(PASSWORD); // standards-allow: secret
    await page.locator('#kc-login').click();
    await expect(page.getByRole('link', { name: 'Sign out' })).toBeVisible();
    expect(new URL(page.url()).origin).toBe(new URL(baseURL as string).origin);
  });
});

test.describe('request forgery', () => {
  test('a state-changing request without the custom header is refused', async ({ page }) => {
    await signIn(page);
    await clearItems(page.request);
    const status = await page.evaluate(async () => {
      const response = await fetch('/api/v1/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'forged' }),
      });
      return response.status;
    });
    expect(status).toBe(403);
    const list = (await (await page.request.get('/api/v1/items')).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(0);

    const ok = await page.request.post('/api/v1/items', { headers: CSRF, data: { name: 'legit' } });
    expect(ok.status()).toBe(201);
    await clearItems(page.request);
  });
});
