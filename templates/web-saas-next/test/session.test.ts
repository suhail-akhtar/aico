import { beforeAll, describe, expect, it } from 'vitest';
import { decodeSession, encodeSession } from '@/lib/session';

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-that-is-long-enough';
});

describe('session cookie', () => {
  it('round-trips a user id', () => {
    expect(decodeSession(encodeSession(42))).toBe(42);
  });
  it('rejects a tampered id', () => {
    const [, expires, sig] = encodeSession(42).split('.');
    expect(decodeSession(`43.${expires}.${sig}`)).toBeUndefined();
  });
  it('rejects an expired cookie', () => {
    const past = Date.now() - 40 * 86_400_000;
    expect(decodeSession(encodeSession(42, past))).toBeUndefined();
  });
  it('rejects garbage', () => {
    expect(decodeSession(undefined)).toBeUndefined();
    expect(decodeSession('')).toBeUndefined();
    expect(decodeSession('a.b')).toBeUndefined();
  });
});
