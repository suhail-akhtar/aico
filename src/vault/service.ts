/**
 * The credential broker: the one object that turns a *name* into a *use*.
 *
 * Everything that touches a secret value goes through here, and every path
 * has the same shape — check the policy, ask a human when the policy says to,
 * write the audit entry, then (and only then) let the value out, to trusted
 * code that sends it where the policy said it may go. The model is never on
 * that path: it hands over names and receives outcomes.
 *
 * This module also keeps the sinks' redactor current. Every value the vault
 * has held in this process stays in the redaction index for the life of the
 * process, including after a lock or a delete: a secret removed from the vault
 * may still be sitting in a config file the agent wrote, and the redactor is
 * what stops a later `cat` of that file reaching the model. The index lives in
 * memory only.
 *
 * @module vault/service
 */

import path from 'node:path';
import { aicoHome } from '../home.js';
import { AuditLog } from './audit.js';
import { openExport, sealExport } from './backup.js';
import { generatePassword, generateSshKeyPair, generateToken } from './generate.js';
import {
  AttemptLimiter, HumanGrants, PendingApprovals, PendingRequests, denyPrompter, newRequestId, unavailableRequester,
  type ApprovalPrompter, type ApprovalRequest, type GrantAction, type HumanCredentialRequest, type HumanRequester,
} from './human.js';
import type { KeyProvider } from './keys.js';
import { defaultField, parsePlaceholders, referenceFor } from './placeholders.js';
import { RateTracker, SessionGrants, effectiveScope, evaluateUse, isLoosening, normalizePolicy } from './policy.js';
import { Redactor, placeholderFor } from './redact.js';
import { replaceDetected, scanForSecrets, type DetectedSecret } from './scan.js';
import { setActiveRedactor } from './sink.js';
import { similarNames, VaultStore, type CreateInput, type MetaPatch } from './store.js';
import {
  ApprovalDeniedError, CredentialNotFoundError, DEFAULT_POLICY, GrantRequiredError, PolicyDeniedError, SECRET_FIELDS,
  VaultError, VaultLockedError, VaultUnavailableError,
  type CreatedBy, type CredentialKind, type CredentialMeta, type CredentialSummary, type Policy, type UseContext,
} from './types.js';

/** What a trusted consumer gets from {@link VaultService.resolve}. */
export interface ResolvedSecret {
  readonly name: string;
  readonly kind: CredentialKind;
  readonly username?: string;
  readonly host?: string;
  readonly port?: number;
  readonly url?: string;
  /** Every secret field. Send them; never log, return or stream them. */
  readonly fields: Readonly<Record<string, string>>;
  /** The default field's value (or a named one). Throws for an unknown field. */
  value(field?: string): string;
  /** The owner allowed a self-signed certificate on this credential's origins. */
  readonly allowSelfSigned: boolean;
  /**
   * Drop this object's references to the values. JavaScript strings cannot be
   * zeroed, so this is hygiene — shortening how long a value is reachable —
   * not erasure. Call it as soon as the value has been sent.
   */
  release(): void;
}

export interface GenerateInput {
  name: string;
  kind: 'login' | 'ssh-key' | 'ssh-password' | 'api-token' | 'basic-auth' | 'winrm' | 'database' | 'generic';
  username?: string;
  host?: string;
  port?: number;
  url?: string;
  description?: string;
  length?: number;
  symbols?: boolean;
  /** Allow `{{secret:name}}` in shell commands. Each shell use still asks a human. */
  allowShell?: boolean;
  allowSelfSigned?: boolean;
  tags?: string[];
}

export interface GenerateResult {
  name: string;
  kind: CredentialKind;
  /** `{{secret:name}}` — what the model writes where the value should go. */
  reference: string;
  username?: string;
  /** SSH public key line, for an ssh-key. */
  publicKey?: string;
  fingerprint?: string;
  host?: string;
  url?: string;
  warnings: string[];
}

export type HumanRequestOutcome =
  | { status: 'stored'; name: string; reference: string }
  | { status: 'declined' | 'timeout' | 'exists' }
  | { status: 'unavailable'; reason: string };

export interface QuarantineResult {
  text: string;
  stored: Array<{ name: string; kind: CredentialKind; label: string }>;
  /** Values that could not be vaulted and were removed from the text instead. */
  dropped: number;
}

/** Messages from the vault to whoever hosts the engine (desktop main). */
export type HostOutbound =
  | { type: 'vault/approve-request'; request: ApprovalRequest }
  | { type: 'vault/credential-request'; request: HumanCredentialRequest }
  | { type: 'vault/changed' };

