/**
 * AICO Desktop's half of the credential vault's private channel.
 *
 * The engine (a utility process) holds the vault; this module is the trusted
 * process on the other end of its `parentPort` (src/vault/host-channel.ts).
 * That port is the one route into the engine a shell command cannot write to,
 * so everything that must not be forgeable by the model travels over it:
 *
 *   - **the master key.** 32 random bytes, sealed on disk with Electron's
 *     `safeStorage` (DPAPI / Keychain / the Secret Service) and handed to the
 *     engine at every start (`vault/key`). Never an environment variable: the
 *     agent's shell inherits the engine's environment.
 *   - **human grants.** `vault/grant` nonces are minted here only after a
 *     *native* confirmation dialog main shows itself (Windows Hello / OS
 *     re-authentication is not required — a native modal is the bar, and a
 *     same-user process that can script native dialogs is outside the threat
 *     model, as credential-broker.md §1 says of the key store).
 *   - **approvals.** `vault/approve-request` becomes a native dialog naming the
 *     credential, the tool, the target and the purpose, with Allow once /
 *     Allow for this session / Deny.
 *   - **credential requests.** `vault/credential-request` opens the secure
 *     prompt (secure-prompt.ts); what the person types goes from that window to
 *     main to the engine (`vault/fulfil`) and never into the app renderer.
 *   - **fills.** The browser asks for a login for a page's exact origin
 *     (`vault/fill-request`); the answer comes back here and goes straight
 *     into the page by trusted input (browser-vault.ts / browser.ts).
 *   - **tool permissions.** A person's Allow on a tool-permission prompt is
 *     forwarded as `permission/decide` (decision-gate.ts in the engine).
 *
 * Nothing received here is logged; nothing secret is emitted to a window.
 *
 * @module desktop/electron/vault-host
 */

import { app, BrowserWindow, dialog, safeStorage } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DesktopContext } from './context';
import { openSecurePrompt, type SecureField } from './secure-prompt';
import { safeStorageProblem } from './security-core';

/** What the engine's ApprovalRequest looks like (src/vault/human.ts). */
export interface ApprovalRequest {
  id: string;
  credential: { id: string; name: string; kind: string };
  tool: string;
  target?: string;
  purpose: string;
  description: string;
  sessionId?: string;
  mode: 'every-use' | 'session';
}

/** What the engine's HumanCredentialRequest looks like. */
export interface CredentialRequest {
  requestId: string;
  name: string;
  kind: string;
  fields: string[];
  username?: string;
  host?: string;
  url?: string;
  reason: string;
  sessionId?: string;
}

/** The engine's answer to a fill request. `fields` holds values: use once, drop. */
export interface FillReply {
  ok: boolean;
  name?: string;
  kind?: string;
  username?: string;
  fields?: Record<string, string>;
  allowSelfSigned?: boolean;
  reason?: string;
  candidates?: string[];
}

export type GrantAction = 'reveal' | 'loosen' | 'export' | 'delete' | 'rotate' | 'approve';

export interface VaultHost {
  /** Whether the key could be sealed on this computer (else the engine uses its own keyring). */
  keyAvailable(): boolean;
  /** Why not, when it cannot. */
  keyProblem(): string | undefined;
  /** Mint a one-time grant for one action. Call ONLY after a native confirmation. */
  mintGrant(action: GrantAction, credentialId?: string, ttlMs?: number): string;
  /**
   * Ask the engine for a login for this exact origin — or, for an SSH
   * terminal the person opened (`tool: 'SshTerminal'`), for this exact
   * `host[:port]` by name (terminal-ssh.ts, ADR 0019). The reply carries
   * values: use them and drop them.
   */
  requestFill(req: { origin: string; name?: string; tool: 'Browser' | 'browser_login'; sessionId?: string; purpose?: string }
    | { host: string; name: string; tool: 'SshTerminal'; purpose: string }): Promise<FillReply>;
  /**
   * A person's own fill (the key icon, the chooser) is itself their approval:
   * a Browser approval for this origin arriving in the next few seconds is
   * answered yes without a second question.
   */
  expectPersonFill(origin: string, name: string): void;
  /** Forward a person's tool-permission decision over the private port. */
  decidePermission(sessionId: string, id: string, allow: boolean): Promise<boolean>;
  /** Lock the engine's vault (forget the key there) / hand it back. */
  lock(): void;
  unlock(): boolean;
  locked(): boolean;
}

