/**
 * The vault on disk and in memory: create, list, change and remove
 * credentials.
 *
 * Two files under `<AICO_HOME>/vault/`: `key.json` (how the master key is
 * sealed — never the key) and `vault.json` (the sealed records). The store
 * decrypts every record once at unlock, which both verifies the whole file and
 * gives the redactor its index, and keeps them in memory until lock.
 *
 * **There is no method here that returns a secret to an arbitrary caller.**
 * `list()` and `get()` return metadata and policy. The single accessor for
 * values, {@link VaultStore.secretOf}, is used by the vault service's
 * `resolve()` (policy-checked, audited) and `reveal()` (human grant), and is
 * not re-exported from the package's public entry point.
 *
 * Every write re-reads the file under the cross-process lock first, so the CLI
 * and a running server can both change the vault without one silently undoing
 * the other.
 *
 * @module vault/store
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  deriveKeys, FILE_FORMAT, FILE_VERSION, macRecords, migrateFile, newMasterKey, openRecord, parseVaultFile,
  sealRecord, verifyFile, withFileLock, writeFileAtomic, type DerivedKeys, type SealedRecord, type VaultFile,
} from './crypto.js';
import {
  BUILTIN_PROVIDERS, checkGrantVerifier, defaultKeyProvider, makeGrantVerifier,
  type KeyDescriptor, type KeyProvider,
} from './keys.js';
import { normalizePolicy } from './policy.js';
import { FULL_ENCODING_LENGTH, MIN_SECRET_LENGTH, type SecretEntry } from './redact.js';
import {
  CREDENTIAL_KINDS, DEFAULT_POLICY, NAME_RE, SECRET_FIELDS, VaultError, VaultLockedError,
  VaultUnavailableError, CredentialNotFoundError,
  type CreatedBy, type CredentialKind, type CredentialMeta, type CredentialRecord, type CredentialSummary,
  type Policy, type PublicParts,
} from './types.js';

/** What a caller supplies to create a credential. */
export interface CreateInput {
  name: string;
  kind: CredentialKind;
  secret: Record<string, string>;
  username?: string;
  host?: string;
  port?: number;
  url?: string;
  description?: string;
  tags?: string[];
  public?: PublicParts;
  policy?: Partial<Policy>;
  createdBy: CreatedBy;
  quarantined?: boolean;
}

/** Metadata a caller may change after creation. */
export type MetaPatch = Partial<Pick<CredentialMeta, 'username' | 'host' | 'port' | 'url' | 'description' | 'tags' | 'quarantined' | 'name'>>;

const MAX_FIELD_BYTES = 64 * 1024;
const MAX_META = 2_000;
/** Idle time after which an interactive (passphrase) vault locks itself. */
export const DEFAULT_AUTO_LOCK_MS = 15 * 60 * 1000;

function cleanText(v: unknown, max = MAX_META): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

/** Levenshtein distance, for "did you mean" on names. */
function distance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/** Names close to `ref`, for an error message. Names only — never values. */
export function similarNames(ref: string, names: string[]): string[] {
  const r = ref.toLowerCase();
  return names
    .map(n => ({ n, d: n.toLowerCase().includes(r) || r.includes(n.toLowerCase()) ? 0 : distance(r, n.toLowerCase()) }))
    .filter(x => x.d <= Math.max(2, Math.floor(r.length / 3)))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map(x => x.n);
}

export interface VaultStoreOptions {
  dir: string;
  /**
   * Provider to seal a *new* vault with, and to reopen a vault whose key file
   * names the same kind. Defaults to the platform's (see keys.ts).
   */
  keyProvider?: KeyProvider;
  providerPreference?: string;
  autoLockMs?: number;
  now?: () => number;
}

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  provider?: string;
  /** A human must type a passphrase to unlock it. */
  interactive: boolean;
  count: number;
  /** A standalone human-grant passphrase is configured. */
  grantPassphrase: boolean;
}

export class VaultStore {
  readonly dir: string;
  readonly keyFile: string;
  readonly dataFile: string;
  readonly lockFile: string;

