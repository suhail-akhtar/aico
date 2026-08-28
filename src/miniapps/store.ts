/**
 * Where Mini Apps live, and what one is.
 *
 * A Mini App is a directory holding a single-page application, its schema, and
 * its data. It is not part of the user's repository — it is something the agent
 * produced, so it belongs in the workspace alongside every other artifact.
 *
 *   <workspace>/miniapps/<slug>/
 *     app.json          identity, schema version, when it was made
 *     schema.sql        the tables, applied on first serve
 *     data.sqlite       the database, created from the schema
 *     public/
 *       index.html      the app — one page, Alpine, no build step
 *       app.js          its behaviour, as Alpine.data components
 *       app.css         its own styles, on top of the shipped foundation
 *
 * ## Why a directory rather than a row somewhere
 *
 * Because the agent writes files, and a Mini App you cannot open in an editor,
 * copy somewhere else, or read without the tool that made it is a worse
 * artifact than one you can. The directory *is* the app; this module only
 * agrees on its shape.
 *
 * ## The slug is not the title
 *
 * The title is whatever the reader called it. The slug is derived, checked, and
 * used for the URL and the path — so a title containing a slash, a colon, or a
 * `..` cannot become a path segment. Given the whole point is to serve these
 * over HTTP from a model's output, that separation is load-bearing rather than
 * tidy.
 *
 * @module miniapps/store
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { AicoSettings } from '../settings.js';
import { resolveWorkspaceRoot } from '../workspace.js';

export interface MiniApp {
  /** URL and directory name. Derived from the title, never supplied directly. */
  slug: string;
  title: string;
  /** One line for the list. */
  description?: string;
  createdAt: number;
  updatedAt: number;
  /** The session that is building it, so the two can find each other. */
  sessionId?: string;
  /** False until `index.html` exists — a directory is not yet an app. */
  built: boolean;
}

/** Everything Mini Apps own, under one directory. */
export function miniAppsRoot(settings?: AicoSettings, cwd = process.cwd()): string {
  return path.join(resolveWorkspaceRoot(settings, cwd), 'miniapps');
}

export function miniAppDir(slug: string, settings?: AicoSettings, cwd = process.cwd()): string {
  return path.join(miniAppsRoot(settings, cwd), slugify(slug));
}

/**
 * A title reduced to something safe to put in a path and a URL.
 *
 * Lowercase, alphanumerics and single hyphens, nothing else. Everything that
 * could traverse a directory or confuse a router — dots, slashes, colons,
 * backslashes, leading hyphens — is gone by construction rather than by a
 * rejected list, because a rejected list is a list of the attacks somebody
 * thought of.
 */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  // A title of nothing but punctuation reduces to nothing, which would name the
  // apps directory itself. Anything is better than that.
  return slug || 'app';
}

/**
 * Reject a slug that did not come from `slugify`.
 *
 * Belt and braces: every path here is built from a slug, and a slug that
 * reached us from an HTTP route rather than from `create` has not been through
 * the reducer. One check, at the boundary, rather than trusting every caller.
 */
export function isSafeSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,47}$/.test(slug) && slugify(slug) === slug;
}

async function readApp(dir: string): Promise<MiniApp | null> {
  try {
    const raw = await readFile(path.join(dir, 'app.json'), 'utf8');
    const app = JSON.parse(raw) as MiniApp;
    // Recomputed rather than trusted: the flag records whether a page exists,
    // and the only honest source for that is whether a page exists.
    return { ...app, built: existsSync(path.join(dir, 'public', 'index.html')) };
  } catch {
    return null;
  }
}

export async function listMiniApps(
  settings?: AicoSettings, cwd = process.cwd(),
): Promise<MiniApp[]> {
  const root = miniAppsRoot(settings, cwd);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    // No directory means no apps, which is the ordinary state before the first
    // one — not a condition worth reporting.
    return [];
  }
  const apps = await Promise.all(
    names.filter(isSafeSlug).map(name => readApp(path.join(root, name))),
  );
  return apps.filter((a): a is MiniApp => a !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getMiniApp(
  slug: string, settings?: AicoSettings, cwd = process.cwd(),
): Promise<MiniApp | null> {
  if (!isSafeSlug(slug)) return null;
  return readApp(miniAppDir(slug, settings, cwd));
}

/**
 * Claim a directory for a new app.
 *
 * The slug is made unique by suffixing rather than by failing: two apps called
 * "Invoices" is a thing a person does, and refusing the second one teaches them
 * to invent names for the tool's benefit.
 */
export async function createMiniApp(
  input: { title: string; description?: string; sessionId?: string },
  settings?: AicoSettings,
  cwd = process.cwd(),
): Promise<MiniApp> {
  const root = miniAppsRoot(settings, cwd);
  await mkdir(root, { recursive: true });

  const base = slugify(input.title);
  let slug = base;
  for (let n = 2; existsSync(path.join(root, slug)); n++) slug = `${base}-${n}`;

  const now = Date.now();
  const app: MiniApp = {
    slug,
    title: input.title.trim() || slug,
    ...(input.description ? { description: input.description } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    createdAt: now,
    updatedAt: now,
    built: false,
  };

  const dir = path.join(root, slug);
  await mkdir(path.join(dir, 'public'), { recursive: true });
  await writeFile(path.join(dir, 'app.json'), `${JSON.stringify(app, null, 2)}\n`, 'utf8');
  return app;
}

/**
 * Delete an app and everything it holds.
 *
 * Including its database — which is the point worth being loud about, since
 * the data is the part that cannot be regenerated from a prompt. Callers are
 * expected to have asked first.
 */
export async function deleteMiniApp(
  slug: string, settings?: AicoSettings, cwd = process.cwd(),
): Promise<boolean> {
  if (!isSafeSlug(slug)) return false;
  const dir = miniAppDir(slug, settings, cwd);
  if (!existsSync(dir)) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

/** Record that something changed, so the list orders by what was touched last. */
export async function touchMiniApp(
  slug: string, patch: Partial<Pick<MiniApp, 'title' | 'description' | 'sessionId'>> = {},
  settings?: AicoSettings, cwd = process.cwd(),
): Promise<MiniApp | null> {
  const dir = miniAppDir(slug, settings, cwd);
  const app = await readApp(dir);
  if (!app) return null;
  const next: MiniApp = { ...app, ...patch, updatedAt: Date.now() };
  await writeFile(path.join(dir, 'app.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
