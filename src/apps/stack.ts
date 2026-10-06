/**
 * What an app's stack is, as data: the types the manifest and `app.json` share
 * for everything beyond Node, and the validator that makes a typo loud.
 *
 * Why this exists: before ADR 0031 the only stack metadata was `requires.node`
 * and the Node conventions baked into the runner. Now a template says which
 * toolchain it needs (`toolchain`), which file means "scaffolded"
 * (`manifestFile`), where its secrets go (`envFile`), which container to fall
 * back to (`docker`), and — for bundles — which services run together
 * (`services`). A template that fails validation is still dropped by the
 * loader (an unknown shape must not half-run), but `scripts/validate-template.mjs`
 * prints these messages, so a typo no longer makes a template vanish silently.
 *
 * What it deliberately does not do: touch the filesystem beyond the one
 * `manifestPresent` helper, or know any framework. Everything stack-specific is
 * a string in a manifest.
 *
 * @module apps/stack
 */

import { existsSync, readdirSync } from 'fs';
import path from 'path';
import type { RunProfile } from '../miniapps/store.js';
import { TOOLCHAIN_IDS, validateProbe, type ToolchainSpec } from './toolchain.js';

export type ServiceRole = 'frontend' | 'api' | 'worker' | 'db' | 'cache' | 'auth' | 'mail' | 'proxy' | 'storage';
export const SERVICE_ROLES: readonly ServiceRole[] = ['frontend', 'api', 'worker', 'db', 'cache', 'auth', 'mail', 'proxy', 'storage'];

/** Where secrets go and how each is generated. See `env-file.ts` for the formats. */
export interface EnvFileSpec {
  /** `.env` or `.env.local` — whichever the framework actually reads. */
  file: string;
  /** The documented example; default `.env.example`. */
  example?: string;
  generate?: Record<string, string>;
}

export interface DockerSpec {
  /** A pinned development image carrying the toolchain. */
  image?: string;
  /** The port the dev server binds inside the container. */
  containerPort?: number;
  /** A dev command that binds 0.0.0.0 (a container publishes only a non-loopback bind). */
  dev?: string;
  /** Runs once before checks or dev inside the container (`sh -c`). */
  setup?: string;
  /** Container paths kept in named volumes so dependency caches survive. */
  cache?: string[];
  context?: string;
  dockerfile?: string;
  composeFile?: string;
}

/** The stack facts an app carries in `app.json` (and a template in `template.json`). */
export interface AppStack {
  toolchain?: ToolchainSpec;
  /** A file whose presence means "scaffolded". A `*` glob is allowed in the file name. */
  manifestFile?: string | string[];
  envFile?: EnvFileSpec;
  docker?: DockerSpec;
  artifactDirs?: string[];
  keepDirs?: string[];
}

export interface ComposeServiceHints {
  volumes?: string[];
  env?: Record<string, string>;
  command?: string;
}

/** One member of a bundle. */
export interface AppService {
  id: string;
  role: ServiceRole;
  /** Where its code lives in the app (default `services/<id>`). */
  path?: string;
  /** A container-only service: no code, an image. */
  image?: string;
  /** Preferred (container or compose) port. */
  port?: number;
  healthPath?: string;
  dependsOn?: string[];
  /** Wiring, with `{service.<id>.url|host|port}` and `{port}`. */
  env?: Record<string, string>;
  /** The shipped template this service was made from. */
  template?: { id: string; version: string };
  /** Its own run profile and stack, snapshotted from its template. */
  run?: RunProfile;
  stack?: AppStack;
  compose?: ComposeServiceHints;
}

export interface AppCompose {
  file: string;
  generate?: boolean;
}

/** Manifest files that mean "a project is here", for custom apps with no declared stack. */
export const KNOWN_MANIFEST_FILES: readonly string[] = [
  'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'pom.xml',
  'build.gradle', 'build.gradle.kts', '*.csproj', '*.sln', 'go.mod', 'composer.json', 'Cargo.toml',
];

