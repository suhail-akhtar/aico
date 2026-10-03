/**
 * What "About you" reads (ADR 0018) — reduced to aggregates before anything
 * else sees it.
 *
 * Three sources, each switchable:
 *   - **work** — the session logs under `aicoHome()/projects/*` from the last
 *     30 days: which languages the files the agent touched are in, which
 *     frameworks the projects' manifests name, which developer CLIs ran
 *     (an allow-list of tool names — never the command line), which models
 *     were chosen, when the person sends requests and how long they are;
 *   - **preferences** — ADR 0016 rules the person accepted (already
 *     redacted and reviewed);
 *   - **browsing** — the desktop's digest, `desktop/browser/profile-digest.json`
 *     (desktop/electron/browser-profile-digest.ts), re-validated here because
 *     the engine trusts no file it did not write. A paused or switched-off
 *     digest, or one older than two weeks, is not read.
 *
 * WHAT IS NEVER KEPT: message text, file contents, file or project paths,
 * command lines, URLs, whole searches. A project is counted, never named.
 * Free strings that do pass through (search words, thread words, domains)
 * are scrubbed (learning/signals `scrub`: vault values, secret shapes, home
 * paths, emails) and dropped if they touch a sensitive area.
 *
 * @module profile/sources
 */

import fs from 'fs';
import path from 'path';
import { aicoHome } from '../home.js';
import { scrub } from '../learning/signals.js';
import { sensitiveArea, sensitiveDomain } from './sensitive.js';

export const WORK_WINDOW_DAYS = 30;
const MAX_LOGS = 400;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const DIGEST_MAX_AGE_MS = 14 * 86_400_000;

export interface Counted { count: number; sessions: number; lastSeen: number }

export interface WorkAggregates {
  sessions: number;
  projects: number;
  humanMessages: number;
  languages: Record<string, Counted>;
  frameworks: Record<string, Counted>;
  projectKinds: Record<string, Counted>;
  commands: Record<string, Counted>;
  tools: Record<string, Counted>;
  models: Record<string, Counted>;
  /** Human requests by local hour and weekday (0 = Sunday). */
  hours: number[];
  weekdays: number[];
  medianWords: number;
  lastSeen: number;
}

export interface PreferenceSummary { id: string; text: string; category: string; evidence: number; at: number }

export interface BrowserDigest {
  at: number;
  domains: Array<{ domain: string; category: string; minutes: number; visits: number; days: number }>;
  categories: Array<{ category: string; minutes: number; visits: number }>;
  threads: Array<{ terms: string[]; pages: number; sites: number; last: number }>;
  searchTerms: Array<{ term: string; count: number }>;
  routines: { hours: number[]; weekdays: number[] };
  reading: { pages: number; medianSeconds: number; skim: number; partial: number; read: number; style: string };
  kinds: Record<string, number>;
}

export type DigestStatus = 'ok' | 'missing' | 'paused' | 'off' | 'stale' | 'invalid' | 'disabled';

export interface ProfileSources {
  work?: WorkAggregates;
  preferences: PreferenceSummary[];
  browsing?: BrowserDigest;
  status: { work: 'ok' | 'disabled'; browsing: DigestStatus; digestAt?: number };
}

// ── Work ────────────────────────────────────────────────────────────────────

const LANG_BY_EXT: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', cs: 'C#', rb: 'Ruby', php: 'PHP', swift: 'Swift', dart: 'Dart',
  cpp: 'C++', cc: 'C++', hpp: 'C++', c: 'C', h: 'C', css: 'CSS', scss: 'CSS', html: 'HTML', vue: 'Vue', svelte: 'Svelte',
  sql: 'SQL', sh: 'Shell', bash: 'Shell', ps1: 'PowerShell', lua: 'Lua', ex: 'Elixir', exs: 'Elixir', scala: 'Scala', r: 'R', ipynb: 'Python',
};

