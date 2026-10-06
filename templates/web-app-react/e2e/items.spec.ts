import { CSRF, expect, seed, test } from './support';

test.describe('items', () => {
  test('create, see, edit and delete an item', async ({ signedIn: page }) => {
    await expect(page.getByRole('heading', { name: 'No items yet' })).toBeVisible();

    await page.getByRole('button', { name: 'New item' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New item' });
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByText('Enter a name.')).toBeVisible();

    await dialog.getByLabel('Name').fill('Stapler');
    await dialog.getByLabel('Description').fill('Red, heavy');
    await dialog.getByLabel('Quantity').fill('4');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    const row = page.getByRole('listitem').filter({ hasText: 'Stapler' });
    await expect(row).toContainText('Red, heavy');
    await expect(row).toContainText('Quantity 4');
    await expect(page.getByText('1 item', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Edit Stapler' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit item' });
    await expect(edit.getByLabel('Name')).toHaveValue('Stapler');
    await edit.getByLabel('Name').fill('Heavy stapler');
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(edit).toBeHidden();
    await expect(page.getByRole('listitem').filter({ hasText: 'Heavy stapler' })).toBeVisible();

    await page.getByRole('button', { name: 'Delete Heavy stapler' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete this item?' });
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('heading', { name: 'No items yet' })).toBeVisible();
  });

  test("the data survives a reload and is the server's, not the page's", async ({
    signedIn: page,
  }) => {
    await seed(page.request, ['Pen', 'Paper']);
    await page.reload();
    await expect(page.getByRole('listitem')).toHaveCount(2);
    await expect(page.getByRole('listitem').first()).toContainText('Paper');
  });

  test('pages through more items than fit in one request', async ({ signedIn: page }) => {
    await seed(
      page.request,
      Array.from({ length: 25 }, (_, n) => `Bulk ${String(n + 1).padStart(2, '0')}`),
    );
    await page.reload();
    await expect(page.getByRole('listitem')).toHaveCount(20);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByRole('listitem')).toHaveCount(25);
    await expect(page.getByRole('button', { name: 'Load more' })).toBeHidden();
  });

  test('cancelling a delete keeps the item', async ({ signedIn: page }) => {
    await seed(page.request, ['Keeper']);
    await page.reload();
    await page.getByRole('button', { name: 'Delete Keeper' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByRole('listitem').filter({ hasText: 'Keeper' })).toBeVisible();
  });

  test("another user's data is not visible through the API", async ({ signedIn: page }) => {
    await seed(page.request, ['Mine']);
    const list = (await (await page.request.get('/api/v1/items')).json()) as {
      items: Array<{ id: string }>;
    };
    const unknown = '5c4b5d84-4ac0-45a1-8b8a-2b6bf0a5c2de';
    expect((await page.request.get(`/api/v1/items/${unknown}`)).status()).toBe(404);
    expect(
      (await page.request.delete(`/api/v1/items/${unknown}`, { headers: CSRF })).status(),
    ).toBe(404);
    expect(list.items).toHaveLength(1);
  });
});

test.describe('failure and keyboard behaviour', () => {
  test('a refused create shows the error in the dialog and leaves no phantom row', async ({
    signedIn: page,
  }) => {
    await page.route('**/api/v1/items', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 502,
            contentType: 'application/problem+json',
            body: JSON.stringify({
              title: 'Bad Gateway',
              status: 502,
              detail: 'The API is restarting.',
            }),
          })
        : route.fallback(),
    );
    await page.getByRole('button', { name: 'New item' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New item' });
    await dialog.getByLabel('Name').fill('Doomed');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByRole('alert')).toContainText('The API is restarting.');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Doomed')).toBeHidden();
  });

  test('a refused delete puts the item back and says so', async ({ signedIn: page }) => {
    await seed(page.request, ['Survivor']);
    await page.reload();
    await page.route('**/api/v1/items/*', (route) =>
      route.request().method() === 'DELETE'
        ? route.fulfill({
            status: 500,
            contentType: 'application/problem+json',
            body: '{"title":"Boom","status":500}',
          })
        : route.fallback(),
    );
    await page.getByRole('button', { name: 'Delete Survivor' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'could not be deleted' })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'Survivor' })).toBeVisible();
  });

  test('a list that fails to load can be retried', async ({ signedIn: page }) => {
    let failing = true;
    await page.route('**/api/v1/items?*', (route) =>
      failing
        ? route.fulfill({
            status: 500,
            contentType: 'application/problem+json',
            body: '{"title":"Boom","status":500}',
          })
        : route.fallback(),
    );
    await page.reload();
    await expect(page.getByRole('alert')).toContainText('The items could not be loaded.');
    failing = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: 'No items yet' })).toBeVisible();
  });

  test('the whole create flow works from the keyboard, and focus returns afterwards', async ({
    signedIn: page,
    isMobile,
  }) => {
    test.skip(isMobile, 'keyboard shortcut is for a physical keyboard');
    const opener = page.getByRole('button', { name: 'New item' }).first();
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'New item' });
    await expect(dialog.getByLabel('Name')).toBeFocused();
    await page.keyboard.type('Keyboard only');
    // description, quantity, Cancel, Save
    for (let n = 0; n < 4; n++) await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('listitem').filter({ hasText: 'Keyboard only' })).toBeVisible();

    await page.keyboard.press('n');
    await expect(page.getByRole('dialog', { name: 'New item' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByRole('button', { name: 'New item' }).first()).toBeFocused();
  });

  test('Back closes an open dialog', async ({ signedIn: page }) => {
    await page.getByRole('button', { name: 'New item' }).first().click();
    await expect(page.getByRole('dialog', { name: 'New item' })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('dialog')).toBeHidden();
  });
});
