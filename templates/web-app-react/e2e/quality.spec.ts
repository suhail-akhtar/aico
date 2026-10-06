import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { clearItems, expect, seed, signIn, test } from './support';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function audit(page: Page, label: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(
    violations.map((v) => ({
      rule: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => n.target.join(' ')),
    })),
    label,
  ).toEqual([]);
}

async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`accessibility and layout, ${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('the landing page', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await audit(page, 'landing');
      expect(await hasHorizontalScroll(page)).toBe(false);
    });

    test('the items page: empty, populated, and with a dialog open', async ({ signedIn: page }) => {
      await expect(page.getByRole('heading', { name: 'No items yet' })).toBeVisible();
      await audit(page, 'items, empty');
      expect(await hasHorizontalScroll(page)).toBe(false);

      await seed(
        page.request,
        ['A fairly long item name that must wrap rather than overflow the page on a phone'],
        {
          description:
            'And a description that is also long enough to need wrapping onto several lines in a narrow viewport.',
          quantity: 123456,
        },
      );
      await page.reload();
      await expect(page.getByRole('listitem')).toHaveCount(1);
      await audit(page, 'items, populated');
      expect(await hasHorizontalScroll(page)).toBe(false);

      await page.getByRole('button', { name: 'New item' }).first().click();
      const dialog = page.getByRole('dialog', { name: 'New item' });
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog.getByText('Enter a name.')).toBeVisible();
      await audit(page, 'new-item dialog with errors');
      const box = await dialog.boundingBox();
      const viewport = page.viewportSize();
      expect(box && viewport && box.width <= viewport.width).toBe(true);
      expect(await hasHorizontalScroll(page)).toBe(false);
    });
  });
}

test.describe('colour scheme', () => {
  test('follows the system setting, and an explicit choice wins and is remembered', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    const background = () =>
      page.evaluate(
        () => getComputedStyle(document.body.parentElement as HTMLElement).backgroundColor,
      );
    const dark = await background();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.reload();
    const light = await background();
    expect(dark).not.toBe(light);

    await page.getByRole('combobox', { name: 'Colour scheme' }).selectOption('dark');
    expect(await background()).toBe(dark);
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Colour scheme' })).toHaveValue('dark');
    expect(await background()).toBe(dark);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

test.describe('layout adapts to the viewport', () => {
  test('actions sit beside an item on a wide screen and below it on a phone', async ({
    signedIn: page,
  }) => {
    await seed(page.request, ['Responsive']);
    await page.reload();
    const row = page.getByRole('listitem').filter({ hasText: 'Responsive' });
    const text = await row.locator('p').first().boundingBox();
    const edit = await row.getByRole('button', { name: 'Edit Responsive' }).boundingBox();
    expect(text && edit).toBeTruthy();
    if ((page.viewportSize()?.width ?? 0) >= 640) {
      expect((edit as { x: number }).x).toBeGreaterThan(
        (text as { x: number }).x + (text as { width: number }).width - 1,
      );
    } else {
      expect((edit as { y: number }).y).toBeGreaterThan((text as { y: number }).y);
    }
    // Touch targets: at least 40px tall on both.
    expect((edit as { height: number }).height).toBeGreaterThanOrEqual(40);
  });
});

test.describe('security posture in a real browser', () => {
  test('no CSP violation or console error on the main flow, and the session is not readable by script', async ({
    page,
  }) => {
    const problems: string[] = [];
    page.on('console', (message) => {
      // The browser logs every non-2xx fetch; the signed-out session probe (`/auth/me` -> 401) is expected.
      const expected = /status of 401/.test(message.text());
      if (message.type() === 'error' && !expected) problems.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        console.error(`CSP ${event.violatedDirective} blocked ${event.blockedURI}`);
      });
    });

    const response = await page.goto('/');
    const headers = response?.headers() ?? {};
    expect(headers['content-security-policy']).toContain("script-src 'self'");
    expect(headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');

    await signIn(page);
    await clearItems(page.request);
    await seed(page.request, ['CSP check']);
    await page.reload();
    await page.getByRole('button', { name: 'Edit CSP check' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('combobox', { name: 'Colour scheme' }).selectOption('dark');

    // No token, session id or credential is reachable from script. The only things stored are the theme
    // preference and the router's scroll positions.
    const exposed = await page.evaluate(() => ({
      cookie: document.cookie,
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
      values: [...Object.values(localStorage), ...Object.values(sessionStorage)],
    }));
    const stored = [...exposed.local, ...exposed.session];
    expect(stored.every((key) => key === 'theme' || key.startsWith('tsr-'))).toBe(true);
    expect(exposed.values.join(' ')).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(exposed.cookie).not.toMatch(/session|oauth2|token|jwt/i);
    const cookies = await page.context().cookies();
    for (const cookie of cookies.filter((c) => /session|oauth2/i.test(c.name))) {
      expect(cookie.httpOnly, `${cookie.name} must be HttpOnly`).toBe(true);
      expect(['Lax', 'Strict']).toContain(cookie.sameSite);
    }
    expect(problems).toEqual([]);
    await clearItems(page.request);
  });
});
