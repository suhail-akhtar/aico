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

import { execFile } from 'child_process';
import { constants as fsConstants, existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { aicoHome } from '../home.js';
import { meaningfulWords } from '../knowledge/match.js';
import type { AicoSettings } from '../settings.js';
import {
  createMiniApp, getMiniApp, miniAppDir, type DeployTarget, type MiniApp, type MiniAppKind, type RunProfile,
} from '../miniapps/store.js';
import { applyPlatform } from '../miniapps/store.js';
import { profileFromTemplate } from '../project/profile.js';
import { seedDecisions } from '../project/decisions.js';
import { hasArtifactSegment, isArtifactName } from '../../shared/apps/artifact-dirs.mjs';
import { writeAppEnv } from './env-file.js';
import { checkRequirements, type RequirementReport } from './toolchain.js';
import {
  validateBundle, validateRunExtensions, validateStack,
  type AppCompose, type AppService, type AppStack, type DockerSpec, type EnvFileSpec,
} from './stack.js';
import type { ToolchainSpec } from './toolchain.js';

export interface TemplateManifest {
  id: string;
  version: string;
  name: string;
  /** The shelf it sits on in the Apps screen. */
  category: string;
  kind: Exclude<MiniAppKind, 'nextjs'>;
  /** One or two sentences for the card. */
  summary: string;
  /** Three short lines of what the app arrives with, for the gallery card. */
  features?: string[];
  tags?: string[];
  /** Words in a brief that suggest this template. */
  match?: string[];
  requires?: { node?: string };
  /** The toolchain a non-Node (or any) stack needs, probed for real. ADR 0031. */
  toolchain?: ToolchainSpec;
  /** The file whose presence means "scaffolded"; default `package.json`. */
  manifestFile?: string | string[];
  envFile?: EnvFileSpec;
  /** Extra artefact directory names (never copied, listed or packaged). */
  artifactDirs?: string[];
  /** Names from the shared artefact list this template keeps (`bin/` as source). */
  keepDirs?: string[];
  docker?: DockerSpec;
  /** Read by the rot check (`scripts/templates-live.mjs`). */
  verify?: { env?: Record<string, string>; skip?: string[] };
  /** A bundle's services, the one the preview shows, and its compose file. */
  services?: AppService[];
  preview?: string;
  compose?: AppCompose;
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

const KINDS = new Set(['page', 'static', 'process', 'cli', 'mobile', 'bundle']);

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
  // Multi-stack additions (ADR 0031). Absent on the nine Node templates, which stay valid unchanged.
  problems.push(...validateStack(m));
  problems.push(...validateRunExtensions(m.run));
  const toolchain = (m.toolchain as { id?: string } | undefined)?.id;
  if (toolchain && toolchain !== 'node' && m.kind !== 'bundle') {
    if (m.manifestFile === undefined) problems.push(`a ${toolchain} template must declare manifestFile (the file that means "scaffolded")`);
    if (m.kind === 'process' && !(m.run && typeof (m.run as RunProfile).test === 'string')) problems.push('a process template must declare run.test so the checks gate can run');
  }
  if (m.kind === 'bundle') problems.push(...validateBundle(m));
  else if (m.services !== undefined) problems.push('services belong to kind "bundle"');
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
  const words = new Set([...meaningfulWords(brief)].map(stem));
  if (words.size === 0) return [];
  const scored = templates.map(t => ({ t, score: suggestionScore(t, words) }));
  return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).map(s => s.t);
}

/**
 * Words that name a stack. A brief that says "a Python API" or "Laravel" picks
 * that stack's starter; a brief that says nothing about a stack must not be
 * handed whichever stack happens to share the most generic words ("api",
 * "rest", "service"). Node's starters are the long-standing default (each one
 * built end to end by a real model), so a starter on another toolchain, and a
 * bundle, count half unless the brief names its stack or asks for a bundle.
 */
const STACK_WORDS: Record<string, string[]> = {
  python: ['python', 'fastapi', 'django', 'flask', 'pydantic', 'uvicorn', 'pytest'],
  java: ['java', 'spring', 'springboot', 'maven', 'gradle', 'jvm', 'kotlin', 'jakarta'],
  dotnet: ['dotnet', 'csharp', 'aspnet', 'blazor', 'efcore', 'nuget'],
  // Two-letter words never reach the matcher (meaningfulWords drops them), so "go" cannot be listed.
  go: ['golang', 'gin', 'goroutine'],
  php: ['php', 'laravel', 'symfony', 'composer', 'livewire', 'blade', 'eloquent'],
};
// Not "service"/"services": nearly every API brief says it, and it must not read as a request for a bundle.
const BUNDLE_WORDS = ['bundle', 'microservices', 'multi-service', 'multiservice', 'compose', 'full-stack', 'fullstack', 'monorepo'];

