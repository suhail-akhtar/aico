/**
 * Who may say "yes" to a tool call waiting for permission.
 *
 * `/api/permission` used to be authorised by the API token alone. The token
 * authenticates a *client*, not a *person* — and the vault's threat model
 * (docs/security/credential-broker.md §1) assumes the model can `curl` the
 * loopback port and may learn the token. A model that could approve its own
 * tool calls would make every "ask before running" setting decorative. So a
 * *yes* now needs something the token does not give:
 *
 *  - **AICO Desktop** (a host is attached): only the private host channel.
 *    Main forwards the person's click from its own window over the utility
 *    process's `parentPort`, which no shell command can write to. HTTP yeses
 *    are refused outright.
 *  - **`aico serve` / VS Code**: a *UI key*, minted here at startup and handed
 *    out only in the URL fragment printed for the person (`#ui=…`, which a
 *    browser never sends to a server) or read by a parent process from the
 *    server's stdout (the VS Code extension). The browser client trades it
 *    for a per-client nonce (`POST /api/ui/attach`) that is valid only while
 *    that client holds an event stream open for the session it decides — a
 *    nonce that leaks from a closed tab is useless a minute later. A parent
 *    process that holds the key itself sends it as `x-aico-ui-key`.
 *  - A request a browser marks as cross-site (`Sec-Fetch-Site: cross-site`)
 *    is refused whatever it carries.
 *
 * A *no* needs no proof: refusing is always safe, and a client with only the
 * token must still be able to stop a run it can see.
 *
 * Residual risk, stated plainly: the UI key travels with the token in the one
 * link printed at startup. A process that can read that link — the terminal's
 * scrollback, the browser's history before the client strips it, the VS Code
 * server log — has both. This removes the token as sufficient; it does not
 * make the loopback API a boundary against a same-user process that can read
 * what the person can read. The shell guard (vault/guard.ts) additionally
 * refuses the obvious `curl …/api/permission` from the agent's own shell.
 *
 * @module server/decision-gate
 */

import crypto from 'node:crypto';

/** How long a client nonce outlives its last event stream (a reload, a dropped connection). */
const RECONNECT_GRACE_MS = 60_000;
/** Nonces per server, so a loop cannot grow the table without bound. */
const MAX_CLIENTS = 256;

export type AllowVerdict = { ok: true; via: 'host' | 'ui-key' | 'client' } | { ok: false; reason: string };

export interface AllowRequest {
  sessionId: string;
  /** Per-client nonce from `ui/attach`, in the body or `x-aico-client`. */
  client?: unknown;
  /** The UI key itself, from a parent process (`x-aico-ui-key`). */
  uiKey?: unknown;
  /** `Sec-Fetch-Site`, when a browser sent one. */
  fetchSite?: string | undefined;
}

