/**
 * Is this package name real, old enough and popular enough to install without a
 * person looking at it? The second half of the supply-chain check (ADR 0033);
 * `package-parse.ts` finds the names, this judges them.
 *
 * WHY. Models invent plausible package names, and anyone can register one.
 * "Slopsquatting" is exactly that: the name does not exist today, an attacker
 * publishes it with an install script, and the next model that hallucinates the
 * same name installs it. The cheap defence is to ask the registry before the
 * install runs. The registry's answer is a fact (`404`) or a signal (published
 * last week, a handful of downloads, one letter from `requests`) — never a
 * proof of safety, and the ADR says so.
 *
 * Shape:
 *  - {@link lookupPackage} asks the PUBLIC registry through `tools/net.ts`
 *    (injectable in tests, a named User-Agent, a short deadline) and caches the
 *    answer under `aicoHome()/cache/package-check.json` (exists 24 h, missing 1 h;
 *    unknown is never cached).
 *  - {@link judgePackage} is pure: facts in, verdict out.
 *  - {@link privateRegistry} detects a configured private registry (`.npmrc`,
 *    `PIP_INDEX_URL`, `.cargo` source replacement, `GOPROXY`, `nuget.config`…).
 *    The public registry says nothing about a private name, so the caller then
 *    abstains — a corporate user is never told their internal package "does not
 *    exist".
 *
 * Deliberate choices:
 *  - **Hosts are constants, checked before every request.** Stricter than the
 *    SSRF guard (no one else's text ever picks a host); redirects are followed
 *    because the public registries only redirect within themselves.
 *  - **Popular names are free.** ~400 well-known names per the lists below skip
 *    the network entirely: `npm i react` costs nothing and works offline.
 *  - **Unknown never refuses.** A timeout, a 5xx or no network is `unknown`; the
 *    caller abstains and says it could not verify. Blocking offline work would
 *    make the control a reason to switch it off.
 *  - **Honest coverage.** Download counts exist for npm, crates.io and RubyGems
 *    only; first-publication age for npm, PyPI, crates.io, Packagist and
 *    RubyGems. Go and NuGet are existence-only, and have no lookalike rule.
 *
 * @module tools/package-registry
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aicoHome } from '../home.js';
import { NetError, request } from './net.js';
import type { Ecosystem, PackageRef } from './package-parse.js';

// ── Facts and verdicts ───────────────────────────────────────────────

export interface PackageFacts {
  status: 'exists' | 'missing' | 'unknown';
  /** A well-known name, answered without a request. */
  established?: boolean;
  /** First publication, epoch ms, where the registry exposes it. */
  createdAt?: number;
  downloads?: number;
  downloadsKind?: 'weekly' | 'total';
  /** Why `unknown`, for the advisory note. */
  note?: string;
}

export type JudgeRule = 'package-new' | 'package-low-downloads' | 'package-lookalike';

export interface Judgement {
  verdict: 'ok' | 'missing' | 'person' | 'unknown';
  reasons: Array<{ rule: JudgeRule; text: string }>;
}

export const DEFAULT_MIN_AGE_DAYS = 30;
/** "Very low": below this the package is effectively unused. */
const LOW_DOWNLOADS: Partial<Record<Ecosystem, { below: number; kind: 'weekly' | 'total' }>> = {
  npm: { below: 20, kind: 'weekly' },
  crates: { below: 200, kind: 'total' },
  rubygems: { below: 500, kind: 'total' },
};
/** Above this a package is established whatever its age. */
const ESTABLISHED: Partial<Record<Ecosystem, number>> = { npm: 1000, crates: 100_000, rubygems: 50_000 };
const DAY = 86_400_000;
const LOOKALIKE_MAX_AGE_DAYS = 365;

// ── Popular names ────────────────────────────────────────────────────

const list = (s: string): string[] => s.split(/\s+/).filter(Boolean);