/** Whether the brief's words name this template's stack (or ask for a bundle). */
function namesItsStack(t: TemplateManifest, words: Set<string>): boolean {
  if (t.kind === 'bundle') return BUNDLE_WORDS.some(w => words.has(stem(w)));
  return (STACK_WORDS[t.toolchain?.id ?? ''] ?? []).some(w => words.has(stem(w)));
}

/** The ranking score: the word overlap, halved for a stack the brief did not ask for. */
function suggestionScore(t: TemplateManifest, words: Set<string>): number {
  const { score } = matchScore(t, words);
  const other = t.kind === 'bundle' || (t.toolchain && t.toolchain.id !== 'node');
  return other && !namesItsStack(t, words) ? Math.floor(score / 2) : score;
}

/** A crude singular: "invoices" and "invoice" are one word to the ranking. */
export function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/**
 * How well a template fits a set of brief words, and which entries matched.
 *
 * `match` words are what the template author said the template is *for*;
 * they count double. Tags are what it is made of ("node", "page") and count
 * once — a brief that says "page" is not asking for the page kind. A
 * multi-word entry ("sign in", "web app") matches when all its words do.
 */
export function matchScore(t: TemplateManifest, words: Set<string>): { score: number; matched: string[] } {
  const matched: string[] = [];
  let score = 0;
  const hit = (entry: string): boolean => entry.toLowerCase().split(/[\s-]+/).filter(Boolean).every(w => words.has(stem(w)));
  for (const entry of t.match ?? []) if (hit(entry)) { score += 2; matched.push(entry); }
  for (const entry of t.tags ?? []) if (hit(entry) && !matched.includes(entry)) { score += 1; matched.push(entry); }
  return { score, matched };
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
    if (isArtifactName(entry.name)) continue;
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

/** The stack facts of a template as an app carries them (empty for the Node templates, so their `app.json` is unchanged). */
export function stackOf(t: Pick<TemplateManifest, 'toolchain' | 'manifestFile' | 'envFile' | 'docker' | 'artifactDirs' | 'keepDirs'>): AppStack | undefined {
  const stack: AppStack = {
    ...(t.toolchain ? { toolchain: t.toolchain } : {}),
    ...(t.manifestFile ? { manifestFile: t.manifestFile } : {}),
    ...(t.envFile ? { envFile: t.envFile } : {}),
    ...(t.docker ? { docker: t.docker } : {}),
    ...(t.artifactDirs?.length ? { artifactDirs: t.artifactDirs } : {}),
    ...(t.keepDirs?.length ? { keepDirs: t.keepDirs } : {}),
  };
  return Object.keys(stack).length ? stack : undefined;
}

/**
 * Whether this machine can run a template, and what to say when it cannot.
 *
 * A Node-only template keeps its historical check (the engine's own Node
 * version). A template with a `toolchain` is probed for real; when the native
 * toolchain is missing but Docker answers, the template is still usable (it
 * runs in a container, ADR 0031 section 4) and the message says how. A bundle
 * never blocks creation: compose needs only Docker, and native start
 * re-checks each service.
 */
export function checkTemplateRequirements(t: TemplateManifest): { ok: boolean; message: string; report?: RequirementReport } {
  if (t.kind === 'bundle') return { ok: true, message: '' };
  if (!t.toolchain) {
    return nodeSatisfies(t.requires?.node)
      ? { ok: true, message: '' }
      : { ok: false, message: `Template "${t.id}" needs Node ${t.requires?.node}; this machine runs ${process.versions.node}. Pick another template or upgrade Node.` };
  }
  const report = checkRequirements({ toolchain: t.toolchain });
  if (report.ok) return { ok: true, message: '', report };
  if (report.dockerAvailable) {
    return { ok: true, message: `Note: ${report.message}`, report };
  }
  return { ok: false, message: `Template "${t.id}" cannot run on this machine. ${report.message} Docker is not available either, so there is no fallback.`, report };
}

/** Copy a template's files into `dir`, minus what a template must never carry. */
async function copyTemplateFiles(template: Template, dir: string): Promise<void> {
  const opts = { keep: template.keepDirs ?? [], extra: template.artifactDirs ?? [] };
  // The nine Node templates have always dropped a scratch `data/`; a stack with a toolchain keeps it.
  const legacyData = !template.toolchain;
  // Not fs.cp: in the packaged desktop app the templates sit in an asar archive
  // (unpacked on disk), and fs.cp bypasses Electron's asar layer and answers
  // ENOENT for every template. readdir + copyFile go through it and keep file modes.
  const keepEntry = (src: string): boolean => {
    const base = path.basename(src);
    // Local conveniences of a template's own development never travel: an
    // install, build output, a scratch database, a committed secret.
    if (base === 'template.json' || base === '.env' || base === '.env.local' || base === 'package-lock.json.bak') return false;
    if (legacyData && base === 'data') return false;
    return !hasArtifactSegment(path.relative(template.dir, src), opts);
  };
  const copyDir = async (from: string, to: string): Promise<void> => {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      if (!keepEntry(src)) continue;
      const dest = path.join(to, entry.name);
      if (entry.isDirectory()) await copyDir(src, dest);
      else if (entry.isFile()) {
        // force: false — a file already there (a custom brief's README) is kept.
        await copyFile(src, dest, fsConstants.COPYFILE_EXCL).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; });
      }
    }
  };
  await copyDir(template.dir, dir);
}