export type VaultNotifier = (
  sessionId: string | undefined,
  type: 'vault-approval' | 'vault-approval-done' | 'vault-request' | 'vault-request-done' | 'vault-quarantined' | 'vault-changed',
  data: unknown,
) => void;

export interface VaultServiceOptions {
  dir?: string;
  keyProvider?: KeyProvider;
  providerPreference?: string;
  autoLockMs?: number;
  now?: () => number;
}

/** Kinds a browser may fill into a login form. */
const BROWSER_KINDS: ReadonlySet<CredentialKind> = new Set(['login', 'basic-auth', 'generic']);

/** Field for a kind a caller did not name. */
function primaryField(kind: CredentialKind): string {
  return SECRET_FIELDS[kind][0]!;
}

export class VaultService {
  readonly store: VaultStore;
  readonly audit: AuditLog;
  readonly grants = new HumanGrants();
  readonly approvals = new PendingApprovals();
  readonly requests = new PendingRequests();
  private readonly sessionGrants = new SessionGrants();
  private readonly rate = new RateTracker();
  private readonly limiter = new AttemptLimiter();
  private readonly known = new Map<string, Set<string>>();
  private prompter: ApprovalPrompter | undefined;
  private requester: HumanRequester | undefined;
  private notifier: VaultNotifier | undefined;
  private hostSend: ((message: HostOutbound) => void) | undefined;
  private readonly now: () => number;
  private opening: Promise<void> | undefined;

  constructor(options: VaultServiceOptions = {}) {
    const dir = options.dir ?? path.join(aicoHome(), 'vault');
    this.now = options.now ?? Date.now;
    this.store = new VaultStore({
      dir,
      ...(options.keyProvider ? { keyProvider: options.keyProvider } : {}),
      ...(options.providerPreference ? { providerPreference: options.providerPreference } : {}),
      ...(options.autoLockMs !== undefined ? { autoLockMs: options.autoLockMs } : {}),
      now: this.now,
    });
    this.audit = new AuditLog(path.join(dir, 'audit.jsonl'));
    this.store.onChange(() => this.refreshRedactor());
  }

  get dir(): string { return this.store.dir; }

  // ── wiring (host process, server, CLI) ─────────────────────────────

  /** Who is asked to approve a use. Unset: the per-call fallback, else deny. */
  setApprovalPrompter(prompter: ApprovalPrompter | undefined): void { this.prompter = prompter; }
  /** Who is asked to type a credential in. */
  setHumanRequester(requester: HumanRequester | undefined): void { this.requester = requester; }
  /** Where stream events go (the server's hub). */
  setNotifier(notifier: VaultNotifier | undefined): void { this.notifier = notifier; }
  /** Attach the host channel (desktop). Approvals and requests then go there. */
  setHostSender(send: ((message: HostOutbound) => void) | undefined): void { this.hostSend = send; }
  get hostAttached(): boolean { return this.hostSend !== undefined; }

  // ── lifecycle ──────────────────────────────────────────────────────

  status(): ReturnType<VaultStore['status']> & { dir: string; host: boolean } {
    return { ...this.store.status(), dir: this.store.dir, host: this.hostAttached };
  }

  /**
   * Open the vault if it exists and can be opened without a person (keyring,
   * injected key). Never throws: a vault that cannot open yet is reported by
   * `status()`, and the engine starts regardless.
   */
  async ready(): Promise<void> {
    if (this.store.isUnlocked() || !this.store.exists()) return;
    this.opening ??= this.store.unlock().catch(() => undefined).finally(() => { this.opening = undefined; });
    await this.opening;
  }

  /** Open (creating if allowed) or explain why not. */
  private async ensureOpen(create = false): Promise<void> {
    if (this.store.isUnlocked()) return;
    if (!this.store.exists()) {
      if (!create) throw new VaultUnavailableError('There is no credential vault yet. Store a credential to create one.');
      await this.store.init();
      this.audit.append({ action: 'create', outcome: 'ok', reason: 'vault initialised' });
      return;
    }
    const st = this.store.status();
    if (st.interactive) throw new VaultLockedError();
    await this.ready();
    if (!this.store.isUnlocked()) await this.store.unlock();
  }

  async unlock(passphrase?: string): Promise<void> {
    const wait = this.limiter.blocked(this.now());
    if (wait) throw new VaultError('wrong-passphrase', `Too many wrong passphrases. Try again in ${Math.ceil(wait / 1000)}s.`);
    try {
      await this.store.unlock(passphrase ? { passphrase } : {});
      this.limiter.succeed();
      this.audit.append({ action: 'unlock', outcome: 'ok' });
    } catch (err) {
      if (err instanceof VaultError && err.code === 'wrong-passphrase') this.limiter.fail(this.now());
      this.audit.append({ action: 'unlock', outcome: 'denied', reason: err instanceof Error ? err.message : 'failed' });
      throw err;
    }
  }