/** Well-known names (lower case). Not a safelist of "good" software — a short list of names nobody typos on purpose. */
export const TOP_PACKAGES: Record<Ecosystem, ReadonlySet<string>> = {
  npm: new Set(list(`react react-dom vue svelte preact next nuxt vite webpack rollup esbuild parcel typescript ts-node tsx tsup babel-loader css-loader style-loader
    lodash lodash-es underscore ramda express koa fastify hapi cors body-parser cookie-parser express-session helmet morgan multer compression passport jsonwebtoken bcrypt bcryptjs
    axios node-fetch got superagent request cross-fetch isomorphic-fetch ws socket.io chalk commander yargs minimist inquirer ora debug dotenv semver uuid moment dayjs date-fns luxon
    async bluebird rxjs tslib core-js zod yup joi ajv validator classnames clsx styled-components tailwindcss postcss autoprefixer sass less
    redux react-redux react-router react-router-dom zustand mobx immer prop-types jquery d3 three chart.js echarts leaflet
    jest mocha chai sinon vitest cypress playwright puppeteer supertest eslint prettier nodemon husky lint-staged cross-env concurrently
    mongoose mongodb mysql mysql2 pg sequelize typeorm knex prisma redis ioredis sqlite3 better-sqlite3
    glob rimraf mkdirp fs-extra yaml js-yaml xml2js cheerio marked highlight.js markdown-it handlebars ejs pug mustache sharp jimp archiver adm-zip tar qs query-string
    winston pino nodemailer graphql electron electron-builder terser uglify-js regenerator-runtime events buffer`)),
  pypi: new Set(list(`requests numpy pandas scipy matplotlib flask django fastapi uvicorn gunicorn sqlalchemy psycopg2 psycopg2-binary pymysql redis celery boto3 botocore awscli
    pytest pytest-cov tox black flake8 pylint mypy isort ruff pre-commit pydantic httpx aiohttp urllib3 certifi idna chardet charset-normalizer six setuptools wheel pip virtualenv
    pillow opencv-python scikit-learn tensorflow torch keras transformers openai anthropic langchain jinja2 markupsafe werkzeug click rich typer pyyaml toml tomli
    python-dotenv python-dateutil pytz tqdm beautifulsoup4 lxml selenium scrapy pyjwt cryptography paramiko fabric ansible docker kubernetes grpcio protobuf
    numba cython sympy statsmodels seaborn plotly dash streamlit jupyter ipython notebook pyarrow polars duckdb attrs packaging pluggy typing-extensions wrapt decorator
    jsonschema simplejson ujson orjson msgpack regex nltk spacy gensim xgboost lightgbm catboost pyinstaller poetry pipenv uv sentry-sdk oauthlib httplib2 websockets
    alembic marshmallow peewee flask-cors flask-sqlalchemy djangorestframework pymongo motor pika kafka-python confluent-kafka`)),
  crates: new Set(list(`serde serde_json tokio rand clap regex anyhow thiserror log env_logger reqwest hyper futures async-trait chrono uuid lazy_static once_cell itertools rayon
    syn quote proc-macro2 bytes tracing tracing-subscriber axum actix-web rocket sqlx diesel tonic prost bincode toml base64 sha2 hex libc cfg-if bitflags smallvec parking_lot
    crossbeam num_cpus tempfile walkdir indicatif colored dirs glob url openssl rustls ring`)),
  go: new Set(),
  nuget: new Set(list(`newtonsoft.json serilog dapper automapper xunit nunit moq fluentassertions microsoft.entityframeworkcore microsoft.extensions.logging polly swashbuckle.aspnetcore
    mediatr fluentvalidation stackexchange.redis restsharp csvhelper humanizer npgsql microsoft.data.sqlclient`)),
  packagist: new Set(list(`laravel/framework symfony/console symfony/http-foundation guzzlehttp/guzzle monolog/monolog phpunit/phpunit doctrine/orm doctrine/dbal nesbot/carbon
    vlucas/phpdotenv league/flysystem twig/twig psr/log psr/http-message ramsey/uuid fakerphp/faker mockery/mockery phpstan/phpstan friendsofphp/php-cs-fixer illuminate/support
    livewire/livewire spatie/laravel-permission laravel/sanctum laravel/passport firebase/php-jwt predis/predis symfony/yaml symfony/finder symfony/process composer/composer`)),
  rubygems: new Set(list(`rails rake bundler rspec rubocop puma sinatra nokogiri devise pg mysql2 sqlite3 redis sidekiq activerecord activesupport json minitest capybara faker
    factory_bot rack jekyll thor webpacker sass-rails turbolinks jbuilder bcrypt httparty faraday rest-client dotenv pry byebug colorize`)),
};

