/**
 * Pages the chrome draws itself, in place of the web page: the new tab page,
 * history, bookmarks (the manager, BookmarkManager.tsx), downloads, reader mode, and the two error pages
 * (a network error, and "Your connection is not private").
 *
 * @module desktop/renderer/browser/pages
 */

import React, { useEffect, useMemo, useState } from 'react';
import { MarkdownRenderer } from '@aico/ui';
import { Icon } from '@/lib/icons';
import { dayBucket } from '@/lib/util';
import { toast } from '@/state/desk';
import { desktop } from '@/desktop';
import { call, fire, useAvailable } from './ipc';
import { hostOf } from './urls';
import { Favicon, Omnibox } from './Omnibox';
import { openUrl, refreshBookmarks, showInternal, useBrowser, type InternalPage } from './store';
import { QUICK_STARTS } from './context';
import { prefillCopilot } from './copilot-ui';
import { DownloadsPanel } from './Toolbar';
import { BookmarkManager } from './BookmarkManager';
import { InsightsPage } from './Insights';
import { ForYouCards } from './ForYou';
import { PrivacyPage } from './PrivacyPage';
import { PasswordsPage } from './PasswordsPage';
import { TeachReview } from './Teach';
import { openImportWizard } from './ImportWizard';
import type { HistoryEntry, TabError, TabState } from './types';

// ── New tab ──

