import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './runtime-config';

function serve(body: unknown, init: ResponseInit = {}): typeof fetch {
  return (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), init)) as typeof fetch;
}

describe('loadConfig', () => {
  it('reads a valid file and fills the defaults', async () => {
    expect(await loadConfig(serve({}))).toEqual({
      apiBaseUrl: '/api',
      loginUrl: '/api/auth/start',
      logoutUrl: '/api/auth/sign_out?rd=/',
      environment: 'production',
    });
    expect(
      await loadConfig(serve({ apiBaseUrl: '/gateway/api', environment: 'staging' })),
    ).toMatchObject({
      apiBaseUrl: '/gateway/api',
      environment: 'staging',
    });
  });

  it('refuses a URL that would send the session cookie to another origin', async () => {
    for (const apiBaseUrl of [
      'https://evil.example/api',
      '//evil.example',
      'api',
      '/a b',
      '/a\\b',
    ]) {
      await expect(loadConfig(serve({ apiBaseUrl }))).rejects.toThrow(/apiBaseUrl/);
    }
  });

  it('explains a missing, non-JSON or unreachable config file', async () => {
    await expect(loadConfig(serve('nope', { status: 404 }))).rejects.toThrow('answered 404');
    await expect(loadConfig(serve('<html>', { status: 200 }))).rejects.toThrow(
      'could not be read as JSON',
    );
    await expect(
      loadConfig((async () => {
        throw new TypeError('offline');
      }) as typeof fetch),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
