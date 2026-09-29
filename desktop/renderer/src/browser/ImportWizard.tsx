/**
 * The import centre's wizard: bring bookmarks, history and addresses over
 * from the other browsers on this computer, and passwords from a file you
 * export yourself.
 *
 * One dialog for the whole window (mounted beside Settings), opened from the
 * browser's menu, the new-tab page, the bookmarks importer, Settings, the
 * Passwords page — or by the agent (`browser_import`), which can only open it
 * pre-selected: the person still reviews the counts and presses Import.
 *
 * Every profile is counted before anything is imported, and a summary is
 * shown after. The other browsers are only read. Passwords never come from
 * another browser's store: the wizard explains how to export them from each
 * browser or manager, the person picks the file, and afterwards AICO offers to
 * delete it (it is plain text).
 *
 * @module desktop/renderer/browser/ImportWizard
 */

import React, { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { on } from '@/desktop';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { toast, useDesk } from '@/state/desk';
import { Modal } from '@/shell/Modal';
import type {
  BookmarkImportResult, ImportCounts, ImportPart, ImportPreset, ImportProfile, ImportSummary, PasswordFilePreview, PasswordImportResult, VaultStatus,
} from '@desk/browser-types';
import { call } from './ipc';
import { installVaultEvents, openPasswords } from './PasswordsBar';

export const useImportWizard = create<{ open: boolean; preset: ImportPreset | null; seq: number }>(() => ({ open: false, preset: null, seq: 0 }));

export function openImportWizard(preset?: ImportPreset): void {
  useImportWizard.setState(s => ({ open: true, preset: preset ?? null, seq: s.seq + 1 }));
}

const PARTS: Array<{ id: ImportPart; label: string }> = [
  { id: 'bookmarks', label: 'Bookmarks' },
  { id: 'history', label: 'History' },
  { id: 'addresses', label: 'Addresses' },
];

/** How to export passwords from each place people keep them. */
const EXPORT_HOWTO: Array<{ id: string; label: string; steps: string }> = [
  { id: 'chrome', label: 'Chrome', steps: 'Open chrome://password-manager/settings → “Export passwords” → Download file. Chrome asks for your computer’s password first.' },
  { id: 'edge', label: 'Edge', steps: 'Open edge://wallet/passwords → ⋯ (More actions) → “Export passwords”.' },
  { id: 'brave', label: 'Brave', steps: 'Open brave://password-manager/settings → “Export passwords”.' },
  { id: 'firefox', label: 'Firefox', steps: 'Open about:logins → ⋯ (menu) → “Export passwords…”.' },
  { id: 'safari', label: 'Safari', steps: 'File → Export → Passwords… (or the Passwords app: File → Export All Passwords).' },
  { id: 'bitwarden', label: 'Bitwarden', steps: 'Tools → Export vault → File format “.csv”.' },
  { id: '1password', label: '1Password', steps: 'File → Export → choose the account → format “CSV”.' },
];

const n = (x: number): string => x.toLocaleString();
const plural = (x: number, one: string, many = `${one}s`): string => `${n(x)} ${x === 1 ? one : many}`;

let installed = false;
function installWizardEvents(): void {
  if (installed) return;
  installed = true;
  on<ImportPreset>('browser:import:open', (p) => {
    // The agent asked: bring the window's attention to the wizard, over whatever is open.
    const d = useDesk.getState();
    if (d.settings) d.closeSettings();
    openImportWizard(p ?? {});
  });
}

/** Mounted once for the window: listens for main's requests and draws the wizard when open. */
export function ImportWizard(): React.ReactElement | null {
  const open = useImportWizard(s => s.open);
  const seq = useImportWizard(s => s.seq);
  useEffect(() => { installWizardEvents(); installVaultEvents(); }, []);
  if (!open) return null;
  return <Wizard key={seq} close={() => useImportWizard.setState({ open: false, preset: null })} />;
}

type Step = 'choose' | 'running' | 'done';

function Wizard({ close }: { close: () => void }): React.ReactElement {
  const preset = useImportWizard.getState().preset;
  const [profiles, setProfiles] = useState<ImportProfile[] | null>(null);
  const [counts, setCounts] = useState<Record<string, ImportCounts | 'loading'>>({});
  const [picked, setPicked] = useState<Record<string, ImportPart[]>>({});
  const [vault, setVault] = useState<VaultStatus | null>(null);
  const [csv, setCsv] = useState<PasswordFilePreview | null>(null);
  const [useCsv, setUseCsv] = useState(true);
  const [howto, setHowto] = useState(EXPORT_HOWTO[0]!.id);
  const [step, setStep] = useState<Step>('choose');
  const [results, setResults] = useState<ImportSummary[]>([]);
  const [pwResult, setPwResult] = useState<PasswordImportResult | null>(null);
  const [fileGone, setFileGone] = useState(false);
  const [busy, setBusy] = useState('');

  // Find the profiles, then count each (in parallel); the agent's preset ticks its browser's first profile.
  useEffect(() => {
    let live = true;
    void call<VaultStatus>('browser:vault:status').then(s => { if (live) setVault(s ?? null); }).catch(() => {});
    void call<ImportProfile[]>('browser:import:profiles').then((list) => {
      if (!live) return;
      const ps = list ?? [];
      setProfiles(ps);
      setCounts(Object.fromEntries(ps.map(p => [p.id, 'loading' as const])));
      const target = preset?.browser ? ps.filter(p => p.browser.toLowerCase() === preset.browser!.toLowerCase()).sort((a, b) => Number(b.isDefault ?? 0) - Number(a.isDefault ?? 0))[0] : undefined;
      for (const p of ps) {
        void call<ImportCounts>('browser:import:scan', p.id).then((c) => {
          if (!live) return;
          setCounts(s => ({ ...s, [p.id]: c ?? {} }));
          if (target?.id === p.id && c) {
            const want = preset?.parts?.length ? preset.parts : PARTS.map(x => x.id);
            setPicked(s => ({ ...s, [p.id]: want.filter(w => (c[w] ?? 0) > 0) }));
          }
        }).catch((e: Error) => { if (live) setCounts(s => ({ ...s, [p.id]: { errors: [e.message] } })); });
      }
    }).catch(() => { if (live) setProfiles([]); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (preset?.passwords) document.getElementById('imp-passwords')?.scrollIntoView({ block: 'start' });
  }, [preset?.passwords, profiles]);

  const toggle = (id: string, part: ImportPart): void => setPicked(s => {
    const cur = s[id] ?? [];
    return { ...s, [id]: cur.includes(part) ? cur.filter(x => x !== part) : [...cur, part] };
  });
  const chosen = useMemo(() => Object.entries(picked).filter(([, parts]) => parts.length), [picked]);
  const anything = chosen.length > 0 || Boolean(csv && useCsv);

  const pickCsv = async (): Promise<void> => {
    setBusy('csv');
    try {
      const p = await call<PasswordFilePreview | null>('browser:import:pickPasswords');
      if (p) { setCsv(p); setUseCsv(true); }
    } catch (e) { toast.error('Could not read that file', cleanError(e)); }
    finally { setBusy(''); }
  };
  const bookmarksHtml = async (): Promise<void> => {
    const r = await call<BookmarkImportResult | null>('browser:bookmarks:import', 'html:file').catch((e: Error) => { toast.error('Could not import', cleanError(e)); return null; });
    if (r) toast.success(`Imported ${plural(r.count, 'bookmark')}`, `Into “${r.title}” on the bookmarks bar.`);
  };

  const run = async (): Promise<void> => {
    setStep('running');
    const out: ImportSummary[] = [];
    for (const [profileId, parts] of chosen) {
      try {
        const r = await call<ImportSummary>('browser:import:run', { profileId, parts });
        if (r) out.push(r);
      } catch (e) {
        const p = profiles?.find(x => x.id === profileId);
        out.push({ browser: p?.browser ?? 'Browser', profile: p?.profile ?? '', errors: [cleanError(e)] });
      }
    }
    setResults(out);
    if (csv && useCsv) {
      try { setPwResult((await call<PasswordImportResult>('browser:import:passwords', csv.token)) ?? null); }
      catch (e) { out.push({ browser: 'Passwords file', profile: '', errors: [cleanError(e)] }); setResults([...out]); }
    } else if (csv) {
      void call('browser:import:discard', csv.token).catch(() => {});
    }
    setStep('done');
  };
  const deleteCsv = async (): Promise<void> => {
    if (!pwResult) return;
    try {
      const gone = await call<boolean>('browser:import:deleteFile', pwResult.file);
      setFileGone(Boolean(gone));
      if (gone) toast.success('Passwords file deleted', pwResult.file);
    } catch (e) { toast.error('Could not delete the file', cleanError(e)); }
  };
  const dismiss = (): void => {
    if (step === 'choose' && csv) void call('browser:import:discard', csv.token).catch(() => {});
    close();
  };

  return (
    <Modal open onClose={step === 'running' ? () => {} : dismiss} title="Import browser data" width={640} hideClose={step === 'running'}>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2 pt-1 thin-scroll" style={{ maxHeight: 'min(70vh, 640px)' }}>
        {preset?.note && step === 'choose' && <p className="mb-2 rounded-xl bg-aico-accent-soft px-3 py-2 text-[12.5px] text-aico-accent">{preset.note}</p>}
        {step === 'choose' && (
          <>
            <p className="mb-3 text-[12.5px] text-aico-muted">
              {preset && (preset.browser || preset.parts || preset.passwords) ? 'AICO has picked what you asked for — check it and press Import. ' : ''}
              The other browsers are only read, never changed. Close a browser first if AICO says it is in use.
            </p>
            <div className="mb-1 text-[12px] font-medium text-aico-muted">Browsers on this computer</div>
            {!profiles && <div className="flex items-center gap-2 px-3 py-5 text-[13px] text-aico-muted"><span className="spinner h-4 w-4" />Looking for browsers…</div>}
            {profiles?.length === 0 && <div className="px-3 py-3 text-[12.5px] text-aico-muted">No Chrome, Edge, Brave, Vivaldi, Opera, Chromium or Firefox profile was found.</div>}
            {profiles?.map(p => {
              const c = counts[p.id];
              const ready = c && c !== 'loading' ? c : null;
              return (
                <div key={p.id} className={cls('mb-1 rounded-xl border px-3 py-2.5', (picked[p.id]?.length ?? 0) > 0 ? 'border-aico-accent/60 bg-aico-accent-soft/40' : 'border-aico-border-subtle')}>
                  <div className="flex items-center gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-aico-hover text-aico-secondary"><Icon name={p.engine === 'firefox' ? 'compass' : 'globe'} size={16} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium">{p.browser}<span className="font-normal text-aico-muted"> · {p.profile}</span></span>
                      <span className="block truncate text-[11.5px] text-aico-muted" title={p.id}>{c === 'loading' ? 'Counting…' : describeCounts(ready)}</span>
                    </span>
                    {c === 'loading' && <span className="spinner h-3.5 w-3.5" />}
                  </div>
                  {ready && (
                    <div className="mt-2 flex flex-wrap gap-1.5 pl-11">
                      {PARTS.map(part => {
                        const have = ready[part.id] ?? 0;
                        const on = picked[p.id]?.includes(part.id) ?? false;
                        return (
                          <label key={part.id} className={cls('chip h-7 cursor-pointer gap-1.5 py-0 text-[12.5px]', !have && 'cursor-default opacity-45', on && 'border-aico-accent text-aico-accent')}>
                            <input type="checkbox" className="accent-[var(--aico-accent)]" disabled={!have} checked={on} onChange={() => toggle(p.id, part.id)} />
                            {part.label}{have ? <span className="tabular-nums text-aico-muted">{n(have)}</span> : null}
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {ready?.errors?.map(e => <div key={e} className="mt-1 pl-11 text-[11.5px] text-aico-warning">{e}</div>)}
                </div>
              );
            })}
            <button className="mt-1 px-3 text-[12px] text-aico-accent hover:underline" onClick={() => void bookmarksHtml()}>Or import a bookmarks HTML file…</button>

            <div id="imp-passwords" className="mb-1 mt-5 text-[12px] font-medium text-aico-muted">Passwords</div>
            <div className="rounded-xl border border-aico-border-subtle px-4 py-3">
              <div className="flex items-start gap-2.5 text-[12.5px]">
                <Icon name="lock" size={15} className="mt-0.5 shrink-0 text-aico-secondary" />
                <span className="text-aico-secondary">
                  Passwords come in only through a file <b className="font-medium text-aico-primary">you export from your browser or password manager yourself</b>.
                  AICO never reads, copies or decrypts another browser’s saved passwords, cookies or keychain.
                </span>
              </div>
              {vault && !vault.available ? (
                <p className="mt-2 text-[12.5px] text-aico-warning">{vault.reason}</p>
              ) : (
                <>
                  <div className="mt-3 flex flex-wrap gap-1">
                    {EXPORT_HOWTO.map(h => (
                      <button key={h.id} className={cls('chip h-7 py-0 text-[12px]', howto === h.id && 'border-aico-accent text-aico-accent')} onClick={() => setHowto(h.id)}>{h.label}</button>
                    ))}
                  </div>
                  <p className="mt-2 text-[12.5px]">{EXPORT_HOWTO.find(h => h.id === howto)?.steps}</p>
                  <div className="mt-3 flex items-center gap-3">
                    <button className="btn-outline btn-sm" disabled={busy === 'csv'} onClick={() => void pickCsv()}>
                      {busy === 'csv' ? <span className="spinner h-3.5 w-3.5" /> : <Icon name="file" size={14} />}{csv ? 'Choose another file…' : 'Choose the exported file…'}
                    </button>
                    {csv && (
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-[12.5px]">
                        <input type="checkbox" className="accent-[var(--aico-accent)]" checked={useCsv} onChange={e => setUseCsv(e.target.checked)} />
                        <span className="min-w-0 truncate">
                          <b className="font-medium">{plural(csv.count, 'password')}</b> for {plural(csv.sites, 'site')} · {csv.source}
                          {csv.skipped ? <span className="text-aico-muted" title={Object.entries(csv.reasons).map(([k, v]) => `${v} × ${k}`).join('\n')}> · {n(csv.skipped)} skipped</span> : null}
                        </span>
                      </label>
                    )}
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {step === 'running' && (
          <div className="flex flex-col items-center gap-3 py-16 text-[13px] text-aico-muted"><span className="spinner h-6 w-6" />Importing…</div>
        )}

        {step === 'done' && (
          <div className="pb-2">
            <div className="mb-3 flex items-center gap-2 text-[14px] font-medium"><Icon name="check-circle" size={18} className="text-aico-success" />Import finished</div>
            {results.map((r, i) => (
              <div key={i} className="mb-2 rounded-xl border border-aico-border-subtle px-4 py-3 text-[12.5px]">
                <div className="mb-1 text-[13px] font-medium">{r.browser}{r.profile ? <span className="font-normal text-aico-muted"> · {r.profile}</span> : null}</div>
                {r.bookmarks && <SummaryLine icon="star" text={`${plural(r.bookmarks.count, 'bookmark')} into “${r.bookmarks.folder}” on the bookmarks bar${r.bookmarks.skipped ? ` (${plural(r.bookmarks.skipped, 'bookmarklet or query', 'bookmarklets or queries')} skipped)` : ''}`} />}
                {r.history && <SummaryLine icon="history" text={`${plural(r.history.added, 'new page')} in your history, ${n(r.history.updated)} updated (${n(r.history.read)} read)`} />}
                {r.addresses && ('unavailable' in r.addresses
                  ? <SummaryLine icon="home" text={r.addresses.unavailable} warn />
                  : <SummaryLine icon="home" text={`${plural(r.addresses.added, 'address', 'addresses')} added to autofill${r.addresses.skipped ? `, ${n(r.addresses.skipped)} already there` : ''}`} />)}
                {r.errors.map(e => <SummaryLine key={e} icon="alert" text={e} warn />)}
              </div>
            ))}
            {pwResult && (
              <div className="mb-2 rounded-xl border border-aico-border-subtle px-4 py-3 text-[12.5px]">
                <div className="mb-1 text-[13px] font-medium">Passwords</div>
                <SummaryLine icon="key" text={`${plural(pwResult.added, 'password')} saved, ${n(pwResult.updated)} updated, ${n(pwResult.unchanged)} already saved`} />
                {!fileGone ? (
                  <div className="mt-3 rounded-lg bg-aico-warning/10 px-3 py-2.5">
                    <div className="font-medium">Delete the exported file?</div>
                    <div className="mt-0.5 break-all text-aico-muted">{pwResult.file} holds every password in plain text. Anyone or any program that can read it can read them.</div>
                    <div className="mt-2 flex gap-2">
                      <button className="btn-sm bg-aico-danger text-white hover:opacity-90" onClick={() => void deleteCsv()}><Icon name="trash" size={13} />Delete the file</button>
                      <button className="btn-ghost btn-sm" onClick={() => setFileGone(true)}>Keep it</button>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
            {!results.length && !pwResult && <p className="text-[12.5px] text-aico-muted">Nothing was imported.</p>}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-aico-border-subtle px-5 py-3">
        {step === 'choose' && (
          <>
            <span className="min-w-0 flex-1 truncate text-[12px] text-aico-muted">{anything ? plan(chosen, profiles ?? [], counts, csv && useCsv ? csv : null) : 'Tick what to bring over.'}</span>
            <button className="btn-outline" onClick={dismiss}>Cancel</button>
            <button className="btn-primary" disabled={!anything} onClick={() => void run()}>Import</button>
          </>
        )}
        {step === 'done' && (
          <>
            <div className="flex-1" />
            {pwResult && <button className="btn-outline" onClick={() => { close(); openPasswords(); }}>Open Passwords</button>}
            <button className="btn-primary" onClick={close}>Done</button>
          </>
        )}
      </div>
    </Modal>
  );
}

function SummaryLine({ icon, text, warn }: { icon: string; text: string; warn?: boolean }): React.ReactElement {
  return <div className={cls('flex items-start gap-2 py-0.5', warn && 'text-aico-warning')}><Icon name={icon} size={13} className="mt-0.5 shrink-0" /><span>{text}</span></div>;
}

function describeCounts(c: ImportCounts | null): string {
  if (!c) return '';
  const bits = [
    c.bookmarks ? plural(c.bookmarks, 'bookmark') : '',
    c.history ? `${plural(c.history, 'history entry', 'history entries')}${c.history > 5000 ? ' (the 5,000 newest are kept)' : ''}` : '',
    c.addresses ? plural(c.addresses, 'address', 'addresses') : '',
  ].filter(Boolean);
  return bits.length ? bits.join(' · ') : c.errors?.length ? 'Could not be read' : 'Nothing to import';
}

function plan(chosen: Array<[string, ImportPart[]]>, profiles: ImportProfile[], counts: Record<string, ImportCounts | 'loading'>, csv: PasswordFilePreview | null): string {
  const parts = chosen.map(([id, ps]) => {
    const p = profiles.find(x => x.id === id);
    const c = counts[id];
    const what = ps.map(x => (c && c !== 'loading' ? `${n(c[x] ?? 0)} ${x}` : x)).join(', ');
    return `${p?.browser ?? ''}: ${what}`;
  });
  if (csv) parts.push(`${plural(csv.count, 'password')}`);
  return parts.join(' · ');
}

function cleanError(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
