/**
 * Starter templates: an app's skeleton, copied rather than generated.
 *
 * The old way was two thousand tokens of prose handed to the model, which then
 * wrote a project from scratch — a different project every time, with the same
 * mistakes rediscovered. A template is the opposite bargain: files on disk that
 * are copied for zero model tokens, already wired to the checks the gate runs,
 * already deployable, with one worked feature the agent extends by copying a
 * pattern rather than inventing one.
 *
 * ## Where they live
 *
 * `templates/<id>/` in this repository, shipped in the package and copied to
 * `dist/templates` at build. A user's own go under `~/.aico/templates/<id>/`,
 * a project's under `<project>/.aico/templates/<id>/`; later wins by id — the
 * same rule skills use, so overriding a shipped template is a copy and an edit.
 *
 * ## The manifest
 *
 * `template.json` says what the template is, which kind of app it makes, how
 * that app is run and checked, how it deploys, and which files get the title
 * substituted. Everything an app needs to know about itself is copied into its
 * `app.json` at create time, so a template changing later changes nothing
 * about apps already made from it.
 *
 * @module apps/templates
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { cp, mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { aicoHome } from '../home.js';
import { meaningfulWords } from '../knowledge/match.js';
import type { AicoSettings } from '../settings.js';
import {
  createMiniApp, miniAppDir, type DeployTarget, type MiniApp, type MiniAppKind, type RunProfile,
} from '../miniapps/store.js';
import { profileFromTemplate } from '../project/profile.js';

export interface TemplateManifest {
  id: string;
  version: string;
  name: string;
  /** The shelf it sits on in the Apps screen. */
  category: string;
  kind: Exclude<MiniAppKind, 'nextjs'>;
  /** One or two sentences for the card. */
  summary: string;
  tags?: string[];
  /** Words in a brief that suggest this template. */
  match?: string[];
  requires?: { node?: string };
  run?: RunProfile;
  deploy?: DeployTarget[];
  /** Files (relative paths) in which `__APP_TITLE__` and friends are substituted. */
  substitute?: string[];
  /** The file the agent is pointed at first, relative to the app. */
  brief?: string;
}

export interface Template extends TemplateManifest {
  /** Where its files are. */
  dir: string;
  /** Which shelf it came from: shipped, the user's, or the project's. */
  source: 'bundled' | 'user' | 'project';
}

/** The files every template must ship, and why. Enforced by the harness. */
export const REQUIRED_TEMPLATE_FILES = [
  'template.json',
  'AICO.md',              // what the agent needs to know, inlined into the bound block
  'README.md',            // for the person
  '.aico/backlog.md',     // the stories
  '.aico/decisions.md',   // what was decided and why
  'docs/EXTENDING.md',    // how to add a page, a route, a table, a test
] as const;

const KINDS = new Set(['page', 'static', 'process', 'cli', 'mobile']);

/**
 * Where the shipped templates are.
 *
 * Two places, because the bundler flattens `dist/`: beside the built entry
 * (`dist/templates`) when running from a build, and the source tree's
 * `templates/` when running tests against `dist-test`. The first that exists
 * wins; neither existing means no shipped templates, which is a real answer
 * rather than an error.
 */
export function bundledTemplatesDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'templates'),
    path.join(here, '..', 'templates'),
    path.join(here, '..', '..', 'templates'),
  ];
  return candidates.find(c => existsSync(path.join(c)) && statSync(c).isDirectory());
}

function userTemplatesDir(): string {
  return path.join(aicoHome(), 'templates');
}

function projectTemplatesDir(cwd: string): string {
  return path.join(cwd, '.aico', 'templates');
}

/**
 * Check a manifest, returning the problems rather than throwing.
 *
 * Exported for the harness, which runs it over every shipped template.
 */