/** Optimal-string-alignment distance: one insert, delete, substitute or adjacent swap is 1. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/** The popular package this name is one slip away from, if any. */
export function lookalikeOf(ecosystem: Ecosystem, name: string): string | undefined {
  const n = name.toLowerCase();
  if (ecosystem === 'go' || ecosystem === 'nuget' || TOP_PACKAGES[ecosystem].has(n) || (ecosystem === 'npm' && n.startsWith('@'))) return undefined;
  const squash = (s: string): string => s.replace(/[-_.]/g, '');
  for (const top of TOP_PACKAGES[ecosystem]) {
    if (top.length < 5 || top.includes('/') !== n.includes('/')) continue;
    const allowed = top.length >= 8 ? 2 : 1;
    if (Math.abs(top.length - n.length) > allowed) continue;
    // `reactdom` for `react-dom`: the same letters with the separators moved.
    if (squash(top) === squash(n)) return top;
    if (editDistance(n, top) <= allowed) return top;
  }
  return undefined;
}

// ── The verdict ──────────────────────────────────────────────────────

/** Facts in, verdict out. Pure. */
export function judgePackage(ref: Pick<PackageRef, 'ecosystem' | 'name'>, facts: PackageFacts, cfg: { minAgeDays?: number; now?: number } = {}): Judgement {
  const reasons: Judgement['reasons'] = [];
  if (facts.established) return { verdict: 'ok', reasons };
  if (facts.status === 'missing') return { verdict: 'missing', reasons };
  if (facts.status === 'unknown') return { verdict: 'unknown', reasons };
  const now = cfg.now ?? Date.now();
  const minAge = cfg.minAgeDays ?? DEFAULT_MIN_AGE_DAYS;
  const ageDays = facts.createdAt === undefined ? undefined : Math.max(0, Math.floor((now - facts.createdAt) / DAY));
  if (ageDays !== undefined && minAge > 0 && ageDays < minAge) {
    reasons.push({ rule: 'package-new', text: `it was first published ${ageDays === 0 ? 'today' : `${ageDays} day${ageDays === 1 ? '' : 's'} ago`} (the minimum age is ${minAge} days)` });
  }
  const low = LOW_DOWNLOADS[ref.ecosystem];
  if (low && facts.downloads !== undefined && facts.downloadsKind === low.kind && facts.downloads < low.below) {
    reasons.push({ rule: 'package-low-downloads', text: `it has almost no use (${facts.downloads} ${low.kind === 'weekly' ? 'downloads last week' : 'downloads in total'})` });
  }
  const young = ageDays !== undefined && ageDays < LOOKALIKE_MAX_AGE_DAYS;
  const quiet = ageDays === undefined && facts.downloads !== undefined && low !== undefined && facts.downloads < low.below * 50;
  if (young || quiet) {
    const like = lookalikeOf(ref.ecosystem, ref.name);
    if (like) reasons.push({ rule: 'package-lookalike', text: `its name is one slip away from the popular package \`${like}\`` });
  }
  return { verdict: reasons.length ? 'person' : 'ok', reasons };
}

// ── Cache ────────────────────────────────────────────────────────────

interface CacheEntry { at: number; status: 'exists' | 'missing'; createdAt?: number; downloads?: number; downloadsKind?: 'weekly' | 'total' }
const EXISTS_TTL = DAY;
const MISSING_TTL = 3_600_000;

export class PackageCache {
  private entries = new Map<string, CacheEntry>();
  private loaded = false;
  constructor(private readonly file: () => string = () => path.join(aicoHome(), 'cache', 'package-check.json'), private readonly now: () => number = Date.now) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as { v?: number; entries?: Record<string, CacheEntry> };
      if (parsed.v === 1 && parsed.entries) for (const [k, v] of Object.entries(parsed.entries)) this.entries.set(k, v);
    } catch { /* no cache yet, or unreadable: start empty */ }
  }

  get(key: string): PackageFacts | undefined {
    this.load();
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (this.now() - e.at > (e.status === 'exists' ? EXISTS_TTL : MISSING_TTL)) { this.entries.delete(key); return undefined; }
    return { status: e.status, ...(e.createdAt !== undefined ? { createdAt: e.createdAt } : {}), ...(e.downloads !== undefined ? { downloads: e.downloads } : {}), ...(e.downloadsKind ? { downloadsKind: e.downloadsKind } : {}) };
  }

  set(key: string, facts: PackageFacts): void {
    if (facts.status === 'unknown') return; // never cache not knowing
    this.load();
    this.entries.set(key, {
      at: this.now(), status: facts.status,
      ...(facts.createdAt !== undefined ? { createdAt: facts.createdAt } : {}),
      ...(facts.downloads !== undefined ? { downloads: facts.downloads } : {}),
      ...(facts.downloadsKind ? { downloadsKind: facts.downloadsKind } : {}),
    });
    this.save();
  }

  private save(): void {
    try {
      const file = this.file();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const cutoff = this.now() - 2 * DAY;
      const entries = Object.fromEntries([...this.entries].filter(([, e]) => e.at > cutoff));
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries }));
      fs.renameSync(tmp, file);
    } catch { /* best effort: a cache that cannot be written is only slower */ }
  }
}

