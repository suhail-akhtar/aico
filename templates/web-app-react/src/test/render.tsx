/**
 * Renders the real application (real routes, real providers, real generated
 * client) at a URL, against the mock gateway. Integration over isolation: the
 * bugs that matter here live in the seams (a route guard, a cache key, an
 * interceptor), which a component rendered alone never touches.
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { configureApi } from '../api/client';
import { createQueryClient } from '../app/query-client';
import { createAppRouter } from '../app/router';
import { sessionKey } from '../auth/auth';
import type { AppConfig } from '../config/runtime-config';
import { ToastProvider } from '../shared/ui/Toast';
import { mockStack } from './server';

export const testConfig: AppConfig = {
  apiBaseUrl: '/api',
  loginUrl: '/api/auth/start',
  logoutUrl: '/api/auth/sign_out?rd=/',
  environment: 'test',
};

export const DEV_EMAIL = 'dev@example.com';

export interface Rendered {
  router: ReturnType<typeof createAppRouter>;
  queryClient: ReturnType<typeof createQueryClient>;
  unauthorized: () => number;
}

export async function renderApp(
  path: string,
  { signedIn = true }: { signedIn?: boolean } = {},
): Promise<Rendered & ReturnType<typeof render>> {
  mockStack.impersonate(signedIn ? DEV_EMAIL : undefined);
  const queryClient = createQueryClient();
  // Retries make failure tests slow and add nothing here.
  queryClient.setDefaultOptions({
    queries: { retry: false, staleTime: 0 },
    mutations: { retry: false },
  });
  const router = createAppRouter(
    { queryClient, config: testConfig },
    createMemoryHistory({ initialEntries: [path] }),
  );
  let unauthorized = 0;
  configureApi(testConfig, () => {
    unauthorized += 1;
    queryClient.setQueryData(sessionKey, null);
  });
  await router.load();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...utils, router, queryClient, unauthorized: () => unauthorized };
}

/** Create items as the signed-in dev user without going through the UI. */
export async function seedItems(names: string[]): Promise<void> {
  mockStack.impersonate(DEV_EMAIL);
  for (const name of names) {
    const response = await mockStack.handle(
      new Request('http://localhost:3000/api/v1/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
        body: JSON.stringify({ name, quantity: 1 }),
      }),
    );
    if (response?.status !== 201) throw new Error(`seed failed for ${name}: ${response?.status}`);
  }
}