/** Developer CLIs worth knowing about. Anything else in a command line is ignored, never kept. */
const CLIS = new Set([
  'git', 'gh', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'node', 'deno', 'tsc', 'vite', 'vitest', 'jest', 'playwright', 'eslint', 'prettier',
  'python', 'python3', 'pip', 'pip3', 'uv', 'poetry', 'pytest', 'ruff', 'mypy', 'django-admin', 'go', 'cargo', 'rustc', 'dotnet', 'mvn',
  'gradle', 'java', 'docker', 'docker-compose', 'kubectl', 'helm', 'terraform', 'make', 'cmake', 'psql', 'sqlite3', 'redis-cli',
  'aws', 'az', 'gcloud', 'firebase', 'vercel', 'netlify', 'flutter', 'swift', 'xcodebuild', 'composer', 'php', 'bundle', 'rails', 'ruby',
]);
const CLI_ALIAS: Record<string, string> = { python3: 'python', pip3: 'pip', 'docker-compose': 'docker' };

/** Framework markers in manifests → (framework, project kind). Names only; versions are ignored. */
const JS_FRAMEWORKS: Record<string, [string, string]> = {
  react: ['React', 'web apps'], next: ['Next.js', 'web apps'], vue: ['Vue', 'web apps'], svelte: ['Svelte', 'web apps'], '@angular/core': ['Angular', 'web apps'],
  'solid-js': ['Solid', 'web apps'], astro: ['Astro', 'websites'], vite: ['Vite', 'web apps'], express: ['Express', 'APIs and backends'],
  fastify: ['Fastify', 'APIs and backends'], '@nestjs/core': ['NestJS', 'APIs and backends'], hono: ['Hono', 'APIs and backends'],
  electron: ['Electron', 'desktop apps'], 'react-native': ['React Native', 'mobile apps'], expo: ['Expo', 'mobile apps'],
  tailwindcss: ['Tailwind CSS', 'web apps'], prisma: ['Prisma', 'APIs and backends'], 'drizzle-orm': ['Drizzle', 'APIs and backends'],
  '@modelcontextprotocol/sdk': ['MCP', 'AI tools'], openai: ['OpenAI SDK', 'AI tools'], '@anthropic-ai/sdk': ['Anthropic SDK', 'AI tools'],
  langchain: ['LangChain', 'AI tools'], commander: ['Commander', 'command-line tools'], yargs: ['yargs', 'command-line tools'],
};
const TEXT_FRAMEWORKS: Array<[string, RegExp, string, string]> = [
  ['pyproject.toml|requirements.txt', /\bdjango\b/i, 'Django', 'web apps'],
  ['pyproject.toml|requirements.txt', /\bflask\b/i, 'Flask', 'APIs and backends'],
  ['pyproject.toml|requirements.txt', /\bfastapi\b/i, 'FastAPI', 'APIs and backends'],
  ['pyproject.toml|requirements.txt', /\b(pandas|numpy|polars|scikit-learn|jupyter)\b/i, 'data tooling', 'data and ML'],
  ['pyproject.toml|requirements.txt', /\b(torch|tensorflow|transformers|jax)\b/i, 'ML frameworks', 'data and ML'],
  ['pyproject.toml|requirements.txt', /\b(click|typer)\b/i, 'Click/Typer', 'command-line tools'],
  ['Cargo.toml', /\b(tokio)\b/, 'Tokio', 'systems and backends'],
  ['Cargo.toml', /\b(axum|actix-web|rocket)\b/, 'a Rust web framework', 'APIs and backends'],
  ['Cargo.toml', /\b(clap)\b/, 'clap', 'command-line tools'],
  ['go.mod', /\b(gin-gonic|labstack\/echo|gofiber)\b/, 'a Go web framework', 'APIs and backends'],
  ['go.mod', /\b(spf13\/cobra)\b/, 'Cobra', 'command-line tools'],
  ['Gemfile', /\brails\b/, 'Rails', 'web apps'],
  ['composer.json', /laravel\//, 'Laravel', 'web apps'],
  ['pom.xml|build.gradle|build.gradle.kts', /spring-boot/, 'Spring Boot', 'APIs and backends'],
  ['pubspec.yaml', /\bflutter\b/, 'Flutter', 'mobile apps'],
];

function bump(map: Record<string, Counted>, key: string, session: string, at: number, seen: Map<string, Set<string>>, n = 1): void {
  const c = map[key] ?? { count: 0, sessions: 0, lastSeen: 0 };
  c.count += n;
  c.lastSeen = Math.max(c.lastSeen, at);
  const s = seen.get(key) ?? new Set<string>();
  if (!s.has(session)) { s.add(session); c.sessions++; }
  seen.set(key, s);
  map[key] = c;
}

function extOf(p: string): string { return path.extname(p).slice(1).toLowerCase(); }

/** Paths a tool call's arguments name, from the keys tools use for them. */
function pathsIn(args: unknown): string[] {
  if (!args || typeof args !== 'object') return [];
  const a = args as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ['file_path', 'path', 'filePath', 'file', 'notebook_path']) if (typeof a[k] === 'string') out.push(a[k] as string);
  for (const k of ['paths', 'files']) if (Array.isArray(a[k])) for (const x of a[k] as unknown[]) if (typeof x === 'string') out.push(x);
  if (Array.isArray(a.edits)) for (const e of a.edits as unknown[]) if (e && typeof e === 'object' && typeof (e as { file_path?: unknown }).file_path === 'string') out.push((e as { file_path: string }).file_path);
  return out.slice(0, 20);
}