let defaultCache: PackageCache | undefined;
const sharedCache = (): PackageCache => (defaultCache ??= new PackageCache());
/** Drop the in-memory cache (tests switch AICO_HOME). */
export function resetPackageCache(): void { defaultCache = undefined; }

// ── Lookups ──────────────────────────────────────────────────────────

/** The only hosts this module will ask. */
const HOSTS = new Set(['registry.npmjs.org', 'api.npmjs.org', 'pypi.org', 'crates.io', 'proxy.golang.org', 'api.nuget.org', 'repo.packagist.org', 'rubygems.org']);

interface Ask { signal?: AbortSignal | undefined; timeoutMs: number }

async function get(url: string, ask: Ask, what: string, accept = 'application/json'): Promise<{ status: number; text: string }> {
  const host = new URL(url).host;
  if (!HOSTS.has(host)) throw new Error(`package-registry: ${host} is not a public registry host`);
  try {
    const res = await request(url, { what, timeoutMs: ask.timeoutMs, headers: { Accept: accept }, ...(ask.signal ? { signal: ask.signal } : {}) });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    if (err instanceof NetError && err.status !== undefined) return { status: err.status, text: '' };
    throw err;
  }
}

const parse = <T>(text: string): T | undefined => { try { return JSON.parse(text) as T; } catch { return undefined; } };
const time = (s: unknown): number | undefined => { const t = typeof s === 'string' ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : undefined; };

async function lookupNpm(name: string, ask: Ask): Promise<PackageFacts> {
  const enc = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
  let downloads: number | undefined;
  const dl = await get(`https://api.npmjs.org/downloads/point/last-week/${name.startsWith('@') ? name : encodeURIComponent(name)}`, ask, 'npm download counts');
  if (dl.status === 200) downloads = parse<{ downloads?: number }>(dl.text)?.downloads;
  const common = (): Pick<PackageFacts, 'downloads' | 'downloadsKind'> => (downloads === undefined ? {} : { downloads, downloadsKind: 'weekly' });
  if (downloads !== undefined && downloads >= (ESTABLISHED.npm ?? 1000)) return { status: 'exists', established: true, ...common() };
  const doc = await get(`https://registry.npmjs.org/${enc}`, ask, 'the npm registry');
  if (doc.status === 404) return { status: 'missing' };
  if (doc.status !== 200) return { status: 'unknown', note: `the npm registry answered HTTP ${doc.status}` };
  const created = time(parse<{ time?: { created?: string } }>(doc.text)?.time?.created);
  return { status: 'exists', ...(created !== undefined ? { createdAt: created } : {}), ...common() };
}

async function lookupPypi(name: string, ask: Ask): Promise<PackageFacts> {
  const res = await get(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, ask, 'PyPI');
  if (res.status === 404) return { status: 'missing' };
  if (res.status !== 200) return { status: 'unknown', note: `PyPI answered HTTP ${res.status}` };
  const doc = parse<{ releases?: Record<string, Array<{ upload_time_iso_8601?: string; upload_time?: string }>> }>(res.text);
  let first: number | undefined;
  for (const files of Object.values(doc?.releases ?? {})) {
    for (const f of files ?? []) {
      const t = time(f.upload_time_iso_8601 ?? f.upload_time);
      if (t !== undefined && (first === undefined || t < first)) first = t;
    }
  }
  return { status: 'exists', ...(first !== undefined ? { createdAt: first } : {}) };
}

