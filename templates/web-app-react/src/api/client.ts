/**
 * The one place the generated client is configured.
 *
 * Why: the generated SDK (src/api/generated, from openapi/openapi.json) knows
 * the operations but not this app's security posture. Here every request gets
 * the CSRF header the gateway demands for unsafe methods and the session
 * cookie (same-origin only); redirects are not followed (an expired session
 * that a proxy answers with a 302 to a login page must read as a 401, not as
 * HTML that fails to parse); and every failure becomes an `ApiError`, so no
 * screen handles raw problem JSON, text bodies or network exceptions.
 *
 * Interceptors are registered once and ejected on reconfigure, so tests and hot
 * reloads do not stack them.
 *
 * What it does not do: refresh or store tokens. There are none in the browser;
 * the gateway owns the session.
 */

import type { AppConfig } from '../config/runtime-config';
import { ApiError, parseProblem } from '../shared/problem';
import { client } from './generated/client.gen';

export const CSRF_HEADER = 'X-Requested-With';
export const CSRF_VALUE = 'fetch';

let registered: { response: number; error: number } | undefined;

/** `/api` -> `https://app.example/api`, so URL resolution works in every runtime (browser, jsdom, Node). */
export function absoluteBaseUrl(path: string, origin = window.location.origin): string {
  return new URL(path, origin).toString().replace(/\/$/, '');
}

export function configureApi(
  config: Pick<AppConfig, 'apiBaseUrl'>,
  onUnauthorized: () => void,
): void {
  client.setConfig({
    baseUrl: absoluteBaseUrl(config.apiBaseUrl),
    credentials: 'same-origin',
    redirect: 'manual',
    headers: { [CSRF_HEADER]: CSRF_VALUE },
  });
  if (registered) {
    client.interceptors.response.eject(registered.response);
    client.interceptors.error.eject(registered.error);
  }
  registered = {
    response: client.interceptors.response.use((response, request) => {
      // `redirect: 'manual'` turns a redirect into an opaque response with status 0.
      const redirected = response.type === 'opaqueredirect';
      const status = redirected ? 401 : response.status;
      // The session probe (`/auth/me`) expects a 401 when signed out: that is an answer, not an event.
      if (status === 401 && !new URL(request.url).pathname.endsWith('/auth/me')) onUnauthorized();
      return redirected ? new Response(null, { status: 401 }) : response;
    }),
    error: client.interceptors.error.use((error, response) => {
      if (error instanceof ApiError) return error;
      if (!response) return parseProblem(0, undefined);
      return parseProblem(response.status, error, response.headers.get('x-request-id'));
    }),
  };
}