const KEY_FILE = 'vault-key.bin';
const MAGIC = Buffer.from('AICOVKEY1\n', 'utf8');

export function registerVaultHost(ctx: DesktopContext): VaultHost {
  const keyFile = path.join(ctx.paths.desktopDir, KEY_FILE);
  let problem: string | undefined;
  let lockedByPerson = false;

  /** Why safeStorage cannot protect a key here (Linux's fixed-key fallback protects nothing). */
  const safeProblem = (): string | undefined => {
    if (!app.isReady()) return safeStorageProblem({ ready: false, available: false, platform: process.platform });
    let backend: string | undefined;
    if (process.platform === 'linux') {
      try { backend = (safeStorage as unknown as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.(); } catch { /* older Electron: trust isEncryptionAvailable */ }
    }
    // One rule for the vault key and the autofill profile (security-core.ts).
    return safeStorageProblem({ ready: true, available: safeStorage.isEncryptionAvailable(), platform: process.platform, backend });
  };

  /** The master key: unsealed from disk, or made and sealed on first run. Never kept beyond sending. */
  const masterKey = (): Buffer | null => {
    problem = safeProblem();
    if (problem) return null;
    try {
      if (fs.existsSync(keyFile)) {
        const buf = fs.readFileSync(keyFile);
        if (buf.length <= MAGIC.length || !buf.subarray(0, MAGIC.length).equals(MAGIC)) { problem = 'The vault key file is damaged; it was left as it is.'; return null; }
        const b64 = safeStorage.decryptString(buf.subarray(MAGIC.length));
        const key = Buffer.from(b64, 'base64');
        if (key.length !== 32) { problem = 'The vault key file is damaged; it was left as it is.'; return null; }
        return key;
      }
      const key = crypto.randomBytes(32);
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      const sealed = Buffer.concat([MAGIC, safeStorage.encryptString(key.toString('base64'))]);
      fs.writeFileSync(`${keyFile}.tmp`, sealed, { mode: 0o600 });
      fs.renameSync(`${keyFile}.tmp`, keyFile);
      return key;
    } catch (err) {
      problem = `The vault key could not be opened (${(err as Error).message}).`;
      return null;
    }
  };

  // The engine must be told to use this key before it first opens a vault.
  // Naming the provider is not secret; the key never goes in the environment.
  problem = safeProblem();
  if (!problem) ctx.engine.setEnv({ AICO_VAULT_KEY_PROVIDER: 'injected' });

  const sendKey = (): void => {
    if (lockedByPerson) return;
    const key = masterKey();
    if (!key) return;
    const b64 = key.toString('base64');
    key.fill(0);
    ctx.engine.post({ type: 'vault/key', key: b64 });
  };
  ctx.engine.on('engine-ready', () => sendKey());

  // ── Approvals ──
  const personFills = new Map<string, number>();
  const approvalQueue: ApprovalRequest[] = [];
  let approving = false;
  const parentWindow = (): BrowserWindow | null => {
    const w = BrowserWindow.getFocusedWindow() ?? ctx.window();
    return w && !w.isDestroyed() ? w : null;
  };

  const approve = async (req: ApprovalRequest): Promise<void> => {
    // A person's own fill of this credential on this origin: they already said yes.
    const key = `${req.target ?? ''}\u0000${req.credential.name}`;
    const expected = personFills.get(key);
    if (req.tool === 'Browser' && expected && Date.now() < expected) {
      personFills.delete(key);
      ctx.engine.post({ type: 'vault/approval', id: req.id, approved: true, scope: 'once' });
      return;
    }
    const session = req.mode === 'session';
    // A use that names no chat (the browser's MCP tools do not know which chat
    // called them) is remembered for this engine run — said so, not dressed up
    // as "this session".
    const buttons = session ? ['Allow once', req.sessionId ? 'Allow for this chat session' : 'Allow until AICO restarts', 'Deny'] : ['Allow once', 'Deny'];
    const deny = buttons.length - 1;
    const what = req.tool === 'browser_login' ? 'sign in with' : req.tool === 'Browser' ? 'fill' : 'use';
    const abort = new AbortController();
    // The engine gives up after five minutes; so does the question.
    const timer = setTimeout(() => abort.abort(), 4.5 * 60_000);
    ctx.reveal();
    const opts: Electron.MessageBoxOptions = {
      type: 'question', title: 'Use a stored credential?', noLink: true, buttons, defaultId: deny, cancelId: deny, signal: abort.signal,
      message: `The agent wants to ${what} “${req.credential.name}”.`,
      detail: [
        `Credential: ${req.credential.name} (${req.credential.kind})`,
        `Tool: ${req.tool}`,
        req.target ? `Where it goes: ${req.target}` : 'Where it goes: not stated — only allow if you are sure',
        `Purpose: ${req.purpose.slice(0, 600)}`,
        '',
        'The value is filled or sent by AICO itself. The agent never sees it.',
      ].join('\n'),
    };
    try {
      const w = parentWindow();
      const r = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
      const approved = !abort.signal.aborted && r.response !== deny;
      ctx.engine.post({ type: 'vault/approval', id: req.id, approved, ...(approved && r.response === 0 ? { scope: 'once' } : {}) });
    } catch {
      ctx.engine.post({ type: 'vault/approval', id: req.id, approved: false });
    } finally {
      clearTimeout(timer);
    }
  };
  const drainApprovals = async (): Promise<void> => {
    if (approving) return;
    approving = true;
    try {
      while (approvalQueue.length) await approve(approvalQueue.shift()!);
    } finally { approving = false; }
  };

  // ── Credential requests: the secure prompt ──
  const credentialRequest = async (req: CredentialRequest): Promise<void> => {
    const fields: SecureField[] = [
      ...(req.kind !== 'api-token' && req.kind !== 'note' && req.kind !== 'generic' && req.kind !== 'ssh-key' && req.kind !== 'certificate'
        ? [{ id: 'username', label: 'Username', secret: false, value: req.username ?? '' }] : []),
      ...req.fields.map(f => ({ id: `secret.${f}`, label: labelFor(f), secret: true, multiline: /privateKey|pfx|text/.test(f) })),
    ];
    const answer = await openSecurePrompt(ctx, {
      title: 'The agent needs a credential',
      heading: `“${req.name}” (${req.kind})${req.url ?? req.host ? ` for ${req.url ?? req.host}` : ''}`,
      explain: `Reason: ${req.reason.slice(0, 500)}`,
      note: 'What you type goes straight into AICO’s encrypted vault, bound to that address. The agent gets only the name — never the value.',
      fields,
      submitLabel: 'Save to vault',
      cancelLabel: 'Decline',
      timeoutMs: 9.5 * 60_000,
    });
    if (!answer) { ctx.engine.post({ type: 'vault/fulfil', requestId: req.requestId, decline: true }); return; }
    const secret: Record<string, string> = {};
    for (const [k, v] of Object.entries(answer)) if (k.startsWith('secret.') && v) secret[k.slice('secret.'.length)] = v;
    const username = answer.username?.trim();
    ctx.engine.post({ type: 'vault/fulfil', requestId: req.requestId, secret, ...(username ? { username } : {}) });
    for (const k of Object.keys(answer)) answer[k] = '';
  };

  // ── Fill replies and permission decisions ──
  const fills = new Map<string, { resolve: (r: FillReply) => void; timer: NodeJS.Timeout }>();
  const decisions = new Map<string, (ok: boolean) => void>();

  ctx.engine.on('message', (msg: { type?: string; [k: string]: unknown }) => {
    switch (msg.type) {
      case 'vault/ready':
        ctx.emit('vault:changed', { ready: true });
        return;
      case 'vault/changed':
        ctx.emit('vault:changed', {});
        return;
      case 'vault/approve-request': {
        const req = msg.request as ApprovalRequest | undefined;
        if (req?.id) { approvalQueue.push(req); void drainApprovals(); }
        return;
      }
      case 'vault/credential-request': {
        const req = msg.request as CredentialRequest | undefined;
        if (req?.requestId) void credentialRequest(req).catch(() => ctx.engine.post({ type: 'vault/fulfil', requestId: req.requestId, decline: true }));
        return;
      }
      case 'vault/fill': {
        const id = typeof msg.requestId === 'string' ? msg.requestId : '';
        const f = fills.get(id);
        if (!f) return;
        fills.delete(id);
        clearTimeout(f.timer);
        f.resolve(msg as unknown as FillReply);
        return;
      }
      case 'permission/decided': {
        const key = `${String(msg.sessionId)}\u0000${String(msg.id)}`;
        const d = decisions.get(key);
        if (d) { decisions.delete(key); d(msg.ok === true); }
        return;
      }
      default:
    }
  });

  let fillSeq = 0;
  return {
    keyAvailable: () => safeProblem() === undefined,
    keyProblem: () => problem ?? safeProblem(),
    mintGrant(action, credentialId, ttlMs) {
      const nonce = crypto.randomBytes(24).toString('base64url');
      ctx.engine.post({ type: 'vault/grant', nonce, action, ...(credentialId ? { credentialId } : {}), ...(ttlMs ? { ttlMs } : {}) });
      return nonce;
    },
    requestFill(req) {
      const requestId = `fill-${Date.now().toString(36)}-${++fillSeq}`;
      return new Promise<FillReply>((resolve) => {
        // Long enough for a person to answer an approval dialog.
        const timer = setTimeout(() => { fills.delete(requestId); resolve({ ok: false, reason: 'the vault did not answer in time (was an approval left open?)' }); }, 5 * 60_000);
        fills.set(requestId, { resolve, timer });
        const target = 'host' in req ? { host: req.host } : { origin: req.origin, ...(req.sessionId ? { sessionId: req.sessionId } : {}) };
        if (!ctx.engine.post({ type: 'vault/fill-request', requestId, ...target, tool: req.tool, ...(req.name ? { name: req.name } : {}), ...(req.purpose ? { purpose: req.purpose } : {}) })) {
          clearTimeout(timer);
          fills.delete(requestId);
          resolve({ ok: false, reason: 'the AICO engine is not running' });
        }
      });
    },
    expectPersonFill(origin, name) {
      personFills.set(`${origin}\u0000${name}`, Date.now() + 8000);
    },
    decidePermission(sessionId, id, allow) {
      return new Promise<boolean>((resolve) => {
        const key = `${sessionId}\u0000${id}`;
        const timer = setTimeout(() => { decisions.delete(key); resolve(false); }, 10_000);
        decisions.set(key, (ok) => { clearTimeout(timer); resolve(ok); });
        if (!ctx.engine.post({ type: 'permission/decide', sessionId, id, allow })) { clearTimeout(timer); decisions.delete(key); resolve(false); }
      });
    },
    lock() {
      lockedByPerson = true;
      ctx.engine.post({ type: 'vault/lock' });
      ctx.emit('vault:changed', {});
    },
    unlock() {
      lockedByPerson = false;
      if (!masterKey()) return false;
      sendKey();
      return true;
    },
    locked: () => lockedByPerson,
  };
}

function labelFor(field: string): string {
  const map: Record<string, string> = {
    password: 'Password', totpSeed: 'TOTP seed (optional)', privateKey: 'Private key', passphrase: 'Key passphrase',
    token: 'Token', community: 'Community string', authKey: 'Auth key', privKey: 'Privacy key', connectionString: 'Connection string',
    pfx: 'PFX (base64)', text: 'Note', value: 'Value',
  };
  return map[field] ?? field;
}