async function lookupCrates(name: string, ask: Ask): Promise<PackageFacts> {
  const res = await get(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`, ask, 'crates.io');
  if (res.status === 404) return { status: 'missing' };
  if (res.status !== 200) return { status: 'unknown', note: `crates.io answered HTTP ${res.status}` };
  const c = parse<{ crate?: { created_at?: string; downloads?: number } }>(res.text)?.crate;
  const created = time(c?.created_at);
  const downloads = typeof c?.downloads === 'number' ? c.downloads : undefined;
  return {
    status: 'exists',
    ...(created !== undefined ? { createdAt: created } : {}),
    ...(downloads !== undefined ? { downloads, downloadsKind: 'total' as const } : {}),
    ...(downloads !== undefined && downloads >= (ESTABLISHED.crates ?? 1e5) ? { established: true } : {}),
  };
}

const FORGES = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'sr.ht']);
const goEscape = (p: string): string => p.replace(/[A-Z]/g, c => `!${c.toLowerCase()}`);

/** A module path may name a package inside a module (`github.com/a/b/sub/pkg`); ask for the longest prefix down to the module root. */
async function lookupGo(name: string, ask: Ask): Promise<PackageFacts> {
  const parts = name.split('/');
  const min = FORGES.has(parts[0]!.toLowerCase()) ? 3 : 2;
  let answered = 0;
  for (let n = parts.length, tried = 0; n >= Math.min(min, parts.length) && tried < 4; n--, tried++) {
    const res = await get(`https://proxy.golang.org/${goEscape(parts.slice(0, n).join('/'))}/@v/list`, { ...ask, timeoutMs: Math.max(ask.timeoutMs, 8000) }, 'the Go module proxy', 'text/plain');
    if (res.status === 200) return { status: 'exists' };
    if (res.status === 404 || res.status === 410) { answered++; continue; }
    return { status: 'unknown', note: `the Go module proxy answered HTTP ${res.status}` };
  }
  if (!answered) return { status: 'unknown', note: 'the Go module proxy could not be asked' };
  // A vanity import path or a company git host is fetched directly when the proxy has never heard of it
  // (GOPROXY=…,direct): the proxy's 404 proves nothing there. Only a public forge's name is judged missing.
  if (!FORGES.has(parts[0]!.toLowerCase())) return { status: 'unknown', note: `${parts[0]} is not on the public Go proxy; if it is a private module, set GOPRIVATE for it` };
  return { status: 'missing' };
}

async function lookupNuget(name: string, ask: Ask): Promise<PackageFacts> {
  const res = await get(`https://api.nuget.org/v3-flatcontainer/${encodeURIComponent(name.toLowerCase())}/index.json`, ask, 'NuGet');
  if (res.status === 404) return { status: 'missing' };
  return res.status === 200 ? { status: 'exists' } : { status: 'unknown', note: `NuGet answered HTTP ${res.status}` };
}

async function lookupPackagist(name: string, ask: Ask): Promise<PackageFacts> {
  const res = await get(`https://repo.packagist.org/p2/${name.split('/').map(encodeURIComponent).join('/')}.json`, ask, 'Packagist');
  if (res.status === 404) return { status: 'missing' };
  if (res.status !== 200) return { status: 'unknown', note: `Packagist answered HTTP ${res.status}` };
  const versions = parse<{ packages?: Record<string, Array<{ time?: string }>> }>(res.text)?.packages?.[name] ?? [];
  let first: number | undefined;
  for (const v of versions) { const t = time(v.time); if (t !== undefined && (first === undefined || t < first)) first = t; }
  return { status: 'exists', ...(first !== undefined ? { createdAt: first } : {}) };
}