/** Substitute the title tokens in the files the manifest names. */
async function substituteIn(template: Template, dir: string, values: { title: string; slug: string; description: string }): Promise<void> {
  for (const rel of walk(dir)) {
    if (!matchesSubstitute(rel, template.substitute)) continue;
    const file = path.join(dir, rel);
    const text = await readFile(file, 'utf8');
    const next = substituteTokens(text, values);
    if (next !== text) await writeFile(file, next, 'utf8');
  }
}

/** The first commit's subject: what this app was made from, so history says where it started. */
export function scaffoldMessage(t: Pick<Template, 'name' | 'id' | 'version'>): string {
  return `chore: scaffold ${t.name} (aico template ${t.id}@${t.version})`;
}

/**
 * Make an app from a template.
 *
 * Claims the directory through the store (so the slug is unique and the
 * manifest carries the template's run and deploy blocks), copies every file
 * but `template.json`, `node_modules` and build output, then substitutes the
 * title tokens in the files the manifest names. Returns the app as the store
 * now describes it.
 *
 * A bundle (`kind: "bundle"`) is the same, plus each service made from a
 * template is copied into its own directory with its own env file, and the
 * service's run profile and stack are snapshotted into `app.json.services`.
 */
export async function instantiateTemplate(
  input: InstantiateInput,
  settings?: AicoSettings,
  cwd = process.cwd(),
): Promise<MiniApp> {
  const { template } = input;

  // Resolve a bundle's service templates before claiming a directory: a missing
  // one must refuse cleanly, not leave a half-made app behind.
  const services: AppService[] = [];
  const serviceTemplates = new Map<string, Template>();
  for (const svc of template.services ?? []) {
    const entry: AppService = { ...svc };
    const templateId = typeof (svc as { template?: unknown }).template === 'string' ? (svc as unknown as { template: string }).template : undefined;
    if (templateId) {
      const st = getTemplate(templateId, cwd);
      if (!st) throw new Error(`bundle "${template.id}" needs template "${templateId}" for service "${svc.id}", which is not installed`);
      if (st.kind === 'bundle') throw new Error(`service "${svc.id}" cannot itself be a bundle`);
      serviceTemplates.set(svc.id, st);
      entry.template = { id: st.id, version: st.version };
      if (st.run) entry.run = st.run;
      const stack = stackOf(st);
      if (stack) entry.stack = stack;
    }
    // Only a service made from a template gets a default directory; a bare db/cache has no code to put anywhere.
    if (templateId && !svc.path) entry.path = path.posix.join('services', svc.id);
    services.push(entry);
  }

  const stack = stackOf(template);
  const app = await createMiniApp({
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    kind: template.kind,
    category: template.category,
    template: { id: template.id, version: template.version },
    ...(template.run ? { run: template.run } : {}),
    ...(template.deploy ? { deploy: template.deploy } : {}),
    ...(stack ? { stack } : {}),
    ...(services.length ? { services } : {}),
    ...(template.compose ? { compose: template.compose } : {}),
    ...(template.preview ? { preview: template.preview } : {}),
  }, settings, cwd);
  const dir = miniAppDir(app.slug, settings, cwd);

  await copyTemplateFiles(template, dir);
  const values = { title: app.title, slug: app.slug, description: input.description ?? '' };
  await substituteIn(template, dir, values);
  await writeLocalEnv(dir, template.envFile);

  for (const svc of services) {
    const st = serviceTemplates.get(svc.id);
    if (!st || !svc.path) continue;
    const svcDir = path.join(dir, svc.path);
    await mkdir(svcDir, { recursive: true });
    await copyTemplateFiles(st, svcDir);
    await substituteIn(st, svcDir, values);
    await writeLocalEnv(svcDir, st.envFile);
  }
  if (template.kind === 'bundle' && template.compose?.generate) {
    const { writeGeneratedCompose } = await import('./bundle.js');
    await writeGeneratedCompose({ ...app, services }, dir);
  }
  // The manifest the store wrote is authoritative; the copy must not have
  // overwritten it (the template has no app.json, but a user's might).
  await mkdir(dir, { recursive: true });

  // Born knowing its commands, at template rank: above anything the manifest
  // would be guessed to say, below anything the person later decides.
  await profileFromTemplate(dir, template.run ? applyPlatform(template.run) : template.run, `${template.name} (${template.id})`).catch(() => undefined);
  // Last, so the first commit is the template exactly as it landed —
  // substituted, with a generated env file already gitignored.
  await initAppGit(dir, scaffoldMessage(template));
  const built = await getMiniApp(app.slug, settings, cwd);
  return { ...app, ...(services.length ? { services } : {}), built: built?.built ?? true };
}

