import { describe, expect, it } from 'vitest';
import { loginHref, logoutHref, safeReturnTo } from './auth';

describe('safeReturnTo (the open-redirect guard)', () => {
  it('keeps a path on this origin, with its query and hash', () => {
    for (const ok of ['/', '/items', '/items?dialog=new', '/a/b?c=d#e'])
      expect(safeReturnTo(ok)).toBe(ok);
  });

  it('replaces everything else with the start page', () => {
    for (const bad of [
      undefined,
      null,
      '',
      'items',
      '//evil.example',
      '///evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      '/\\evil.example',
      '/items\nSet-Cookie: x=1',
      '/items\u0000',
      '/items\u007f',
    ]) {
      expect(safeReturnTo(bad)).toBe('/');
    }
  });
});

describe('gateway links', () => {
  it('appends the sanitised return path to the login URL', () => {
    expect(loginHref({ loginUrl: '/api/auth/start' }, '/items?dialog=new')).toBe(
      '/api/auth/start?rd=%2Fitems%3Fdialog%3Dnew',
    );
    expect(loginHref({ loginUrl: '/api/auth/start' }, 'https://evil.example')).toBe(
      '/api/auth/start?rd=%2F',
    );
    expect(loginHref({ loginUrl: '/auth/start?client=web' }, undefined)).toBe(
      '/auth/start?client=web&rd=%2F',
    );
  });

  it('uses the configured logout URL as is', () => {
    expect(logoutHref({ logoutUrl: '/api/auth/sign_out?rd=/' })).toBe('/api/auth/sign_out?rd=/');
  });
});