/** The developer CLIs a command line runs, by name only. */
export function clisIn(command: string): string[] {
  const out = new Set<string>();
  for (const seg of command.split(/&&|\|\||[;|\n]/)) {
    const words = seg.trim().replace(/^(?:sudo|time|env\s+\S+=\S+)\s+/, '').split(/\s+/);
    const first = (words[0] ?? '').replace(/^.*[\\/]/, '').replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
    if (CLIS.has(first)) out.add(CLI_ALIAS[first] ?? first);
  }
  return [...out];
}

function projectFrameworks(cwd: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as Record<string, unknown>;
    const deps = { ...(pkg.dependencies as object | undefined), ...(pkg.devDependencies as object | undefined) };
    for (const name of Object.keys(deps)) { const hit = JS_FRAMEWORKS[name]; if (hit) out.push(hit); }
    if (pkg.bin) out.push(['a Node CLI', 'command-line tools']);
  } catch { /* no package.json: other manifests may say */ }
  for (const [files, re, fw, kind] of TEXT_FRAMEWORKS) {
    for (const f of files.split('|')) {
      try {
        const text = fs.readFileSync(path.join(cwd, f), 'utf8').slice(0, 200_000);
        if (re.test(text)) { out.push([fw, kind]); break; }
      } catch { /* absent */ }
    }
  }
  return out;
}

