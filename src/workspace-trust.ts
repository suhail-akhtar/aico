/**
 * Workspace trust: a project's settings may not run anything until a person
 * has said yes to exactly what they would run.
 *
 * A cloned repository's `.aico/settings.json` merged in silently. Its
 * `mcpServers` were spawned at startup, its `hooks` ran on every tool call,
 * and its `env` went into this process's environment (where `NODE_OPTIONS`
 * alone is code execution in every child Node process). Opening a stranger's
 * repo in AICO was running a stranger's commands. `mcpSecurity`, the setting
 * that looked like it guarded this, was printed by `/mcp-security` and read by
 * nothing — and a project file could set it too.
 *
 * Now the sections of a project's settings that make AICO execute something
 * ({@link TRUST_GATED_SECTIONS}, from both `.aico/settings.json` and
 * `.aico/settings.local.json`) are left out of the merged settings until the
 * person approves them, once per project and again whenever they change: the
 * approval is bound to a hash of exactly those sections. Everything else in
 * the file (a model, compaction thresholds, …) applies as before. One
 * chokepoint — `loadSettings` — so there is no path that loads the config
 * and forgets to check.
 *
 * Where approvals live: `aicoHome()/workspace-trust.json`, the user's store
 * (not `trust.json`: the terminal's old per-tool answers were written there
 * when it ran in the home directory, so that name is taken). Never in
 * the project, which is the one place a cloned repo could pre-approve itself.
 *
 * Who is asked: the terminal asks at startup; the web portal and the desktop
 * ask through the turn's ordinary permission card (so the "a yes never comes
 * from the API token alone" rule of `server/decision-gate.ts` holds). Headless
 * and unattended runs never ask — they skip the entries and say so once.
 *
 * Not covered, deliberately: project skills and agents (instructions, the same
 * tier as AICO.md — design §4.4), and settings that redirect credentials rather
 * than run code (provider base URLs) — recorded as a follow-up in the design.
 *
 * @module workspace-trust
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { aicoHome } from './home.js';

/** Settings sections that make AICO execute something, and so need trust from a project file. */
export const TRUST_GATED_SECTIONS = ['mcpServers', 'hooks', 'env'] as const;

export type TrustState = 'none' | 'trusted' | 'untrusted';

export interface ProjectTrustStatus {
  /** `none`: the project's files define nothing that executes. */
  state: TrustState;
  /** The project directory the files were read from. */
  root: string;
  /** Hash of the gated sections an approval is bound to; empty when `none`. */
  hash: string;
  /** What would run, one line each, exact commands included — what the person approves. */
  summary: string;
  /** Short names of what is gated, for a one-line notice. */
  names: string[];
}

type Layer = Record<string, unknown>;

/** The gated sections of one settings layer, or nothing. */
function gatedOf(layer: Layer): Layer {
  const out: Layer = {};
  for (const section of TRUST_GATED_SECTIONS) {
    const value = layer[section];
    if (value && typeof value === 'object' && Object.keys(value as object).length > 0) out[section] = value;
  }
  return out;
}

/** JSON with sorted keys, so the hash does not depend on key order. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map(k => `${JSON.stringify(k)}:${stable((value as Layer)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Quote an argument that has whitespace in it, without escaping anything else. */
function shown(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

/** One line per thing that would run. Env and header *values* are never shown (they may be secrets). */
function describe(gated: Layer[]): { summary: string; names: string[] } {
  const lines: string[] = [];
  const names: string[] = [];
  for (const layer of gated) {
    const servers = (layer.mcpServers ?? {}) as Record<string, { type?: string; command?: string; args?: unknown[]; url?: string; env?: object; headers?: object }>;
    for (const [name, cfg] of Object.entries(servers)) {
      names.push(`MCP server "${name}"`);
      const how = cfg?.command
        ? [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args.map(String) : [])].map(shown).join(' ')
        : `${cfg?.type ?? 'http'} ${cfg?.url ?? '(no url)'}`;
      const keys = [...Object.keys(cfg?.env ?? {}), ...Object.keys(cfg?.headers ?? {})];
      lines.push(`MCP server "${name}": ${how}${keys.length ? ` (with ${keys.join(', ')} set)` : ''}`);
    }
    const hooks = (layer.hooks ?? {}) as Record<string, unknown>;
    for (const [event, commands] of Object.entries(hooks)) {
      for (const command of Array.isArray(commands) ? commands : []) {
        names.push(`${event} hook`);
        lines.push(`${event} hook: ${String(command)}`);
      }
    }
    const env = Object.keys((layer.env ?? {}) as object);
    if (env.length) {
      names.push('environment variables');
      lines.push(`environment variables for this process and everything it starts: ${env.join(', ')}`);
    }
  }
  return { summary: lines.join('\n'), names: [...new Set(names)] };
}

function storePath(): string {
  return path.join(aicoHome(), 'workspace-trust.json');
}

