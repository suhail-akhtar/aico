/**
 * "Remember what I read" in the chrome: the search box on the Insights page
 * ("Find something you read" — results with title, site, when, snippet, open
 * and forget), and the switch with its explanation on the Privacy & security
 * page. Main keeps and searches the pages (electron/browser-memory.ts); this
 * only asks it.
 *
 * @module desktop/renderer/browser/MemorySearch
 */

import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { desktop } from '@/desktop';
import { toast } from '@/state/desk';
import type { MemoryAnswer, MemoryStatus } from '@desk/browser-memory-types';
import { call, useAvailable } from './ipc';
import { Favicon } from './Omnibox';
import { openUrl, showInternal } from './store';
import { Toggle } from './Shields';

const when = (t: number): string => {
  const days = Math.floor((Date.now() - t) / 86_400_000);
  const time = new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (new Date(t).toDateString() === new Date().toDateString()) return `today, ${time}`;
  if (days < 7) return new Date(t).toLocaleDateString(undefined, { weekday: 'long' }) + `, ${time}`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined });
};

const size = (b: number): string => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

function useMemoryStatus(): [MemoryStatus | null | undefined, (s: MemoryStatus | undefined) => void] {
  const [s, setS] = useState<MemoryStatus | null | undefined>(undefined);
  useEffect(() => { void call<MemoryStatus>('browser:memory:status').then(r => setS(r ?? null)).catch(() => setS(null)); }, []);
  return [s, (v) => { if (v) setS(v); }];
}

/** The Insights page's "Find something you read". */
export function MemorySearch(): React.ReactElement | null {
  const available = useAvailable('browser:memory:status');
  const [status, setStatus] = useMemoryStatus();
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState<MemoryAnswer | null>(null);
  const seq = useRef(0);

  const run = (text: string): void => {
    const n = ++seq.current;
    if (!text.trim()) { setAnswer(null); return; }
    void call<MemoryAnswer>('browser:memory:search', { query: text }).then(r => { if (n === seq.current) setAnswer(r ?? null); }).catch(() => {});
  };
  useEffect(() => { const t = setTimeout(() => run(q), 180); return () => clearTimeout(t); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!available || status === undefined || status === null) return null;
  const forget = async (id: string): Promise<void> => {
    setStatus(await call<MemoryStatus>('browser:memory:remove', id).catch(() => undefined));
    run(q);
  };

  return (
    <div className="card mb-4 p-4" data-testid="memory-search">
      <div className="mb-2 flex items-center gap-2">
        <Icon name="brain" size={15} className="text-aico-secondary" />
        <div className="flex-1 text-[13px] font-semibold">Find something you read</div>
        {status.enabled && <span className="text-[11.5px] text-aico-muted">{status.pages.toLocaleString()} page{status.pages === 1 ? '' : 's'} remembered on this device</span>}
      </div>
      {!status.enabled && status.pages === 0 ? (
        <div className="flex items-center gap-2 rounded-xl bg-aico-hover/70 px-3 py-2 text-[12.5px] text-aico-secondary">
          <Icon name="info" size={14} />AICO can remember what you read here, on this device only, so you can find it again by what it was about.
          <button className="ml-auto shrink-0 text-aico-accent hover:underline" onClick={() => showInternal('privacy')}>Turn on</button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 rounded-xl border border-aico-border-subtle px-3 py-1.5">
            <Icon name="search" size={14} className="text-aico-muted" />
            <input className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-aico-muted" value={q} onChange={e => setQ(e.target.value)}
              placeholder="e.g. the red leather jacket I looked at last week" aria-label="Find something you read" />
            {q && <button className="text-aico-muted hover:text-aico-primary" onClick={() => setQ('')} title="Clear"><Icon name="x" size={13} /></button>}
          </div>
          {answer && (
            <div className="mt-2">
              {answer.window && (
                <div className="mb-1 px-1 text-[11.5px] text-aico-muted">
                  {answer.widened ? `Nothing ${answer.window.label} — closest matches from other times:` : `Read ${answer.window.label}:`}
                </div>
              )}
              {answer.hits.length === 0 && <div className="py-4 text-center text-[12.5px] text-aico-muted">Nothing you read matches that. Try other words.</div>}
              {answer.hits.map(h => (
                <div key={h.id} className="group flex items-start gap-2.5 rounded-lg px-2 py-2 hover:bg-aico-hover" data-testid="memory-hit">
                  <Favicon url={h.url} size={16} />
                  <button className="min-w-0 flex-1 text-left" onClick={() => openUrl(h.url, true)} title={h.url}>
                    <div className="truncate text-[13px] font-medium">{h.title}</div>
                    <div className="truncate text-[11.5px] text-aico-muted">{h.site} · {when(h.last)}{h.visits > 1 ? ` · read ${h.visits} times` : ''}</div>
                    {h.snippet && <div className="mt-0.5 line-clamp-2 text-[12px] text-aico-secondary">{h.snippet}</div>}
                  </button>
                  <button className="btn-ghost btn-sm shrink-0" onClick={() => openUrl(h.url, true)} title="Open in a new tab"><Icon name="external" size={13} />Open</button>
                  <button className="icon-btn-sm shrink-0 opacity-0 group-hover:opacity-100" onClick={() => void forget(h.id)} title="Forget this page"><Icon name="trash" size={13} /></button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The Privacy & security page's switch, with what it does and what it never does. */
export function MemorySettings(): React.ReactElement | null {
  const available = useAvailable('browser:memory:status');
  const [s, setS] = useMemoryStatus();
  if (!available || !s) return null;
  const set = (on: boolean): void => { void call<MemoryStatus>('browser:memory:set', { enabled: on }).then(setS).catch((e: Error) => toast.error('Could not change', e.message)); };
  const forget = async (): Promise<void> => {
    const ok = await desktop.dialog.confirm({ title: 'Forget everything', message: 'Forget every page AICO remembered?', detail: 'The pages’ saved text is deleted from this device. History and bookmarks are kept.', ok: 'Forget everything', danger: true }).catch(() => false);
    if (ok) setS(await call<MemoryStatus>('browser:memory:forget').catch(() => undefined));
  };
  return (
    <section className="card p-4" data-testid="memory-settings">
      <h2 className="text-[14px] font-semibold">Memory</h2>
      <p className="mb-2 mt-0.5 text-[12px] text-aico-muted">Lets you — and AICO, when you ask it — find a page again by what it was about: “the red leather jacket I looked at last week”.</p>
      <Toggle label="Remember what I read (on this device)" on={s.enabled} set={set}
        hint={`Keeps the text of pages you actually read (about 15 seconds in front, or scrolled), up to 8 KB each, ${s.encrypted ? 'encrypted with your system keychain' : 'unencrypted — this computer offers no keychain'}, and searches it here — nothing is sent anywhere. Never kept: internal pages, pages flagged as deceptive, sites you excluded from learning, pages AICO is driving, and pages with a password or card field. Clearing browsing data clears it too.`} />
      <div className={cls('mt-1 flex items-center gap-2 px-2 text-[12px] text-aico-muted', !s.pages && 'hidden')}>
        <span className="flex-1">{s.pages.toLocaleString()} page{s.pages === 1 ? '' : 's'} · {size(s.bytes)}{s.oldest ? ` · since ${new Date(s.oldest).toLocaleDateString()}` : ''}</span>
        <button className="btn-outline btn-sm" onClick={() => void forget()}><Icon name="trash" size={13} />Forget everything</button>
      </div>
    </section>
  );
}
