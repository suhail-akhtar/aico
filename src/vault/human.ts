/**
 * The three ways the vault asks for a person: one-time grants, use
 * approvals, and credential requests.
 *
 * The threat model assumes the model can `curl` the engine's loopback API and
 * may learn its token. So nothing reachable with the token alone may stand in
 * for a human. A human's "yes" reaches the engine only through:
 *
 *  - **the host channel** (AICO Desktop): main shows a native confirmation and
 *    passes a nonce or an answer over the utility process's private
 *    `parentPort`, which no shell command can write to; or
 *  - **a passphrase** the human types (the vault passphrase, or a standalone
 *    grant passphrase), checked here and never stored; or
 *  - **the terminal** of an interactive CLI, where the person is at the keys.
 *
 * A human's "no" needs no proof — anything may decline. That asymmetry is the
 * whole design: the API can refuse, deny and time out freely, and can grant
 * only with evidence a model cannot manufacture.
 *
 * @module vault/human
 */

import crypto from 'node:crypto';
import readline from 'node:readline';
import type { CredentialKind } from './types.js';

// ── one-time grants ──────────────────────────────────────────────────

export type GrantAction = 'reveal' | 'loosen' | 'export' | 'delete' | 'rotate' | 'approve' | 'scope';

interface Grant { action: GrantAction; credentialId?: string; expiresAt: number }

/** Grants live this long unless the minter says otherwise. */
const DEFAULT_GRANT_MS = 2 * 60 * 1000;

/**
 * One-time human grants. `register` is called only from trusted channels (the
 * host channel, or a route that has just verified a passphrase); `consume`
 * spends one.
 */
export class HumanGrants {
  private readonly grants = new Map<string, Grant>();

  register(g: { action: GrantAction; credentialId?: string; ttlMs?: number; nonce?: string }, now = Date.now()): string {
    const nonce = g.nonce ?? crypto.randomBytes(24).toString('base64url');
    if (nonce.length < 16) throw new Error('A grant nonce must be at least 16 characters.');
    this.grants.set(nonce, {
      action: g.action,
      ...(g.credentialId ? { credentialId: g.credentialId } : {}),
      expiresAt: now + Math.min(g.ttlMs ?? DEFAULT_GRANT_MS, 10 * 60 * 1000),
    });
    return nonce;
  }

  /** Spend a grant. True only if it exists, is unexpired, and matches. Spent either way once matched. */
  consume(nonce: unknown, action: GrantAction, credentialId?: string, now = Date.now()): boolean {
    if (typeof nonce !== 'string' || !nonce) return false;
    const g = this.grants.get(nonce);
    if (!g) return false;
    this.grants.delete(nonce);
    if (g.expiresAt < now) return false;
    if (g.action !== action) return false;
    if (g.credentialId && g.credentialId !== credentialId) return false;
    return true;
  }

  clear(): void { this.grants.clear(); }
}

/**
 * Failed passphrase attempts, so a model with the token cannot brute-force a
 * grant passphrase through the API. Exponential lockout from the fifth miss.
 */
export class AttemptLimiter {
  private failures = 0;
  private lockedUntil = 0;
  blocked(now = Date.now()): number { return Math.max(0, this.lockedUntil - now); }
  fail(now = Date.now()): void {
    this.failures++;
    if (this.failures >= 5) this.lockedUntil = now + Math.min(2 ** (this.failures - 5) * 30_000, 60 * 60 * 1000);
  }
  succeed(): void { this.failures = 0; this.lockedUntil = 0; }
}

// ── approvals ────────────────────────────────────────────────────────

export interface ApprovalRequest {
  id: string;
  credential: { id: string; name: string; kind: CredentialKind };
  tool: string;
  target?: string;
  purpose: string;
  /** The line to show the person. */
  description: string;
  sessionId?: string;
  /** `session` approvals are remembered for the session; `every-use` are not. */
  mode: 'every-use' | 'session';
}

/** Asks a human to allow one use. Must resolve false rather than hang or throw. */
export interface ApprovalPrompter {
  readonly kind: string;
  ask(request: ApprovalRequest): Promise<boolean>;
}

/** Nobody to ask: every approval is refused. The right default for unattended runs. */
export const denyPrompter: ApprovalPrompter = {
  kind: 'deny',
  async ask() { return false; },
};

/**
 * Ask on the terminal. Only for an interactive CLI where a person is at the
 * keyboard; the server never uses it, because a server's terminal is not
 * where its user is looking.
 */
export function ttyPrompter(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): ApprovalPrompter {
  return {
    kind: 'tty',
    ask: (req) => new Promise<boolean>((resolve) => {
      if (!(input as { isTTY?: boolean }).isTTY) { resolve(false); return; }
      const rl = readline.createInterface({ input, output, terminal: false });
      rl.question(`\n  🔑 ${req.description}\n  Allow this use of "${req.credential.name}"? [y/N] `, (answer) => {
        rl.close();
        resolve(/^y(es)?$/i.test(answer.trim()));
      });
    }),
  };
}

/** Adapt an existing yes/no permission callback (the terminal UI's) to a prompter. */
export function callbackPrompter(ask: (title: string, detail: string) => Promise<boolean>): ApprovalPrompter {
  return {
    kind: 'callback',
    ask: async (req) => {
      try { return await ask(`Use credential "${req.credential.name}"`, req.description); } catch { return false; }
    },
  };
}

/**
 * Approvals waiting on an answer from somewhere else (the host channel or the
 * HTTP approve route). Every pending entry times out to "no".
 */
