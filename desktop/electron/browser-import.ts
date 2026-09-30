/**
 * The import centre: one wizard that brings bookmarks, history and addresses
 * over from the other browsers on this machine, and passwords from a CSV file
 * the person exports themselves.
 *
 * Profiles are found and read by browser-import-read.ts (read-only, locked
 * databases through a temporary copy); what they hold is counted before
 * anything is imported, and the wizard shows a summary after. Main only reads
 * a profile it found itself — the interface names one by the id main gave it,
 * never by a path of its choosing.
 *
 * PASSWORDS COME IN ONE WAY ONLY: a CSV the person exported from Chrome, Edge,
 * Brave, Firefox, Safari, Bitwarden or 1Password and picked in a file dialog.
 * No other browser's password store, cookies, keychain entries or keys are
 * read, copied or decrypted — not even with consent. The CSV's passwords stay
 * in main (the interface sees counts), go into the vault, and afterwards the
 * wizard offers to delete the plain-text file.
 *
 * The agent can only open the wizard (`browser_import`, pre-selected) and read
 * back counts; the person still picks and confirms everything.
 *
 * @module desktop/electron/browser-import
 */

import { app, dialog } from 'electron';
import fs from 'node:fs';
import type { DesktopContext } from './context';
import type {
  HistoryEntry, ImportCounts, ImportPart, ImportPreset, ImportProfile, ImportRequest, ImportSummary, PasswordFilePreview, PasswordImportResult,
} from '../shared/browser-types';
import type { ImportTree } from './browser-bookmarks-io';
import type { AutofillProfile } from './browser-autofill';
import { mapPasswordCsv, mergeAddresses, mergeHistory, type ImportedLogin } from './browser-import-core';
import { findProfiles, readProfile, scanProfile, type FoundProfile } from './browser-import-read';
import type { VaultService } from './browser-vault';

const MAX_CSV_BYTES = 20 * 1024 * 1024;

export interface ImportService {
  /** Open the wizard, pre-selected; the person confirms. */
  open(preset: ImportPreset): void;
  /** What was found, with counts (for the agent's report). */
  profiles(): Promise<Array<ImportProfile & { counts: ImportCounts }>>;
  /** The imports done in this run, newest first — counts only. */
  recent(): Array<ImportSummary | { passwords: Omit<PasswordImportResult, 'file'> & { source: string }; at: number }>;
}

export interface ImportDeps {
  history: { get(): HistoryEntry[]; set(list: HistoryEntry[]): void; flush(): void };
  bookmarks: { importTree(tree: ImportTree, title: string): { count: number; title: string; skipped: number } };
  /** AICO's autofill profile, when that store is there to import addresses into. */
  addresses(): { profile(): AutofillProfile; save(p: AutofillProfile): unknown } | null;
  vault: VaultService;
}

const toPublic = (p: FoundProfile): ImportProfile => ({ id: p.id, browser: p.browser, profile: p.profile, engine: p.engine, ...(p.isDefault ? { isDefault: true } : {}) });