async function lookupGem(name: string, ask: Ask): Promise<PackageFacts> {
  const res = await get(`https://rubygems.org/api/v1/gems/${encodeURIComponent(name)}.json`, ask, 'RubyGems');
  if (res.status === 404) return { status: 'missing' };
  if (res.status !== 200) return { status: 'unknown', note: `RubyGems answered HTTP ${res.status}` };
  const downloads = parse<{ downloads?: number }>(res.text)?.downloads;
  const facts: PackageFacts = { status: 'exists', ...(typeof downloads === 'number' ? { downloads, downloadsKind: 'total' as const } : {}) };
  if (typeof downloads === 'number' && downloads >= (ESTABLISHED.rubygems ?? 5e4)) return { ...facts, established: true };
  // The gem's own record has no first-publication date; the version list does (obscure gems only: popular lists are large).
  const vs = await get(`https://rubygems.org/api/v1/versions/${encodeURIComponent(name)}.json`, ask, 'RubyGems versions');
  if (vs.status === 200) {
    let first: number | undefined;
    for (const v of parse<Array<{ created_at?: string }>>(vs.text) ?? []) { const t = time(v.created_at); if (t !== undefined && (first === undefined || t < first)) first = t; }
    if (first !== undefined) facts.createdAt = first;
  }
  return facts;
}

export interface LookupOptions { cache?: PackageCache; signal?: AbortSignal; timeoutMs?: number }

/** Ask the public registry about one package (cache first). Never throws: a failure is `unknown`. */
export async function lookupPackage(ref: Pick<PackageRef, 'ecosystem' | 'name'>, opts: LookupOptions = {}): Promise<PackageFacts> {
  const key = `${ref.ecosystem}:${ref.name.toLowerCase()}`;
  if (TOP_PACKAGES[ref.ecosystem].has(ref.name.toLowerCase())) return { status: 'exists', established: true };
  const cache = opts.cache ?? sharedCache();
  const hit = cache.get(key);
  if (hit) return hit;
  const ask: Ask = { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 5000 };
  let facts: PackageFacts;
  try {
    switch (ref.ecosystem) {
      case 'npm': facts = await lookupNpm(ref.name, ask); break;
      case 'pypi': facts = await lookupPypi(ref.name, ask); break;
      case 'crates': facts = await lookupCrates(ref.name, ask); break;
      case 'go': facts = await lookupGo(ref.name, ask); break;
      case 'nuget': facts = await lookupNuget(ref.name, ask); break;
      case 'packagist': facts = await lookupPackagist(ref.name, ask); break;
      case 'rubygems': facts = await lookupGem(ref.name, ask); break;
    }
  } catch (err) {
    return { status: 'unknown', note: err instanceof Error ? err.message : String(err) };
  }
  cache.set(key, facts);
  return facts;
}

// ── The project's own packages ───────────────────────────────────────

/** `name` of a package.json (or undefined). */
function pkgName(file: string): string | undefined {
  try { const n = (JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: unknown }).name; return typeof n === 'string' ? n : undefined; } catch { return undefined; }
}

/**
 * Whether the name is this project's own package — a workspace member, the
 * module the go.mod declares, the project the pyproject names — which no public
 * registry has to know about (`npm i @org/internal -w web` in a monorepo).
 */