  private keys: DerivedKeys | undefined;
  private descriptor: KeyDescriptor | undefined;
  private provider: KeyProvider | undefined;
  private records = new Map<string, CredentialRecord>();
  private sealed = new Map<string, SealedRecord>();
  private stamp = '';
  private idle: NodeJS.Timeout | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly options: VaultStoreOptions) {
    this.dir = options.dir;
    this.keyFile = path.join(this.dir, 'key.json');
    this.dataFile = path.join(this.dir, 'vault.json');
    this.lockFile = path.join(this.dir, 'vault.lock');
    this.now = options.now ?? Date.now;
  }

  /** Stable per-vault id for keyring item names. */
  get vaultId(): string {
    return crypto.createHash('sha256').update(path.resolve(this.dir).toLowerCase()).digest('hex').slice(0, 16);
  }

  /** Called after any change to the credential set (for the redactor and the UI). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed(): void {
    for (const l of this.listeners) { try { l(); } catch { /* a listener must not break a write */ } }
  }

  exists(): boolean {
    return fs.existsSync(this.keyFile);
  }

  isUnlocked(): boolean {
    return this.keys !== undefined;
  }

  private readDescriptor(): KeyDescriptor {
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(this.keyFile, 'utf8')); } catch {
      throw new VaultError('format', 'The vault key file is missing or unreadable.');
    }
    const d = raw as KeyDescriptor;
    if (!d || typeof d.provider !== 'string') throw new VaultError('format', 'The vault key file is malformed.');
    return d;
  }

  status(): VaultStatus {
    const exists = this.exists();
    let descriptor: KeyDescriptor | undefined;
    if (exists) { try { descriptor = this.descriptor ?? this.readDescriptor(); } catch { /* reported as unknown */ } }
    return {
      exists,
      unlocked: this.isUnlocked(),
      ...(descriptor ? { provider: descriptor.provider } : {}),
      interactive: descriptor?.provider === 'passphrase',
      count: this.records.size,
      grantPassphrase: Boolean(descriptor?.grant) || descriptor?.provider === 'passphrase',
    };
  }

  private providerFor(kind: string): KeyProvider {
    if (this.options.keyProvider && this.options.keyProvider.kind === kind) return this.options.keyProvider;
    const builtin = BUILTIN_PROVIDERS[kind as keyof typeof BUILTIN_PROVIDERS];
    if (!builtin) throw new VaultUnavailableError(`This vault was sealed with "${kind}", which this process cannot open.`);
    return builtin;
  }

  /**
   * Create an empty vault. Refuses if one exists — replacing a vault is a
   * delete, and deletes are the owner's to make.
   */
  async init(opts: { passphrase?: string } = {}): Promise<void> {
    if (this.exists()) throw new VaultError('exists', 'A credential vault already exists here.');
    const provider = this.options.keyProvider ?? await defaultKeyProvider(this.options.providerPreference);
    if (!(await provider.available()) && provider.kind !== 'injected') {
      throw new VaultUnavailableError(`The ${provider.kind} key store is not available, so secrets cannot be stored. `
        + 'AICO never falls back to storing them unsealed.');
    }
    if (provider.interactive && !opts.passphrase) {
      throw new VaultUnavailableError('No OS keyring is available here. Create the vault with a passphrase: `aico vault init`.');
    }
    // An injected provider's key *is* the host's key; inventing one here would
    // seal the vault with a key nobody keeps.
    const master = provider.providedMaster?.() ?? (provider.kind === 'injected' ? undefined : newMasterKey());
    if (!master) throw new VaultLockedError('The vault key is held by AICO Desktop and has not been handed to this engine yet.');
    const sealedKey = await provider.seal(master, { vaultId: this.vaultId, ...(opts.passphrase ? { passphrase: opts.passphrase } : {}) });
    const keys = deriveKeys(master);
    master.fill(0);
    const descriptor: KeyDescriptor = { provider: provider.kind, kcv: keys.kcv, ...sealedKey };
    withFileLock(this.lockFile, () => {
      if (fs.existsSync(this.keyFile)) throw new VaultError('exists', 'A credential vault already exists here.');
      const file: VaultFile = { format: FILE_FORMAT, version: FILE_VERSION, kcv: keys.kcv, records: [], mac: macRecords(keys, []) };
      writeFileAtomic(this.dataFile, JSON.stringify(file, null, 1));
      writeFileAtomic(this.keyFile, JSON.stringify(descriptor, null, 1));
    });
    this.keys = keys;
    this.descriptor = descriptor;
    this.provider = provider;
    this.records.clear();
    this.sealed.clear();
    this.stamp = this.fileStamp();
    this.armIdle();
    this.changed();
  }

  /** Unseal the master key and load every record. */
  async unlock(opts: { passphrase?: string } = {}): Promise<void> {
    if (!this.exists()) throw new VaultUnavailableError('There is no credential vault yet.');
    const descriptor = this.readDescriptor();
    const provider = this.providerFor(descriptor.provider);
    const master = await provider.unseal(descriptor, { vaultId: this.vaultId, ...(opts.passphrase ? { passphrase: opts.passphrase } : {}) });
    const keys = deriveKeys(master);
    master.fill(0);
    if (descriptor.kcv && descriptor.kcv !== keys.kcv) {
      throw new VaultError('wrong-passphrase', 'The key this vault was opened with is not the key it was sealed with.');
    }
    this.keys = keys;
    this.descriptor = descriptor;
    this.provider = provider;
    try {
      this.load();
    } catch (err) {
      this.keys = undefined;
      throw err;
    }
    this.armIdle();
    this.changed();
  }

  /** Forget the key and every decrypted record. */
  lock(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    if (this.keys) { this.keys.enc.fill(0); this.keys.mac.fill(0); }
    this.keys = undefined;
    this.records.clear();
    this.sealed.clear();
    this.stamp = '';
    this.changed();
  }

  /** Verify a passphrase for a human grant, without changing lock state. */
  async verifyHumanPassphrase(passphrase: string): Promise<boolean> {
    if (!this.exists()) return false;
    const d = this.readDescriptor();
    if (d.provider === 'passphrase') {
      try {
        const key = await this.providerFor('passphrase').unseal(d, { vaultId: this.vaultId, passphrase });
        key.fill(0);
        return true;
      } catch { return false; }
    }
    return d.grant ? checkGrantVerifier(d.grant, passphrase) : false;
  }

  /**
   * Set (or change) the standalone grant passphrase. Changing one that exists
   * needs the current one — otherwise whoever reaches this first owns every
   * future reveal.
   */
  setGrantPassphrase(next: string, current?: string): void {
    withFileLock(this.lockFile, () => {
      const d = this.readDescriptor();
      if (d.provider === 'passphrase') throw new VaultError('invalid', 'A passphrase vault uses its own passphrase for grants.');
      if (d.grant && (!current || !checkGrantVerifier(d.grant, current))) {
        throw new VaultError('wrong-passphrase', 'The current grant passphrase is required to change it.');
      }
      const updated: KeyDescriptor = { ...d, grant: makeGrantVerifier(next) };
      writeFileAtomic(this.keyFile, JSON.stringify(updated, null, 1));
      this.descriptor = updated;
    });
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    if (!this.provider?.interactive) return;
    const ms = this.options.autoLockMs ?? DEFAULT_AUTO_LOCK_MS;
    if (ms <= 0) return;
    this.idle = setTimeout(() => this.lock(), ms);
    this.idle.unref?.();
  }

  private requireKeys(): DerivedKeys {
    if (!this.keys) throw new VaultLockedError();
    this.armIdle();
    return this.keys;
  }

  private fileStamp(): string {
    try { const s = fs.statSync(this.dataFile); return `${s.mtimeMs}:${s.size}`; } catch { return 'missing'; }
  }

  /** Read, verify and decrypt the whole file. */
  private load(): void {
    const keys = this.requireKeys();
    let text: string;
    try { text = fs.readFileSync(this.dataFile, 'utf8'); } catch {
      throw new VaultError('format', 'The vault file is missing.');
    }
    let file = parseVaultFile(text);
    if (file.version !== FILE_VERSION) file = migrateFile(this.dataFile, file);
    verifyFile(keys, file);
    const records = new Map<string, CredentialRecord>();
    const sealed = new Map<string, SealedRecord>();
    for (const r of file.records) {
      const plain = JSON.parse(openRecord(keys, r).toString('utf8')) as CredentialRecord;
      if (plain.meta?.id !== r.id) throw new VaultError('tampered', `Record ${r.id} holds a different credential's data.`);
      // Usage counters are in memory only; keep them across reloads.
      const prev = this.records.get(r.id)?.meta;
      if (prev?.lastUsedAt) { plain.meta.lastUsedAt = prev.lastUsedAt; plain.meta.useCount = prev.useCount; }
      records.set(r.id, plain);
      sealed.set(r.id, r);
    }
    this.records = records;
    this.sealed = sealed;
    this.stamp = this.fileStamp();
  }

  /** Pick up another process's writes. */
  private refresh(): void {
    if (!this.keys) return;
    if (this.fileStamp() !== this.stamp) {
      this.load();
      this.changed();
    }
  }

  /** Apply a change under the lock, from a fresh read, and write it out. */
  private persist(mutate: (records: Map<string, CredentialRecord>) => { upsert?: CredentialRecord[]; remove?: string[] }): void {
    const keys = this.requireKeys();
    withFileLock(this.lockFile, () => {
      this.load();
      const { upsert = [], remove = [] } = mutate(this.records);
      for (const id of remove) { this.records.delete(id); this.sealed.delete(id); }
      for (const rec of upsert) {
        const version = (this.sealed.get(rec.meta.id)?.v ?? 0) + 1;
        this.sealed.set(rec.meta.id, sealRecord(keys, rec.meta.id, version, Buffer.from(JSON.stringify(rec), 'utf8')));
        this.records.set(rec.meta.id, rec);
      }
      const list = [...this.sealed.values()];
      const file: VaultFile = { format: FILE_FORMAT, version: FILE_VERSION, kcv: keys.kcv, records: list, mac: macRecords(keys, list) };
      writeFileAtomic(this.dataFile, JSON.stringify(file, null, 1));
      this.stamp = this.fileStamp();
    });
    this.changed();
  }

  // ── reading ────────────────────────────────────────────────────────

  private summary(rec: CredentialRecord): CredentialSummary {
    return { ...structuredClone(rec.meta), policy: structuredClone(rec.policy), fields: Object.keys(rec.secret).sort() };
  }

  /** Every credential's metadata and policy. Never values. */
  list(filter: { host?: string; kind?: CredentialKind; tag?: string } = {}): CredentialSummary[] {
    this.requireKeys();
    this.refresh();
    const host = filter.host?.toLowerCase();
    return [...this.records.values()]
      .filter(r => !filter.kind || r.meta.kind === filter.kind)
      .filter(r => !filter.tag || r.meta.tags.includes(filter.tag))
      .filter(r => !host || [r.meta.host, r.meta.url, ...r.policy.allowedHosts, ...r.policy.allowedOrigins]
        .some(v => v?.toLowerCase().includes(host)))
      .map(r => this.summary(r))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  names(): string[] {
    return [...this.records.values()].map(r => r.meta.name);
  }

  private find(ref: string): CredentialRecord | undefined {
    const r = ref.trim();
    const byId = this.records.get(r);
    if (byId) return byId;
    const lower = r.toLowerCase();
    for (const rec of this.records.values()) if (rec.meta.name.toLowerCase() === lower) return rec;
    return undefined;
  }

  private require(ref: string): CredentialRecord {
    this.requireKeys();
    this.refresh();
    const rec = this.find(ref);
    if (!rec) throw new CredentialNotFoundError(ref, similarNames(ref, this.names()));
    return rec;
  }

  /** One credential's metadata and policy, by id or name. */
  get(ref: string): CredentialSummary {
    return this.summary(this.require(ref));
  }

  has(ref: string): boolean {
    this.requireKeys();
    this.refresh();
    return this.find(ref) !== undefined;
  }

  /**
   * The secret fields of a credential. **Trusted callers only** — the vault
   * service's resolve and reveal, which enforce policy and grants and write
   * the audit entry. Not exported from `vault/index.ts`.
   */
  secretOf(ref: string): { meta: CredentialMeta; policy: Policy; secret: Record<string, string> } {
    const rec = this.require(ref);
    return { meta: structuredClone(rec.meta), policy: structuredClone(rec.policy), secret: { ...rec.secret } };
  }

  /** Every value, for building the redaction index. Trusted callers only. */
  secretEntries(): SecretEntry[] {
    return [...this.records.values()].map(r => ({ name: r.meta.name, values: Object.values(r.secret).filter(Boolean) }));
  }

  /** Note a use in memory (shown in the manager while this process runs). */
  noteUse(id: string): void {
    const rec = this.records.get(id);
    if (!rec) return;
    rec.meta.lastUsedAt = this.now();
    rec.meta.useCount = (rec.meta.useCount ?? 0) + 1;
  }

  // ── writing ────────────────────────────────────────────────────────

  private validateSecret(kind: CredentialKind, secret: unknown): Record<string, string> {
    if (!secret || typeof secret !== 'object' || Array.isArray(secret)) {
      throw new VaultError('invalid', 'A credential needs its secret fields as an object of strings.');
    }
    const allowed = SECRET_FIELDS[kind];
    const out: Record<string, string> = {};
    for (const [field, value] of Object.entries(secret as Record<string, unknown>)) {
      if (typeof value !== 'string' || !value) continue;
      if (kind !== 'generic' && !allowed.includes(field)) {
        throw new VaultError('invalid', `A ${kind} credential has no secret field "${field}" (it has: ${allowed.join(', ')}).`);
      }
      if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(field)) throw new VaultError('invalid', `"${field}" is not a valid field name.`);
      if (Buffer.byteLength(value, 'utf8') > MAX_FIELD_BYTES) throw new VaultError('invalid', `The ${field} field is too large.`);
      out[field] = value;
    }
    if (!Object.keys(out).length) throw new VaultError('invalid', 'A credential needs at least one non-empty secret field.');
    return out;
  }

  /** Refuse metadata that contains one of the secret values — the easiest way to leak by accident. */
  private checkNoSecretInMeta(meta: CredentialMeta, secret: Record<string, string>): void {
    const texts = [meta.name, meta.username, meta.host, meta.url, meta.description, ...meta.tags].filter(Boolean) as string[];
    for (const value of Object.values(secret)) {
      if (value.length < MIN_SECRET_LENGTH) continue;
      if (texts.some(t => t.includes(value))) {
        throw new VaultError('invalid', 'A secret value also appears in the credential\'s non-secret details (name, user, host, url, description or tags). Remove it from there.');
      }
    }
  }

  private shortWarnings(secret: Record<string, string>): string[] {
    return Object.entries(secret)
      .filter(([, v]) => v.length < FULL_ENCODING_LENGTH)
      .map(([field, v]) => v.length < MIN_SECRET_LENGTH
        ? `The ${field} is under ${MIN_SECRET_LENGTH} characters and cannot be redacted from output at all.`
        : `The ${field} is under ${FULL_ENCODING_LENGTH} characters: it is redacted only where it appears on its own, not in encoded forms.`);
  }

  private buildMeta(input: Partial<CreateInput> & { name: string; kind: CredentialKind; createdBy: CreatedBy }, id: string, now: number, prev?: CredentialMeta): CredentialMeta {
    const port = input.port === undefined ? prev?.port : Number(input.port);
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new VaultError('invalid', 'port must be 1–65535.');
    const tags = Array.isArray(input.tags) ? input.tags.map(t => cleanText(t, 40)).filter((t): t is string => !!t).slice(0, 20) : (prev?.tags ?? []);
    const pub = input.public ?? prev?.public;
    const meta: CredentialMeta = {
      id,
      name: input.name,
      kind: input.kind,
      tags,
      createdBy: input.createdBy,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    const username = input.username !== undefined ? cleanText(input.username, 256) : prev?.username;
    const host = input.host !== undefined ? cleanText(input.host, 256)?.toLowerCase() : prev?.host;
    const url = input.url !== undefined ? cleanText(input.url, 2048) : prev?.url;
    const description = input.description !== undefined ? cleanText(input.description) : prev?.description;
    if (username) meta.username = username;
    if (host) meta.host = host;
    if (port !== undefined) meta.port = port;
    if (url) meta.url = url;
    if (description) meta.description = description;
    if (pub && Object.keys(pub).length) meta.public = pub;
    const quarantined = input.quarantined ?? prev?.quarantined;
    if (quarantined) meta.quarantined = true;
    return meta;
  }

  /** Add a credential. Returns its summary and any warnings about redaction. */
  create(input: CreateInput): { credential: CredentialSummary; warnings: string[] } {
    if (!NAME_RE.test(input.name ?? '')) {
      throw new VaultError('invalid', 'A credential name is 1–64 letters, digits, "-" or "_", starting with a letter or digit.');
    }
    if (!CREDENTIAL_KINDS.includes(input.kind)) throw new VaultError('invalid', `Unknown credential kind "${input.kind}".`);
    const secret = this.validateSecret(input.kind, input.secret);
    const now = this.now();
    const id = `cred_${crypto.randomBytes(9).toString('base64url')}`;
    const meta = this.buildMeta(input, id, now);
    this.checkNoSecretInMeta(meta, secret);
    const policy = normalizePolicy(input.policy, { ...DEFAULT_POLICY });
    let created: CredentialRecord | undefined;
    this.persist((records) => {
      const lower = input.name.toLowerCase();
      for (const r of records.values()) {
        if (r.meta.name.toLowerCase() === lower) throw new VaultError('exists', `A credential named "${input.name}" already exists.`);
      }
      created = { meta, policy, secret };
      return { upsert: [created] };
    });
    return { credential: this.summary(created!), warnings: this.shortWarnings(secret) };
  }

  /** Change metadata. Scope-affecting changes are judged by the caller (see service). */
  updateMeta(ref: string, patch: MetaPatch): CredentialSummary {
    const target = this.require(ref);
    if (patch.name !== undefined && !NAME_RE.test(patch.name)) throw new VaultError('invalid', 'Invalid credential name.');
    let updated: CredentialRecord | undefined;
    this.persist((records) => {
      const rec = records.get(target.meta.id);
      if (!rec) throw new CredentialNotFoundError(ref, []);
      if (patch.name && patch.name.toLowerCase() !== rec.meta.name.toLowerCase()) {
        for (const r of records.values()) {
          if (r.meta.name.toLowerCase() === patch.name.toLowerCase()) throw new VaultError('exists', `A credential named "${patch.name}" already exists.`);
        }
      }
      const meta = this.buildMeta({ ...patch, name: patch.name ?? rec.meta.name, kind: rec.meta.kind, createdBy: rec.meta.createdBy }, rec.meta.id, this.now(), rec.meta);
      if (patch.quarantined === false) delete meta.quarantined;
      this.checkNoSecretInMeta(meta, rec.secret);
      updated = { ...rec, meta };
      return { upsert: [updated] };
    });
    return this.summary(updated!);
  }

  /** Replace the policy (the caller has decided whether this needed a grant). */
  setPolicy(ref: string, policy: Partial<Policy>): CredentialSummary {
    const target = this.require(ref);
    let updated: CredentialRecord | undefined;
    this.persist((records) => {
      const rec = records.get(target.meta.id);
      if (!rec) throw new CredentialNotFoundError(ref, []);
      updated = { ...rec, policy: normalizePolicy(policy, rec.policy), meta: { ...rec.meta, updatedAt: this.now() } };
      return { upsert: [updated] };
    });
    return this.summary(updated!);
  }

  /** Replace secret fields (rotation). */
  setSecret(ref: string, secret: Record<string, string>, pub?: PublicParts): { credential: CredentialSummary; warnings: string[] } {
    const target = this.require(ref);
    const clean = this.validateSecret(target.meta.kind, secret);
    let updated: CredentialRecord | undefined;
    this.persist((records) => {
      const rec = records.get(target.meta.id);
      if (!rec) throw new CredentialNotFoundError(ref, []);
      const meta = { ...rec.meta, updatedAt: this.now(), ...(pub ? { public: pub } : {}) };
      this.checkNoSecretInMeta(meta, clean);
      updated = { ...rec, meta, secret: clean };
      return { upsert: [updated] };
    });
    return { credential: this.summary(updated!), warnings: this.shortWarnings(clean) };
  }

  remove(ref: string): CredentialSummary {
    const target = this.require(ref);
    const summary = this.summary(target);
    this.persist(() => ({ remove: [target.meta.id] }));
    return summary;
  }
}