export function registerImport(ctx: DesktopContext, deps: ImportDeps): ImportService {
  let found: FoundProfile[] = [];
  const discover = (): FoundProfile[] => { found = findProfiles(); return found; };
  const byId = (id: string): FoundProfile => {
    const hit = found.find(p => p.id === id) ?? discover().find(p => p.id === id);
    if (!hit) throw new Error('That browser profile was not found any more.');
    return hit;
  };
  const recent: ReturnType<ImportService['recent']> = [];
  const note = (r: ReturnType<ImportService['recent']>[number]): void => { recent.unshift(r); recent.length = Math.min(recent.length, 10); };

  ctx.handle('browser:import:profiles', (): ImportProfile[] => discover().map(toPublic));
  ctx.handle('browser:import:scan', (id: string): Promise<ImportCounts> => scanProfile(byId(String(id))));

  ctx.handle('browser:import:run', async (req: ImportRequest): Promise<ImportSummary> => {
    const p = byId(String(req?.profileId));
    const parts = new Set<ImportPart>((Array.isArray(req?.parts) ? req.parts : []).filter((x): x is ImportPart => x === 'bookmarks' || x === 'history' || x === 'addresses'));
    if (!parts.size) throw new Error('Choose what to import.');
    const summary: ImportSummary = { browser: p.browser, profile: p.profile, errors: [] };
    const several = found.filter(x => x.browser === p.browser).length > 1;
    const label = `${p.browser}${several ? ` (${p.profile})` : ''}`;
    // Each part on its own: one that cannot be read does not stop the others.
    for (const part of ['bookmarks', 'history', 'addresses'] as const) {
      if (!parts.has(part)) continue;
      try {
        const data = await readProfile(p, { [part]: true });
        if (part === 'bookmarks' && data.bookmarks) {
          const r = deps.bookmarks.importTree(data.bookmarks, `Imported from ${label}`);
          summary.bookmarks = { count: r.count, folder: r.title, skipped: r.skipped };
        }
        if (part === 'history') {
          const m = mergeHistory(deps.history.get(), data.history ?? []);
          deps.history.set(m.list);
          deps.history.flush();
          summary.history = { read: data.history?.length ?? 0, added: m.added, updated: m.updated };
        }
        if (part === 'addresses') {
          const store = deps.addresses();
          if (!store) summary.addresses = { unavailable: 'Autofill is not available in this version, so addresses were not imported.' };
          else {
            const m = mergeAddresses(store.profile(), data.addresses ?? [], label);
            if (m.added) store.save(m.profile);
            summary.addresses = { added: m.added, skipped: m.skipped };
          }
        }
      } catch (err) {
        summary.errors.push(`${part[0]!.toUpperCase()}${part.slice(1)}: ${(err as Error).message}`);
      }
    }
    note(summary);
    return summary;
  });

  // ── Passwords, from a CSV the person exported ──
  const pending = new Map<string, { file: string; source: string; logins: ImportedLogin[]; timer: NodeJS.Timeout }>();
  const importedFiles = new Set<string>();
  let tokenSeq = 0;
  const dropPending = (t: string): void => { const p = pending.get(t); if (p) { clearTimeout(p.timer); pending.delete(t); } };

  ctx.handle('browser:import:pickPasswords', async (): Promise<PasswordFilePreview | null> => {
    const s = await deps.vault.status();
    if (!s.available) throw new Error(s.reason ?? 'Passwords cannot be stored on this computer.');
    const w = ctx.window();
    const o: Electron.OpenDialogOptions = {
      title: 'Choose the passwords file you exported', defaultPath: app.getPath('downloads'), properties: ['openFile'],
      filters: [{ name: 'Passwords CSV', extensions: ['csv'] }, { name: 'All files', extensions: ['*'] }],
    };
    const r = w ? await dialog.showOpenDialog(w, o) : await dialog.showOpenDialog(o);
    const file = r.filePaths[0];
    if (r.canceled || !file) return null;
    if (fs.statSync(file).size > MAX_CSV_BYTES) throw new Error('That file is too large to be a passwords export.');
    const parsed = mapPasswordCsv(fs.readFileSync(file, 'utf8'));
    for (const t of [...pending.keys()]) dropPending(t);
    const token = `csv${++tokenSeq}`;
    // Kept in main only, and only for ten minutes: the wizard asks, the person confirms.
    pending.set(token, { file, source: parsed.source, logins: parsed.logins, timer: setTimeout(() => pending.delete(token), 10 * 60_000) });
    return { token, file, source: parsed.source, count: parsed.logins.length, skipped: parsed.skipped, reasons: parsed.reasons, sites: new Set(parsed.logins.map(l => l.origin)).size };
  });
  ctx.handle('browser:import:passwords', async (token: string): Promise<PasswordImportResult> => {
    const p = pending.get(String(token));
    if (!p) throw new Error('Choose the file again — the one you picked has been forgotten.');
    dropPending(String(token));
    // Into the credential vault, as browser logins bound to their exact origins (browser-vault.ts).
    const r = await deps.vault.addMany(p.logins);
    for (const l of p.logins) l.password = '';
    importedFiles.add(p.file);
    note({ passwords: { ...r, source: p.source }, at: Date.now() });
    return { ...r, file: p.file };
  });
  ctx.handle('browser:import:discard', (token: string) => { dropPending(String(token)); return true; });
  /** Delete the plain-text CSV — only one this run imported from. */
  ctx.handle('browser:import:deleteFile', (file: string) => {
    const f = String(file);
    if (!importedFiles.has(f)) throw new Error('AICO only deletes the passwords file it has just imported.');
    fs.rmSync(f, { force: true });
    importedFiles.delete(f);
    return !fs.existsSync(f);
  });

  return {
    open(preset) {
      ctx.emit('browser:import:open', preset);
      ctx.reveal();
    },
    async profiles() {
      const list = discover();
      return Promise.all(list.map(async p => ({ ...toPublic(p), counts: await scanProfile(p) })));
    },
    recent: () => recent,
  };
}