/** The session logs modified in the window, newest first. */
function recentLogs(now: number, days: number): Array<{ file: string; mtime: number }> {
  const root = path.join(aicoHome(), 'projects');
  const out: Array<{ file: string; mtime: number }> = [];
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    const sdir = path.join(root, d, 'sessions');
    let files: string[] = [];
    try { files = fs.readdirSync(sdir).filter(f => f.endsWith('.events.jsonl')); } catch { continue; }
    for (const f of files) {
      try {
        const st = fs.statSync(path.join(sdir, f));
        if (st.mtimeMs >= now - days * 86_400_000 && st.size <= MAX_LOG_BYTES) out.push({ file: path.join(sdir, f), mtime: st.mtimeMs });
      } catch { /* vanished */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_LOGS);
}

/** Aggregate the person's recent work from the session logs. Reads; writes nothing. */
export function collectWork(now = Date.now(), days = WORK_WINDOW_DAYS): WorkAggregates {
  const agg: WorkAggregates = {
    sessions: 0, projects: 0, humanMessages: 0, languages: {}, frameworks: {}, projectKinds: {}, commands: {}, tools: {}, models: {},
    hours: new Array(24).fill(0), weekdays: new Array(7).fill(0), medianWords: 0, lastSeen: 0,
  };
  const seen = { lang: new Map<string, Set<string>>(), cmd: new Map<string, Set<string>>(), tool: new Map<string, Set<string>>(), model: new Map<string, Set<string>>(), fw: new Map<string, Set<string>>(), kind: new Map<string, Set<string>>() };
  const words: number[] = [];
  const projects = new Map<string, { sessions: string[] }>();
  const since = now - days * 86_400_000;
  for (const { file } of recentLogs(now, days)) {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    let cwd = '';
    let session = path.basename(file);
    let used = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev: { type?: string; timestamp?: number; data?: Record<string, unknown>; cwd?: string; id?: string };
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === '__header__') { cwd = String(ev.cwd ?? ''); session = String(ev.id ?? session); continue; }
      const at = typeof ev.timestamp === 'number' ? ev.timestamp : 0;
      if (at < since) continue;
      const data = ev.data ?? {};
      if (ev.type === 'user/message') {
        const source = data.source as { kind?: string } | undefined;
        if (source?.kind !== 'human') continue;
        used = true;
        agg.humanMessages++;
        const d = new Date(at);
        agg.hours[d.getHours()]! += 1;
        agg.weekdays[d.getDay()]! += 1;
        words.push(String(data.content ?? '').split(/\s+/).filter(Boolean).length);
        agg.lastSeen = Math.max(agg.lastSeen, at);
      } else if (ev.type === 'tool/call') {
        used = true;
        const name = String(data.name ?? '');
        if (!name || name.length > 60) continue;
        bump(agg.tools, name.startsWith('mcp__') ? 'MCP tools' : name, session, at, seen.tool);
        let args: unknown;
        try { args = JSON.parse(String(data.arguments ?? '{}')); } catch { args = undefined; }
        for (const p of pathsIn(args)) { const lang = LANG_BY_EXT[extOf(p)]; if (lang) bump(agg.languages, lang, session, at, seen.lang); }
        const command = args && typeof args === 'object' ? (args as { command?: unknown }).command : undefined;
        if (typeof command === 'string') for (const cli of clisIn(command)) bump(agg.commands, cli, session, at, seen.cmd);
      } else if (ev.type === 'request/header') {
        const model = (data.header as { model?: unknown } | undefined)?.model;
        if (typeof model === 'string' && model && model.length < 80) bump(agg.models, model, session, at, seen.model);
      }
    }
    if (!used) continue;
    agg.sessions++;
    if (cwd) {
      const p = projects.get(cwd) ?? { sessions: [] };
      p.sessions.push(session);
      projects.set(cwd, p);
    }
  }
  agg.projects = projects.size;
  for (const [cwd, p] of projects) {
    if (!fs.existsSync(cwd)) continue;
    for (const [fw, kind] of projectFrameworks(cwd)) {
      for (const s of p.sessions) { bump(agg.frameworks, fw, s, now, seen.fw, 0); bump(agg.projectKinds, kind, s, now, seen.kind, 0); }
      agg.frameworks[fw]!.count += 1;
      agg.projectKinds[kind]!.count += 1;
    }
  }
  if (words.length) {
    const s = [...words].sort((a, b) => a - b);
    agg.medianWords = s[Math.floor(s.length / 2)]!;
  }
  return agg;
}

// ── Preferences (ADR 0016) ──────────────────────────────────────────────────

export async function collectPreferences(): Promise<PreferenceSummary[]> {
  const { listRules } = await import('../learning/preferences.js');
  return listRules().filter(r => r.status === 'active').slice(0, 40)
    .map(r => ({ id: r.id, text: r.text, category: r.category, evidence: r.evidence.length, at: r.acceptedAt ?? r.updatedAt }));
}

// ── Browsing (the desktop's digest) ─────────────────────────────────────────

