import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '../shared/problem';

/** Client errors (4xx) are answers, not blips: retrying a 404 or a 422 only delays the message. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: shouldRetry },
      mutations: { retry: false },
    },
  });
}
