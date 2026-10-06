import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../shared/problem';
import { server } from '../test/server';
import { absoluteBaseUrl, CSRF_HEADER, CSRF_VALUE, configureApi } from './client';
import { createItem, getItem, getMe, listItems } from './generated';

const API = 'http://localhost:3000/api/v1';

describe('configureApi', () => {
  it('resolves the base path against the page origin', () => {
    expect(absoluteBaseUrl('/api', 'https://app.example')).toBe('https://app.example/api');
    expect(absoluteBaseUrl('/', 'https://app.example')).toBe('https://app.example');
  });

  it('sends the CSRF header and the same-origin cookie policy on every request', async () => {
    configureApi({ apiBaseUrl: '/api' }, vi.fn());
    let seen: Request | undefined;
    server.use(
      http.get(`${API}/items`, ({ request }) => {
        seen = request;
        return HttpResponse.json({ items: [] });
      }),
    );
    await listItems({ throwOnError: true });
    expect(seen?.headers.get(CSRF_HEADER)).toBe(CSRF_VALUE);
    expect(seen?.credentials).toBe('same-origin');
  });

  it('turns a problem response into an ApiError with the field errors', async () => {
    configureApi({ apiBaseUrl: '/api' }, vi.fn());
    server.use(
      http.post(`${API}/items`, () =>
        HttpResponse.json(
          { title: 'Unprocessable Content', status: 422, errors: { Name: ['Required'] } },
          {
            status: 422,
            headers: { 'content-type': 'application/problem+json', 'x-request-id': 'req-9' },
          },
        ),
      ),
    );
    const error = await createItem({ body: { name: '' }, throwOnError: true }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      fieldErrors: { name: 'Required' },
      requestId: 'req-9',
    });
  });

  it('reports an unreachable server as a network error (status 0)', async () => {
    configureApi({ apiBaseUrl: '/api' }, vi.fn());
    server.use(http.get(`${API}/items`, () => HttpResponse.error()));
    const error = await listItems({ throwOnError: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isNetwork).toBe(true);
  });

  it('announces a 401 once per call, except for the session probe', async () => {
    const onUnauthorized = vi.fn();
    configureApi({ apiBaseUrl: '/api' }, onUnauthorized);
    server.use(
      http.get(`${API}/items/:id`, () => HttpResponse.text('Unauthorized', { status: 401 })),
      http.get(`${API}/auth/me`, () => HttpResponse.text('Unauthorized', { status: 401 })),
    );
    const error = await getItem({
      path: { id: '5c4b5d84-4ac0-45a1-8b8a-2b6bf0a5c2de' },
      throwOnError: true,
    }).catch((e: unknown) => e);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ status: 401, detail: 'Unauthorized' });

    await getMe({ throwOnError: true }).catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('reads a proxy redirect (an opaque redirect) as an expired session', async () => {
    const onUnauthorized = vi.fn();
    configureApi({ apiBaseUrl: '/api' }, onUnauthorized);
    const redirected = (async () => {
      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
      return response;
    }) as typeof fetch;
    const error = await listItems({ throwOnError: true, fetch: redirected }).catch(
      (e: unknown) => e,
    );
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ status: 401 });
  });

  it('does not stack interceptors when reconfigured', async () => {
    const first = vi.fn();
    const second = vi.fn();
    configureApi({ apiBaseUrl: '/api' }, first);
    configureApi({ apiBaseUrl: '/api' }, second);
    server.use(http.get(`${API}/items/:id`, () => HttpResponse.text('no', { status: 401 })));
    await getItem({
      path: { id: '5c4b5d84-4ac0-45a1-8b8a-2b6bf0a5c2de' },
      throwOnError: true,
    }).catch(() => undefined);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
