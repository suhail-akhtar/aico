/**
 * The Credential Manager's main-process half.
 *
 * The interface (renderer/src/settings/CredentialManager.tsx) lists, filters
 * and edits credentials — metadata and policy, which are not secret — and
 * asks main for everything that touches a value. Main is where values are
 * allowed to exist, briefly:
 *
 *   - **putting one in** (Add, Rotate with a typed value, SSH key import,
 *     export/import passphrases) opens the secure prompt (secure-prompt.ts),
 *     and the value goes from there to the engine; the interface gets back
 *     the credential's metadata;
 *   - **getting one out** (Reveal, Copy) needs a native confirmation, then a
 *     one-time grant minted over the private channel (vault-host.ts); the
 *     value is shown in a native dialog that closes itself, or put on the
 *     clipboard and cleared again — never returned to the interface;
 *   - **widening or removing** (a looser policy, Delete, Rotate of a value the
 *     person stored, Export) needs the same confirmation and grant, because
 *     the API token alone must never be enough (credential-broker.md §5).
 *
 * The aico:// proxy (protocol.ts) refuses the value-returning vault routes
 * from the interface outright, so this module is the only way to them.
 *
 * @module desktop/electron/credential-manager
 */

import { BrowserWindow, clipboard, dialog } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { DesktopContext } from './context';
import type { GrantAction, VaultHost } from './vault-host';
import { openSecurePrompt, type SecureField } from './secure-prompt';
import { toPasswordCsv } from './browser-vault-core';

/** Secret fields per kind (src/vault/types.ts SECRET_FIELDS), for the Add / Rotate prompts. */
export const KIND_FIELDS: Record<string, Array<{ field: string; label: string; multiline?: boolean; optional?: boolean }>> = {
  login: [{ field: 'password', label: 'Password' }, { field: 'totpSeed', label: 'TOTP seed (optional)', optional: true }],
  'ssh-key': [{ field: 'privateKey', label: 'Private key (OpenSSH or PEM)', multiline: true }, { field: 'passphrase', label: 'Key passphrase (optional)', optional: true }],
  'ssh-password': [{ field: 'password', label: 'Password' }],
  'api-token': [{ field: 'token', label: 'Token' }],
  'basic-auth': [{ field: 'password', label: 'Password' }],
  winrm: [{ field: 'password', label: 'Password' }],
  snmp: [{ field: 'community', label: 'Community string (v1/v2c)', optional: true }, { field: 'authKey', label: 'Auth key (v3, optional)', optional: true }, { field: 'privKey', label: 'Privacy key (v3, optional)', optional: true }],
  database: [{ field: 'password', label: 'Password' }, { field: 'connectionString', label: 'Connection string (optional)', optional: true }],
  certificate: [{ field: 'privateKey', label: 'Private key (PEM)', multiline: true }, { field: 'passphrase', label: 'Passphrase (optional)', optional: true }],
  note: [{ field: 'text', label: 'Secure note', multiline: true }],
  generic: [{ field: 'value', label: 'Value' }],
};

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_!@#%^*+=';

/** A strong random value for Rotate → Generate (main makes it; it goes straight to the engine). */
function randomValue(length = 24): string {
  const bytes = crypto.randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b < 256 - (256 % PASSWORD_ALPHABET.length)) out += PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length];
  }
  return out;
}

interface Summary { id: string; name: string; kind: string; username?: string; host?: string; url?: string; createdBy: string; fields: string[] }

