import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end suite: a real browser against a running stack.
 *
 * Two modes, one set of specs:
 *  - default: builds the app and serves it with `vite preview`, whose mock
 *    gateway (mock/api.ts) stands in for the BFF and the API, with the same
 *    security headers production serves. No Docker, no network.
 *  - `E2E_BASE_URL=http://host:port`: runs against a real stack (the full-stack
 *    bundles run it through Traefik against Keycloak, the real API and
 *    Postgres). `E2E_USER` / `E2E_PASSWORD` are that stack's test account.
 *
 * Two viewports (desktop 1280 and phone 390) run every spec, because a layout
 * that only works wide is the most common responsive bug.
 */
// `||`, not `??`: compose passes an unset variable as the empty string.
const external = process.env.E2E_BASE_URL || undefined;

export default defineConfig({
  testDir: './e2e',
  // The stack is shared and stateful (one signed-in user, one item list), so specs run in order.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: external ?? 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: external
    ? undefined
    : {
        command: 'npm run build && npx vite preview --port 4173 --strictPort',
        url: 'http://127.0.0.1:4173/config.json',
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