export class PendingApprovals {
  private readonly pending = new Map<string, { request: ApprovalRequest; resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>();
  /**
   * "Allow once" answers to `session`-mode requests. A person may approve a
   * use without letting the rest of the session reuse it; the broker reads
   * this right after the approval resolves (see service.ts `resolve`).
   */
  private readonly once = new Set<string>();

  constructor(private readonly timeoutMs = 5 * 60 * 1000) {}

  /** Whether an approved request was approved for this one use only. Read once. */
  takeOnce(id: string): boolean {
    const was = this.once.has(id);
    this.once.delete(id);
    return was;
  }

  open(request: ApprovalRequest, announce: (request: ApprovalRequest) => void): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.answer(request.id, false), this.timeoutMs);
      timer.unref?.();
      this.pending.set(request.id, { request, resolve, timer });
      try { announce(request); } catch { this.answer(request.id, false); }
    });
  }

  get(id: string): ApprovalRequest | undefined { return this.pending.get(id)?.request; }

  list(sessionId?: string): ApprovalRequest[] {
    return [...this.pending.values()].map(p => p.request).filter(r => !sessionId || r.sessionId === sessionId);
  }

  /**
   * Settle one. Returns false if there was nothing pending under that id.
   * `scope: 'once'` narrows a session-mode approval to this use; it can never
   * widen an every-use one.
   */
  answer(id: string, approved: boolean, scope?: 'once' | 'session'): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (approved && scope === 'once') this.once.add(id);
    p.resolve(approved);
    return true;
  }

  denyAll(): void { for (const id of [...this.pending.keys()]) this.answer(id, false); }
}

export function newRequestId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
}

// ── credential requests ──────────────────────────────────────────────

/** What the agent asked the human for. Carries no secret. */
export interface HumanCredentialRequest {
  requestId: string;
  name: string;
  kind: CredentialKind;
  /** Secret fields wanted, e.g. `['password']`. */
  fields: string[];
  username?: string;
  host?: string;
  url?: string;
  reason: string;
  sessionId?: string;
}

/** What came back. `secret` goes straight into the vault and nowhere else. */
export type HumanCredentialResponse =
  | { status: 'provided'; secret: Record<string, string>; username?: string }
  | { status: 'declined' }
  | { status: 'timeout' }
  | { status: 'unavailable'; reason: string };

export interface HumanRequester {
  readonly kind: string;
  request(req: HumanCredentialRequest): Promise<HumanCredentialResponse>;
}

export const unavailableRequester: HumanRequester = {
  kind: 'none',
  async request() {
    return { status: 'unavailable', reason: 'No person is attached to this run to enter a credential.' };
  },
};

/**
 * Pending requests answered by `POST /api/vault/fulfil` (or the host channel).
 * Write-only: a fulfilment carries a value in and gets nothing but a status out.
 */
export class PendingRequests {
  private readonly pending = new Map<string, { request: HumanCredentialRequest; resolve: (r: HumanCredentialResponse) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly timeoutMs = 10 * 60 * 1000) {}

  open(request: HumanCredentialRequest, announce: (request: HumanCredentialRequest) => void): Promise<HumanCredentialResponse> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(request.requestId, { status: 'timeout' }), this.timeoutMs);
      timer.unref?.();
      this.pending.set(request.requestId, { request, resolve, timer });
      try { announce(request); } catch { this.settle(request.requestId, { status: 'unavailable', reason: 'The request could not be shown.' }); }
    });
  }

  get(id: string): HumanCredentialRequest | undefined { return this.pending.get(id)?.request; }

  list(sessionId?: string): HumanCredentialRequest[] {
    return [...this.pending.values()].map(p => p.request).filter(r => !sessionId || r.sessionId === sessionId);
  }

  settle(id: string, response: HumanCredentialResponse): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(response);
    return true;
  }

  declineAll(): void { for (const id of [...this.pending.keys()]) this.settle(id, { status: 'declined' }); }
}

/**
 * Read a line without echoing it. For the CLI's secret prompts: the value is
 * typed by the person, never shown, and never passes through the model.
 */
export function promptHidden(question: string, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!input.isTTY) { reject(new Error('A hidden prompt needs an interactive terminal.')); return; }
    output.write(question);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    let value = '';
    const onData = (buf: Buffer): void => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') { finish(); return; }
        if (ch === '\u0003') { cleanup(); output.write('\n'); reject(new Error('Cancelled.')); return; }
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        value += ch;
      }
    };
    const cleanup = (): void => {
      input.removeListener('data', onData);
      input.setRawMode(wasRaw ?? false);
      input.pause();
    };
    const finish = (): void => { cleanup(); output.write('\n'); resolve(value); };
    input.on('data', onData);
  });
}

/** A requester for an interactive terminal: hidden input per field. */
export function ttyRequester(): HumanRequester {
  return {
    kind: 'tty',
    async request(req) {
      if (!process.stdin.isTTY) return { status: 'unavailable', reason: 'No interactive terminal to ask on.' };
      process.stdout.write(`\n  🔑 The agent is asking for a credential: "${req.name}" (${req.kind})`
        + `${req.host || req.url ? ` for ${req.url ?? req.host}` : ''}\n  Reason: ${req.reason}\n`
        + '  It is stored in the vault; the agent only ever gets its name. Leave empty to decline.\n');
      const secret: Record<string, string> = {};
      try {
        for (const field of req.fields) {
          const v = await promptHidden(`  ${field}: `);
          if (!v) return { status: 'declined' };
          secret[field] = v;
        }
      } catch { return { status: 'declined' }; }
      return { status: 'provided', secret };
    },
  };
}