export function validateManifest(value: unknown): string[] {
  const problems: string[] = [];
  if (!value || typeof value !== 'object') return ['not an object'];
  const m = value as Record<string, unknown>;
  const str = (key: string): boolean => typeof m[key] === 'string' && (m[key] as string).trim().length > 0;
  for (const key of ['id', 'version', 'name', 'category', 'summary']) {
    if (!str(key)) problems.push(`${key} must be a non-empty string`);
  }
  if (typeof m.id === 'string' && !/^[a-z0-9][a-z0-9-]{1,40}$/.test(m.id)) {
    problems.push('id must be lowercase letters, digits and hyphens');
  }
  if (typeof m.version === 'string' && !/^\d+\.\d+\.\d+$/.test(m.version)) {
    problems.push('version must be MAJOR.MINOR.PATCH');
  }
  if (!KINDS.has(String(m.kind))) problems.push(`kind must be one of ${[...KINDS].join(', ')}`);
  for (const key of ['tags', 'match', 'substitute']) {
    if (m[key] !== undefined && !(Array.isArray(m[key]) && (m[key] as unknown[]).every(x => typeof x === 'string'))) {
      problems.push(`${key} must be an array of strings`);
    }
  }
  if (m.run !== undefined && (typeof m.run !== 'object' || m.run === null)) problems.push('run must be an object');
  if (m.deploy !== undefined) {
    if (!Array.isArray(m.deploy)) problems.push('deploy must be an array');
    else for (const [i, d] of (m.deploy as unknown[]).entries()) {
      const t = d as Record<string, unknown>;
      if (!t || typeof t.id !== 'string' || typeof t.label !== 'string' || typeof t.script !== 'string') {
        problems.push(`deploy[${i}] needs id, label and script`);
      }
    }
  }
  // A kind that runs a process must say how; a page or static app must not
  // pretend to.
  if ((m.kind === 'process' || m.kind === 'mobile') && !(m.run && typeof (m.run as RunProfile).dev === 'string')) {
    problems.push('a process template must declare run.dev');
  }
  return problems;
}

function readTemplate(dir: string, source: Template['source']): Template | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, 'template.json'), 'utf8')) as TemplateManifest;
    if (validateManifest(raw).length) return null;
    return { ...raw, dir, source };
  } catch {
    return null;
  }
}

function templatesIn(dir: string | undefined, source: Template['source']): Template[] {
  if (!dir || !existsSync(dir)) return [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .map(name => readTemplate(path.join(dir, name), source))
    .filter((t): t is Template => t !== null);
}

/** Every template the reader can start from, later shelves winning by id. */
export function listTemplates(cwd = process.cwd()): Template[] {
  const byId = new Map<string, Template>();
  for (const t of templatesIn(bundledTemplatesDir(), 'bundled')) byId.set(t.id, t);
  for (const t of templatesIn(userTemplatesDir(), 'user')) byId.set(t.id, t);
  for (const t of templatesIn(projectTemplatesDir(cwd), 'project')) byId.set(t.id, t);
  return [...byId.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

export function getTemplate(id: string, cwd = process.cwd()): Template | undefined {
  return listTemplates(cwd).find(t => t.id === id);
}

/**
 * Templates a brief suggests, best first.
 *
 * Word overlap over each template's `match` words and tags — the same
 * deliberately cheap matching Knowledge uses, because a ranking that cost a
 * model call would be spent before the app exists. Ties keep catalogue order.
 */
export function suggestTemplates(brief: string, templates = listTemplates()): Template[] {
  const words = new Set(meaningfulWords(brief));
  if (words.size === 0) return [];
  const scored = templates.map(t => {
    const vocabulary = [...(t.match ?? []), ...(t.tags ?? [])].map(w => w.toLowerCase());
    const hits = vocabulary.filter(w => words.has(w)).length;
    return { t, hits };
  });
  return scored.filter(s => s.hits > 0).sort((a, b) => b.hits - a.hits).map(s => s.t);
}

/** The catalogue as the agent sees it: one line each, ≤20, suggestions first. */
export function renderCatalogue(brief = '', cwd = process.cwd()): string {
  const all = listTemplates(cwd);
  if (all.length === 0) return 'No templates are installed.';
  const suggested = suggestTemplates(brief, all);
  const ordered = [...suggested, ...all.filter(t => !suggested.includes(t))].slice(0, 20);
  return ordered.map((t, i) => {
    const mark = i < suggested.length ? '★ ' : '  ';
    return `${mark}${t.id} — ${t.name} (${t.kind}, ${t.category}): ${t.summary}`;
  }).join('\n');
}

const TOKENS: Record<string, (v: { title: string; slug: string; description: string }) => string> = {
  __APP_TITLE__: v => v.title,
  __APP_SLUG__: v => v.slug,
  __APP_DESCRIPTION__: v => v.description,
};

/** Substitute the title tokens in a text file's content. */
export function substituteTokens(text: string, values: { title: string; slug: string; description: string }): string {
  let out = text;
  for (const [token, value] of Object.entries(TOKENS)) out = out.split(token).join(value(values));
  return out;
}

/** Whether a relative path is covered by one of the manifest's substitute globs (`**` and `*` only). */
export function matchesSubstitute(rel: string, patterns: string[] = []): boolean {
  const normalised = rel.split(path.sep).join('/');
  return patterns.some(pattern => new RegExp(`^${globToRegExp(pattern)}$`).test(normalised));
}

/**
 * A glob to a regular expression source, one token at a time — so the `*`
 * inside an already-emitted `.*` is never rewritten again, which is the bug a
 * chain of string replaces has.
 */
function globToRegExp(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') { i += 1; out += '(?:.*/)?'; } else out += '.*';
      } else {
        out += '[^/]*';
      }
    } else if (ch === '{') {
      const close = glob.indexOf('}', i);
      if (close < 0) { out += '\\{'; continue; }
      const alts = glob.slice(i + 1, close).split(',').map(a => a.replace(/[.+^${}()|[\]\\*?]/g, '\\$&'));
      out += `(?:${alts.join('|')})`;
      i = close;
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}

/** Every file under a directory, relative, skipping what a template must never carry. */
function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist' || entry.name === 'data.sqlite') continue;
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(dir, next));
    else out.push(next);
  }
  return out;
}