  lock(): void {
    this.store.lock();
    this.sessionGrants.clear();
    this.approvals.denyAll();
    this.audit.append({ action: 'lock', outcome: 'ok' });
  }

  /** Rebuild the sinks' index from everything this process has seen. */
  refreshRedactor(): void {
    if (this.store.isUnlocked()) {
      for (const entry of this.store.secretEntries()) {
        const set = this.known.get(entry.name) ?? new Set<string>();
        for (const v of entry.values) set.add(v);
        this.known.set(entry.name, set);
      }
    }
    setActiveRedactor(new Redactor([...this.known].map(([name, values]) => ({ name, values: [...values] }))));
    this.notifier?.(undefined, 'vault-changed', {});
    try { this.hostSend?.({ type: 'vault/changed' }); } catch { /* host gone */ }
  }

  // ── reading metadata ───────────────────────────────────────────────

  async list(filter: { host?: string; kind?: CredentialKind; tag?: string } = {}): Promise<CredentialSummary[]> {
    if (!this.store.exists()) return [];
    await this.ensureOpen();
    return this.store.list(filter);
  }

  async get(ref: string): Promise<CredentialSummary> {
    await this.ensureOpen();
    return this.store.get(stripRef(ref).name);
  }

  /**
   * Credentials a browser may offer for an origin: web-login kinds whose
   * scope admits it. Bound by origin ranks above bound by host — a database
   * password on the same machine is not a login for its web portal.
   */
  async findForOrigin(origin: string): Promise<CredentialSummary[]> {
    const all = await this.list();
    const ranked: Array<{ c: CredentialSummary; rank: number }> = [];
    for (const c of all) {
      if (!BROWSER_KINDS.has(c.kind)) continue;
      const scope = effectiveScope(c, c.policy);
      if (!scope.hosts.length && !scope.origins.length) continue;
      const d = evaluateUse(c, c.policy, { tool: 'Browser', origin, purpose: 'match' }, {
        grants: this.sessionGrants, rate: new RateTracker(), now: this.now(),
      });
      if (!d.allowed) continue;
      ranked.push({ c, rank: scope.origins.length ? 0 : 1 });
    }
    return ranked.sort((a, b) => a.rank - b.rank || a.c.name.localeCompare(b.c.name)).map(r => r.c);
  }

  auditTrail(filter: { credentialId?: string; name?: string; limit?: number } = {}): ReturnType<AuditLog['read']> {
    return this.audit.read(filter);
  }

  // ── the one way to a value for tool code ───────────────────────────

  /**
   * Resolve a reference for a use. Enforces scope, tool, expiry and rate;
   * asks a human when the policy says to; writes the audit entry either way.
   *
   * `ref` may be `name`, `name.field` or `{{secret:name.field}}`.
   * `fallbackPrompter` is used only when no prompter was set process-wide.
   */
  async resolve(ref: string, use: UseContext, fallbackPrompter?: ApprovalPrompter): Promise<ResolvedSecret> {
    const { name, field } = stripRef(ref);
    await this.ensureOpen();
    if (!this.store.has(name)) {
      this.audit.append({ action: 'use', outcome: 'denied', name, tool: use.tool, purpose: use.purpose, ...(use.sessionId ? { sessionId: use.sessionId } : {}), reason: 'not found' });
      throw new CredentialNotFoundError(name, similarNames(name, this.store.names()));
    }
    const { meta, policy, secret } = this.store.secretOf(name);
    const base = {
      credentialId: meta.id, name: meta.name, tool: use.tool, purpose: use.purpose,
      ...(use.origin ?? use.host ? { target: use.origin ?? use.host } : {}),
      ...(use.sessionId ? { sessionId: use.sessionId } : {}),
    };
    const decision = evaluateUse(meta, policy, use, { grants: this.sessionGrants, rate: this.rate, now: this.now() });
    if (!decision.allowed) {
      this.audit.append({ ...base, action: 'use', outcome: 'denied', reason: decision.reason });
      throw new PolicyDeniedError(decision.reason);
    }
    if (decision.needsApproval) {
      const request: ApprovalRequest = {
        id: newRequestId('appr'),
        credential: { id: meta.id, name: meta.name, kind: meta.kind },
        tool: use.tool,
        ...(decision.target ? { target: decision.target } : {}),
        purpose: use.purpose.slice(0, 2000),
        description: decision.description,
        ...(use.sessionId ? { sessionId: use.sessionId } : {}),
        mode: decision.mode === 'session' ? 'session' : 'every-use',
      };
      const prompter = this.prompter ?? fallbackPrompter ?? denyPrompter;
      let approved = false;
      try { approved = await prompter.ask(request); } catch { approved = false; }
      if (!approved) {
        this.audit.append({ ...base, action: 'use', outcome: 'declined', reason: `not approved (${prompter.kind})` });
        throw new ApprovalDeniedError(prompter.kind === 'deny'
          ? `Using "${meta.name}" here needs a person's approval, and nobody is available to give it.`
          : `The use of "${meta.name}" was not approved.`);
      }
      // "Allow once" (host or passphrase path) approves this use without
      // remembering it for the session.
      const once = this.approvals.takeOnce(request.id);
      if (decision.mode === 'session' && !once) this.sessionGrants.add(meta.id, use.tool, use.sessionId);
    }
    if (field && !(field in secret)) {
      this.audit.append({ ...base, action: 'use', outcome: 'error', reason: `no field ${field}` });
      throw new VaultError('invalid', `The credential "${meta.name}" has no field "${field}" (it has: ${Object.keys(secret).join(', ')}).`);
    }
    this.rate.record(meta.id, this.now());
    this.store.noteUse(meta.id);
    this.audit.append({ ...base, action: 'use', outcome: 'ok' });
    return makeResolved(meta, policy, secret, field);
  }

