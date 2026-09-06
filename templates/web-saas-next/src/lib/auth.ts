/**
 * Users and passwords, plus the cookie plumbing that ties a request to a user.
 *
 * Passwords are hashed with scrypt from node:crypto — no dependency, and the
 * parameters are the Node defaults, which are current recommendations. The
 * pure functions (`createUser`, `authenticate`) take the database so tests run
 * them in memory; the request-bound ones (`currentUser`, `requireUser`) read
 * the cookie through next/headers and are only called from server code.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from './db';
import { SESSION_COOKIE, SESSION_DAYS, decodeSession, encodeSession } from './session';

export interface User {
  id: number;
  email: string;
  created_at: string;
}

type UserRow = User & { password_hash: string };

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export type FieldErrors = Record<string, string>;

export function validateCredentials(email: string, password: string): FieldErrors {
  const errors: FieldErrors = {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter an email address like name@example.com.';
  if (password.length < 8) errors.password = 'Use at least 8 characters.';
  return errors;
}

export function findUserByEmail(database: DatabaseSync, email: string): UserRow | undefined {
  return database.prepare('SELECT * FROM users WHERE email = ?').get(email.trim()) as unknown as UserRow | undefined;
}

/** Create a user, or say why not (`{ errors }`, including a taken email). */
export function createUser(database: DatabaseSync, email: string, password: string): { user: User } | { errors: FieldErrors } {
  const errors = validateCredentials(email.trim(), password);
  if (Object.keys(errors).length) return { errors };
  if (findUserByEmail(database, email)) return { errors: { email: 'An account with this email already exists.' } };
  const { lastInsertRowid } = database
    .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run(email.trim(), hashPassword(password));
  const row = database.prepare('SELECT id, email, created_at FROM users WHERE id = ?').get(Number(lastInsertRowid)) as unknown as User;
  return { user: row };
}

/** The user for these credentials, or undefined. Same answer for a wrong email and a wrong password. */
export function authenticate(database: DatabaseSync, email: string, password: string): User | undefined {
  const row = findUserByEmail(database, email);
  if (!row || !verifyPassword(password, row.password_hash)) return undefined;
  return { id: row.id, email: row.email, created_at: row.created_at };
}

// ── Request-bound ────────────────────────────────────────────────────────────

export async function setSessionCookie(userId: number): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, encodeSession(userId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

/** The signed-in user, or undefined. */
export async function currentUser(): Promise<User | undefined> {
  const jar = await cookies();
  const userId = decodeSession(jar.get(SESSION_COOKIE)?.value);
  if (!userId) return undefined;
  return db().prepare('SELECT id, email, created_at FROM users WHERE id = ?').get(userId) as unknown as User | undefined;
}

/** The signed-in user, or a redirect to /login. Call at the top of a protected page or action. */
export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect('/login');
  return user;
}