/** Whether one manifest entry (a file name, or a glob in the file name) exists directly under `dir`. */
function entryPresent(dir: string, entry: string): boolean {
  if (!entry.includes('*')) return existsSync(path.join(dir, entry));
  const re = new RegExp(`^${entry.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  try { return readdirSync(dir).some(name => re.test(name)); } catch { return false; }
}

/** Whether any of the manifest files exists in `dir`. */
export function manifestPresent(dir: string, manifestFile: string | string[] | undefined): boolean {
  const entries = manifestFile === undefined ? [] : Array.isArray(manifestFile) ? manifestFile : [manifestFile];
  return entries.some(e => entryPresent(dir, e));
}

const SAFE_PATH = /^[A-Za-z0-9._*][A-Za-z0-9._*/-]*$/;
const NAME = /^[A-Za-z0-9._-]+$/;
const IMAGE = /^[a-z0-9][a-z0-9._/:@-]*$/i;

/** `hex[:n]`, `base64[:n]`, `laravel-app-key`… — kept in step with env-file.ts's generators. */
const ENV_FORMAT = /^(hex|base64|base64url)(:\d{1,3})?$|^(uuid|laravel-app-key|jwt-secret|aspnet-dp-key-path)$|^password(:\d{1,3})?$|^path:[A-Za-z0-9._/-]+$/;

function isStringMap(v: unknown): v is Record<string, string> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every(x => typeof x === 'string');
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string');
}

function safeRel(p: unknown): boolean {
  return typeof p === 'string' && p.length > 0 && !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..') && SAFE_PATH.test(p);
}

/** Problems with the `run` fields added for other stacks. */
export function validateRunExtensions(run: unknown, where = 'run'): string[] {
  const problems: string[] = [];
  if (run === undefined) return problems;
  if (!run || typeof run !== 'object') return [`${where} must be an object`];
  const r = run as Record<string, unknown>;
  for (const key of ['install', 'dev', 'ready', 'build', 'test', 'typecheck', 'lint', 'start', 'format', 'audit', 'health', 'installedMarker', 'portEnv']) {
    if (r[key] !== undefined && typeof r[key] !== 'string') problems.push(`${where}.${key} must be a string`);
  }
  if (typeof r.installedMarker === 'string' && !safeRel(r.installedMarker)) problems.push(`${where}.installedMarker must be a relative path inside the app`);
  if (typeof r.portEnv === 'string' && r.portEnv !== '' && !/^[A-Z_][A-Z0-9_]*$/.test(r.portEnv)) problems.push(`${where}.portEnv must be an environment variable name or ""`);
  if (typeof r.health === 'string' && !r.health.startsWith('/')) problems.push(`${where}.health must be an HTTP path starting with /`);
  if (r.env !== undefined && !isStringMap(r.env)) problems.push(`${where}.env must map names to strings`);
  if (r.env && typeof r.env === 'object') {
    for (const key of Object.keys(r.env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) problems.push(`${where}.env key "${key}" is not a valid variable name`);
  }
  if (r.win32 !== undefined) {
    if (!r.win32 || typeof r.win32 !== 'object' || !isStringMap(r.win32)) problems.push(`${where}.win32 must map run fields to strings`);
  }
  // A shell chain in a command is the single most common authoring mistake for a stack with no npm scripts.
  for (const key of ['install', 'dev', 'build', 'test', 'typecheck', 'lint', 'format', 'audit', 'start']) {
    const v = r[key];
    if (typeof v === 'string' && /&&|\|\||\s\|\s|;\s/.test(v)) {
      problems.push(`${where}.${key} chains commands; a run command is one executable and its arguments (wrap the chain in a script)`);
    }
  }
  return problems;
}

/** Problems with the stack keys of a manifest (`toolchain`, `manifestFile`, `envFile`, …). */
export function validateStack(m: Record<string, unknown>, where = ''): string[] {
  const p = (s: string) => `${where}${s}`;
  const problems: string[] = [];
  const tc = m.toolchain as Record<string, unknown> | undefined;
  if (tc !== undefined) {
    if (!tc || typeof tc !== 'object') problems.push(p('toolchain must be an object'));
    else {
      if (!TOOLCHAIN_IDS.includes(tc.id as never)) problems.push(p(`toolchain.id must be one of ${TOOLCHAIN_IDS.join(', ')}`));
      if (tc.version !== undefined && (typeof tc.version !== 'string' || !/^\s*((>=|<=|>|<|=)?\s*v?\d+(\.\d+){0,2}\s*)+$/.test(tc.version))) {
        problems.push(p('toolchain.version must be comparators like ">=3.12 <4"'));
      }
      if (tc.probe !== undefined) problems.push(...validateProbe(tc.probe, p('toolchain.probe')));
      if (tc.installHint !== undefined && typeof tc.installHint !== 'string') problems.push(p('toolchain.installHint must be a string'));
      if (tc.tools !== undefined) {
        if (!Array.isArray(tc.tools)) problems.push(p('toolchain.tools must be an array'));
        else for (const [i, t] of (tc.tools as unknown[]).entries()) {
          const tool = t as Record<string, unknown>;
          if (!tool || typeof tool.id !== 'string' || !NAME.test(tool.id)) problems.push(p(`toolchain.tools[${i}].id must be an executable name`));
          if (tool?.version !== undefined && typeof tool.version !== 'string') problems.push(p(`toolchain.tools[${i}].version must be a string`));
          if (tool?.probe !== undefined) problems.push(...validateProbe(tool.probe, p(`toolchain.tools[${i}].probe`)));
        }
      }
    }
  }
  if (m.manifestFile !== undefined) {
    const entries = Array.isArray(m.manifestFile) ? m.manifestFile : [m.manifestFile];
    if (entries.length === 0 || !entries.every(e => typeof e === 'string' && NAME.test(e.replace(/\*/g, 'x')))) {
      problems.push(p('manifestFile must be a file name (or list of names) in the app root; * is allowed in the name'));
    }
  }
  const env = m.envFile as Record<string, unknown> | undefined;
  if (env !== undefined) {
    if (!env || typeof env !== 'object') problems.push(p('envFile must be an object'));
    else {
      if (typeof env.file !== 'string' || !/^\.env(\.[a-z]+)?$/.test(env.file) || env.file === '.env.example') {
        problems.push(p('envFile.file must be .env or .env.local (never the example)'));
      }
      if (env.example !== undefined && (typeof env.example !== 'string' || !safeRel(env.example))) problems.push(p('envFile.example must be a relative file name'));
      if (env.generate !== undefined) {
        if (!isStringMap(env.generate)) problems.push(p('envFile.generate must map KEY to a format'));
        else for (const [k, f] of Object.entries(env.generate)) {
          if (!/^[A-Z][A-Z0-9_]*$/.test(k)) problems.push(p(`envFile.generate key "${k}" must be UPPER_SNAKE_CASE`));
          if (!ENV_FORMAT.test(f)) problems.push(p(`envFile.generate.${k} has unknown format "${f}"`));
        }
      }
    }
  }
  for (const key of ['artifactDirs', 'keepDirs']) {
    const v = m[key];
    if (v !== undefined && !(isStringArray(v) && v.every(x => NAME.test(x)))) problems.push(p(`${key} must be an array of directory names`));
  }
  const d = m.docker as Record<string, unknown> | undefined;
  if (d !== undefined) {
    if (!d || typeof d !== 'object') problems.push(p('docker must be an object'));
    else {
      if (d.image !== undefined && (typeof d.image !== 'string' || !IMAGE.test(d.image))) problems.push(p('docker.image must be an image reference'));
      if (d.containerPort !== undefined && !(Number.isInteger(d.containerPort) && (d.containerPort as number) > 0 && (d.containerPort as number) < 65536)) problems.push(p('docker.containerPort must be a port number'));
      for (const key of ['dev', 'setup', 'context', 'dockerfile', 'composeFile']) {
        if (d[key] !== undefined && typeof d[key] !== 'string') problems.push(p(`docker.${key} must be a string`));
      }
      if (d.cache !== undefined && !(isStringArray(d.cache) && d.cache.every(x => /^\/[A-Za-z0-9_./-]+$/.test(x)))) problems.push(p('docker.cache must be absolute container paths'));
    }
  }
  const v = m.verify as Record<string, unknown> | undefined;
  if (v !== undefined) {
    if (!v || typeof v !== 'object') problems.push(p('verify must be an object'));
    else {
      if (v.env !== undefined && !isStringMap(v.env)) problems.push(p('verify.env must map names to strings'));
      if (v.skip !== undefined && !isStringArray(v.skip)) problems.push(p('verify.skip must be an array of strings'));
    }
  }
  return problems;
}

/** Problems with a bundle's `services`, `preview` and `compose`. */
export function validateBundle(m: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const services = m.services;
  if (!Array.isArray(services) || services.length < 2) return ['a bundle needs services (at least two)'];
  const ids = new Set<string>();
  for (const [i, raw] of (services as unknown[]).entries()) {
    const s = raw as Record<string, unknown>;
    const at = `services[${i}]`;
    if (!s || typeof s !== 'object') { problems.push(`${at} must be an object`); continue; }
    if (typeof s.id !== 'string' || !/^[a-z][a-z0-9-]{0,30}$/.test(s.id)) problems.push(`${at}.id must be lowercase letters, digits and hyphens`);
    else if (ids.has(s.id)) problems.push(`${at}.id "${s.id}" is used twice`);
    else ids.add(s.id);
    if (!SERVICE_ROLES.includes(s.role as ServiceRole)) problems.push(`${at}.role must be one of ${SERVICE_ROLES.join(', ')}`);
    const sources = ['template', 'path', 'image'].filter(k => s[k] !== undefined);
    if (s.template !== undefined && typeof s.template !== 'string') problems.push(`${at}.template must be a template id`);
    if (s.image !== undefined && (typeof s.image !== 'string' || !IMAGE.test(s.image))) problems.push(`${at}.image must be an image reference`);
    if (s.path !== undefined && !safeRel(s.path)) problems.push(`${at}.path must be a relative directory inside the app`);
    // A container-only role (a database, a cache) may omit every source and take the pinned default image.
    const bare = ['db', 'cache', 'auth', 'mail', 'proxy', 'storage'].includes(String(s.role));
    if (sources.length === 0 ? !bare : (sources.includes('image') && sources.length > 1)) {
      problems.push(`${at} needs a template or a path (or, for db/cache/auth/mail/proxy/storage, an image or nothing); an image cannot be combined with code`);
    }
    const hints = s.compose as Record<string, unknown> | undefined;
    if (hints !== undefined) {
      if (!hints || typeof hints !== 'object') problems.push(`${at}.compose must be an object`);
      else {
        if (hints.volumes !== undefined && !(isStringArray(hints.volumes) && hints.volumes.every(v => /^[a-z0-9][a-z0-9_.-]*:\/[A-Za-z0-9_./-]+$/.test(v)))) {
          problems.push(`${at}.compose.volumes must be named volumes like "pgdata:/var/lib/postgresql/data" (no bind mounts)`);
        }
        if (hints.env !== undefined && !isStringMap(hints.env)) problems.push(`${at}.compose.env must map names to strings`);
        if (hints.command !== undefined && typeof hints.command !== 'string') problems.push(`${at}.compose.command must be a string`);
      }
    }
    if (s.port !== undefined && !(Number.isInteger(s.port) && (s.port as number) > 0 && (s.port as number) < 65536)) problems.push(`${at}.port must be a port number`);
    if (s.healthPath !== undefined && (typeof s.healthPath !== 'string' || !s.healthPath.startsWith('/'))) problems.push(`${at}.healthPath must start with /`);
    if (s.dependsOn !== undefined && !isStringArray(s.dependsOn)) problems.push(`${at}.dependsOn must be an array of service ids`);
    if (s.env !== undefined && !isStringMap(s.env)) problems.push(`${at}.env must map names to strings`);
  }
  // Dependencies must exist and must not loop.
  const byId = new Map((services as Array<Record<string, unknown>>).filter(s => typeof s?.id === 'string').map(s => [s.id as string, s]));
  for (const [id, s] of byId) {
    for (const dep of (s.dependsOn as string[] | undefined) ?? []) {
      if (!byId.has(dep)) problems.push(`service "${id}" depends on unknown service "${dep}"`);
    }
  }
  if (problems.length === 0 && dependencyOrder([...byId.values()] as Array<{ id: string; dependsOn?: string[] }>) === null) {
    problems.push('services depend on each other in a loop');
  }
  if (m.preview !== undefined && (typeof m.preview !== 'string' || !byId.has(m.preview))) problems.push('preview must name one of the services');
  if (m.compose !== undefined) {
    const c = m.compose as Record<string, unknown>;
    if (!c || typeof c !== 'object' || typeof c.file !== 'string' || !safeRel(c.file)) problems.push('compose.file must be a relative file name');
  }
  return problems;
}

/**
 * Services in start order (dependencies first), or null when they loop.
 * Ties keep declaration order so the result is deterministic.
 */
export function dependencyOrder<T extends { id: string; dependsOn?: string[] }>(services: T[]): T[] | null {
  const done = new Set<string>();
  const out: T[] = [];
  const pending = [...services];
  while (pending.length) {
    const ready = pending.findIndex(s => (s.dependsOn ?? []).every(d => done.has(d) || !services.some(x => x.id === d)));
    if (ready < 0) return null;
    const [next] = pending.splice(ready, 1);
    done.add(next!.id);
    out.push(next!);
  }
  return out;
}