export function digestPath(): string {
  return path.join(aicoHome(), 'desktop', 'browser', 'profile-digest.json');
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const word = (v: unknown, max = 40): string => (typeof v === 'string' ? scrub(v).toLowerCase().replace(/[^a-z0-9+#.\- ]/g, '').trim().slice(0, max) : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const DOMAIN = /^(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+)$/;

/**
 * The digest, re-validated: only the fields the learner uses, every string
 * cleaned and re-checked against the sensitive list. The desktop already
 * filtered; this is the engine not trusting a file it did not write.
 */
export function readBrowserDigest(now = Date.now(), file = digestPath()): { status: DigestStatus; digest?: BrowserDigest; at?: number } {
  let raw: Record<string, unknown>;
  try { raw = obj(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (err) {
    return { status: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid' };
  }
  if (raw.v !== 1) return { status: 'invalid' };
  const at = num(raw.at);
  if (raw.paused === true) return { status: 'paused', at };
  if (raw.off === true) return { status: 'off', at };
  if (now - at > DIGEST_MAX_AGE_MS) return { status: 'stale', at };
  // A domain is checked as written: anything with a path, query or odd character is not one (and is not repaired into one).
  const domainOf = (v: unknown): string => (typeof v === 'string' && v.length <= 80 && DOMAIN.test(v.toLowerCase()) ? v.toLowerCase() : '');
  const domains = arr(raw.domains).map(obj).map(d => ({ domain: domainOf(d.domain), category: word(d.category), minutes: num(d.minutes), visits: num(d.visits), days: num(d.days) }))
    .filter(d => DOMAIN.test(d.domain) && d.category && !sensitiveDomain(d.domain) && !sensitiveArea(d.category)).slice(0, 40);
  const categories = arr(raw.categories).map(obj).map(c => ({ category: word(c.category), minutes: num(c.minutes), visits: num(c.visits) }))
    .filter(c => c.category && !sensitiveArea(c.category)).slice(0, 30);
  const threads = arr(raw.threads).map(obj).map(t => ({ terms: arr(t.terms).map(x => word(x)).filter(Boolean).slice(0, 3), pages: num(t.pages), sites: num(t.sites), last: num(t.last) }))
    .filter(t => t.terms.length && !sensitiveArea(t.terms.join(' '))).slice(0, 8);
  const searchTerms = arr(raw.searchTerms).map(obj).map(s => ({ term: word(s.term, 24), count: num(s.count) }))
    .filter(s => s.term && !sensitiveArea(s.term)).slice(0, 20);
  const r = obj(raw.routines);
  const hist = (v: unknown, n: number): number[] => { const a = arr(v).map(num); return a.length === n ? a : new Array(n).fill(0); };
  const rd = obj(raw.reading);
  const kinds: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj(raw.kinds))) { const key = word(k, 20); if (key && num(v)) kinds[key] = num(v); }
  return {
    status: 'ok', at,
    digest: {
      at, domains, categories, threads, searchTerms,
      routines: { hours: hist(r.hours, 24), weekdays: hist(r.weekdays, 7) },
      reading: { pages: num(rd.pages), medianSeconds: num(rd.medianSeconds), skim: num(rd.skim), partial: num(rd.partial), read: num(rd.read), style: ['skims', 'reads', 'mixed'].includes(String(rd.style)) ? String(rd.style) : 'unknown' },
      kinds,
    },
  };
}

/** Everything the learner may read this run, per the person's switches. */
export async function gatherSources(opts: { now?: number; work?: boolean; browsing?: boolean; digestFile?: string } = {}): Promise<ProfileSources> {
  const now = opts.now ?? Date.now();
  const status: ProfileSources['status'] = { work: opts.work === false ? 'disabled' : 'ok', browsing: 'disabled' };
  const out: ProfileSources = { preferences: [], status };
  if (opts.work !== false) {
    out.work = collectWork(now);
    out.preferences = await collectPreferences().catch(() => []);
  }
  if (opts.browsing !== false) {
    const b = readBrowserDigest(now, opts.digestFile);
    status.browsing = b.status;
    if (b.at) status.digestAt = b.at;
    if (b.digest) out.browsing = b.digest;
  }
  return out;
}