interface Client {
  issuedAt: number;
  /** Sessions with an event stream open now, and how many. */
  open: Map<string, number>;
  /** Sessions this client has ever watched (bounded by its lifetime). */
  seen: Set<string>;
  lastClosedAt: number;
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export class DecisionGate {
  readonly uiKey: string;
  private hostAttached = false;
  private readonly clients = new Map<string, Client>();
  private hostDecider: ((sessionId: string, id: string, allow: boolean) => boolean) | undefined;

  constructor(private readonly now: () => number = Date.now, uiKey?: string) {
    this.uiKey = uiKey ?? crypto.randomBytes(24).toString('base64url');
  }

  /** AICO Desktop attached its private channel: yeses come only from there. */
  setHostAttached(attached: boolean): void { this.hostAttached = attached; }
  get host(): boolean { return this.hostAttached; }

  /** The run manager's decide(), for decisions arriving over the host channel. */
  setDecider(decide: (sessionId: string, id: string, allow: boolean) => boolean): void { this.hostDecider = decide; }

  /** A decision from the host channel (desktop main). Trusted: that port is not reachable from a shell. */
  decideFromHost(sessionId: string, id: string, allow: boolean): boolean {
    return this.hostDecider?.(sessionId, id, allow) ?? false;
  }

  /**
   * Trade the UI key for a per-client nonce. Refuses without the key: a
   * client that has only the token can watch, and can refuse, but not allow.
   */
  attach(uiKey: unknown, fetchSite?: string): { client: string } | { error: string } {
    if (fetchSite === 'cross-site') return { error: 'cross-site request refused' };
    if (typeof uiKey !== 'string' || !sameSecret(uiKey, this.uiKey)) {
      return { error: 'This window has no approval key. Open AICO from the link it printed (the part after # carries the key).' };
    }
    this.prune();
    if (this.clients.size >= MAX_CLIENTS) {
      const oldest = [...this.clients.entries()].sort((a, b) => a[1].issuedAt - b[1].issuedAt)[0];
      if (oldest) this.clients.delete(oldest[0]);
    }
    const client = crypto.randomBytes(18).toString('base64url');
    this.clients.set(client, { issuedAt: this.now(), open: new Map(), seen: new Set(), lastClosedAt: 0 });
    return { client };
  }

  /**
   * A client opened an event stream for a session. Returns the function to
   * call when it closes. Unknown nonces are ignored (the stream still works;
   * that client simply cannot allow).
   */
  connect(client: unknown, sessionId: string): () => void {
    if (typeof client !== 'string') return () => {};
    const c = this.clients.get(client);
    if (!c) return () => {};
    c.open.set(sessionId, (c.open.get(sessionId) ?? 0) + 1);
    if (c.seen.size < 1000) c.seen.add(sessionId);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      const n = (c.open.get(sessionId) ?? 1) - 1;
      if (n > 0) c.open.set(sessionId, n);
      else c.open.delete(sessionId);
      c.lastClosedAt = this.now();
    };
  }

  /** May this request allow a tool call in this session? */
  checkAllow(req: AllowRequest): AllowVerdict {
    if (req.fetchSite === 'cross-site') return { ok: false, reason: 'cross-site request refused' };
    if (this.hostAttached) {
      return { ok: false, reason: 'In AICO Desktop, a tool call is allowed from the AICO window itself; the API token cannot allow it.' };
    }
    if (typeof req.uiKey === 'string' && req.uiKey && sameSecret(req.uiKey, this.uiKey)) return { ok: true, via: 'ui-key' };
    if (typeof req.client === 'string' && req.client) {
      const c = this.clients.get(req.client);
      // Connected to this session now — or was, and dropped less than a
      // minute ago (a reload, a flaky tunnel): the person is still there.
      const connected = c?.open.has(req.sessionId)
        || (c?.seen.has(req.sessionId) && !c.open.has(req.sessionId) && this.now() - c.lastClosedAt < RECONNECT_GRACE_MS);
      if (connected) return { ok: true, via: 'client' };
      if (c) return { ok: false, reason: 'This window is not showing that chat. Open it and answer there.' };
    }
    return { ok: false, reason: 'Allowing a tool call needs the AICO window that shows the prompt; the API token alone cannot allow it. Refusing needs nothing.' };
  }

  private prune(): void {
    const t = this.now();
    for (const [k, c] of this.clients) {
      // Never connected within a minute of attaching, or closed for longer than the grace.
      if (c.open.size === 0 && t - Math.max(c.lastClosedAt, c.issuedAt) > RECONNECT_GRACE_MS) this.clients.delete(k);
    }
  }
}

let gate: DecisionGate | undefined;

/** The process's gate (one server per process in every host AICO has). */
export function decisionGate(): DecisionGate {
  gate ??= new DecisionGate();
  return gate;
}

/** Tests: a fresh gate with a controllable clock. */
export function resetDecisionGate(next?: DecisionGate): DecisionGate {
  gate = next ?? new DecisionGate();
  return gate;
}
