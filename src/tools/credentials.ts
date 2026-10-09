/**
 * The model's three credential tools. None of them returns a secret.
 *
 * The model works with *names*. It can see what is stored (metadata), ask a
 * person to enter something (the person types it into a prompt the model
 * cannot read), and create a random credential for a place it is setting up.
 * It uses a credential by writing `{{secret:name}}` where the value should go
 * — in a trusted tool's arguments, or in a Bash command when the credential
 * allows that — and trusted code substitutes the value after the policy and,
 * where required, a person have agreed.
 *
 * The descriptions below are the contract as the model reads it, so they say
 * plainly what is and is not possible. A model told only "use CredentialList"
 * will try `cat ~/.aico/vault/vault.json` the moment a task gets hard.
 *
 * @module tools/credentials
 */

import { currentRunContext } from '../run-context.js';
import { getVault } from '../vault/index.js';
import { referenceFor } from '../vault/placeholders.js';
import { effectiveScope } from '../vault/policy.js';
import { CREDENTIAL_KINDS, VaultError, type CredentialKind, type CredentialSummary } from '../vault/types.js';

const CONTRACT = 'You never see credential values, and no tool will show them to you. Refer to a stored credential as '
  + '{{secret:NAME}} (or {{secret:NAME.field}}) and trusted code substitutes it at the moment of use, if its policy allows. '
  + 'In Bash that works only for credentials that allow shell use, and a person approves each such command. '
  + 'Do not try to read the vault\'s files, a keyring, or process memory — those attempts are blocked and audited.';

function describe(c: CredentialSummary): Record<string, unknown> {
  const scope = effectiveScope(c, c.policy);
  return {
    name: c.name,
    reference: referenceFor(c.name),
    kind: c.kind,
    fields: c.fields,
    ...(c.username ? { username: c.username } : {}),
    ...(c.host ? { host: c.host } : {}),
    ...(c.port ? { port: c.port } : {}),
    ...(c.url ? { url: c.url } : {}),
    ...(c.description ? { description: c.description } : {}),
    ...(c.tags.length ? { tags: c.tags } : {}),
    ...(c.public?.publicKey ? { publicKey: c.public.publicKey, fingerprint: c.public.fingerprint } : {}),
    usableWith: scope.hosts.length || scope.origins.length ? [...scope.hosts, ...scope.origins] : 'any target, with a person approving each use',
    ...(c.policy.allowedTools.length ? { tools: c.policy.allowedTools } : {}),
    shell: c.policy.allowShell ? 'allowed, each command approved by a person' : 'not allowed',
    approval: c.policy.approval,
    ...(c.policy.expiresAt ? { expires: new Date(c.policy.expiresAt).toISOString() } : {}),
    createdBy: c.createdBy.startsWith('agent:') ? 'agent' : 'user',
    ...(c.quarantined ? { quarantined: true } : {}),
  };
}

// ── CredentialList ───────────────────────────────────────────────────

export const credentialListDefinition = {
  name: 'CredentialList',
  description: 'List the credentials in the vault: names, kinds, usernames, hosts they are bound to, and how they may be used. '
    + 'Metadata only. ' + CONTRACT,
  inputSchema: {
    type: 'object' as const,
    properties: {
      host: { type: 'string', description: 'Only credentials bound to (or mentioning) this host, URL or origin.' },
      kind: { type: 'string', enum: [...CREDENTIAL_KINDS], description: 'Only this kind.' },
    },
  },
};

export async function credentialList(input: { host?: string; kind?: string }): Promise<unknown> {
  const vault = getVault();
  const st = vault.status();
  if (!st.exists) return { credentials: [], note: 'The vault is empty. Use CredentialGenerate or CredentialRequest to add one.' };
  try {
    const kind = CREDENTIAL_KINDS.includes(input.kind as CredentialKind) ? input.kind as CredentialKind : undefined;
    const creds = await vault.list({ ...(input.host ? { host: input.host } : {}), ...(kind ? { kind } : {}) });
    return { credentials: creds.map(describe), count: creds.length };
  } catch (err) {
    return { error: err instanceof VaultError ? err.message : 'The vault could not be read.' };
  }
}

