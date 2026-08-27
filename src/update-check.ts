/**
 * Telling someone a newer AICO exists, without ever making them wait for it.
 *
 * Run through `npx`, AICO is whatever version was cached the first time — and
 * nothing in the tool ever mentions that a newer one shipped. The person least
 * likely to find out is exactly the person who never installed it and so never
 * runs an upgrade command.
 *
 * The rule that shapes everything here: **the check must never be on the path
 * between the user and their work.** So it does not block startup, and the
 * notice shown at startup is the result of the *previous* run's check, read
 * from a cache file. The current run refreshes that cache in the background
 * and says nothing. That is one run of lag on learning about a release, which
 * costs nothing, in exchange for never once adding a network round trip to
 * something a person is waiting on.
 *
 * Everything fails silent. Offline, behind a proxy, rate-limited, a repository
 * that has no tags yet — all of these produce no notice rather than an error.
 * A version check that can interrupt the tool is worse than no version check.
 *
 * Tags rather than releases, because tags are what this project actually
 * creates; a repository that never cuts a GitHub Release would otherwise be
 * permanently silent. The owner and repo come from `package.json`, so a fork
 * checks itself rather than reporting its upstream's releases as its own.
 *
 * @module update-check
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';

/** How long a cached answer is trusted before another check is worth making. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Long enough for a slow network, short enough to never matter. */
const REQUEST_TIMEOUT_MS = 3_000;

interface CacheFile {
  /** Epoch ms of the last completed check, successful or not. */
  checkedAt: number;
  /** Highest release tag seen, without the `v`. Absent if nothing was found. */
  latest?: string;
}

function cachePath(): string {
  return path.join(os.homedir(), '.aico', 'update-check.json');
}

/**
 * Compare two `x.y.z` strings.
 *
 * Returns positive when `a` is newer. Deliberately no prerelease handling:
 * {@link parseTags} drops anything that is not three plain integers, so a
 * `-rc.1` build never reaches here and can never be announced as an upgrade to
 * someone running a stable version.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The highest stable version among a repository's tags.
 *
 * Sorted by version rather than trusting the order the API returns, which is
 * by ref and puts `v0.9.0` after `v0.10.0` — the classic way to announce a
 * downgrade as an update.
 */
export function highestVersion(tags: ReadonlyArray<{ name?: unknown }>): string | undefined {
  const versions = tags
    .map(tag => (typeof tag.name === 'string' ? tag.name : ''))
    .map(name => /^v?(\d+\.\d+\.\d+)$/.exec(name)?.[1])
    .filter((v): v is string => v !== undefined);
  if (versions.length === 0) return undefined;
  return versions.reduce((best, v) => (compareVersions(v, best) > 0 ? v : best));
}

/** `owner/repo` from a package.json repository field, in any of its spellings. */
export function repoSlug(repository: unknown): string | undefined {
  const url = typeof repository === 'string'
    ? repository
    : (repository as { url?: unknown } | undefined)?.url;
  if (typeof url !== 'string') return undefined;
  // Covers git+https://, git://, ssh, and the bare `owner/repo` shorthand npm
  // also accepts — all of which appear in real package.json files.
  const match = /(?:github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url.trim());
  if (!match) return undefined;
  return `${match[1]}/${match[2]}`;
}

async function readCache(): Promise<CacheFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(), 'utf8')) as CacheFile;
    return typeof parsed?.checkedAt === 'number' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeCache(data: CacheFile): Promise<void> {
  try {
    await mkdir(path.dirname(cachePath()), { recursive: true });
    await writeFile(cachePath(), JSON.stringify(data), 'utf8');
  } catch {
    // A cache we cannot write means we check again next time. Harmless.
  }
}

/**
 * The newer version to mention, if the last check found one.
 *
 * Reads only the cache — no network, no await on anything remote — so it is
 * safe to call on the startup path. Returns nothing when the cache is empty,
 * stale-but-unrefreshed, or already at or ahead of the published version.
 */
export async function pendingUpdate(current: string): Promise<string | undefined> {
  const cached = await readCache();
  if (!cached?.latest) return undefined;
  return compareVersions(cached.latest, current) > 0 ? cached.latest : undefined;
}

/**
 * Refresh the cache from GitHub, in the background.
 *
 * Returns a promise the caller is free to ignore — and should, on any path a
 * person is waiting on. The timestamp is written even when the request fails,
 * so an offline machine tries once a day rather than on every single command.
 */
export async function refreshUpdateCache(repository: unknown): Promise<void> {
  const cached = await readCache();
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) return;

  const slug = repoSlug(repository);
  if (!slug) return;

  let latest: string | undefined;
  try {
    const response = await fetch(`https://api.github.com/repos/${slug}/tags?per_page=100`, {
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub rejects unidentified clients outright.
        'User-Agent': 'aico-update-check',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.ok) {
      const tags = await response.json() as Array<{ name?: unknown }>;
      if (Array.isArray(tags)) latest = highestVersion(tags);
    }
  } catch {
    // Offline, proxied, rate-limited, DNS-blocked. All the same answer: none.
  }

  await writeCache({ checkedAt: Date.now(), ...latest ? { latest } : {} });
}

/**
 * The line to print, or nothing.
 *
 * Names the command rather than saying "an update is available", because the
 * reader's next question is always "how" — and for an `npx` user the answer is
 * not the `npm update` they would otherwise guess at.
 */
export function updateNotice(current: string, latest: string, pkg: string): string {
  return `A newer AICO is available: ${current} → ${latest}\n`
    + `  npx ${pkg}@latest    (or: npm i -g ${pkg}@latest)`;
}