export interface CustomAppInput {
  title: string;
  description?: string;
  sessionId?: string;
}

/**
 * Make a bare, stack-less app: the other door, beside a template.
 *
 * Nothing is copied and nothing is wired — the nine templates exist precisely
 * because that costs no model tokens when one fits, and this path is for when
 * none does, or the person wants the stack decided from the brief rather than
 * picked from a list. What a template's own files would establish (the run
 * profile, `AICO.md`, a fitted `.gitignore`) is left for Skill app-plan and
 * the agent to write once the stack is actually chosen — this only makes the
 * scaffold a decision has somewhere to land in: the app record, a decisions
 * file so compaction has somewhere to point from turn one, a stack-agnostic
 * `.gitignore` as a net until a real one replaces it, and a first commit.
 */
export async function createCustomApp(
  input: CustomAppInput,
  settings?: AicoSettings,
  cwd = process.cwd(),
): Promise<MiniApp> {
  const app = await createMiniApp({
    title: input.title,
    kind: 'process',
    ...(input.description ? { description: input.description } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  }, settings, cwd);
  const dir = miniAppDir(app.slug, settings, cwd);
  seedDecisions(dir, app.title);
  await writeFile(path.join(dir, '.gitignore'),
    // A net until the real, stack-fitted one replaces it: every ecosystem's installs, caches and build output
    // (not `bin/` or `vendor/`, which are source in some stacks) and every env file but the example.
    'node_modules/\n.venv/\nvenv/\n__pycache__/\n.pytest_cache/\n.mypy_cache/\n.ruff_cache/\ntarget/\nobj/\n.gradle/\ndist/\nbuild/\ncoverage/\n.env\n.env.*\n!.env.example\n*.log\n', 'utf8');
  await initAppGit(dir, 'Custom app scaffold — stack not yet chosen');
  return app;
}

/**
 * `.env.local` from `.env.example`, with every `change-me…` value replaced by
 * a random secret.
 *
 * A template documents its configuration in `.env.example` and reads it from
 * the environment, which is right for a repository and wrong for the first
 * five minutes of an app: the first sign-up threw "SESSION_SECRET is missing"
 * and an agent spent twenty steps on a form that was fine. The app should be
 * runnable the moment it is created; the example stays as the documentation.
 */
export async function writeLocalEnv(dir: string, spec?: EnvFileSpec): Promise<string | undefined> {
  // The generation itself (formats, gitignore safety, key names only) lives in env-file.ts.
  return (await writeAppEnv(dir, spec))?.file;
}

const execFileAsync = promisify(execFile);

/**
 * `git init` and a first commit, for an app that did not have either.
 *
 * Every app starts under version control the way a person starting a real
 * project would — not because aico needs it, but because the person inherits
 * it the moment they open the directory, and a project with no history is a
 * worse handoff than one with a boring first commit.
 *
 * Best effort, and quiet about failing: a machine with no `git` on PATH, or a
 * directory nested inside a repository that already claims it, must not stop
 * the app from being created. The identity is set locally, in this repo only
 * — never touching the person's own name or email — because these are commits
 * the agent made, and saying so honestly is more correct than borrowing
 * whoever's global git config happens to be sitting on the machine, which on
 * a fresh one is usually nothing and would otherwise fail the very first
 * commit with "Please tell me who you are".
 */
export async function initAppGit(dir: string, message: string): Promise<boolean> {
  if (existsSync(path.join(dir, '.git'))) return false;
  const git = (...args: string[]) => execFileAsync('git', args, { cwd: dir });
  try {
    await git('init', '--quiet', '-b', 'main');
    await git('config', 'user.name', 'AICO Agent');
    await git('config', 'user.email', 'agent@aico.local');
    await git('add', '-A');
    await git('commit', '--quiet', '-m', message);
    return true;
  } catch {
    return false;
  }
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