// ── CredentialRequest ────────────────────────────────────────────────

export const credentialRequestDefinition = {
  name: 'CredentialRequest',
  description: 'Ask the person to enter a credential you need and do not have (a password, token, key). They type it into a '
    + 'secure prompt you cannot read; it is stored in the vault bound to the host you name. You get back only "stored as '
    + 'NAME", "declined" or "timed out". Say clearly in `reason` what it is for. Prefer CredentialGenerate when you are '
    + 'creating the account yourself. ' + CONTRACT,
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Name to store it under: letters, digits, - and _. E.g. "nas-admin".' },
      kind: { type: 'string', enum: [...CREDENTIAL_KINDS], description: 'What it is.' },
      host: { type: 'string', description: 'Host it is for, e.g. 10.0.0.5. It will only be usable there.' },
      url: { type: 'string', description: 'Origin/URL it is for, e.g. https://10.0.0.5:8443.' },
      username: { type: 'string', description: 'Account name, if known.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Secret fields wanted (default: the kind\'s main one, e.g. password).' },
      reason: { type: 'string', description: 'Shown to the person: what you will do with it.' },
    },
    required: ['name', 'kind', 'reason'],
  },
};

export async function credentialRequest(input: {
  name: string; kind: string; host?: string; url?: string; username?: string; fields?: string[]; reason: string;
}): Promise<unknown> {
  if (!CREDENTIAL_KINDS.includes(input.kind as CredentialKind)) return { error: `Unknown kind "${input.kind}".` };
  if (!input.reason?.trim()) return { error: 'Say in `reason` what the credential is for; the person sees it.' };
  const sessionId = currentRunContext()?.sessionId;
  try {
    const outcome = await getVault().requestFromHuman({
      name: input.name,
      kind: input.kind as CredentialKind,
      reason: input.reason.trim().slice(0, 500),
      ...(input.host ? { host: input.host } : {}),
      ...(input.url ? { url: input.url } : {}),
      ...(input.username ? { username: input.username } : {}),
      ...(input.fields?.length ? { fields: input.fields } : {}),
      ...(sessionId ? { sessionId } : {}),
    });
    switch (outcome.status) {
      case 'stored': return { result: `stored as ${outcome.name}`, reference: outcome.reference };
      case 'exists': return { result: `A credential named "${input.name}" already exists. Use it as ${referenceFor(input.name)}, or ask under another name.` };
      case 'declined': return { result: 'declined — the person chose not to provide it.' };
      case 'timeout': return { result: 'timed out — nobody answered.' };
      default: return { result: `unavailable — ${outcome.reason}` };
    }
  } catch (err) {
    return { error: err instanceof VaultError ? err.message : 'The credential request failed.' };
  }
}

// ── CredentialGenerate ───────────────────────────────────────────────

const GENERATABLE = ['login', 'ssh-key', 'ssh-password', 'api-token', 'basic-auth', 'winrm', 'database', 'generic'] as const;

export const credentialGenerateDefinition = {
  name: 'CredentialGenerate',
  description: 'Create a strong random credential and store it in the vault, bound to the host/URL it is for — e.g. the '
    + 'admin password for a service you are installing, or an SSH key pair. You get back its reference ({{secret:NAME}}) '
    + 'and the non-secret parts (username, SSH public key and fingerprint) — never the value. Use the reference where '
    + 'the password must go. Set allowShell only if a Bash command must contain it; a person then approves each such '
    + 'command. ' + CONTRACT,
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Name to store it under: letters, digits, - and _. E.g. "grafana-admin".' },
      kind: { type: 'string', enum: [...GENERATABLE], description: 'login/database/… get a password; ssh-key an ed25519 key pair; api-token a random token.' },
      username: { type: 'string', description: 'The account name this is for.' },
      host: { type: 'string', description: 'Host it will be used with, e.g. 10.0.0.5. Scope: it will only be usable there.' },
      port: { type: 'number' },
      url: { type: 'string', description: 'Origin it will be used with, e.g. https://10.0.0.5:8443 (write http:// explicitly for a plain-http LAN service).' },
      description: { type: 'string' },
      length: { type: 'number', description: 'Password length, default 24.' },
      symbols: { type: 'boolean', description: 'Include symbols (default true). Turn off for services that reject them.' },
      allowShell: { type: 'boolean', description: 'Allow {{secret:NAME}} in Bash commands (each approved by a person). Default false.' },
      allowSelfSigned: { type: 'boolean', description: 'The service uses a self-signed certificate on its origin.' },
    },
    required: ['name', 'kind'],
  },
};