export interface InstantiateInput {
  template: Template;
  title: string;
  description?: string;
  sessionId?: string;
}

/**
 * Make an app from a template.
 *
 * Claims the directory through the store (so the slug is unique and the
 * manifest carries the template's run and deploy blocks), copies every file
 * but `template.json`, `node_modules` and build output, then substitutes the
 * title tokens in the files the manifest names. Returns the app as the store
 * now describes it.
 */
export async function instantiateTemplate(
  input: InstantiateInput,
  settings?: AicoSettings,
  cwd = process.cwd(),
): Promise<MiniApp> {
  const { template } = input;
  const app = await createMiniApp({
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    kind: template.kind,
    category: template.category,
    template: { id: template.id, version: template.version },
    ...(template.run ? { run: template.run } : {}),
    ...(template.deploy ? { deploy: template.deploy } : {}),
  }, settings, cwd);
  const dir = miniAppDir(app.slug, settings, cwd);

  await cp(template.dir, dir, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (src) => {
      const base = path.basename(src);
      // Local conveniences of a template's own development never travel: an
      // install, build output, a scratch database, a committed secret.
      return base !== 'template.json' && base !== 'node_modules' && base !== '.next' && base !== 'data.sqlite'
        && base !== 'coverage' && base !== 'data' && base !== '.env' && base !== '.env.local'
        && !base.endsWith('.tsbuildinfo') && base !== 'package-lock.json.bak';
    },
  });

  const values = { title: app.title, slug: app.slug, description: input.description ?? '' };
  for (const rel of walk(dir)) {
    if (!matchesSubstitute(rel, template.substitute)) continue;
    const file = path.join(dir, rel);
    const text = await readFile(file, 'utf8');
    const next = substituteTokens(text, values);
    if (next !== text) await writeFile(file, next, 'utf8');
  }
  // The manifest the store wrote is authoritative; the copy must not have
  // overwritten it (the template has no app.json, but a user's might).
  await mkdir(dir, { recursive: true });

  // Born knowing its commands, at template rank: above anything the manifest
  // would be guessed to say, below anything the person later decides.
  await profileFromTemplate(dir, template.run, `${template.name} (${template.id})`).catch(() => undefined);
  return { ...app, built: true };
}

/** Whether this process's Node satisfies a template's requirement, e.g. ">=22.5". */
export function nodeSatisfies(requirement: string | undefined, version = process.versions.node): boolean {
  if (!requirement) return true;
  const m = /^>=\s*(\d+)(?:\.(\d+))?/.exec(requirement.trim());
  if (!m) return true;
  const [major, minor = 0] = version.split('.').map(Number);
  const wantMajor = Number(m[1]);
  const wantMinor = Number(m[2] ?? 0);
  return major! > wantMajor || (major === wantMajor && minor! >= wantMinor);
}
