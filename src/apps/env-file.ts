/**
 * The env file an app is born with: `.env.example` copied to the file the
 * framework actually reads, with every secret replaced by a fresh random value
 * in the format that framework wants.
 *
 * Why this exists: `writeLocalEnv` wrote `.env.local` (a Next.js convention)
 * and filled every `change-me…` with 24 random bytes as hex. FastAPI's
 * pydantic-settings, Laravel, godotenv and ASP.NET read `.env` or the process
 * environment, and some values are not hex at all: Laravel's `APP_KEY` must be
 * `base64:` plus 32 random bytes or the app refuses to boot, an ASP.NET
 * data-protection key *path* is a directory that must exist, a JWT secret wants
 * more entropy than a session cookie's. A template now says which file and
 * which format per key (`envFile` in template.json).
 *
 * Safety it enforces in code rather than hoping a template remembered it:
 * the generated file is added to `.gitignore` before the first `git add -A`
 * (a secret in the scaffold commit is the worst place for one), values are
 * never returned or logged (callers get key *names* only), and an existing env
 * file is never overwritten.
 *
 * What it does not do: validate the example's other values, or invent keys the
 * example does not list — except keys named in `generate`, which are appended
 * so a template can say "this key must exist" in one place.
 *
 * @module apps/env-file
 */

import crypto from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import type { EnvFileSpec } from './stack.js';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** One generated value, plus a directory to create when the format is a path. */
export interface Generated {
  value: string;
  /** A directory (relative to the app) the value points at, which must exist. */
  mkdir?: string;
}

/**
 * Generate a secret in a named format.
 *
 * Formats: `hex[:bytes]` (24), `base64[:bytes]` (32), `base64url[:bytes]` (32),
 * `uuid`, `password[:length]` (24, alphanumeric), `laravel-app-key`
 * (`base64:` + 32 bytes, what `php artisan key:generate` writes), `jwt-secret`
 * (64 bytes base64url), `aspnet-dp-key-path` (`.aspnet/keys`, created),
 * `path:<dir>` (created). Unknown formats throw: a typo must not produce an
 * empty secret.
 */
export function generateSecret(format: string, rng: (n: number) => Buffer = crypto.randomBytes): Generated {
  const [name, arg] = format.split(/:(.*)/s);
  const n = (fallback: number): number => {
    const v = Number(arg);
    return Number.isInteger(v) && v > 0 && v <= 512 ? v : fallback;
  };
  switch (name) {
    case 'hex': return { value: rng(n(24)).toString('hex') };
    case 'base64': return { value: rng(n(32)).toString('base64') };
    case 'base64url': return { value: rng(n(32)).toString('base64url') };
    case 'uuid': return { value: crypto.randomUUID() };
    case 'password': {
      const len = n(24);
      // randomInt avoids modulo bias; rng is only for byte-shaped formats.
      let out = '';
      for (let i = 0; i < len; i++) out += ALNUM[crypto.randomInt(ALNUM.length)];
      return { value: out };
    }
    case 'laravel-app-key': return { value: `base64:${rng(32).toString('base64')}` };
    case 'jwt-secret': return { value: rng(64).toString('base64url') };
    case 'aspnet-dp-key-path': return { value: '.aspnet/keys', mkdir: '.aspnet/keys' };
    case 'path': {
      const rel = (arg ?? '').replace(/\\/g, '/');
      if (!rel || path.isAbsolute(rel) || rel.split('/').includes('..') || !/^[A-Za-z0-9._/-]+$/.test(rel)) {
        throw new Error(`path format needs a relative directory inside the app, got "${arg ?? ''}"`);
      }
      return { value: rel, mkdir: rel };
    }
    default:
      throw new Error(`unknown secret format "${format}"`);
  }
}

/** Make sure a file name is ignored by git in `dir`, appending to (or creating) `.gitignore`. */
export async function ensureGitignored(dir: string, entry: string): Promise<void> {
  const file = path.join(dir, '.gitignore');
  let text = '';
  try { text = await readFile(file, 'utf8'); } catch { /* none yet */ }
  const lines = text.split(/\r?\n/).map(l => l.trim());
  if (lines.includes(entry) || lines.includes(`/${entry}`)) return;
  const sep = text && !text.endsWith('\n') ? '\n' : '';
  await writeFile(file, `${text}${sep}${entry}\n`, 'utf8');
}

/**
 * Write the app's env file from its example. Returns the key *names* that were
 * generated (never their values), or undefined when nothing was written.
 */
export async function writeAppEnv(dir: string, spec?: EnvFileSpec): Promise<{ file: string; generated: string[] } | undefined> {
  const exampleName = spec?.example ?? '.env.example';
  const fileName = spec?.file ?? '.env.local';
  const example = path.join(dir, exampleName);
  const target = path.join(dir, fileName);
  if (!existsSync(example) || existsSync(target)) return undefined;

  const listed = spec?.generate ?? {};
  const seen = new Set<string>();
  const generated: string[] = [];
  const make = (key: string, format: string): string => {
    const g = generateSecret(format);
    if (g.mkdir) mkdirSync(path.join(dir, g.mkdir), { recursive: true });
    generated.push(key);
    return g.value;
  };

  const text = await readFile(example, 'utf8');
  const lines = text.split(/\r?\n/).map(line => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) return line;
    const key = m[1]!;
    seen.add(key);
    if (listed[key]) return `${key}=${make(key, listed[key]!)}`;
    // The historical rule, kept so the nine Node templates behave exactly as before.
    if (/^change-me/i.test(m[2] ?? '')) return `${key}=${make(key, 'hex:24')}`;
    return line;
  });
  for (const [key, format] of Object.entries(listed)) {
    if (!seen.has(key)) lines.push(`${key}=${make(key, format)}`);
  }
  // Ignored before anything can `git add -A` it.
  await ensureGitignored(dir, fileName);
  await writeFile(target, lines.join('\n'), 'utf8');
  return { file: target, generated };
}
