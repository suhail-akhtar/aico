/**
 * MCP server secrets live in the credential vault, not in settings files.
 *
 * An MCP server's API key used to sit in plaintext in `env` or `headers` of a
 * settings file — readable by any tool that could read a file, copied into
 * every `McpManage read`, exported verbatim. Now:
 *
 * - `env` and `headers` values may contain `{{secret:name}}`. They are
 *   substituted when the server is spawned or connected, by the registry,
 *   through the vault's own `resolve()` under the tool name `mcp:<server>` —
 *   so the credential's policy (allowed tools, origins, approval) applies, the
 *   use is audited, and the value is in the redaction index from then on.
 * - A literal secret in a config AICO is about to write (add, update, paste,
 *   import) is moved into the vault first and the reference written instead.
 *   It is moved rather than "offered": the alternative is writing it to disk
 *   in the clear, which is the thing being removed. When there is no usable
 *   vault (nothing can seal its key), the literal is kept and the reply says so.
 * - `migrateMcpSecrets()` does the same for configs already on disk, after
 *   copying each settings file it changes to `<file>.bak-<time>`.
 * - `maskLiterals()` is what `read` and `export` show: references as they
 *   are, any literal left over replaced by a marker. Export never writes a value.
 *
 * A moved credential is bound to `mcp:<server>` (and, for a URL server, to its
 * origin) with `approval: auto`, which is how the plaintext was used before:
 * at every start, without asking. It cannot be used by anything else.
 *
 * Detection is by key name (`*_TOKEN`, `Authorization`, …) plus the vault's
 * own high-confidence scanner, never a guess on the value alone.
 *
 * @module mcp/secrets
 */

import fs from 'node:fs';
import path from 'node:path';
import { aicoHome } from '../home.js';
import { getVault, resolve as resolveCredential } from '../vault/index.js';
import { hasPlaceholders, referenceFor, substitutePlaceholders } from '../vault/placeholders.js';
import { looksLikeSecret, scanForSecrets } from '../vault/scan.js';
import type { CreatedBy } from '../vault/types.js';
import { carryTrustAcrossOwnWrite, projectTrustStatus } from '../workspace-trust.js';
import type { McpServerConfigV2 } from './base.js';

const SECRET_KEY_RE = /token|secret|passw|pwd|api[_-]?key|apikey|auth|credential|private[_-]?key|access[_-]?key|bearer|cookie/i;
const MASK = '<secret: not shown>';

/** Whether one env/header value is a literal secret that belongs in the vault. */
export function isLiteralSecret(key: string, value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || hasPlaceholders(value)) return false;
  const bare = splitScheme(value).secret;
  return (SECRET_KEY_RE.test(key) && looksLikeSecret(bare, '=')) || scanForSecrets(value).length > 0;
}

/** `Bearer abc` → the scheme is kept in the config, only `abc` is the secret. */
function splitScheme(value: string): { prefix: string; secret: string } {
  const m = /^(Bearer|Basic|Token|Bot)\s+(\S.*)$/i.exec(value.trim());
  return m ? { prefix: `${m[1]} `, secret: m[2]! } : { prefix: '', secret: value.trim() };
}

function originOf(config: McpServerConfigV2): string | undefined {
  if (!config.url) return undefined;
  try { return new URL(config.url).origin; } catch { return undefined; }
}

/** The config with every literal secret in env/headers replaced by a marker. */
export function maskLiterals(config: McpServerConfigV2): McpServerConfigV2 {
  const mask = (map?: Record<string, string>) => map
    ? Object.fromEntries(Object.entries(map).map(([k, v]) => [k, isLiteralSecret(k, v) ? MASK : v]))
    : undefined;
  return {
    ...config,
    ...(config.env ? { env: mask(config.env)! } : {}),
    ...(config.headers ? { headers: mask(config.headers)! } : {}),
  };
}

/** Whether a config still holds a literal secret. */
export function hasLiteralSecrets(config: McpServerConfigV2): boolean {
  return [config.env, config.headers].some(map => map && Object.entries(map).some(([k, v]) => isLiteralSecret(k, v)));
}

/**
 * Substitute `{{secret:…}}` in env and headers for one spawn or connect.
 * Throws a value-free error when a reference cannot be used (missing, locked,
 * not allowed for `mcp:<server>`, declined).
 */