  // ── putting credentials in ─────────────────────────────────────────

  /** Store a credential. `secret` is written and never echoed. */
  async create(input: CreateInput): Promise<{ credential: CredentialSummary; warnings: string[] }> {
    await this.ensureOpen(true);
    const out = this.store.create(input);
    this.audit.append({ action: 'create', outcome: 'ok', credentialId: out.credential.id, name: out.credential.name, actor: input.createdBy });
    return out;
  }

  /**
   * Create a random credential bound to a scope. Returns the reference and
   * the non-secret parts only.
   */
  async generate(input: GenerateInput, createdBy: CreatedBy): Promise<GenerateResult> {
    let secret: Record<string, string>;
    let pub: { publicKey?: string; fingerprint?: string } | undefined;
    switch (input.kind) {
      case 'ssh-key': {
        const pair = generateSshKeyPair(input.username ? `${input.username}@${input.host ?? 'aico'}` : input.name);
        secret = { privateKey: pair.privateKey };
        pub = { publicKey: pair.publicKey, fingerprint: pair.fingerprint };
        break;
      }
      case 'api-token': secret = { token: generateToken(Math.max(16, Math.ceil((input.length ?? 43) * 0.75))) }; break;
      case 'generic': secret = { value: generatePassword({ length: input.length ?? 32, ...(input.symbols === false ? { symbols: false } : {}) }) }; break;
      default: secret = { password: generatePassword({ length: input.length ?? 24, ...(input.symbols === false ? { symbols: false } : {}) }) };
    }
    const scoped = Boolean(input.host || input.url);
    const { credential, warnings } = await this.create({
      name: input.name,
      kind: input.kind,
      secret,
      ...(input.username ? { username: input.username } : {}),
      ...(input.host ? { host: input.host } : {}),
      ...(input.port ? { port: input.port } : {}),
      ...(input.url ? { url: input.url } : {}),
      description: input.description ?? `Generated by the agent${input.host ? ` for ${input.host}` : ''}.`,
      tags: [...(input.tags ?? []), 'generated'],
      ...(pub ? { public: pub } : {}),
      createdBy,
      policy: {
        // The agent made it for a place; trusted tools bound to that place use
        // it without asking. Unscoped, every use asks.
        approval: scoped ? 'auto' : 'every-use',
        allowShell: input.allowShell === true,
        ...(input.allowSelfSigned ? { allowSelfSigned: true } : {}),
      },
    });
    return {
      name: credential.name,
      kind: credential.kind,
      reference: referenceFor(credential.name),
      ...(credential.username ? { username: credential.username } : {}),
      ...(pub?.publicKey ? { publicKey: pub.publicKey } : {}),
      ...(pub?.fingerprint ? { fingerprint: pub.fingerprint } : {}),
      ...(credential.host ? { host: credential.host } : {}),
      ...(credential.url ? { url: credential.url } : {}),
      warnings,
    };
  }

