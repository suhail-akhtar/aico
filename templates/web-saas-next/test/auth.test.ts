import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '@/lib/db';
import { authenticate, createUser, hashPassword, verifyPassword } from '@/lib/auth';

describe('passwords', () => {
  it('verifies the right one and refuses the wrong one', () => {
    const stored = hashPassword('correct horse');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('correct horse', stored)).toBe(true);
    expect(verifyPassword('wrong', stored)).toBe(false);
    expect(verifyPassword('anything', 'garbage')).toBe(false);
  });
});

describe('users', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = openDatabase(':memory:'); });

  it('creates and authenticates', () => {
    const made = createUser(db, ' Ann@Example.com ', 'longenough');
    expect('user' in made && made.user.email).toBe('Ann@Example.com');
    expect(authenticate(db, 'ann@example.com', 'longenough')?.email).toBe('Ann@Example.com');
    expect(authenticate(db, 'ann@example.com', 'nope')).toBeUndefined();
    expect(authenticate(db, 'nobody@example.com', 'longenough')).toBeUndefined();
  });

  it('answers with field errors', () => {
    expect(createUser(db, 'not-an-email', 'short')).toEqual({
      errors: { email: 'Enter an email address like name@example.com.', password: 'Use at least 8 characters.' },
    });
  });

  it('refuses a taken email, case-insensitively', () => {
    createUser(db, 'ann@example.com', 'longenough');
    const again = createUser(db, 'ANN@example.com', 'longenough');
    expect('errors' in again && again.errors.email).toMatch(/already exists/);
  });
});