export async function resolveConfigSecrets(server: string, config: McpServerConfigV2): Promise<McpServerConfigV2> {
  const maps = [config.env, config.headers];
  if (!maps.some(map => map && Object.values(map).some(v => typeof v === 'string' && hasPlaceholders(v)))) return config;
  const origin = originOf(config);
  const use = {
    tool: `mcp:${server}`,
    purpose: `start the MCP server "${server}"`,
    ...(origin ? { origin } : {}),
  };
  const sub = async (map?: Record<string, string>) => {
    if (!map) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
      out[k] = typeof v === 'string' && hasPlaceholders(v)
        ? await substitutePlaceholders(v, async ref => {
          const secret = await resolveCredential(ref.field ? `${ref.name}.${ref.field}` : ref.name, use);
          try { return secret.value(ref.field); } finally { secret.release(); }
        })
        : v;
    }
    return out;
  };
  try {
    const env = await sub(config.env);
    const headers = await sub(config.headers);
    return { ...config, ...(env ? { env } : {}), ...(headers ? { headers } : {}) };
  } catch (err) {
    throw new Error(`a {{secret:…}} in its env/headers could not be used: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function credentialName(server: string, key: string, taken: (name: string) => Promise<boolean>): Promise<string> {
  const base = `mcp-${server}-${key}`.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 58) || 'mcp-secret';
  return (async () => {
    for (let i = 1; i < 100; i++) {
      const name = i === 1 ? base : `${base}-${i}`;
      if (!await taken(name)) return name;
    }
    return `${base}-${Date.now().toString(36)}`;
  })();
}

export interface MoveResult {
  config: McpServerConfigV2;
  /** `env.API_KEY → {{secret:mcp-github-API_KEY}}`, one per moved value. */
  moved: string[];
  /** Set when literals were found but could not be moved (the vault is unavailable). */
  problem?: string;
}

/** Move every literal secret in one server's env/headers into the vault. */
export async function moveLiteralSecrets(server: string, config: McpServerConfigV2, createdBy: CreatedBy): Promise<MoveResult> {
  if (!hasLiteralSecrets(config)) return { config, moved: [] };
  const vault = getVault();
  const origin = originOf(config);
  const moved: string[] = [];
  const taken = async (name: string) => { try { await vault.get(name); return true; } catch { return false; } };
  const next: McpServerConfigV2 = { ...config };
  try {
    for (const section of ['env', 'headers'] as const) {
      const map = config[section];
      if (!map) continue;
      const out: Record<string, string> = { ...map };
      for (const [key, value] of Object.entries(map)) {
        if (!isLiteralSecret(key, value)) continue;
        const { prefix, secret } = splitScheme(value);
        const name = await credentialName(server, key, taken);
        await vault.create({
          name,
          kind: 'api-token',
          secret: { token: secret },
          description: `MCP server "${server}" ${section === 'env' ? 'environment variable' : 'header'} ${key}`,
          tags: ['mcp'],
          ...(origin ? { url: origin } : {}),
          policy: {
            allowedTools: [`mcp:${server}`],
            approval: 'auto',
            ...(origin ? { allowedOrigins: [origin] } : {}),
          },
          createdBy,
        });
        out[key] = `${prefix}${referenceFor(name)}`;
        moved.push(`${section}.${key} → ${referenceFor(name)}`);
      }
      next[section] = out;
    }
  } catch (err) {
    return {
      config,
      moved: [],
      problem: `could not move its secret value(s) into the credential vault (${err instanceof Error ? err.message : String(err)}); `
        + 'they stay in the settings file in plaintext until the vault is available — then run /mcp-secure',
    };
  }
  return { config: next, moved };
}

/** One line for a reply after a move: what moved, or why nothing could. */
export function describeMove(server: string, result: MoveResult): string {
  if (result.problem) return `WARNING: "${server}" ${result.problem}.`;
  if (!result.moved.length) return '';
  return `Moved ${result.moved.length} secret value(s) of "${server}" into the credential vault (settings hold only the reference): ${result.moved.join('; ')}.`;
}

/**
 * Move literal secrets out of every MCP server entry in the settings files
 * this process reads (global, project, project-local). Each file changed is
 * backed up first. A project file AICO rewrites keeps the trust it had.
 */
export async function migrateMcpSecrets(cwd = process.cwd(), createdBy: CreatedBy = 'user'): Promise<string[]> {
  const files = [
    path.join(aicoHome(), 'settings.json'),
    path.join(cwd, '.aico', 'settings.json'),
    path.join(cwd, '.aico', 'settings.local.json'),
  ];
  const report: string[] = [];
  const trustBefore = await projectTrustStatus(cwd);
  let touchedProject = false;
  for (const file of files) {
    let root: Record<string, unknown>;
    try { root = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { continue; }
    const servers = root.mcpServers as Record<string, McpServerConfigV2> | undefined;
    if (!servers || typeof servers !== 'object') continue;
    const names = Object.keys(servers).filter(n => servers[n] && hasLiteralSecrets(servers[n]!));
    if (!names.length) continue;
    const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const updated = { ...servers };
    const lines: string[] = [];
    for (const name of names) {
      const result = await moveLiteralSecrets(name, servers[name]!, createdBy);
      if (result.moved.length) updated[name] = result.config;
      const line = describeMove(name, result);
      if (line) lines.push(`  ${line}`);
    }
    if (JSON.stringify(updated) === JSON.stringify(servers)) {
      report.push(`${file}:`, ...lines);
      continue;
    }
    fs.copyFileSync(file, backup);
    fs.writeFileSync(file, JSON.stringify({ ...root, mcpServers: updated }, null, 2));
    if (file !== files[0]) touchedProject = true;
    report.push(`${file} (backup with the old plaintext: ${backup} — delete it once the servers start):`, ...lines);
  }
  if (touchedProject) await carryTrustAcrossOwnWrite(cwd, trustBefore);
  return report.length ? report : ['No MCP server in your settings holds a literal secret.'];
}
