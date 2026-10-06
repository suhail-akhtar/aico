import { describe, expect, it } from 'vitest';
import { ApiError, api } from './api';
import { errorMessage } from './components/errors';
import { installFakeApi, json, problem } from './test/fake-api';

describe('api client', () => {
  it('reads the session without a CSRF header', async () => {
    document.cookie = 'XSRF-TOKEN=token-1';
    const { calls } = installFakeApi({
      'GET /api/v1/session': () => json({ authenticated: false, user: null, features: null }),
    });

    const session = await api.session();

    expect(session.authenticated).toBe(false);
    expect(calls[0]?.headers['X-XSRF-TOKEN']).toBeUndefined();
    expect(calls[0]?.headers.Accept).toBe('application/json');
  });

  it('adds the CSRF token from the cookie to every request that changes state', async () => {
    document.cookie = `XSRF-TOKEN=${encodeURIComponent('a+b=c')}`;
    const { calls } = installFakeApi({
      'POST /api/v1/tasks': () => json({ id: 'x' }, 201),
      'DELETE /api/v1/tasks/x': () => new Response(null, { status: 204 }),
    });

    await api.createTask({ title: 'T' });
    await api.deleteTask('x');

    expect(calls.map((c) => c.headers['X-XSRF-TOKEN'])).toEqual(['a+b=c', 'a+b=c']);
    expect(calls[0]?.headers['Content-Type']).toBe('application/json');
    expect(calls[0]?.body).toEqual({ title: 'T' });
  });

  it('sends no CSRF header when the cookie is absent (the API will refuse, and say why)', async () => {
    const { calls } = installFakeApi({ 'POST /api/v1/tasks': () => json({ id: 'x' }, 201) });

    await api.createTask({ title: 'T' });

    expect(calls[0]?.headers['X-XSRF-TOKEN']).toBeUndefined();
  });

  it('turns a problem document into an ApiError with the fields', async () => {
    installFakeApi({
      'POST /api/v1/tasks': () =>
        problem(400, 'validation_failed', 'Request validation failed', [
          { field: 'title', message: 'must not be blank' },
        ]),
    });

    const failure = await api.createTask({ title: '' }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ApiError);
    const error = failure as ApiError;
    expect(error.status).toBe(400);
    expect(error.code).toBe('validation_failed');
    expect(error.errors).toEqual([{ field: 'title', message: 'must not be blank' }]);
    expect(error.isUnauthorized).toBe(false);
    expect(errorMessage(error)).toBe('Request validation failed (title: must not be blank)');
  });

  it('falls back to the status line when an error is not JSON', async () => {
    installFakeApi({
      'GET /api/v1/tasks': () =>
        new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
    });

    const failure = (await api.listTasks({}).catch((e: unknown) => e)) as ApiError;

    expect(failure.status).toBe(502);
    expect(failure.message).toBe('Bad Gateway');
    expect(failure.code).toBe('error');
  });

  it('recognises an expired session', async () => {
    installFakeApi({
      'GET /api/v1/tasks': () => problem(401, 'unauthenticated', 'Authentication required.'),
    });

    const failure = (await api.listTasks({}).catch((e: unknown) => e)) as ApiError;

    expect(failure.isUnauthorized).toBe(true);
  });

  it('describes an unexpected failure without leaking internals', () => {
    expect(errorMessage(new TypeError('Failed to fetch'))).toBe(
      'Something went wrong. Check your connection and try again.',
    );
  });

  it('builds list queries from only the parameters that are set', async () => {
    const { calls } = installFakeApi({ 'GET /api/v1/tasks': () => json({ items: [] }) });

    await api.listTasks({ page: 2, size: 10, status: 'DONE', q: '' });
    await api.listTasks({});

    expect(calls[0]?.url).toBe('/api/v1/tasks?page=2&size=10&status=DONE');
    expect(calls[1]?.url).toBe('/api/v1/tasks');
  });

  it('uploads the raw file with its type and an encoded name', async () => {
    const { calls } = installFakeApi({
      'POST /api/v1/tasks/t1/attachments': () => json({ id: 'a' }, 201),
    });
    const file = new File(['hello'], 'my notes & more.txt', { type: 'text/plain' });

    await api.uploadAttachment('t1', file);

    expect(calls[0]?.url).toBe('/api/v1/tasks/t1/attachments?name=my+notes+%26+more.txt');
    expect(calls[0]?.headers['Content-Type']).toBe('text/plain');
    expect(calls[0]?.body).toBe(file);
  });

  it('labels an unknown file type as a byte stream, which the API then refuses', async () => {
    const { calls } = installFakeApi({
      'POST /api/v1/tasks/t1/attachments': () => json({ id: 'a' }, 201),
    });

    await api.uploadAttachment('t1', new File(['x'], 'blob'));

    expect(calls[0]?.headers['Content-Type']).toBe('application/octet-stream');
  });

  it('logs out and returns where the identity provider wants the browser next', async () => {
    installFakeApi({
      'POST /api/v1/session/logout': () =>
        json({ redirect: 'http://idp.localhost:8180/logout?x=1' }),
    });

    await expect(api.logout()).resolves.toBe('http://idp.localhost:8180/logout?x=1');
  });

  it('points downloads at the API, never at storage', () => {
    expect(api.attachmentUrl('t1', 'a1')).toBe('/api/v1/tasks/t1/attachments/a1');
  });
});
