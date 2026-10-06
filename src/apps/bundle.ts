/**
 * Bundles: several services that run together as one app.
 *
 * Why this exists: an app was one process on one port, which cannot express
 * "a React frontend, an API and a Postgres". A bundle (`kind: "bundle"`,
 * ADR 0031) carries `services[]`; this module is the *pure* half of running
 * it — ordering, port wiring, and the compose file — so it can be tested
 * without starting anything. `process.ts` does the launching.
 *
 * Two ways to run a bundle, chosen by what the machine has:
 *   - compose: `docker compose up` over a compose file (the one the template
 *     ships, or one generated here). Needs Docker; runs container-only
 *     services (a database) as well.
 *   - native: each service that has code as its own process, in dependency
 *     order, each on its own free port. Needs every service's toolchain, and
 *     cannot run container-only services — it says so rather than pretending.
 *
 * Generated compose follows the cross-stack baseline: pinned image tags
 * (Postgres 18, Valkey 9, Keycloak 26.8, Mailpit, Traefik 3.7 — never Redis 8
 * or MinIO, whose licence/maintenance status the research ruled out),
 * `no-new-privileges`, dropped capabilities, named volumes only, secrets as
 * `${VAR:?}` interpolations read from the app's gitignored `.env` (the
 * generator appends the keys with fresh random values), one published port on
 * 127.0.0.1, and — when the bundle has a frontend and an API — a Traefik
 * single origin (`/` to the frontend, `/api` to the API) configured from files
 * rather than the Docker socket, because mounting the socket into a proxy is
 * exactly the kind of mount ADR 0031 refuses.
 *
 * What it does not do: Kubernetes, service meshes, or per-service
 * VerifyApp origins. It never writes a secret into a committed file.
 *
 * @module apps/bundle
 */

import crypto from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import type { MiniApp, RunProfile } from '../miniapps/store.js';
import { ensureGitignored } from './env-file.js';
import { dependencyOrder, type AppService, type ServiceRole } from './stack.js';

type BundleApp = Pick<MiniApp, 'slug' | 'services' | 'preview' | 'compose'>;

/** Roles that may be a bare image with a default (no code to copy). */
export const CONTAINER_ROLES: readonly ServiceRole[] = ['db', 'cache', 'auth', 'mail', 'proxy', 'storage'];

interface RoleDefault {
  image?: string;
  port: number;
  env?: Record<string, string>;
  volumes?: string[];
  command?: string[];
  health?: string[];
}

/** Pinned defaults, from the verified-tags table in the research notes. */
export const ROLE_DEFAULTS: Partial<Record<ServiceRole, RoleDefault>> = {
  db: {
    image: 'postgres:18-alpine', port: 5432,
    env: { POSTGRES_USER: 'app', POSTGRES_DB: 'app', POSTGRES_PASSWORD: '{secret}' },
    volumes: ['pgdata:/var/lib/postgresql/data'],
    health: ['CMD-SHELL', 'pg_isready -U app -d app'],
  },
  cache: { image: 'valkey/valkey:9-alpine', port: 6379, health: ['CMD', 'valkey-cli', 'ping'] },
  auth: { image: 'quay.io/keycloak/keycloak:26.8', port: 8080, command: ['start-dev'] },
  mail: { image: 'axllent/mailpit:v1.31.4', port: 8025 },
};

export const TRAEFIK_IMAGE = 'traefik:v3.7';

/** `name:/container/path` — a named volume only; a bind mount is never accepted from a manifest. */
const NAMED_VOLUME = /^[a-z0-9][a-z0-9_.-]*:\/[A-Za-z0-9_./-]+$/;

/** The service whose origin the Apps preview shows. */
export function previewService(app: BundleApp): AppService | undefined {
  const services = app.services ?? [];
  return services.find(s => s.id === app.preview)
    ?? services.find(s => s.role === 'frontend')
    ?? services.find(s => !s.image && s.role !== 'worker')
    ?? services[0];
}

/** The service's own directory inside the app. */
export function servicePath(s: AppService): string | undefined {
  return s.image || (!s.path && !s.template) ? undefined : (s.path ?? path.posix.join('services', s.id));
}