  /**
   * Ask a person to type a credential in. The value goes from their keyboard
   * into the vault; the agent gets back a status and a name.
   */
  async requestFromHuman(req: Omit<HumanCredentialRequest, 'requestId' | 'fields'> & { fields?: string[] }): Promise<HumanRequestOutcome> {
    await this.ensureOpen(true);
    if (this.store.has(req.name)) return { status: 'exists' };
    const fields = (req.fields?.length ? req.fields : [primaryField(req.kind)])
      .filter(f => req.kind === 'generic' || SECRET_FIELDS[req.kind].includes(f));
    const request: HumanCredentialRequest = { ...req, requestId: newRequestId('creq'), fields: fields.length ? fields : [primaryField(req.kind)] };
    this.audit.append({ action: 'request', outcome: 'ok', name: req.name, purpose: req.reason, ...(req.sessionId ? { sessionId: req.sessionId } : {}), ...(req.url ?? req.host ? { target: req.url ?? req.host } : {}) });

    let response;
    if (this.requester) {
      response = await this.requester.request(request);
    } else if (this.hostSend || this.notifier) {
      response = await this.requests.open(request, (r) => {
        if (this.hostSend) this.hostSend({ type: 'vault/credential-request', request: r });
        // `hostPrompt: true` tells a client that the host (AICO Desktop) is already
        // showing its own secure prompt, so it must not open a second one in
        // its own DOM — the desktop's app renderer never takes the value.
        this.notifier?.(r.sessionId, 'vault-request', { ...publicRequest(r), ...(this.hostSend ? { hostPrompt: true } : {}) });
      });
      // Answered here, in another window, declined or timed out: every client
      // showing the prompt closes it.
      this.notifier?.(request.sessionId, 'vault-request-done', { requestId: request.requestId, status: response.status });
    } else {
      response = await unavailableRequester.request(request);
    }
    if (response.status !== 'provided') {
      this.audit.append({ action: 'request', outcome: response.status === 'timeout' ? 'timeout' : 'declined', name: req.name });
      return response.status === 'unavailable' ? { status: 'unavailable', reason: response.reason } : { status: response.status };
    }
    const { credential } = await this.create({
      name: req.name,
      kind: req.kind,
      secret: response.secret,
      ...(response.username ?? req.username ? { username: response.username ?? req.username } : {}),
      ...(req.host ? { host: req.host } : {}),
      ...(req.url ? { url: req.url } : {}),
      description: `Entered by the user when asked: ${req.reason}`.slice(0, 500),
      createdBy: 'user',
      policy: { approval: 'session' },
    });
    return { status: 'stored', name: credential.name, reference: referenceFor(credential.name) };
  }

  /** Answer a pending credential request (the fulfil route). Write-only. */
  fulfil(requestId: string, body: { secret?: Record<string, string>; value?: string; username?: string; decline?: boolean }): boolean {
    const req = this.requests.get(requestId);
    if (!req) return false;
    if (body.decline) return this.requests.settle(requestId, { status: 'declined' });
    const secret = body.secret ?? (typeof body.value === 'string' ? { [req.fields[0]!]: body.value } : undefined);
    if (!secret || !Object.values(secret).some(v => typeof v === 'string' && v)) return false;
    return this.requests.settle(requestId, {
      status: 'provided', secret,
      ...(typeof body.username === 'string' && body.username.trim() ? { username: body.username.trim() } : {}),
    });
  }

