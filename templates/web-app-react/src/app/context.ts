import type { QueryClient } from '@tanstack/react-query';
import type { AppConfig } from '../config/runtime-config';

/** What every route's `beforeLoad` and `loader` can use without importing singletons. */
export interface RouterContext {
  queryClient: QueryClient;
  config: AppConfig;
}

/** The product name, as the HTML page was titled at build/scaffold time. */
export const appName: string = (typeof document !== 'undefined' && document.title) || 'App';