/** Whether a service has code that can run natively (as opposed to a bare image). */
export function hasCode(s: AppService): boolean {
  return !!servicePath(s);
}

export interface WireContext {
  /** Port and host each service is reachable on, in the mode being planned. */
  hostOf: (id: string) => string;
  portOf: (id: string) => number | undefined;
  /** The service the value belongs to (for `{port}`). */
  self: string;
  /** Turns `{secret}` / `{secret.<service>}` into something (an interpolation in compose; refused natively). */
  secret?: (service: string) => string;
}

/** Substitute `{port}`, `{secret}` and `{service.<id>.url|host|port}`. Unknown references stay visible so the failure is legible. */
export function wire(value: string, ctx: WireContext): string {
  return value
    .replace(/\{service\.([a-z][a-z0-9-]*)\.(url|host|port)\}/g, (whole, id: string, what: string) => {
      const port = ctx.portOf(id);
      if (port === undefined) return whole;
      const host = ctx.hostOf(id);
      return what === 'port' ? String(port) : what === 'host' ? host : `http://${host}:${port}`;
    })
    .replace(/\{port\}/g, String(ctx.portOf(ctx.self) ?? '{port}'))
    // `{secret}` is this service's own; `{secret.db}` names another's, so the API and the database share one password.
    .replace(/\{secret(?:\.([a-z][a-z0-9-]*))?\}/g, (whole, id?: string) => ctx.secret ? ctx.secret(id ?? ctx.self) : whole);
}

export interface NativeStep {
  service: AppService;
  /** Directory relative to the app. */
  cwd: string;
  port: number;
  /** The wired environment (non-secret). */
  env: Record<string, string>;
  run: RunProfile;
}

export interface NativePlan {
  steps: NativeStep[];
  /** Services that cannot run natively (bare images), with why. */
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * The native start order, with each service's port and wired environment.
 *
 * Ports come from the caller (free ports in production, fixed in tests).
 * Container-only services are reported in `skipped`; the caller decides
 * whether that blocks (it does when something code-bearing depends on one).
 */
export function planNative(app: BundleApp, portFor: (id: string) => number): NativePlan {
  const services = app.services ?? [];
  const ordered = dependencyOrder(services) ?? services;
  const ports = new Map<string, number>();
  for (const s of ordered) if (hasCode(s)) ports.set(s.id, portFor(s.id));
  const steps: NativeStep[] = [];
  const skipped: NativePlan['skipped'] = [];
  for (const s of ordered) {
    if (!hasCode(s)) {
      skipped.push({ id: s.id, reason: `${s.id} is a container image (${s.image ?? ROLE_DEFAULTS[s.role]?.image ?? s.role}); native start cannot run it` });
      continue;
    }
    const ctx: WireContext = { hostOf: () => '127.0.0.1', portOf: id => ports.get(id), self: s.id };
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...(s.run?.env ?? {}), ...(s.env ?? {}) })) env[k] = wire(v, ctx);
    steps.push({ service: s, cwd: servicePath(s)!, port: ports.get(s.id)!, env, run: s.run ?? {} });
  }
  return { steps, skipped };
}

/** Services a code-bearing service needs that native start cannot provide. */
export function nativeBlockers(app: BundleApp): string[] {
  const services = app.services ?? [];
  const bare = new Set(services.filter(s => !hasCode(s)).map(s => s.id));
  const blockers: string[] = [];
  for (const s of services.filter(hasCode)) {
    for (const dep of s.dependsOn ?? []) if (bare.has(dep)) blockers.push(`${s.id} depends on ${dep}, which only runs in a container`);
  }
  return blockers;
}

// ───────────────────────── compose ─────────────────────────

/** A minimal YAML emitter: objects, arrays, strings (always quoted), numbers, booleans. Enough for compose; no dependency. */
export function toYaml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    return value.map(v => {
      if (v && typeof v === 'object') {
        const inner = toYaml(v, indent + 1).split('\n');
        return `${pad}- ${inner[0]!.trimStart()}${inner.length > 1 ? `\n${inner.slice(1).join('\n')}` : ''}`;
      }
      return `${pad}- ${scalar(v)}`;
    }).join('\n');
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(([k, v]) => {
      if (v && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.keys(v).length)) return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
      if (v && typeof v === 'object') return `${pad}${k}: ${Array.isArray(v) ? '[]' : '{}'}`;
      return `${pad}${k}: ${scalar(v)}`;
    }).join('\n');
  }
  return `${pad}${scalar(value)}`;
}

