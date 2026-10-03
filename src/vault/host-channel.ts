/**
 * The engine side of the vault's private channel to its host (AICO Desktop).
 *
 * The desktop runs the engine in an Electron utility process and talks to it
 * over `process.parentPort`. That port is the one thing in the system a
 * shell command cannot write to: it is not a socket, a file, an environment
 * variable or an HTTP route. So it carries the three things that must not be
 * forgeable by anything the model can run:
 *
 *   ← `vault/key`      { key: base64 }                         the master key (injected provider)
 *   ← `vault/grant`    { nonce, action, credentialId?, ttlMs? } a one-time human grant, minted by main
 *                                                                after a native confirmation
 *   ← `vault/approval` { id, approved, scope? }                the answer to an approval request
 *                                                                (`scope: 'once'` = allow this use only)
 *   ← `vault/fulfil`   { requestId, secret?|decline }          a credential typed into a main-owned prompt
 *   ← `vault/lock`     {}                                      forget the key
 *   ← `vault/fill-request` { requestId, origin, name?, sessionId?, tool? } browser vault login
 *                        (tool: 'Browser' for the person's own fill, 'browser_login' for the agent's;
 *                        or { requestId, host, name, tool: 'SshTerminal' } for an SSH terminal tab, ADR 0019)
 *   → `vault/fill`     { requestId, ok, name?, kind?, username?, fields?, allowSelfSigned?, reason?, candidates? }
 *   → `vault/approve-request`    { request }                   ask the person (native dialog)
 *   → `vault/credential-request` { request }                   ask for a credential (secure prompt)
 *   → `vault/changed`  {}                                       the credential set changed
 *   → `vault/ready`    { status }                              reply to `vault/key`
 *
 * Nothing received here is ever logged. The contract is documented for the
 * host side in docs/security/credential-broker.md.
 *
 * @module vault/host-channel
 */

import { clearInjectedKey, injectMasterKey } from './keys.js';
import { getVault } from './index.js';
import type { GrantAction } from './human.js';

export interface HostPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (e: { data: unknown }) => void): void;
}

const GRANT_ACTIONS: readonly GrantAction[] = ['reveal', 'loosen', 'export', 'delete', 'rotate', 'approve'];

/**
 * Attach the vault to a host's message port. Also makes the server's
 * approvals and credential requests go to the host first.
 */