export function NewTabPage(): React.ReactElement {
  const bookmarks = useBrowser(s => s.bookmarks);
  const [recent, setRecent] = useState<HistoryEntry[]>([]);
  useEffect(() => {
    void refreshBookmarks();
    void call<HistoryEntry[]>('browser:history:list', { limit: 30 }).then(h => setRecent(dedupeByHost(h ?? []).slice(0, 6))).catch(() => {});
  }, []);
  const tiles = bookmarks.slice(0, 10);

  return (
    <div className="bx-chrome-page bx-ntp-glow thin-scroll">
      <div className="mx-auto flex min-h-full w-full max-w-[760px] flex-col items-center px-6 pb-16 pt-[12vh]">
        <div className="mb-6 flex items-center gap-3">
          <span className="bx-orb h-9 w-9" />
          <h1 className="text-[30px] font-semibold tracking-tight">Browse with AICO</h1>
        </div>
        <div className="w-full">
          <Omnibox url="" big autoFocus placeholder="Search Google or type a URL" />
        </div>
        <button className="mt-3 flex items-center gap-1.5 text-[12px] text-aico-muted hover:text-aico-accent" onClick={() => openImportWizard()}>
          <Icon name="download" size={13} />Import bookmarks, history and passwords from another browser
        </button>

        {tiles.length > 0 && (
          <div className="mt-9 flex w-full flex-wrap justify-center gap-1">
            {tiles.map(b => (
              <button key={b.url} className="bx-tile" onClick={() => openUrl(b.url)} title={`${b.title}\n${b.url}`}>
                <span className="bx-tile-icon"><Favicon src={b.favicon} url={b.url} size={22} /></span>
                <span className="w-full truncate text-center">{b.title || hostOf(b.url)}</span>
              </button>
            ))}
          </div>
        )}

        <ForYouCards place="ntp" />

        <div className="mt-10 w-full">
          <div className="mb-3 flex items-center gap-2 text-[12.5px] font-medium text-aico-muted">
            <Icon name="sparkles" size={14} /> Let AICO do it
          </div>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {QUICK_STARTS.map(q => (
              <button key={q.id} className="bx-start-card" onClick={() => prefillCopilot(q.prompt)}>
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-aico-accent-soft text-aico-accent"><Icon name={q.icon} size={17} /></span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-medium">{q.label}</span>
                  <span className="block text-[12px] text-aico-muted">{q.hint}</span>
                </span>
              </button>
            ))}
          </div>
          <p className="mt-3 text-center text-[11.5px] text-aico-muted">
            AICO never solves “I’m human” checks, types passwords, card numbers or one-time codes, or pays for anything — it hands the page to you.
          </p>
        </div>

        {recent.length > 0 && (
          <div className="mt-10 w-full">
            <div className="mb-2 flex items-center gap-2 text-[12.5px] font-medium text-aico-muted">
              <Icon name="history" size={14} /> Recently visited
              <div className="flex-1" />
              <button className="text-[12px] font-normal text-aico-accent hover:underline" onClick={() => showInternal('history')}>All history</button>
            </div>
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {recent.map(h => (
                <button key={h.url} className="flex items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-aico-hover" onClick={() => openUrl(h.url)}>
                  <Favicon src={h.favicon} url={h.url} size={16} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{h.title || hostOf(h.url)}</span>
                    <span className="block truncate text-[11.5px] text-aico-muted">{hostOf(h.url)}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function dedupeByHost(list: HistoryEntry[]): HistoryEntry[] {
  const seen = new Set<string>();
  return [...list].sort((a, b) => b.lastVisit - a.lastVisit).filter(h => {
    const k = hostOf(h.url);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── History, bookmarks, downloads ──

function PageFrame({ title, icon, children, actions, query, setQuery }: {
  title: string; icon: string; children: React.ReactNode; actions?: React.ReactNode;
  query?: string; setQuery?: (q: string) => void;
}): React.ReactElement {
  return (
    <div className="bx-chrome-page thin-scroll">
      <div className="mx-auto w-full max-w-[820px] px-8 pb-16 pt-8">
        <div className="mb-5 flex items-center gap-3">
          <Icon name={icon} size={20} className="text-aico-secondary" />
          <h1 className="flex-1 text-[22px] font-semibold tracking-tight">{title}</h1>
          {actions}
          <button className="icon-btn" onClick={() => showInternal(null)} title="Close (Esc)"><Icon name="x" size={16} /></button>
        </div>
        {setQuery && (
          <div className="mb-5 flex items-center gap-2 rounded-full border border-aico-border-subtle px-4 py-2">
            <Icon name="search" size={15} className="text-aico-muted" />
            <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder={`Search ${title.toLowerCase()}`}
              className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-aico-muted" />
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function InternalPageView({ page }: { page: InternalPage }): React.ReactElement {
  if (page === 'history') return <HistoryPage />;
  if (page === 'bookmarks') return <BookmarkManager />;
  if (page === 'insights') return <InsightsPage />;
  if (page === 'privacy') return <PrivacyPage />;
  if (page === 'passwords') return <PasswordsPage />;
  if (page === 'teach') return <TeachReview />;
  return (
    <PageFrame title="Downloads" icon="download" actions={<button className="btn-outline btn-sm" onClick={() => { void call('browser:downloads:clear').catch(() => {}); }}>Clear finished</button>}>
      <DownloadsPanel full />
    </PageFrame>
  );
}

function HistoryPage(): React.ReactElement {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<HistoryEntry[] | null>(null);
  const available = useAvailable('browser:history:list');
  const load = (): void => { void call<HistoryEntry[]>('browser:history:list', { query: query.trim() || undefined, limit: 500 }).then(h => setItems(h ?? [])).catch(() => setItems([])); };
  useEffect(() => { const t = setTimeout(load, query ? 120 : 0); return () => clearTimeout(t); }, [query]);
  const groups = useMemo(() => {
    const m = new Map<string, HistoryEntry[]>();
    for (const h of [...(items ?? [])].sort((a, b) => b.lastVisit - a.lastVisit)) {
      const k = dayBucket(h.lastVisit);
      m.set(k, [...(m.get(k) ?? []), h]);
    }
    return [...m.entries()];
  }, [items]);
  const clear = async (): Promise<void> => {
    const ok = await desktop.dialog.confirm({ title: 'Clear history', message: 'Clear all browsing history?', detail: 'Cookies and sign-ins are kept. Use “Clear browsing data” in the browser menu to remove those too.', ok: 'Clear history', danger: true }).catch(() => false);
    if (!ok) return;
    await call('browser:history:clear').catch((e: Error) => toast.error('Could not clear', e.message));
    load();
  };
  return (
    <PageFrame title="History" icon="history" query={query} setQuery={setQuery}
      actions={<button className="btn-outline btn-sm" disabled={!items?.length} onClick={() => void clear()}>Clear history</button>}>
      {!available && <Empty icon="history" text="History is not available in this version." />}
      {available && items?.length === 0 && <Empty icon="history" text={query ? 'Nothing in your history matches.' : 'Pages you visit appear here.'} />}
      {groups.map(([day, list]) => (
        <div key={day} className="mb-5">
          <div className="mb-1 px-3 text-[12px] font-medium text-aico-muted">{day}</div>
          <div className="card overflow-hidden p-1">
            {list.map(h => (
              <Row key={h.url} url={h.url} title={h.title} favicon={h.favicon}
                meta={new Date(h.lastVisit).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                onRemove={() => { void call('browser:history:remove', h.url).then(load).catch(() => {}); }} />
            ))}
          </div>
        </div>
      ))}
    </PageFrame>
  );
}

function Row({ url, title, favicon, meta, onRemove }: { url: string; title: string; favicon?: string; meta?: string; onRemove: () => void }): React.ReactElement {
  return (
    <div className="group flex items-center gap-3 rounded-xl px-3 py-2 hover:bg-aico-hover">
      {meta && <span className="w-[52px] shrink-0 text-[11.5px] tabular-nums text-aico-muted">{meta}</span>}
      <Favicon src={favicon} url={url} size={16} />
      <button className="min-w-0 flex-1 text-left" onClick={() => openUrl(url)} onAuxClick={e => { if (e.button === 1) openUrl(url, true); }} title={url}>
        <span className="truncate text-[13px]">{title || hostOf(url)}</span>
        <span className="ml-2 truncate text-[12px] text-aico-muted">{hostOf(url)}</span>
      </button>
      <button className="icon-btn-sm opacity-0 group-hover:opacity-100" onClick={() => openUrl(url, true)} title="Open in new tab"><Icon name="external" size={13} /></button>
      <button className="icon-btn-sm opacity-0 group-hover:opacity-100" onClick={onRemove} title="Remove"><Icon name="trash" size={13} /></button>
    </div>
  );
}

function Empty({ icon, text }: { icon: string; text: string }): React.ReactElement {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center text-[13px] text-aico-muted">
      <Icon name={icon} size={26} />{text}
    </div>
  );
}

// ── Reader mode ──

export function ReaderView(): React.ReactElement | null {
  const reader = useBrowser(s => s.reader);
  if (!reader) return null;
  const d = reader.data;
  const minutes = d ? Math.max(1, Math.round(d.words / 230)) : 0;
  return (
    <div className="bx-chrome-page thin-scroll"
      onClickCapture={e => {
        const a = (e.target as HTMLElement).closest('a');
        const href = a?.getAttribute('href');
        if (a && href && /^https?:/i.test(href)) { e.preventDefault(); e.stopPropagation(); openUrl(href, e.ctrlKey || e.metaKey || e.button === 1); }
      }}>
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-aico-border-subtle bg-aico-bg/90 px-5 py-2 backdrop-blur">
        <Icon name="book-open" size={15} className="text-aico-accent" />
        <span className="text-[12.5px] font-medium">Reader mode</span>
        <span className="truncate text-[12px] text-aico-muted">{hostOf(reader.url)}</span>
        <div className="flex-1" />
        {d && <button className="btn-ghost btn-sm" onClick={() => void desktop.clipboard.writeRich(d.markdown).then(() => toast.success('Copied as Markdown'))}><Icon name="copy" size={13} />Copy</button>}
        <button className="btn-outline btn-sm" onClick={() => useBrowser.setState({ reader: null })}>Leave reader</button>
      </div>
      <article className="bx-reader mx-auto w-full max-w-[720px] px-8 pb-24 pt-10 selectable">
        {reader.loading && (
          <div className="space-y-3">
            <div className="skeleton h-9 w-3/4" /><div className="skeleton h-4 w-1/3" />
            {[0, 1, 2, 3, 4, 5].map(i => <div key={i} className="skeleton h-4 w-full" />)}
          </div>
        )}
        {reader.error && <Empty icon="book-open" text={reader.error} />}
        {d && (
          <>
            <h1 className="mb-3 text-[32px] font-semibold leading-tight tracking-tight">{d.title}</h1>
            <div className="mb-8 flex flex-wrap items-center gap-x-2 text-[13px] text-aico-muted">
              {d.byline && <span>{d.byline}</span>}
              {d.byline && <span>·</span>}
              <span>{hostOf(d.url)}</span><span>·</span><span>{minutes} min read</span>
            </div>
            <MarkdownRenderer content={stripLeadingTitle(d.markdown, d.title)} />
          </>
        )}
      </article>
    </div>
  );
}

function stripLeadingTitle(md: string, title: string): string {
  const m = md.match(/^\s*#\s+(.+)\n/);
  return m && m[1]!.trim() === title.trim() ? md.slice(m[0].length) : md;
}

// ── Errors ──

export function ErrorPage({ tab, error }: { tab: TabState; error: TabError }): React.ReactElement {
  const offline = error.code === -106;
  const dns = error.code === -105 || error.code === -137;
  const title = offline ? 'You’re not connected' : dns ? 'This site can’t be reached' : error.code === -118 || error.code === -7 ? 'This site took too long to respond' : 'This page isn’t working';
  const host = hostOf(error.url || tab.url);
  return (
    <div className="bx-chrome-page">
      <div className="mx-auto flex min-h-full max-w-[560px] flex-col justify-center px-8 py-16">
        <Icon name={offline ? 'cloud' : 'alert'} size={40} className="mb-5 text-aico-muted" />
        <h1 className="text-[24px] font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-aico-secondary">
          {offline ? 'Check your network connection, then try again.'
            : dns ? <><b className="font-medium text-aico-primary">{host}</b>’s server address could not be found. Check the spelling, or search for it instead.</>
              : <><b className="font-medium text-aico-primary">{host || 'The page'}</b> couldn’t be loaded: {error.description}</>}
        </p>
        <div className="mt-2 font-mono text-[11.5px] text-aico-muted">{error.description} ({error.code})</div>
        <div className="mt-7 flex gap-2">
          <button className="btn-primary" onClick={() => fire('browser:reload')}><Icon name="refresh" size={14} />Retry</button>
          {dns && <button className="btn-outline" onClick={() => openUrl(`https://www.google.com/search?q=${encodeURIComponent(host || error.url)}`)}>Search instead</button>}
          {tab.canGoBack && <button className="btn-ghost" onClick={() => fire('browser:back')}>Go back</button>}
        </div>
      </div>
    </div>
  );
}

export function CertErrorPage({ tab, error }: { tab: TabState; error: TabError }): React.ReactElement {
  const w = tab.cert;
  const host = w?.host || hostOf(error.url || tab.url);
  const [advanced, setAdvanced] = useState(false);
  const [always, setAlways] = useState(false);
  const back = (): void => {
    fire('browser:certAnswer', tab.id, false);
    if (tab.canGoBack) fire('browser:back'); else openUrl('about:blank');
  };
  // Main checks the warning's token and that this click really happened on the AICO window (browser-certs-core.ts).
  const proceed = (): void => {
    if (!w) return;
    void call('browser:certProceed', { tabId: tab.id, token: w.token, always }).catch((e: Error) => toast.error('Could not continue', e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')));
  };
  const allowLocalhost = (): void => {
    void call('browser:certs:localhost', true).then(() => fire('browser:reload')).catch((e: Error) => toast.error('Could not change', e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')));
  };
  const code = (w?.error || error.description || 'NET::ERR_CERT_INVALID').replace(/^net::/, 'NET::');
  return (
    <div className="bx-chrome-page" style={{ background: 'color-mix(in srgb, var(--aico-danger) 5%, var(--aico-bg))' }}>
      <div className="mx-auto flex min-h-full max-w-[640px] flex-col justify-center px-8 py-16">
        <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-aico-danger/10 text-aico-danger"><Icon name="alert" size={30} /></div>
        <h1 className="text-[26px] font-semibold tracking-tight">Your connection is not private</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-aico-secondary">
          Attackers might be trying to steal your information from <b className="font-medium text-aico-primary">{host}</b> (for example, passwords, messages or credit cards).
          The site’s security certificate could not be trusted.
        </p>
        <div className="mt-2 font-mono text-[11.5px] text-aico-muted">{code} ({error.code})</div>
        {w && !w.bypassable && <p className="mt-4 text-[12.5px] leading-relaxed text-aico-secondary">{w.reason}</p>}
        {!w && <p className="mt-4 text-[12.5px] text-aico-muted">AICO does not let you or the agent continue to a site with a broken certificate.</p>}
        <div className="mt-7 flex items-center gap-2">
          <button className="btn-accent" onClick={back} autoFocus>Back to safety</button>
          {w && <button className="btn-ghost" aria-expanded={advanced} onClick={() => setAdvanced(v => !v)}>{advanced ? 'Hide advanced' : 'Advanced'}</button>}
        </div>
        {w && advanced && (
          <div className="mt-5 rounded-xl border border-aico-border-subtle bg-aico-bg/70 p-4 text-[12.5px]">
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <span className="text-aico-muted">Site</span><span className="truncate selectable">{host}</span>
              <span className="text-aico-muted">Problem</span><span className="selectable">{certProblem(w.error)}</span>
              <span className="text-aico-muted">Issued to</span><span className="truncate selectable">{w.subject || '—'}</span>
              <span className="text-aico-muted">Issued by</span><span className="truncate selectable">{w.issuer || '—'}</span>
              <span className="text-aico-muted">Valid</span><span>{fmtDay(w.validFrom)} – {fmtDay(w.validTo)}</span>
              <span className="text-aico-muted">SHA-256</span><span className="break-all font-mono text-[11px] selectable">{fingerprintHex(w.fingerprint)}</span>
            </div>
            {w.bypassable ? (
              <>
                <p className="mt-4 leading-relaxed text-aico-secondary">
                  AICO can’t confirm that this is really <b className="font-medium text-aico-primary">{host}</b>. Continue only if you know this server — a development server, or one that uses your organisation’s own certificate authority.
                  The site will be marked <b className="font-medium text-aico-danger">Not secure</b>, AICO will not fill saved passwords there, and the agent can use it only after you continue.
                </p>
                {w.loopback && (
                  <div className="mt-3 rounded-lg bg-aico-hover/70 px-3 py-2">
                    <div className="text-aico-secondary">This is your own computer. To stop seeing this for local development servers:</div>
                    <button className="btn-outline btn-sm mt-2" onClick={allowLocalhost}>Allow self-signed certificates on localhost</button>
                  </div>
                )}
                <label className="mt-3 flex cursor-pointer items-center gap-2">
                  <input type="checkbox" className="accent-[var(--aico-danger)]" checked={always} onChange={e => setAlways(e.target.checked)} />
                  <span>Always trust this certificate for {host}</span>
                </label>
                <div className="mt-1 pl-6 text-[11.5px] text-aico-muted">{always ? 'Remembered until you remove it in Privacy & security → Certificate exceptions. A different certificate shows this warning again.' : 'Until AICO closes, and only for this exact certificate.'}</div>
                <button className="mt-3 text-[12.5px] font-medium text-aico-danger underline underline-offset-2 hover:opacity-80" onClick={proceed}>Proceed to {host} (unsafe)</button>
              </>
            ) : (
              <p className="mt-4 text-aico-secondary">There is no way to continue to this site from AICO.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function certProblem(error: string): string {
  const name = /ERR_[A-Z0-9_]+/.exec(error)?.[0] ?? error;
  switch (name) {
    case 'ERR_CERT_AUTHORITY_INVALID': return 'Not issued by an authority AICO trusts (self-signed or a private CA)';
    case 'ERR_CERT_COMMON_NAME_INVALID': return 'Issued for a different name than this address';
    case 'ERR_CERT_DATE_INVALID': return 'Expired, or not valid yet';
    case 'ERR_CERT_REVOKED': return 'Revoked by its issuer';
    default: return name;
  }
}

/** Electron's `sha256/<base64>` as the colon-separated hex other browsers show. */
function fingerprintHex(fp: string): string {
  const b64 = fp.replace(/^sha256\//, '');
  try { return Array.from(atob(b64), c => c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()).join(':'); } catch { return fp; }
}

function fmtDay(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
}