export async function credentialGenerate(input: {
  name: string; kind: string; username?: string; host?: string; port?: number; url?: string; description?: string;
  length?: number; symbols?: boolean; allowShell?: boolean; allowSelfSigned?: boolean;
}): Promise<unknown> {
  if (!(GENERATABLE as readonly string[]).includes(input.kind)) return { error: `Cannot generate a "${input.kind}". Kinds: ${GENERATABLE.join(', ')}.` };
  const sessionId = currentRunContext()?.sessionId ?? 'cli';
  try {
    const out = await getVault().generate({
      name: input.name,
      kind: input.kind as (typeof GENERATABLE)[number],
      ...(input.username ? { username: input.username } : {}),
      ...(input.host ? { host: input.host } : {}),
      ...(input.port ? { port: input.port } : {}),
      ...(input.url ? { url: input.url } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.length ? { length: input.length } : {}),
      ...(input.symbols === false ? { symbols: false } : {}),
      ...(input.allowShell ? { allowShell: true } : {}),
      ...(input.allowSelfSigned ? { allowSelfSigned: true } : {}),
    }, `agent:${sessionId.replace(/[^\w.-]/g, '').slice(0, 100) || 'unknown'}`);
    return {
      result: `Generated and stored as ${out.name}. Use ${out.reference} where the value must go; you will not see it.`,
      ...out,
    };
  } catch (err) {
    return { error: err instanceof VaultError ? err.message : 'The credential could not be generated.' };
  }
}

/**
 * How every registered tool relates to the vault. The registry invariant test
 * fails for any tool missing from here, so adding a tool forces the question
 * "can this return a secret?" to be answered — by a person, in review.
 *
 *  - `metadata`: reads the vault, returns metadata only (these three).
 *  - `consumer`: resolves credentials through `vault.resolve()` and must never
 *    return a value (future SSH/HTTP/WinRM tools register here).
 *  - everything else is `none`: never touches the vault. Their output still
 *    passes the redactor, which the same test proves for every tool.
 */
export const VAULT_TOOL_CLASSES: Readonly<Record<string, 'metadata' | 'consumer'>> = {
  CredentialList: 'metadata',
  CredentialRequest: 'metadata',
  CredentialGenerate: 'metadata',
  // Substitutes {{secret:…}} via the vault:placeholders pipeline stage.
  Bash: 'consumer',
  // AICO Desktop's browser login (desktop/electron/mcp.ts, browser-login.ts):
  // takes a credential NAME; desktop main resolves it over the private host
  // channel for the page's exact origin (use tool `browser_login`), types it
  // with trusted input events, and returns only "signed in / refused: …".
  'mcp__aico-desktop__browser_login': 'consumer',
  // The ops tools (tools/ops/**): each resolves a credential for the exact
  // host/origin it then contacts and returns no value. docs/security/ops-tools.md.
  SshExec: 'consumer',
  SshCopy: 'consumer',
  SshTunnel: 'consumer',
  HttpRequest: 'consumer',
  WinRmExec: 'consumer',
  SnmpQuery: 'consumer',
  // Tests a connection through the broker (ADR 0039); no action takes or returns a token.
  ConnectionManage: 'consumer',
};

/** Register a future consumer tool (documented hook; see docs/security/credential-broker.md). */
export function registerVaultConsumerTool(name: string): void {
  (VAULT_TOOL_CLASSES as Record<string, 'metadata' | 'consumer'>)[name] = 'consumer';
}
