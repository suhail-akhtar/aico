/**
 * Start-up, in the one order that works: language, then configuration, then the
 * API client, then the first render.
 *
 * Configuration comes first because nothing else can be set up without it (the
 * API base URL, the sign-in URL); if it is bad the app stops on a readable
 * screen. The API client's 401 handler lives here because it needs both the
 * query cache (forget the session) and the router (go to sign-in); neither is
 * visible to the generated client.
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { configureApi } from '../api/client';
import { sessionKey } from '../auth/auth';
import { ConfigError, loadConfig } from '../config/runtime-config';
import { detectLocale, setLocale } from '../shared/i18n/i18n';
import { ErrorBoundary } from '../shared/ui/ErrorBoundary';
import { ToastProvider } from '../shared/ui/Toast';
import { ConfigErrorScreen } from './ConfigErrorScreen';
import { createQueryClient } from './query-client';
import { createAppRouter } from './router';

/** Returns the React root so a test (or a host page) can unmount the app. */
export async function start(container: HTMLElement): Promise<Root> {
  setLocale(detectLocale());
  const root = createRoot(container);

  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig();
  } catch (error) {
    root.render(
      <ConfigErrorScreen detail={error instanceof ConfigError ? error.message : String(error)} />,
    );
    return root;
  }

  const queryClient = createQueryClient();
  const router = createAppRouter({ queryClient, config });

  configureApi(config, () => {
    // Any API call that comes back 401 means the session is gone: forget it and sign in again.
    queryClient.setQueryData(sessionKey, null);
    const { pathname, search } = window.location;
    if (pathname !== '/login' && pathname !== '/') {
      void router.navigate({ to: '/login', search: { returnTo: `${pathname}${search}` } });
    }
  });

  root.render(
    <StrictMode>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
  return root;
}