export function isLocalPackage(ref: Pick<PackageRef, 'ecosystem' | 'name'>, cwd: string): boolean {
  const dirs = ancestors(cwd);
  if (ref.ecosystem === 'npm') {
    for (const d of dirs) {
      if (pkgName(path.join(d, 'package.json')) === ref.name) return true;
      let workspaces: unknown;
      try { workspaces = (JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')) as { workspaces?: unknown }).workspaces; } catch { continue; }
      const globs = Array.isArray(workspaces) ? workspaces : Array.isArray((workspaces as { packages?: unknown } | undefined)?.packages) ? (workspaces as { packages: unknown[] }).packages : [];
      for (const g of globs) {
        if (typeof g !== 'string') continue;
        const base = g.replace(/\/?\*+$/, '');
        if (/[*?{]/.test(base)) continue;
        if (g === base) { if (pkgName(path.join(d, base, 'package.json')) === ref.name) return true; continue; }
        let kids: string[] = [];
        try { kids = fs.readdirSync(path.join(d, base)).slice(0, 300); } catch { continue; }
        if (kids.some(k => pkgName(path.join(d, base, k, 'package.json')) === ref.name)) return true;
      }
    }
    return false;
  }
  if (ref.ecosystem === 'go') {
    for (const d of dirs) {
      const m = /^module\s+(\S+)/m.exec(readText(path.join(d, 'go.mod')));
      if (m && (ref.name === m[1] || ref.name.startsWith(`${m[1]}/`))) return true;
    }
    return false;
  }
  if (ref.ecosystem === 'pypi') {
    for (const d of dirs) {
      const m = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(readText(path.join(d, 'pyproject.toml')));
      if (m && m[1]!.toLowerCase().replace(/[-_.]+/g, '-') === ref.name) return true;
    }
  }
  return false;
}

// ── Private registries ───────────────────────────────────────────────

const PUBLIC_HOSTS: Record<Ecosystem, RegExp> = {
  npm: /(?:^|\.)(?:npmjs\.org|npmjs\.com|yarnpkg\.com)$/i,
  pypi: /(?:^|\.)(?:pypi\.org|pythonhosted\.org)$/i,
  crates: /(?:^|\.)(?:crates\.io|rust-lang\.org)$/i,
  go: /(?:^|\.)(?:golang\.org|go\.dev)$/i,
  nuget: /(?:^|\.)nuget\.org$/i,
  packagist: /(?:^|\.)(?:packagist\.org|packagist\.com)$/i,
  rubygems: /(?:^|\.)(?:rubygems\.org)$/i,
};

/** Whether a URL (or `sparse+https://…`) names somewhere other than the public registry for this ecosystem. */
export function isPrivateUrl(ecosystem: Ecosystem, value: string): boolean {
  const v = value.trim().replace(/^sparse\+/, '');
  if (!v) return false;
  if (!/^[a-z]+:\/\//i.test(v)) return true; // a named source or a path: not the public registry
  try { return !PUBLIC_HOSTS[ecosystem].test(new URL(v).hostname); } catch { return true; }
}

const readText = (p: string): string => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

/** `cwd` and its parents (a project's config may sit above the folder the command runs in). */
function ancestors(cwd: string, levels = 6): string[] {
  const out: string[] = [];
  let dir = path.resolve(cwd);
  for (let i = 0; i < levels; i++) { out.push(dir); const up = path.dirname(dir); if (up === dir) break; dir = up; }
  return out;
}

export interface PrivateRegistryContext { cwd: string; env: NodeJS.ProcessEnv; home?: string }

/**
 * A description of the private registry configured for this package, or undefined
 * when the public one is in use. Best effort and deliberately generous: ANY sign
 * of a private registry makes the caller abstain.
 */
export function privateRegistry(ref: PackageRef, ctx: PrivateRegistryContext): string | undefined {
  const home = ctx.home ?? os.homedir();
  const env = (k: string): string | undefined => ctx.env[k] ?? ctx.env[k.toLowerCase()] ?? ctx.env[k.toUpperCase()];
  if (ref.registry && isPrivateUrl(ref.ecosystem, ref.registry)) return `--registry/--index ${ref.registry}`;
  const dirs = ancestors(ctx.cwd);
  switch (ref.ecosystem) {
    case 'npm': {
      const e = env('npm_config_registry'); if (e && isPrivateUrl('npm', e)) return `npm_config_registry ${e}`;
      const scope = ref.name.startsWith('@') ? ref.name.split('/')[0]! : undefined;
      for (const f of [...dirs.map(d => path.join(d, '.npmrc')), path.join(home, '.npmrc')]) {
        for (const line of readText(f).split(/\r?\n/)) {
          const m = /^\s*(@[^:\s]+:)?registry\s*=\s*(\S+)/.exec(line);
          if (m && (!m[1] || m[1].slice(0, -1) === scope) && isPrivateUrl('npm', m[2]!)) return `${path.basename(f)} registry ${m[2]}`;
        }
      }
      for (const f of dirs.map(d => path.join(d, '.yarnrc.yml'))) {
        const m = /npmRegistryServer:\s*["']?(\S+?)["']?\s*$/m.exec(readText(f));
        if (m && isPrivateUrl('npm', m[1]!)) return `.yarnrc.yml npmRegistryServer ${m[1]}`;
        if (/npmScopes:/.test(readText(f))) return '.yarnrc.yml npmScopes';
      }
      for (const f of dirs.map(d => path.join(d, 'bunfig.toml'))) { if (/registry/.test(readText(f))) return 'bunfig.toml registry'; }
      return undefined;
    }
    case 'pypi': {
      for (const k of ['PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL', 'UV_INDEX_URL', 'UV_DEFAULT_INDEX', 'UV_EXTRA_INDEX_URL', 'UV_INDEX', 'POETRY_REPOSITORIES']) {
        const v = env(k); if (v && isPrivateUrl('pypi', v.split(/\s+/)[0]!)) return `${k} ${v}`;
      }
      const appdata = ctx.env.APPDATA;
      const files = [...dirs.flatMap(d => [path.join(d, 'pip.conf'), path.join(d, 'pip.ini'), path.join(d, 'uv.toml'), path.join(d, 'pyproject.toml')]),
        path.join(home, '.config', 'pip', 'pip.conf'), path.join(home, '.pip', 'pip.conf'), ...(appdata ? [path.join(appdata, 'pip', 'pip.ini')] : [])];
      for (const f of files) {
        const text = readText(f);
        if (!text) continue;
        if (/\[\[tool\.uv\.index\]\]|\[\[tool\.poetry\.source\]\]/.test(text)) return `${path.basename(f)} index/source`;
        const m = /^\s*(?:extra-)?index-url\s*[=:]\s*["']?(\S+?)["']?\s*$/m.exec(text);
        if (m && isPrivateUrl('pypi', m[1]!)) return `${path.basename(f)} index-url ${m[1]}`;
      }
      return undefined;
    }
    case 'crates': {
      for (const f of [...dirs.flatMap(d => [path.join(d, '.cargo', 'config.toml'), path.join(d, '.cargo', 'config')]), path.join(home, '.cargo', 'config.toml'), path.join(home, '.cargo', 'config')]) {
        if (/replace-with|\[registries\./.test(readText(f))) return `${path.basename(f)} source replacement/registries`;
      }
      return undefined;
    }
    case 'go': {
      const proxy = env('GOPROXY');
      if (proxy && proxy.split(/[,|]/).some(p => p && !/^(?:direct|off)$/.test(p) && isPrivateUrl('go', p))) return `GOPROXY ${proxy}`;
      const priv = [env('GOPRIVATE'), env('GONOPROXY')].filter(Boolean).join(',').split(',').map(s => s.trim()).filter(Boolean);
      const hit = priv.find(p => ref.name === p || ref.name.startsWith(`${p.replace(/\/?\*$/, '')}/`) || ref.name === p.replace(/\/?\*$/, ''));
      if (hit) return `GOPRIVATE ${hit}`;
      for (const f of [path.join(home, '.config', 'go', 'env'), ...(ctx.env.APPDATA ? [path.join(ctx.env.APPDATA, 'go', 'env')] : [])]) {
        const m = /^GOPROXY=(\S+)/m.exec(readText(f));
        if (m && m[1]!.split(/[,|]/).some(p => p && !/^(?:direct|off)$/.test(p) && isPrivateUrl('go', p))) return `go env GOPROXY ${m[1]}`;
      }
      return undefined;
    }
    case 'nuget': {
      const appdata = ctx.env.APPDATA;
      for (const f of [...dirs.flatMap(d => [path.join(d, 'nuget.config'), path.join(d, 'NuGet.Config'), path.join(d, 'NuGet.config')]), path.join(home, '.nuget', 'NuGet', 'NuGet.Config'), ...(appdata ? [path.join(appdata, 'NuGet', 'NuGet.Config')] : [])]) {
        for (const m of readText(f).matchAll(/<add\s+key="[^"]*"\s+value="([^"]+)"/g)) {
          if (/^https?:\/\//i.test(m[1]!) && isPrivateUrl('nuget', m[1]!)) return `${path.basename(f)} source ${m[1]}`;
        }
      }
      return undefined;
    }
    case 'packagist': {
      for (const f of dirs.map(d => path.join(d, 'composer.json'))) {
        const text = readText(f);
        if (/"repositories"/.test(text) && /"type"\s*:\s*"(?:composer|artifact|path|vcs|git)"/.test(text)) return 'composer.json repositories';
      }
      return undefined;
    }
    case 'rubygems': {
      for (const f of dirs.map(d => path.join(d, 'Gemfile'))) {
        for (const m of readText(f).matchAll(/^\s*source\s+["']([^"']+)["']/gm)) if (isPrivateUrl('rubygems', m[1]!)) return `Gemfile source ${m[1]}`;
      }
      for (const m of readText(path.join(home, '.gemrc')).matchAll(/^\s*-\s*(https?:\/\/\S+)/gm)) if (isPrivateUrl('rubygems', m[1]!)) return `.gemrc source ${m[1]}`;
      return undefined;
    }
  }
}
