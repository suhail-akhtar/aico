/**
 * The autofill profile on disk, and filling a page from it — for the person
 * (the key button by the address bar) and for the agent (`browser_autofill`,
 * through BrowserService.autofill, access-checked and shown like its other
 * actions).
 *
 * The profile is the person's own, on this machine only:
 * `<AICO_HOME>/desktop/browser/autofill.json`, encrypted with the OS keychain
 * (`safeStorage`). Where the keychain cannot protect it — none at all, or
 * Linux's fixed-key "basic_text" fallback — autofill stays off: nothing is
 * saved, nothing is filled, and the settings page says why (the same check as
 * the vault key, security-core.ts safeStorageProblem). A plain-JSON profile
 * an unprotected machine wrote earlier is no longer read. It holds no passwords or payment details — see
 * browser-autofill.ts for what is filled and what never is.
 *
 * The page is read and filled in an isolated world: the page's own scripts
 * cannot see the values before they are in the fields, or change the filler.
 * The agent is told which fields were filled, not the values.
 *
 * @module desktop/electron/browser-autofill-store
 */

import { app, safeStorage, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { DesktopContext } from './context';
import {
  APPLY_FILLS_JS, COLLECT_FIELDS_JS, EMPTY_PROFILE, normaliseProfile, planAutofill, profileIsEmpty,
  type AfField, type AutofillPlan, type AutofillProfile,
} from './browser-autofill';
import { AICO_WORLD } from './browser-session';
import { safeStorageProblem } from './security-core';

export interface AutofillResult { filled: number; fields: Array<{ label: string; what: string }>; skipped: AutofillPlan['skipped']; address?: string; empty?: boolean }

export interface AutofillService {
  profile(): AutofillProfile;
  /** Replace the profile (the import centre adds addresses through this). */
  save(p: AutofillProfile): AutofillProfile;
  scan(wc: WebContents): Promise<AutofillResult>;
  fill(wc: WebContents, opts?: { addressId?: string }): Promise<AutofillResult>;
  /** The agent's account of a fill. */
  describe(r: AutofillResult): string;
}

const run = <T>(wc: WebContents, code: string, ms = 5000): Promise<T> => Promise.race([
  wc.executeJavaScriptInIsolatedWorld(AICO_WORLD, [{ code }], true) as Promise<T>,
  new Promise<T>((_r, reject) => setTimeout(() => reject(new Error('The page did not answer in time.')), ms)),
]);

export function registerAutofill(ctx: DesktopContext, activeWc: () => WebContents | null): AutofillService {
  const file = path.join(ctx.paths.desktopDir, 'browser', 'autofill.json');
  let cache: AutofillProfile | null = null;

  /** Why the OS keychain cannot protect the profile here; autofill is off while there is one. */
  const problem = (): string | undefined => {
    let backend: string | undefined;
    try { backend = (safeStorage as unknown as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.(); } catch { /* older Electron */ }
    return safeStorageProblem({ ready: app.isReady(), available: safeStorage.isEncryptionAvailable(), platform: process.platform, backend });
  };
  const empty = (): AutofillProfile => ({ ...EMPTY_PROFILE, addresses: [] });

  const read = (): AutofillProfile => {
    if (problem()) return empty();
    if (cache) return cache;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { enc?: string; data?: string; profile?: unknown };
      // Only a sealed profile: a plain one is what an unprotected machine wrote, and stays unread.
      cache = raw.enc === 'safeStorage' && raw.data ? normaliseProfile(JSON.parse(safeStorage.decryptString(Buffer.from(raw.data, 'base64')))) : empty();
    } catch { cache = empty(); }
    return cache;
  };

  const write = (p: AutofillProfile): AutofillProfile => {
    const why = problem();
    if (why) throw new Error(`Autofill is off on this computer: ${why} Your details are not saved unprotected.`);
    const next = normaliseProfile({ ...p, updatedAt: Date.now() });
    const body = { v: 1, enc: 'safeStorage', data: safeStorage.encryptString(JSON.stringify(next)).toString('base64') };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(body));
    fs.renameSync(`${file}.tmp`, file);
    cache = next;
    return next;
  };

  const collect = async (wc: WebContents): Promise<AfField[]> => {
    if (wc.isDestroyed() || !/^(https?|file):/i.test(wc.getURL())) return [];
    return (await run<AfField[]>(wc, COLLECT_FIELDS_JS).catch(() => [])) ?? [];
  };

  const result = (plan: AutofillPlan, filledKeys?: string[]): AutofillResult => {
    const p = read();
    const fills = filledKeys ? plan.fills.filter(f => filledKeys.includes(f.key)) : plan.fills;
    return {
      filled: fills.length, fields: fills.map(f => ({ label: f.label, what: f.what })), skipped: plan.skipped,
      ...(plan.address ? { address: p.addresses.find(a => a.id === plan.address)?.label } : {}),
      ...(profileIsEmpty(p) ? { empty: true } : {}),
    };
  };

  const service: AutofillService = {
    profile: read,
    save: (p) => write(normaliseProfile(p)),
    async scan(wc) {
      const p = read();
      if (profileIsEmpty(p)) return { filled: 0, fields: [], skipped: [], empty: true };
      return result(planAutofill(await collect(wc), p));
    },
    async fill(wc, opts) {
      const p = read();
      if (profileIsEmpty(p)) return { filled: 0, fields: [], skipped: [], empty: true };
      const plan = planAutofill(await collect(wc), p, opts);
      if (!plan.fills.length) return result(plan, []);
      const done = await run<string[]>(wc, APPLY_FILLS_JS.replace('__FILLS__', JSON.stringify(plan.fills.map(f => ({ key: f.key, value: f.value })))));
      return result(plan, done ?? []);
    },
    describe(r) {
      if (r.empty) return 'The user has not saved an autofill profile yet (Settings → Browser → Autofill). Ask them for the details, or to save a profile.';
      const lines = [`Filled ${r.filled} field(s) from the user's saved autofill profile${r.address ? ` (address "${r.address}")` : ''}. Nothing was submitted.`];
      for (const f of r.fields) lines.push(`- "${f.label}": ${f.what}`);
      if (r.skipped.length) lines.push('Not filled:', ...r.skipped.slice(0, 20).map(s => `- "${s.label}": ${s.reason}`));
      if (!r.filled && !r.skipped.length) lines.push('No field on this page matched the profile (name, email, phone, company, address). Use browser_forms and browser_fill for the rest.');
      return lines.join('\n');
    },
  };

  ctx.handle('browser:autofill:get', () => read());
  ctx.handle('browser:autofill:set', (p: unknown) => write(normaliseProfile(p)));
  ctx.handle('browser:autofill:status', () => {
    const p = read();
    const why = problem();
    return { encrypted: !why, ...(why ? { problem: `Autofill is off: ${why}` } : {}), empty: profileIsEmpty(p), addresses: p.addresses.map(a => ({ id: a.id, label: a.label })) };
  });
  ctx.handle('browser:autofill:scan', async () => { const wc = activeWc(); return wc ? service.scan(wc) : { filled: 0, fields: [], skipped: [] }; });
  ctx.handle('browser:autofill:fill', async (opts?: { addressId?: string }) => {
    const wc = activeWc();
    if (!wc) return { filled: 0, fields: [], skipped: [] };
    return service.fill(wc, { addressId: typeof opts?.addressId === 'string' ? opts.addressId : undefined });
  });
  return service;
}
