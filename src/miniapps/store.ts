/**
 * Where Apps live, and what one is.
 *
 * An App is a directory holding an application, its data, and a manifest. It is
 * not part of the user's repository — it is something the agent produced, so it
 * belongs in the workspace alongside every other artifact.
 *
 *   <workspace>/miniapps/<slug>/
 *     app.json          identity, kind, template, how to run and deploy it
 *     schema.sql        the tables (page apps), applied on first serve
 *     data.sqlite       the database (page apps), created from the schema
 *     public/           the page (page and static apps)
 *     package.json …    the project (process, cli and mobile apps)
 *     AICO.md           what the agent needs to know about this app, inlined
 *                       into the bound session's prompt
 *     .aico/backlog.md  stories; .aico/decisions.md  what was decided and why
 *
 * The directory name `miniapps` is a fossil kept on purpose: renaming it would
 * migrate every existing app for no benefit to anyone.
 *
 * ## Kinds are runtimes, not frameworks
 *
 * What the host has to *do* with an app is the thing worth recording. A `page`
 * is served by the shared host with a database it cannot send SQL to. A
 * `static` app is files and nothing else. A `process` is a child process on its
 * own port started from a command the app declares — Next.js, Hono, Astro, a
 * dozen others, all the same to the runner. A `cli` has no server at all. The
 * framework is the template's business; `app.json.run` says how to run it.
 *
 * `nextjs` is the legacy spelling of `process` from before there were
 * templates. It still reads, and maps to the run profile those apps always had.
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

/**
 * What the host does with an app.
 *
 *   page     one HTML file, Alpine, the shared host, a SQLite table API
 *   static   files under public/, served by the shared host, no database
 *   process  its own child process on its own port, from `run.dev`
 *   cli      no server; checks and a `run.start` that prints
 *   mobile   an Expo project; `process` semantics with a web preview
 *   nextjs   legacy spelling of `process` with the Next.js run profile
 */
export type MiniAppKind = 'page' | 'static' | 'process' | 'cli' | 'mobile' | 'nextjs';

/** How to install, run, build and check an app. Copied from its template at create. */
export interface RunProfile {
  /** Installs dependencies. Run before the first `dev` when `node_modules` is absent. */
  install?: string;
  /** Starts the dev server. `{port}` is substituted; `PORT` is also set in the environment. */
  dev?: string;
  /** Regex source matched against the dev server's output to know it is up. */
  ready?: string;
  build?: string;
  test?: string;
  typecheck?: string;
  lint?: string;
  /** For `cli` apps: the command "Run" executes. */
  start?: string;
}

export interface DeployTarget {
  id: string;
  label: string;
  /** A command run in the app directory. Node scripts, so it works on Windows. */
  script: string;
  /** Executables that must be on PATH first, e.g. `docker`. */
  requires?: string[];
}

export interface MiniApp {
  /** URL and directory name. Derived from the title, never supplied directly. */
  slug: string;
  /**
   * Absent means `page`. Apps created before there was a choice are
   * single-page apps, and rewriting their files to say so would be a migration
   * with no benefit.
   */
  kind?: MiniAppKind;
  title: string;
  /** One line for the list. */
  description?: string;
  /** Which shelf it sits on in the Apps screen: web-saas, api, landing, records, … */
  category?: string;
  /** Where it came from, so a newer template can be pointed at without being applied. */
  template?: { id: string; version: string };
  run?: RunProfile;
  deploy?: DeployTarget[];
  createdAt: number;
  updatedAt: number;
  /** The session that is building it, so the two can find each other. */
  sessionId?: string;
  /** False until the files that make it runnable exist — a directory is not yet an app. */
  built: boolean;
}

/** Everything Apps own, under one directory. */
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

/** The kind an app behaves as, with the legacy spelling folded in. */
export function effectiveKind(app: Pick<MiniApp, 'kind'>): Exclude<MiniAppKind, 'nextjs'> {
  if (!app.kind) return 'page';
  return app.kind === 'nextjs' ? 'process' : app.kind;
}

/** Whether the app is a child process with a port of its own. */
export function hasProcess(app: Pick<MiniApp, 'kind'>): boolean {
  const kind = effectiveKind(app);
  return kind === 'process' || kind === 'mobile';
}

