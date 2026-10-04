/**
 * The environment a process the agent starts is given — and what the sinks
 * must redact because of what the engine itself holds.
 *
 * Why this exists: `loadSettings` copies `settings.env` and the providers' API
 * keys into `process.env`, because the provider adapters read them there. Every
 * child the agent then spawned — Bash, the persistent Terminal, WinRM's
 * PowerShell, custom tools, stdio MCP servers — was handed `{...process.env}`,
 * so `printenv` in the agent's own shell printed the user's OpenAI key into a
 * tool result, the session log and the stream. The vault redactor could not
 * catch it: it only knows vault values, and these never entered the vault.
 *
 * So, two things, both in trusted code rather than the prompt:
 *
 *  - **Children are scrubbed.** {@link agentChildEnv} is the parent env minus
 *    every provider-key variable and every name `settings.env` set; PATH and
 *    the rest stay, so tools keep working. A stdio MCP server is someone else's
 *    program, so {@link mcpServerEnv} gives it only a small safe base (what a
 *    process needs to find binaries, a home and a temp dir) plus the env its
 *    own config names.
 *  - **The values are redacted anyway.** {@link registerSettingsSecrets}
 *    publishes the provider keys, the `settings.env` values and every MCP
 *    server's env/header values to the sink redactor as extra entries, so a
 *    value that reaches output by another route (a config file the agent
 *    reads, a server echoing its own key) is still replaced.
 *
 * What it deliberately does not do: remove the keys from the engine's own
 * `process.env` — the providers need them there. Nor is the scrub a sandbox:
 * a child can still read `~/.aico/settings.json` from disk, which the shell
 * guard (vault/guard.ts) refuses on a best-effort basis.
 *
 * @module child-env
 */

import { setExtraRedactions } from './vault/sink.js';
import type { SecretEntry } from './vault/redact.js';

/** Every variable a provider adapter reads its key from. */
export const PROVIDER_KEY_NAMES: readonly string[] = [
  'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'DEEPSEEK_API_KEY',
];

/** Names `settings.env` put into the engine's environment. Replaced on every load. */
let settingsEnvNames = new Set<string>();

/** Upper-cased on Windows, where environment names are case-insensitive. */
function norm(name: string): string {
  return process.platform === 'win32' ? name.toUpperCase() : name;
}

function scrubbedNames(): Set<string> {
  return new Set([...PROVIDER_KEY_NAMES, ...settingsEnvNames].map(norm));
}

/**
 * The environment for a process the agent starts: the engine's own, minus
 * provider keys and `settings.env` names, plus `extra` (which wins — it is
 * what trusted code chose to bind for this one child, e.g. a resolved secret).
 */
export function agentChildEnv(extra?: Record<string, string | undefined>, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const drop = scrubbedNames();
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || drop.has(norm(k))) continue;
    env[k] = v;
  }
  for (const [k, v] of Object.entries(extra ?? {})) if (v !== undefined) env[k] = v;
  return env;
}

/**
 * What any process needs to start: find binaries, a home, a temp dir, a
 * locale, the corporate proxy/CA. Modelled on the MCP SDK's default list.
 */
const SAFE_BASE = [
  'PATH', 'PATHEXT', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP',
  'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE', 'USERNAME', 'SYSTEMDRIVE', 'SYSTEMROOT',
  'WINDIR', 'COMSPEC', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS', 'OS', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS',
];

/** A stdio MCP server's environment: the safe base plus its own configured env. */
export function mcpServerEnv(configured?: Record<string, string>, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allow = new Set(SAFE_BASE.map(norm));
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && allow.has(norm(k))) env[k] = v;
  }
  return { ...env, ...(configured ?? {}) };
}

/** The subset of settings this module reads (structural, so settings.ts need not be imported). */
export interface SecretBearingSettings {
  env?: Record<string, string>;
  providers?: Record<string, { apiKey?: string } | undefined>;
  providerInstances?: Array<{ id?: string; apiKey?: string }>;
  mcpServers?: Record<string, { env?: Record<string, string>; headers?: Record<string, string> } | undefined>;
}

/**
 * Record which names `settings.env` set (so children lose them) and publish
 * every credential-shaped value the settings hold to the sink redactor.
 * Called by `loadSettings` each time it runs; each call replaces the last.
 */
export function registerSettingsSecrets(settings: SecretBearingSettings): void {
  settingsEnvNames = new Set(Object.keys(settings.env ?? {}));
  const entries: SecretEntry[] = [];
  const add = (name: string, value: unknown): void => {
    if (typeof value === 'string' && value) entries.push({ name, values: [value] });
  };
  for (const [k, v] of Object.entries(settings.env ?? {})) add(`env.${k}`, v);
  for (const [family, cfg] of Object.entries(settings.providers ?? {})) add(`providers.${family}.apiKey`, cfg?.apiKey);
  for (const inst of settings.providerInstances ?? []) add(`providerInstances.${inst.id ?? '?'}.apiKey`, inst.apiKey);
  for (const [server, cfg] of Object.entries(settings.mcpServers ?? {})) {
    for (const [k, v] of Object.entries(cfg?.env ?? {})) add(`mcpServers.${server}.env.${k}`, v);
    for (const [k, v] of Object.entries(cfg?.headers ?? {})) {
      add(`mcpServers.${server}.headers.${k}`, v);
      // `Authorization: Bearer <token>` — the token alone is what gets echoed.
      const bare = /^\s*(?:Bearer|Basic|Token)\s+(\S+)\s*$/i.exec(v)?.[1];
      if (bare) add(`mcpServers.${server}.headers.${k}`, bare);
    }
  }
  // Provider keys that came from the user's own environment rather than settings.
  for (const name of PROVIDER_KEY_NAMES) add(`env.${name}`, process.env[name]);
  setExtraRedactions('settings', entries);
}