  /**
   * Move secrets out of text a person submitted, before anything else reads
   * it. Detected values go into the vault (quarantined) and are replaced by
   * `[secret:name]`. A value that cannot be vaulted — no vault can be opened —
   * is removed from the text rather than let through.
   */
  async quarantineUserText(text: string, ctx: { sessionId?: string } = {}): Promise<QuarantineResult> {
    let detected = scanForSecrets(text);
    if (!detected.length) return { text, stored: [], dropped: 0 };
    const names: string[] = [];
    const stored: QuarantineResult['stored'] = [];
    let dropped = 0;
    let usable = true;
    try { await this.ensureOpen(true); } catch { usable = false; }
    // A credential's *name* is never a secret: vaulting one would make the
    // redactor scrub that name from every listing.
    if (usable) detected = detected.filter(d => !this.store.has(d.value));
    if (!detected.length) return { text, stored: [], dropped: 0 };
    for (const d of detected) {
      if (!usable) { names.push(''); dropped++; continue; }
      try {
        const existing = this.findByValue(d.value);
        if (existing) { names.push(existing); continue; }
        const name = this.freeName(`pasted-${d.label}`);
        const field = d.kind === 'generic' ? 'value' : primaryField(d.kind);
        await this.create({
          name,
          kind: d.kind,
          secret: { [field]: d.value },
          ...(d.username ? { username: d.username } : {}),
          ...(d.host ? { host: d.host } : {}),
          ...(d.url ? { url: d.url } : {}),
          description: `Detected in a chat message (${d.label}) and moved here automatically. Review it.`,
          tags: ['quarantined'],
          quarantined: true,
          createdBy: 'user',
          policy: { approval: d.host ? 'session' : 'every-use' },
        });
        this.audit.append({ action: 'quarantine', outcome: 'ok', name, ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}), reason: d.label });
        names.push(name);
        stored.push({ name, kind: d.kind, label: d.label });
      } catch {
        names.push('');
        dropped++;
      }
    }
    const replaced = replaceDetected(text, detected, (_d: DetectedSecret, i: number) =>
      names[i] ? placeholderFor(names[i]!) : '[secret removed: it could not be stored in the vault]');
    const note = stored.length
      ? `\n\n(AICO moved ${stored.length === 1 ? 'a secret' : `${stored.length} secrets`} from this message into the credential vault: `
        + `${stored.map(s => s.name).join(', ')}. Refer to them by name; their values are not shown to you.)`
      : '';
    if (stored.length || dropped) {
      this.notifier?.(ctx.sessionId, 'vault-quarantined', { items: stored, dropped });
    }
    return { text: replaced + note, stored, dropped };
  }

  private findByValue(value: string): string | undefined {
    for (const entry of this.store.secretEntries()) if (entry.values.includes(value)) return entry.name;
    return undefined;
  }

  private freeName(base: string): string {
    const clean = base.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 56);
    if (!this.store.has(clean)) return clean;
    for (let i = 2; ; i++) if (!this.store.has(`${clean}-${i}`)) return `${clean}-${i}`;
  }

  // ── owner operations (Credential Manager, CLI) ─────────────────────

  private requireGrant(grant: unknown, action: GrantAction, credentialId: string, label: string): void {
    if (!this.grants.consume(grant, action, credentialId, this.now())) throw new GrantRequiredError(label);
  }

  /** Change metadata. Changing where it may be used (host, url, port) is a loosening. */
  async updateMeta(ref: string, patch: MetaPatch, grant?: unknown): Promise<CredentialSummary> {
    await this.ensureOpen();
    const before = this.store.get(stripRef(ref).name);
    const scopeChanged = (['host', 'url', 'port'] as const).some(k => k in patch && patch[k] !== before[k]);
    if (scopeChanged && !before.policy.allowedHosts.length && !before.policy.allowedOrigins.length) {
      this.requireGrant(grant, 'loosen', before.id, 'Changing where a credential may be used');
    }
    const after = this.store.updateMeta(before.id, patch);
    this.sessionGrants.revoke(before.id);
    this.audit.append({ action: 'update', outcome: 'ok', credentialId: before.id, name: after.name });
    return after;
  }

  /** Replace the policy. Any loosening needs a grant; tightening never does. */
  async setPolicy(ref: string, policy: Partial<Policy>, grant?: unknown): Promise<CredentialSummary> {
    await this.ensureOpen();
    const before = this.store.get(stripRef(ref).name);
    const next = normalizePolicy(policy, before.policy);
    const loosening = isLoosening(before.policy, next);
    if (loosening) this.requireGrant(grant, 'loosen', before.id, 'Loosening a credential\'s policy');
    const after = this.store.setPolicy(before.id, next);
    this.sessionGrants.revoke(before.id);
    this.audit.append({ action: 'policy-change', outcome: 'ok', credentialId: before.id, name: before.name, reason: loosening ? 'loosened (granted)' : 'tightened or unchanged' });
    return after;
  }

  /** Replace secret values. A user's credential needs a grant: rotating it is a way to hijack it. */
  async rotate(ref: string, secret: Record<string, string>, grant?: unknown): Promise<CredentialSummary> {
    await this.ensureOpen();
    const before = this.store.get(stripRef(ref).name);
    if (before.createdBy === 'user') this.requireGrant(grant, 'rotate', before.id, 'Replacing a credential you stored');
    const { credential } = this.store.setSecret(before.id, secret);
    this.sessionGrants.revoke(before.id);
    this.audit.append({ action: 'rotate', outcome: 'ok', credentialId: before.id, name: before.name });
    return credential;
  }

  /** Delete. A user's credential needs a grant. */
  async remove(ref: string, grant?: unknown): Promise<CredentialSummary> {
    await this.ensureOpen();
    const before = this.store.get(stripRef(ref).name);
    if (before.createdBy === 'user') this.requireGrant(grant, 'delete', before.id, 'Deleting a credential you stored');
    const removed = this.store.remove(before.id);
    this.sessionGrants.revoke(before.id);
    this.audit.append({ action: 'delete', outcome: 'ok', credentialId: before.id, name: before.name });
    return removed;
  }

  /**
   * Show a person the values. Always needs a grant; the grant names the
   * credential. The only path besides `resolve` that lets a value out.
   */
  async reveal(ref: string, grant: unknown, actor = 'human'): Promise<{ name: string; kind: CredentialKind; username?: string; fields: Record<string, string> }> {
    await this.ensureOpen();
    const before = this.store.get(stripRef(ref).name);
    if (!this.grants.consume(grant, 'reveal', before.id, this.now())) {
      this.audit.append({ action: 'reveal', outcome: 'denied', credentialId: before.id, name: before.name, actor, reason: 'no valid grant' });
      throw new GrantRequiredError('Revealing a credential');
    }
    const { meta, secret } = this.store.secretOf(before.id);
    this.audit.append({ action: 'reveal', outcome: 'ok', credentialId: meta.id, name: meta.name, actor });
    return { name: meta.name, kind: meta.kind, ...(meta.username ? { username: meta.username } : {}), fields: secret };
  }

  /** Values for a trusted local owner action (CLI show/export after its own checks). Audited. */
  async revealForOwner(ref: string, action: 'reveal' | 'export', actor: string): Promise<{ meta: CredentialMeta; policy: Policy; secret: Record<string, string> }> {
    await this.ensureOpen();
    const out = this.store.secretOf(stripRef(ref).name);
    this.audit.append({ action, outcome: 'ok', credentialId: out.meta.id, name: out.meta.name, actor });
    return out;
  }

  /**
   * Every credential, sealed with a passphrase the person chose (the
   * Credential Manager's Export). Needs an `export` grant: this is every
   * value at once. Returns ciphertext only.
   */
  async exportEncrypted(passphrase: string, grant: unknown, actor = 'credential-manager'): Promise<{ file: string; count: number }> {
    await this.ensureOpen();
    if (!this.grants.consume(grant, 'export', undefined, this.now())) {
      this.audit.append({ action: 'export', outcome: 'denied', actor, reason: 'no valid grant' });
      throw new GrantRequiredError('Exporting the vault');
    }
    const records = this.store.list().map(c => this.store.secretOf(c.id));
    const file = sealExport(records, passphrase);
    this.audit.append({ action: 'export', outcome: 'ok', actor, reason: `${records.length} credential(s), encrypted` });
    return { file, count: records.length };
  }

  /**
   * Add the credentials in an encrypted export. Existing names are skipped,
   * never replaced — replacing is a delete, and deletes of a person's
   * credentials need their grant.
   */
  async importEncrypted(text: string, passphrase: string, actor = 'credential-manager'): Promise<{ added: number; skipped: number }> {
    const records = openExport(text, passphrase);
    await this.ensureOpen(true);
    let added = 0;
    let skipped = 0;
    for (const r of records) {
      if (this.store.has(r.meta.name)) { skipped++; continue; }
      try {
        this.store.create({
          name: r.meta.name, kind: r.meta.kind, secret: r.secret, policy: r.policy, createdBy: r.meta.createdBy,
          ...(r.meta.username ? { username: r.meta.username } : {}),
          ...(r.meta.host ? { host: r.meta.host } : {}),
          ...(r.meta.port ? { port: r.meta.port } : {}),
          ...(r.meta.url ? { url: r.meta.url } : {}),
          ...(r.meta.description ? { description: r.meta.description } : {}),
          ...(r.meta.public ? { public: r.meta.public } : {}),
          tags: Array.isArray(r.meta.tags) ? r.meta.tags : [],
        });
        added++;
      } catch { skipped++; }
    }
    this.audit.append({ action: 'import', outcome: 'ok', actor, reason: `${added} added, ${skipped} skipped` });
    return { added, skipped };
  }

  /**
   * Mint a grant after verifying a passphrase a person typed. The standalone
   * route to a grant; rate-limited against guessing.
   */
  async grantWithPassphrase(passphrase: unknown, action: GrantAction, credentialRef?: string): Promise<string> {
    const wait = this.limiter.blocked(this.now());
    if (wait) throw new VaultError('wrong-passphrase', `Too many wrong passphrases. Try again in ${Math.ceil(wait / 1000)}s.`);
    if (typeof passphrase !== 'string' || !(await this.store.verifyHumanPassphrase(passphrase))) {
      this.limiter.fail(this.now());
      this.audit.append({ action: 'grant', outcome: 'denied', reason: `${action}: wrong passphrase` });
      throw new VaultError('wrong-passphrase', 'Wrong passphrase.');
    }
    this.limiter.succeed();
    let credentialId: string | undefined;
    if (credentialRef) { await this.ensureOpen(); credentialId = this.store.get(stripRef(credentialRef).name).id; }
    this.audit.append({ action: 'grant', outcome: 'ok', reason: action, ...(credentialId ? { credentialId } : {}) });
    return this.grants.register({ action, ...(credentialId ? { credentialId } : {}) }, this.now());
  }

  /** Answer a pending approval. Approving needs evidence of a person; declining does not. */
  async answerApproval(id: string, approve: boolean, proof: { grant?: unknown; passphrase?: unknown } = {}, scope?: 'once' | 'session'): Promise<boolean> {
    const req = this.approvals.get(id);
    if (!req) return false;
    if (!approve) return this.approvals.answer(id, false);
    let ok = false;
    if (proof.grant !== undefined) ok = this.grants.consume(proof.grant, 'approve', req.credential.id, this.now());
    else if (proof.passphrase !== undefined) {
      const wait = this.limiter.blocked(this.now());
      if (!wait && typeof proof.passphrase === 'string' && await this.store.verifyHumanPassphrase(proof.passphrase)) {
        this.limiter.succeed();
        ok = true;
      } else if (!wait) this.limiter.fail(this.now());
    }
    if (!ok) {
      this.audit.append({ action: 'grant', outcome: 'denied', credentialId: req.credential.id, name: req.credential.name, reason: 'approval without proof of a person' });
      throw new GrantRequiredError('Approving a credential use');
    }
    this.audit.append({ action: 'grant', outcome: 'ok', credentialId: req.credential.id, name: req.credential.name, tool: req.tool, reason: `use approved (${proof.grant !== undefined ? 'grant' : 'passphrase'}${scope === 'once' ? ', once' : ''})` });
    return this.approvals.answer(id, true, scope);
  }

  /**
   * The prompter a server uses: the host channel when attached, otherwise
   * stream events answered by the approve route with a passphrase, otherwise
   * refuse at once rather than wait on nobody.
   */
  serverPrompter(): ApprovalPrompter {
    return {
      kind: 'server',
      ask: async (request) => {
        const st = this.store.status();
        if (!this.hostSend && !st.grantPassphrase) return false;
        const approved = await this.approvals.open(request, (r) => {
          if (this.hostSend) this.hostSend({ type: 'vault/approve-request', request: r });
          this.notifier?.(r.sessionId, 'vault-approval', { ...r, needs: this.hostSend ? 'desktop' : 'passphrase' });
        });
        this.notifier?.(request.sessionId, 'vault-approval-done', { id: request.id, approved });
        return approved;
      },
    };
  }
}