function scalar(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(String(v));
}

const secretVar = (id: string): string => `${id.toUpperCase().replace(/-/g, '_')}_PASSWORD`;

export interface RenderedCompose {
  compose: string;
  /** Extra files to write beside it (path relative to the app). */
  files: Record<string, string>;
  /** `.env` keys the compose file needs, which the generator fills with random values. */
  secretKeys: string[];
  /** Whether a Traefik single origin is in front of the frontend and API. */
  proxy: boolean;
}

/** Container-side port of a service in compose. */
function composePort(s: AppService): number {
  return s.port ?? s.stack?.docker?.containerPort ?? ROLE_DEFAULTS[s.role]?.port ?? 8080;
}

/** The compose file for a bundle's services. Throws on anything a manifest may not ask for. */
export function renderCompose(app: BundleApp): RenderedCompose {
  const services = app.services ?? [];
  const ordered = dependencyOrder(services) ?? services;
  const frontend = services.find(s => s.role === 'frontend' && hasCode(s));
  const api = services.find(s => s.role === 'api' && hasCode(s));
  const proxy = !!(frontend && api);
  const preview = previewService(app);
  const secretKeys = new Set<string>();
  const ctx = (self: string): WireContext => ({
    hostOf: id => id,
    portOf: id => { const s = services.find(x => x.id === id); return s ? composePort(s) : undefined; },
    self,
    secret: id => { const key = secretVar(id); secretKeys.add(key); return `\${${key}:?set ${key} in .env}`; },
  });

  const out: Record<string, Record<string, unknown>> = {};
  const volumes: Record<string, Record<string, never>> = {};
  const healthy = new Map<string, boolean>();

  for (const s of ordered) {
    const def = ROLE_DEFAULTS[s.role];
    const entry: Record<string, unknown> = {};
    const env: Record<string, string> = {};
    if (hasCode(s)) {
      entry.build = { context: `./${servicePath(s)}` };
      entry.image = `aico-${app.slug}-${s.id}`;
      const port = composePort(s);
      env.PORT = String(port);
      env.HOST = '0.0.0.0';
      for (const [k, v] of Object.entries({ ...(s.run?.env ?? {}), ...(s.env ?? {}) })) env[k] = wire(v, ctx(s.id));
      entry.expose = [String(port)];
    } else {
      const image = s.image ?? def?.image;
      if (!image) throw new Error(`service "${s.id}" has no image and no default for role "${s.role}"`);
      entry.image = image;
      const port = composePort(s);
      entry.expose = [String(port)];
      for (const [k, v] of Object.entries({ ...(def?.env ?? {}), ...(s.compose?.env ?? {}), ...(s.env ?? {}) })) env[k] = wire(v, ctx(s.id));
      const vols = s.compose?.volumes ?? def?.volumes ?? [];
      for (const v of vols) {
        if (!NAMED_VOLUME.test(v)) throw new Error(`service "${s.id}": volume "${v}" must be a named volume (name:/container/path); bind mounts are not accepted`);
        entry.volumes = [...((entry.volumes as string[] | undefined) ?? []), v];
        volumes[v.split(':')[0]!] = {};
      }
      const command = s.compose?.command ? s.compose.command.split(/\s+/) : def?.command;
      if (command) entry.command = command;
      if (def?.health) {
        entry.healthcheck = { test: def.health, interval: '5s', timeout: '5s', retries: 12 };
        healthy.set(s.id, true);
      }
    }
    if (Object.keys(env).length) entry.environment = env;
    const deps = (s.dependsOn ?? []).filter(d => services.some(x => x.id === d));
    if (deps.length) {
      entry.depends_on = Object.fromEntries(deps.map(d => [d, { condition: healthy.get(d) ? 'service_healthy' : 'service_started' }]));
    }
    entry.restart = 'unless-stopped';
    entry.security_opt = ['no-new-privileges:true'];
    entry.cap_drop = ['ALL'];
    // Mailpit's UI is the one extra thing worth reaching from the host, loopback only.
    if (s.role === 'mail') entry.ports = [`127.0.0.1:\${AICO_MAIL_PORT:-8025}:8025`];
    if (!proxy && preview && s.id === preview.id) entry.ports = [`127.0.0.1:\${AICO_PREVIEW_PORT:-8080}:${composePort(s)}`];
    out[s.id] = entry;
  }

  const files: Record<string, string> = {};
  if (proxy) {
    out.proxy = {
      image: TRAEFIK_IMAGE,
      volumes: ['./deploy/traefik:/etc/traefik:ro'],
      ports: ['127.0.0.1:${AICO_PREVIEW_PORT:-8080}:80'],
      depends_on: { [frontend!.id]: { condition: 'service_started' }, [api!.id]: { condition: 'service_started' } },
      restart: 'unless-stopped',
      security_opt: ['no-new-privileges:true'],
      cap_drop: ['ALL'],
    };
    files['deploy/traefik/traefik.yml'] = [
      '# Single origin for the bundle: / goes to the frontend, /api to the API, so a cookie session needs no CORS.',
      '# Static config from files, not the Docker provider: mounting the Docker socket into a proxy is refused (ADR 0031).',
      'entryPoints:', '  web:', '    address: ":80"',
      'providers:', '  file:', '    directory: /etc/traefik', '    filename: dynamic.yml',
      'api:', '  dashboard: false', 'log:', '  level: INFO', '',
    ].join('\n');
    files['deploy/traefik/dynamic.yml'] = [
      'http:', '  routers:',
      '    api:', "      rule: PathPrefix(`/api`)", '      priority: 10', '      service: api', '      entryPoints: [web]',
      '    web:', "      rule: PathPrefix(`/`)", '      priority: 1', '      service: web', '      entryPoints: [web]',
      '  services:',
      '    api:', '      loadBalancer:', '        servers:', `          - url: "http://${api!.id}:${composePort(api!)}"`,
      '    web:', '      loadBalancer:', '        servers:', `          - url: "http://${frontend!.id}:${composePort(frontend!)}"`, '',
    ].join('\n');
  }

  const doc: Record<string, unknown> = {
    name: `aico-${app.slug}`,
    services: out,
    ...(Object.keys(volumes).length ? { volumes } : {}),
  };
  const header = [
    '# Generated by AICO from app.json "services" (ADR 0031). Edit freely: once this file exists it is yours and is not regenerated.',
    '# Secrets are read from .env (gitignored). Start: docker compose up --build --wait',
    '',
  ].join('\n');
  return { compose: `${header}${toYaml(doc)}\n`, files, secretKeys: [...secretKeys], proxy };
}

/**
 * Write the generated compose file (and Traefik config) unless the file exists,
 * and make sure every secret it interpolates exists in the gitignored `.env`.
 */
export async function writeGeneratedCompose(app: BundleApp, dir: string): Promise<{ wrote: boolean; secretKeys: string[] }> {
  const file = path.join(dir, app.compose?.file ?? 'compose.yaml');
  if (existsSync(file)) return { wrote: false, secretKeys: [] };
  const rendered = renderCompose(app);
  await writeFile(file, rendered.compose, 'utf8');
  for (const [rel, text] of Object.entries(rendered.files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text, 'utf8');
  }
  if (rendered.secretKeys.length) {
    const envPath = path.join(dir, '.env');
    let text = '';
    try { text = readFileSync(envPath, 'utf8'); } catch { /* none yet */ }
    const have = new Set([...text.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm)].map(m => m[1]));
    const add = rendered.secretKeys.filter(k => !have.has(k)).map(k => `${k}=${crypto.randomBytes(24).toString('hex')}`);
    if (add.length) {
      await writeFile(envPath, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`, 'utf8');
    }
    await ensureGitignored(dir, '.env');
  }
  return { wrote: true, secretKeys: rendered.secretKeys };
}