/** Whether the shared host serves this app's `public/`. */
export function servedByHost(app: Pick<MiniApp, 'kind'>): boolean {
  const kind = effectiveKind(app);
  return kind === 'page' || kind === 'static';
}

/**
 * How to run an app, filling in what its manifest does not say.
 *
 * A `nextjs` app made before templates has no `run` block; it gets the profile
 * those apps always ran with. A templated app carries its own. The defaults for
 * a `process` app with a missing field are the npm conventions, because that is
 * what every template here uses and what a hand-made project most likely has.
 */
export function runProfileFor(app: Pick<MiniApp, 'kind' | 'run'>): RunProfile {
  const declared = app.run ?? {};
  if (app.kind === 'nextjs') {
    return {
      install: 'npm install --no-audit --no-fund',
      dev: 'npx next dev --port {port}',
      ready: 'ready in|started server|Local:\\s+http',
      build: 'npm run build',
      ...declared,
    };
  }
  if (!hasProcess(app) && effectiveKind(app) !== 'cli') return declared;
  return {
    install: 'npm install --no-audit --no-fund',
    ready: 'ready in|started server|Local:\\s+http|listening on|http://',
    ...declared,
  };
}

/** What has to exist for an app of this kind to count as built. */
function builtMarker(app: Pick<MiniApp, 'kind'>): string {
  switch (effectiveKind(app)) {
    case 'page':
    case 'static':
      return path.join('public', 'index.html');
    default:
      return 'package.json';
  }
}

async function readApp(dir: string): Promise<MiniApp | null> {
  try {
    const raw = await readFile(path.join(dir, 'app.json'), 'utf8');
    const app = JSON.parse(raw) as MiniApp;
    /*
      Recomputed rather than trusted: the flag records whether there is an app
      to open, and the only honest source for that is whether the files exist.
      Reading the stored flag instead would let a half-written app claim to be
      finished for as long as nobody corrected the file.
    */
    const built = existsSync(path.join(dir, builtMarker(app)));
    return { ...app, built };
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

export interface CreateMiniAppInput {
  title: string;
  description?: string;
  sessionId?: string;
  kind?: MiniAppKind;
  category?: string;
  template?: { id: string; version: string };
  run?: RunProfile;
  deploy?: DeployTarget[];
}

/**
 * Claim a directory for a new app.
 *
 * The slug is made unique by suffixing rather than by failing: two apps called
 * "Invoices" is a thing a person does, and refusing the second one teaches them
 * to invent names for the tool's benefit.
 */
export async function createMiniApp(
  input: CreateMiniAppInput,
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
    ...(input.kind && input.kind !== 'page' ? { kind: input.kind } : {}),
    title: input.title.trim() || slug,
    ...(input.description ? { description: input.description } : {}),
    ...(input.category ? { category: input.category } : {}),
    ...(input.template ? { template: input.template } : {}),
    ...(input.run && Object.keys(input.run).length ? { run: input.run } : {}),
    ...(input.deploy?.length ? { deploy: input.deploy } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    createdAt: now,
    updatedAt: now,
    built: false,
  };

  const dir = path.join(root, slug);
  await mkdir(servedByHost(app) ? path.join(dir, 'public') : dir, { recursive: true });
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
  slug: string,
  patch: Partial<Pick<MiniApp, 'title' | 'description' | 'sessionId' | 'run' | 'deploy' | 'category'>> = {},
  settings?: AicoSettings, cwd = process.cwd(),
): Promise<MiniApp | null> {
  const dir = miniAppDir(slug, settings, cwd);
  const app = await readApp(dir);
  if (!app) return null;
  const next: MiniApp = { ...app, ...patch, updatedAt: Date.now() };
  await writeFile(path.join(dir, 'app.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/**
 * Backlog progress, from the checkboxes in `.aico/backlog.md`.
 *
 * Read by the Apps screen so a card can say `3/7` without a model call. A file
 * that is not there is zero of zero, which the card shows as nothing.
 */
export async function backlogProgress(dir: string): Promise<{ done: number; total: number }> {
  try {
    const text = await readFile(path.join(dir, '.aico', 'backlog.md'), 'utf8');
    const done = (text.match(/^\s*- \[x\]/gim) ?? []).length;
    const open = (text.match(/^\s*- \[ \]/gm) ?? []).length;
    return { done, total: done + open };
  } catch {
    return { done: 0, total: 0 };
  }
}