/** A store key for a project directory, case-folded where the filesystem is. */
function projectKey(dir: string): string {
  const resolved = path.resolve(dir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

interface TrustStore {
  version: 1;
  projects: Record<string, { path: string; hash: string; approvedAt: string }>;
}

function readStore(): TrustStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as Partial<TrustStore>;
    if (parsed && typeof parsed.projects === 'object' && parsed.projects) return { version: 1, projects: parsed.projects };
  } catch { /* no store yet, or unreadable: nothing is trusted, which is the safe reading */ }
  return { version: 1, projects: {} };
}

/** Whether this exact config of this project was approved. */
function isApproved(root: string, hash: string): boolean {
  return readStore().projects[projectKey(root)]?.hash === hash;
}

/**
 * Judge a project's two settings layers. Pure apart from reading the store,
 * so `loadSettings` can call it on the layers it has already read.
 */
export function evaluateProjectLayers(root: string, project: Layer, local: Layer): ProjectTrustStatus {
  const layers = [gatedOf(project), gatedOf(local)];
  if (layers.every(l => Object.keys(l).length === 0)) {
    return { state: 'none', root: path.resolve(root), hash: '', summary: '', names: [] };
  }
  const hash = `sha256:${crypto.createHash('sha256').update(stable(layers)).digest('hex')}`;
  const { summary, names } = describe(layers);
  return { state: isApproved(root, hash) ? 'trusted' : 'untrusted', root: path.resolve(root), hash, summary, names };
}

function readLayer(file: string): Layer {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Layer : {};
  } catch {
    return {};
  }
}

/** The trust state of the project in `root` (default: where settings are loaded from). */
export async function projectTrustStatus(root: string = process.cwd()): Promise<ProjectTrustStatus> {
  return evaluateProjectLayers(
    root,
    readLayer(path.join(root, '.aico', 'settings.json')),
    readLayer(path.join(root, '.aico', 'settings.local.json')),
  );
}

/** Remove the gated sections from a settings layer, in place. */
export function stripGated(layer: Layer): void {
  for (const section of TRUST_GATED_SECTIONS) delete layer[section];
}

/**
 * Record a person's approval of this exact config. Callers must have asked a
 * person: this is the write that lets a project's commands run.
 */
export async function approveProjectTrust(root: string, hash: string): Promise<void> {
  const store = readStore();
  store.projects[projectKey(root)] = { path: path.resolve(root), hash, approvedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  // Written whole and renamed into place, so a crash cannot leave half a store
  // (which would read as "nothing trusted" — safe, but a surprise).
  const tmp = `${storePath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, storePath());
}

/** The title of the approval a person is shown. */
export const TRUST_PROMPT_TITLE = 'TrustProjectSettings';

/** The body of the approval: where, what exactly would run, and what a yes means. */
export function trustPromptDetail(status: ProjectTrustStatus): string {
  return [
    `${path.join(status.root, '.aico')} settings want to run:`,
    status.summary,
    'Allow trusts this exact configuration for this project; any change to it asks again. '
      + 'Deny keeps it switched off (everything else still works).',
  ].join('\n');
}

/** What an unattended run says instead of asking. */
export function untrustedNotice(status: ProjectTrustStatus): string {
  return `${path.join(status.root, '.aico')} settings define ${status.names.join(', ')}, which are not loaded: `
    + 'this project\'s configuration is not trusted yet. To review and approve it once, start `aico` in that folder, '
    + 'or chat in AICO started there (a "no" there is remembered until AICO restarts).';
}

/**
 * Ask a person to trust a project's config, if it needs it.
 *
 * `ask` is whichever approval the client has: a terminal y/N, or the run's
 * permission card. It must resolve false rather than throw or hang when nobody
 * is there. Returns what the project's config is now.
 */
export async function ensureProjectTrust(opts: {
  cwd: string;
  ask: (title: string, detail: string) => Promise<boolean>;
}): Promise<'none' | 'trusted' | 'declined'> {
  const status = await projectTrustStatus(opts.cwd);
  if (status.state === 'none') return 'none';
  if (status.state === 'trusted') return 'trusted';
  let yes = false;
  try { yes = await opts.ask(TRUST_PROMPT_TITLE, trustPromptDetail(status)); } catch { yes = false; }
  if (!yes) return 'declined';
  await approveProjectTrust(status.root, status.hash);
  return 'trusted';
}

/**
 * Keep trust across a write AICO makes to the project's own settings file on
 * the person's behalf (`McpManage add`, `/config set`): if the config was
 * trusted — or ran nothing — before the write, the new content is trusted too.
 * A config that was untrusted stays untrusted: AICO's own edit does not vouch
 * for what the repository shipped.
 */
export async function carryTrustAcrossOwnWrite(root: string, before: ProjectTrustStatus): Promise<void> {
  if (before.state === 'untrusted') return;
  const after = await projectTrustStatus(root);
  if (after.state === 'untrusted') await approveProjectTrust(after.root, after.hash);
}