/** What a stream event may say about a credential request: everything but nothing secret (there is nothing secret in it). */
function publicRequest(r: HumanCredentialRequest): HumanCredentialRequest {
  return { ...r };
}

function stripRef(ref: string): { name: string; field?: string } {
  const trimmed = ref.trim();
  const parsed = parsePlaceholders(trimmed)[0];
  if (parsed) return { name: parsed.name, ...(parsed.field ? { field: parsed.field } : {}) };
  const m = /^\[secret:([^\]]+)\]$/.exec(trimmed);
  const bare = m ? m[1]! : trimmed;
  const dot = bare.indexOf('.');
  return dot > 0 ? { name: bare.slice(0, dot), field: bare.slice(dot + 1) } : { name: bare };
}

function makeResolved(meta: CredentialMeta, policy: Policy, secret: Record<string, string>, field?: string): ResolvedSecret {
  let fields: Record<string, string> | undefined = { ...secret };
  const primary = field ?? defaultField(meta.kind, Object.keys(secret));
  return {
    name: meta.name,
    kind: meta.kind,
    ...(meta.username ? { username: meta.username } : {}),
    ...(meta.host ? { host: meta.host } : {}),
    ...(meta.port ? { port: meta.port } : {}),
    ...(meta.url ? { url: meta.url } : {}),
    get fields() {
      if (!fields) throw new VaultError('invalid', 'This resolved credential was released.');
      return fields;
    },
    value(f?: string) {
      if (!fields) throw new VaultError('invalid', 'This resolved credential was released.');
      const key = f ?? primary;
      if (!key || !(key in fields)) throw new VaultError('invalid', `The credential "${meta.name}" has no field "${key}".`);
      return fields[key]!;
    },
    allowSelfSigned: policy.allowSelfSigned === true,
    release() { fields = undefined; },
  };
}

export { DEFAULT_POLICY };
