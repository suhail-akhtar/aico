/**
 * Sign-in state, as the browser can know it: it asks the API who it is.
 *
 * The session is a cookie held by the gateway (BFF pattern, RFC 10017): the
 * browser never sees an access or refresh token, so there is nothing for an XSS
 * bug to steal and nothing to refresh here. "Am I signed in?" is one request,
 * `GET /v1/auth/me`; a 401 means no (an answer, not an error). Sign-in and
 * sign-out are full-page navigations to gateway endpoints, because the
 * identity provider's pages are not ours to render in a fetch.
 *
 * `safeReturnTo` is the open-redirect guard: only a path on this origin may be
 * carried through the sign-in round trip.
 */

import { queryOptions } from '@tanstack/react-query';
import type { Me } from '../api/generated';
import { getMe } from '../api/generated';
import type { AppConfig } from '../config/runtime-config';
import { ApiError } from '../shared/problem';

export const sessionKey = ['session'] as const;

async function fetchSession(): Promise<Me | null> {
  try {
    const { data } = await getMe({ throwOnError: true });
    return data;
  } catch (error) {
    if (error instanceof ApiError && error.isUnauthorized) return null;
    throw error;
  }
}

export const sessionQuery = queryOptions({
  queryKey: sessionKey,
  queryFn: fetchSession,
  staleTime: 5 * 60_000,
  retry: false,
});

/** A same-origin absolute path (`/items?x=1`), or `/`. Rejects `//host`, `\\host`, schemes, control characters. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value?.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return '/';
  }
  return value;
}

/** The gateway URL that starts sign-in and returns the user to `returnTo` afterwards. */
export function loginHref(
  config: Pick<AppConfig, 'loginUrl'>,
  returnTo: string | undefined,
): string {
  const url = new URL(config.loginUrl, window.location.origin);
  url.searchParams.set('rd', safeReturnTo(returnTo));
  return `${url.pathname}${url.search}`;
}

export function logoutHref(config: Pick<AppConfig, 'logoutUrl'>): string {
  return config.logoutUrl;
}