export function registerCredentialManager(ctx: DesktopContext, host: VaultHost): void {
  const win = (): BrowserWindow | undefined => {
    const w = BrowserWindow.getFocusedWindow() ?? ctx.window();
    return w && !w.isDestroyed() ? w : undefined;
  };
  const confirm = async (o: { title: string; message: string; detail?: string; ok: string; danger?: boolean }): Promise<boolean> => {
    const opts: Electron.MessageBoxOptions = {
      type: o.danger ? 'warning' : 'question', title: o.title, message: o.message, detail: o.detail,
      buttons: [o.ok, 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
    };
    const w = win();
    const r = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
    return r.response === 0;
  };
  const fail = (json: { error?: string }, fallback: string): never => { throw new Error(json.error ?? fallback); };
  const get = async <T,>(route: string): Promise<T> => {
    const r = await ctx.engine.call<T & { error?: string }>(route);
    if (r.status >= 400) fail(r.json, `The vault said ${r.status}.`);
    return r.json;
  };
  const post = async <T,>(route: string, body: unknown): Promise<{ status: number; json: T & { error?: string; code?: string } }> =>
    ctx.engine.call<T & { error?: string; code?: string }>(route, body);
  const summary = async (id: string): Promise<Summary> => (await get<{ credential: Summary }>(`vault/get?id=${encodeURIComponent(id)}`)).credential;
  /** Try a route; if it wants a grant, ask the person natively, mint one, try once more. */
  const withGrant = async <T,>(route: string, body: Record<string, unknown>, action: GrantAction, credentialId: string | undefined, question: { title: string; message: string; detail?: string; ok: string; danger?: boolean }): Promise<T> => {
    let r = await post<T>(route, body);
    if (r.status === 403 && r.json.code === 'grant-required') {
      if (!(await confirm(question))) throw new Error('Cancelled.');
      r = await post<T>(route, { ...body, grant: host.mintGrant(action, credentialId) });
    }
    if (r.status >= 400) fail(r.json, `The vault said ${r.status}.`);
    return r.json;
  };
  const secretFields = (kind: string, only?: string[]): SecureField[] => (KIND_FIELDS[kind] ?? KIND_FIELDS.generic!)
    .filter(f => !only || only.includes(f.field))
    .map(f => ({ id: `secret.${f.field}`, label: f.label, secret: true, ...(f.multiline ? { multiline: true } : {}), ...(f.optional ? { optional: true } : {}) }));
  const collect = (answer: Record<string, string>): Record<string, string> => {
    const secret: Record<string, string> = {};
    for (const [k, v] of Object.entries(answer)) if (k.startsWith('secret.') && v) secret[k.slice('secret.'.length)] = v;
    return secret;
  };
  const wipe = (o: Record<string, string>): void => { for (const k of Object.keys(o)) o[k] = ''; };

  // ── Reading (no values) ──
  ctx.handle('vault:status', async () => {
    const st = await get<Record<string, unknown>>('vault/status').catch((e: Error) => ({ error: e.message }));
    return { ...st, keyProblem: host.keyProblem() ?? null, lockedByYou: host.locked() };
  });
  ctx.handle('vault:list', (filter?: { host?: string; kind?: string }) => {
    const q = new URLSearchParams();
    if (filter?.host) q.set('host', filter.host);
    if (filter?.kind) q.set('kind', filter.kind);
    return get<{ credentials: unknown[] }>(`vault/list${q.size ? `?${q}` : ''}`).then(r => r.credentials);
  });
  ctx.handle('vault:audit', (o?: { id?: string; limit?: number }) =>
    get<{ entries: unknown[] }>(`vault/audit?limit=${Math.min(1000, o?.limit ?? 200)}${o?.id ? `&id=${encodeURIComponent(o.id)}` : ''}`).then(r => r.entries));
  ctx.handle('vault:fields', () => KIND_FIELDS);

  // ── Putting values in (the secure prompt) ──
  ctx.handle('vault:add', async (o: { name: string; kind: string; username?: string; host?: string; url?: string; port?: number; description?: string; tags?: string[]; policy?: Record<string, unknown> }) => {
    const kind = String(o?.kind ?? '');
    if (!KIND_FIELDS[kind]) throw new Error('Choose what kind of credential this is.');
    const answer = await openSecurePrompt(ctx, {
      title: 'Add a credential',
      heading: `${o.name} (${kind})`,
      explain: `${o.username ? `User ${o.username}. ` : ''}${o.url ?? o.host ? `Usable with ${o.url ?? o.host}.` : 'Not bound to a host yet: every use will ask you.'}`,
      note: 'Typed here, it goes straight into AICO’s encrypted vault. The agent can use it where its policy allows, but never see it.',
      fields: secretFields(kind),
      submitLabel: 'Save',
    });
    if (!answer) return null;
    const secret = collect(answer);
    wipe(answer);
    if (!Object.keys(secret).length) throw new Error('Nothing was entered.');
    const r = await post<{ credential: Summary; warnings: string[] }>('vault/create', {
      name: o.name, kind, secret,
      ...(o.username ? { username: o.username } : {}), ...(o.host ? { host: o.host } : {}), ...(o.url ? { url: o.url } : {}),
      ...(typeof o.port === 'number' ? { port: o.port } : {}), ...(o.description ? { description: o.description } : {}),
      ...(o.tags?.length ? { tags: o.tags } : {}), ...(o.policy ? { policy: o.policy } : {}), createdBy: 'user',
    });
    wipe(secret);
    if (r.status >= 400) fail(r.json, 'The credential could not be saved.');
    return r.json;
  });
  ctx.handle('vault:generate', async (o: Record<string, unknown>) => {
    const r = await post<Record<string, unknown>>('vault/generate', o);
    if (r.status >= 400) fail(r.json, 'The credential could not be generated.');
    return r.json;
  });
  ctx.handle('vault:rotate', async (id: string, mode: 'generate' | 'enter') => {
    const c = await summary(String(id));
    const primary = (KIND_FIELDS[c.kind] ?? KIND_FIELDS.generic!)[0]!.field;
    let secret: Record<string, string>;
    if (mode === 'generate') {
      if (c.kind === 'ssh-key' || c.kind === 'certificate' || c.kind === 'note') throw new Error('A new key cannot be made in place: add a new SSH key credential, or enter the new value.');
      secret = { [primary]: randomValue(c.kind === 'api-token' ? 40 : 24) };
    } else {
      const answer = await openSecurePrompt(ctx, {
        title: `Replace “${c.name}”`, heading: `New value for ${c.name} (${c.kind})`,
        note: 'The old value is replaced in the vault. Change it on the service too, or the next use will fail.',
        fields: secretFields(c.kind), submitLabel: 'Replace',
      });
      if (!answer) return null;
      secret = collect(answer);
      wipe(answer);
      if (!Object.keys(secret).length) throw new Error('Nothing was entered.');
    }
    // Always confirmed: AICO only changes what it stores, not the service's own password.
    const question = {
      title: 'Replace a credential', ok: 'Replace', danger: true,
      message: `Replace the stored value of “${c.name}”?`,
      detail: `${mode === 'generate' ? 'A new random value will be stored. ' : ''}This changes only what AICO has saved — set the same value on ${c.url ?? c.host ?? 'the service'} too.`,
    };
    if (!(await confirm(question))) { wipe(secret); return null; }
    const r = await post<{ credential: Summary }>('vault/rotate', { id: c.id, secret, grant: host.mintGrant('rotate', c.id) });
    wipe(secret);
    if (r.status >= 400) fail(r.json, 'The credential could not be replaced.');
    return r.json.credential;
  });

  // ── Changing scope (a loosening asks) ──
  ctx.handle('vault:policy', async (id: string, policy: Record<string, unknown>) => {
    const c = await summary(String(id));
    return (await withGrant<{ credential: Summary }>('vault/policy', { id: c.id, policy }, 'loosen', c.id, {
      title: 'Widen a credential’s use', ok: 'Allow', danger: true,
      message: `Let “${c.name}” be used more widely?`,
      detail: 'This change lets it be used in more places, by more tools, more often or with fewer questions. The agent cannot make this change itself.',
    })).credential;
  });
  ctx.handle('vault:update', async (id: string, patch: Record<string, unknown>) => {
    const c = await summary(String(id));
    return (await withGrant<{ credential: Summary }>('vault/update', { id: c.id, ...patch }, 'loosen', c.id, {
      title: 'Change where a credential is used', ok: 'Change', danger: true,
      message: `Point “${c.name}” somewhere else?`,
      detail: `It is bound to ${c.url ?? c.host ?? 'its own host'}. Changing that decides where the value may be sent.`,
    })).credential;
  });
  ctx.handle('vault:delete', async (id: string) => {
    const c = await summary(String(id));
    if (!(await confirm({ title: 'Delete a credential', ok: 'Delete', danger: true, message: `Delete “${c.name}”?`, detail: 'It is removed from the vault. This cannot be undone (unless you have an exported backup).' }))) return false;
    const r = await post<{ deleted: string }>('vault/delete', { id: c.id, grant: host.mintGrant('delete', c.id) });
    if (r.status >= 400) fail(r.json, 'The credential could not be deleted.');
    return true;
  });

  // ── Getting values out: native confirm → grant → main-owned surface ──
  const reveal = async (c: Summary): Promise<{ username?: string; fields: Record<string, string> } | null> => {
    const r = await post<{ username?: string; fields: Record<string, string> }>('vault/reveal', { id: c.id, grant: host.mintGrant('reveal', c.id), actor: 'credential-manager' });
    if (r.status >= 400) fail(r.json, 'The credential could not be revealed.');
    return r.json;
  };
  ctx.handle('vault:reveal', async (id: string) => {
    const c = await summary(String(id));
    if (!(await confirm({ title: 'Show a credential', ok: 'Show', danger: true, message: `Show the value of “${c.name}”?`, detail: 'Anyone who can see your screen will be able to read it. It closes itself after 30 seconds.' }))) return false;
    const out = await reveal(c);
    if (!out) return false;
    const lines = Object.entries(out.fields).map(([k, v]) => `${k}:\n${v}`);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 30_000);
    const opts: Electron.MessageBoxOptions = {
      type: 'info', title: c.name, noLink: true, buttons: ['Copy', 'Close'], defaultId: 1, cancelId: 1, signal: abort.signal,
      message: `${c.name}${out.username ? ` · ${out.username}` : ''}`, detail: lines.join('\n\n'),
    };
    try {
      const w = win();
      const r = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
      if (r.response === 0 && !abort.signal.aborted) copyWithClear(Object.values(out.fields)[0] ?? '');
    } finally {
      clearTimeout(timer);
      wipe(out.fields);
    }
    return true;
  });
  const copyWithClear = (value: string): void => {
    // Electron 44's clipboard is the async one; either shape is awaited.
    void Promise.resolve(clipboard.writeText(value)).catch(() => {});
    // Cleared after 45 s, unless something else has been copied since.
    setTimeout(() => {
      void Promise.resolve(clipboard.readText()).then((t) => { if (t === value) void Promise.resolve(clipboard.writeText('')); }).catch(() => {});
    }, 45_000);
  };
  ctx.handle('vault:copy', async (id: string, field?: string) => {
    const c = await summary(String(id));
    if (!(await confirm({ title: 'Copy a credential', ok: 'Copy', danger: true, message: `Copy the value of “${c.name}”?`, detail: 'It is cleared from the clipboard after 45 seconds. Anything that reads your clipboard before then can read it.' }))) return false;
    const out = await reveal(c);
    if (!out) return false;
    const value = (field && out.fields[field]) || Object.values(out.fields)[0] || '';
    copyWithClear(value);
    wipe(out.fields);
    return true;
  });

  // ── Lock ──
  ctx.handle('vault:lock', () => { host.lock(); return true; });
  ctx.handle('vault:unlock', async () => {
    if (!(await confirm({ title: 'Unlock the vault', ok: 'Unlock', message: 'Unlock AICO’s credential vault?', detail: 'Stored credentials become usable again, within their policies.' }))) return false;
    return host.unlock();
  });

  // ── Backups ──
  ctx.handle('vault:export', async () => {
    if (!(await confirm({ title: 'Export the vault', ok: 'Continue', danger: true, message: 'Export every credential to an encrypted file?', detail: 'You choose a passphrase next. Anyone with the file and the passphrase has every credential in it.' }))) return null;
    const answer = await openSecurePrompt(ctx, {
      title: 'Export passphrase', heading: 'Choose a passphrase for the export',
      note: 'At least 8 characters. AICO does not keep it: without it the file cannot be opened.',
      fields: [{ id: 'p1', label: 'Passphrase', secret: true, minLength: 8 }, { id: 'p2', label: 'Again', secret: true, confirms: 'p1' }],
      submitLabel: 'Export',
    });
    if (!answer) return null;
    const passphrase = answer.p1 ?? '';
    wipe(answer);
    const r = await post<{ file: string; count: number }>('vault/export', { passphrase, grant: host.mintGrant('export'), actor: 'credential-manager' });
    if (r.status >= 400) fail(r.json, 'The vault could not be exported.');
    const w = win();
    const o = { title: 'Save the encrypted export', defaultPath: path.join(app.getPath('documents'), `AICO credentials ${new Date().toISOString().slice(0, 10)}.aicovault`), filters: [{ name: 'AICO vault export', extensions: ['aicovault', 'json'] }] };
    const s = w ? await dialog.showSaveDialog(w, o) : await dialog.showSaveDialog(o);
    if (s.canceled || !s.filePath) return null;
    fs.writeFileSync(s.filePath, r.json.file, { encoding: 'utf8', mode: 0o600 });
    return { file: s.filePath, count: r.json.count };
  });
  ctx.handle('vault:import', async () => {
    const w = win();
    const o = { title: 'Import an encrypted export', properties: ['openFile' as const], filters: [{ name: 'AICO vault export', extensions: ['aicovault', 'json'] }] };
    const pick = w ? await dialog.showOpenDialog(w, o) : await dialog.showOpenDialog(o);
    if (pick.canceled || !pick.filePaths[0]) return null;
    const file = fs.readFileSync(pick.filePaths[0], 'utf8');
    const answer = await openSecurePrompt(ctx, {
      title: 'Import passphrase', heading: `Passphrase for ${path.basename(pick.filePaths[0])}`,
      note: 'Credentials whose names already exist are skipped, never replaced.',
      fields: [{ id: 'p', label: 'Passphrase', secret: true }], submitLabel: 'Import',
    });
    if (!answer) return null;
    const passphrase = answer.p ?? '';
    wipe(answer);
    const r = await post<{ added: number; skipped: number }>('vault/import', { file, passphrase, actor: 'credential-manager' });
    if (r.status >= 400) fail(r.json, 'The file could not be imported.');
    return r.json;
  });
  /** The browser logins as a plain CSV for another browser — the old Passwords "Export…". */
  ctx.handle('vault:exportCsv', async () => {
    const all = await get<{ credentials: Array<Summary & { tags: string[] }> }>('vault/list?kind=login');
    const logins = all.credentials.filter(c => c.url && /^https?:/i.test(c.url));
    if (!logins.length) throw new Error('There are no web logins to export.');
    if (!(await confirm({ title: 'Export passwords', ok: 'Export…', danger: true, message: `Export ${logins.length} web login${logins.length === 1 ? '' : 's'} to a plain-text file?`, detail: 'The CSV file is NOT encrypted: anyone or any program that can read it gets every password in it. Import it where you need it, then delete it. (For a backup, use Export encrypted.)' }))) return null;
    const w2 = win();
    const o = { title: 'Export passwords', defaultPath: path.join(app.getPath('documents'), 'AICO Passwords.csv'), filters: [{ name: 'CSV', extensions: ['csv'] }] };
    const s = w2 ? await dialog.showSaveDialog(w2, o) : await dialog.showSaveDialog(o);
    if (s.canceled || !s.filePath) return null;
    const rows: Array<{ id: string; origin: string; username: string; password: string; created: number; updated: number }> = [];
    for (const c of logins) {
      const out = await reveal(c).catch(() => null);
      if (!out?.fields.password) continue;
      let origin = c.url!;
      try { origin = new URL(c.url!).origin; } catch { /* keep */ }
      rows.push({ id: c.id, origin, username: c.username ?? '', password: out.fields.password, created: 0, updated: 0 });
      wipe(out.fields);
    }
    fs.writeFileSync(s.filePath, toPasswordCsv(rows), { encoding: 'utf8', mode: 0o600 });
    for (const r of rows) r.password = '';
    return { file: s.filePath, count: rows.length };
  });
}