export function attachVaultHostChannel(port: HostPort): void {
  const vault = getVault();
  vault.setHostSender((message) => port.postMessage(message));

  port.on('message', (event) => {
    const msg = event?.data as { type?: string; [k: string]: unknown } | undefined;
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('vault/')) return;
    void handle(msg).catch(() => { /* a malformed host message must not crash the engine; nothing is logged */ });
  });

  async function handle(msg: { type?: string; [k: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case 'vault/key': {
        if (typeof msg.key !== 'string') return;
        const key = Buffer.from(msg.key, 'base64');
        try { injectMasterKey(key); } finally { key.fill(0); }
        msg.key = undefined;
        await vault.ready();
        port.postMessage({ type: 'vault/ready', status: vault.status() });
        return;
      }
      case 'vault/grant': {
        const action = msg.action as GrantAction;
        if (typeof msg.nonce !== 'string' || !GRANT_ACTIONS.includes(action)) return;
        vault.grants.register({
          nonce: msg.nonce,
          action,
          ...(typeof msg.credentialId === 'string' ? { credentialId: msg.credentialId } : {}),
          ...(typeof msg.ttlMs === 'number' ? { ttlMs: msg.ttlMs } : {}),
        });
        return;
      }
      case 'vault/approval':
        // `scope: 'once'` — "Allow once" on a session-mode request.
        if (typeof msg.id === 'string' && typeof msg.approved === 'boolean') {
          vault.approvals.answer(msg.id, msg.approved, msg.scope === 'once' ? 'once' : undefined);
        }
        return;
      case 'vault/fulfil':
        if (typeof msg.requestId === 'string') {
          vault.fulfil(msg.requestId, {
            ...(msg.secret && typeof msg.secret === 'object' ? { secret: msg.secret as Record<string, string> } : {}),
            ...(typeof msg.username === 'string' ? { username: msg.username } : {}),
            ...(msg.decline === true ? { decline: true } : {}),
          });
        }
        return;
      case 'vault/lock':
        vault.lock();
        clearInjectedKey();
        return;
      case 'vault/fill-request':
        await fill(msg);
        return;
      default:
    }
  }

  /**
   * The browser's vault login. Main asks for the credential for a page's
   * top-level origin; the engine resolves it under the policy (tool
   * `Browser`, that exact origin) and answers over this port — the only way a
   * value leaves the engine besides a grant-backed reveal. The model is not
   * involved: it may have asked for the page to be opened, but never sees
   * this exchange or its answer.
   */
  async function fill(msg: { [k: string]: unknown }): Promise<void> {
    if (msg.tool === 'SshTerminal') { await sshFill(msg); return; }
    const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
    const origin = typeof msg.origin === 'string' ? msg.origin : '';
    // Who is asking, as main knows it: `Browser` for a person's own fill (the
    // key icon, the chooser), `browser_login` for the agent's tool. Policies
    // and the audit log tell them apart; nothing else is accepted.
    const tool = msg.tool === 'browser_login' ? 'browser_login' : 'Browser';
    const reply = (body: Record<string, unknown>): void => port.postMessage({ type: 'vault/fill', requestId, ...body });
    if (!requestId || !origin) { reply({ ok: false, reason: 'requestId and origin required' }); return; }
    try {
      const candidates = await vault.findForOrigin(origin);
      const wanted = typeof msg.name === 'string' ? candidates.find(c => c.name === msg.name) : candidates[0];
      if (!wanted) {
        const named = typeof msg.name === 'string' ? `"${msg.name}" is not bound to ${origin}` : 'no stored credential is bound to this origin';
        reply({ ok: false, reason: named, candidates: candidates.map(c => c.name) });
        return;
      }
      const resolved = await vault.resolve(wanted.name, {
        tool,
        origin,
        purpose: typeof msg.purpose === 'string' ? msg.purpose.slice(0, 300) : `log in to ${origin} in the AICO browser`,
        ...(typeof msg.sessionId === 'string' ? { sessionId: msg.sessionId } : {}),
      });
      try {
        reply({
          ok: true,
          name: resolved.name,
          kind: resolved.kind,
          ...(resolved.username ? { username: resolved.username } : {}),
          fields: { ...resolved.fields },
          allowSelfSigned: resolved.allowSelfSigned,
        });
      } finally {
        resolved.release();
      }
    } catch (err) {
      reply({ ok: false, reason: err instanceof Error ? err.message : 'failed' });
    }
  }

  /**
   * An SSH terminal the person opened in the desktop (ADR 0019): main names
   * the credential and the exact `host[:port]` it is about to connect to,
   * after its own host-key check. Resolved like any trusted consumer's use —
   * tool `SshTerminal`, the credential's host scope, allowed tools and
   * approval mode, the audit log — and answered over this port only. Unlike
   * a browser fill there is no "best match": the person chose a name.
   */
  async function sshFill(msg: { [k: string]: unknown }): Promise<void> {
    const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
    const host = typeof msg.host === 'string' ? msg.host.trim() : '';
    const name = typeof msg.name === 'string' ? msg.name.trim() : '';
    const reply = (body: Record<string, unknown>): void => port.postMessage({ type: 'vault/fill', requestId, ...body });
    if (!requestId || !host || !name) { reply({ ok: false, reason: 'requestId, host and name required' }); return; }
    try {
      const resolved = await vault.resolve(name, {
        tool: 'SshTerminal',
        host,
        purpose: typeof msg.purpose === 'string' ? msg.purpose.slice(0, 300) : `interactive SSH terminal to ${host}`,
      });
      try {
        reply({
          ok: true, name: resolved.name, kind: resolved.kind,
          ...(resolved.username ? { username: resolved.username } : {}),
          fields: { ...resolved.fields },
        });
      } finally {
        resolved.release();
      }
    } catch (err) {
      reply({ ok: false, reason: err instanceof Error ? err.message : 'failed' });
    }
  }
}
