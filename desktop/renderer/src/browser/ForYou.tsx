/**
 * "For you" — what AICO suggests from how you browse (electron/browser-learn*.ts),
 * on the new tab page and in Insights, and the "What AICO has learned" panel.
 *
 * Every card says why it is shown and has "Not interested", which feeds back
 * into the model (that site or topic counts for less from then on). The panel
 * shows what was learned — interests, sites, routines, research threads —
 * lets you remove any of it, exclude sites, pause learning or forget it all.
 * All of it is on this device; the agent reads a summary only when you ask it
 * about your browsing.
 *
 * @module desktop/renderer/browser/ForYou
 */

import React, { useEffect, useState } from 'react';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { desktop } from '@/desktop';
import { toast } from '@/state/desk';
import type { LearnItem, LearnTab, LearnThread, LearnView } from '@desk/browser-learn-types';
import { fire, useAvailable } from './ipc';
import { Favicon } from './Omnibox';
import { showInternal } from './store';
import { askCopilot } from './Copilot';
import { prefillCopilot, toggleCopilot } from './copilot-ui';
import { fmtTime } from './Insights';
import {
  dismiss, forgetLearning, openItem, refreshLearn, removeLearned, setExcludedSite, setLearningPaused, tidyTabs, useLearn,
} from './ForYouLearn';

const ago = (t: number): string => {
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 60) return m < 2 ? 'just now' : `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
};

function useLearnView(poll = 0): LearnView | null | undefined {
  const view = useLearn(s => s.view);
  useEffect(() => {
    void refreshLearn();
    if (!poll) return;
    const t = setInterval(() => void refreshLearn(), poll);
    return () => clearInterval(t);
  }, [poll]);
  return view;
}

async function ask(prompt: string): Promise<void> {
  toggleCopilot(true);
  await askCopilot(prompt).catch(() => prefillCopilot(prompt));
}

async function tidy(tabs: LearnTab[], action: 'close' | 'bookmark' | 'bookmark_close'): Promise<void> {
  if (!tabs.length) return;
  if (action !== 'bookmark') {
    const ok = await desktop.dialog.confirm({
      title: 'Tidy tabs', message: action === 'close' ? `Close ${tabs.length} idle tabs?` : `Save ${tabs.length} idle tabs as bookmarks and close them?`,
      detail: action === 'close' ? 'You can reopen them from History.' : 'They go into a new folder on the bookmarks bar first, so nothing is lost.',
      ok: action === 'close' ? `Close ${tabs.length} tabs` : 'Save and close', danger: action === 'close',
    }).catch(() => false);
    if (!ok) return;
  }
  const r = await tidyTabs({ tabIds: tabs.map(t => t.id), action }).catch((e: Error) => { toast.error('Could not tidy tabs', e.message); return undefined; });
  if (r) toast.success([r.bookmarked ? `Saved ${r.bookmarked} to “${r.folder}”` : '', r.closed ? `closed ${r.closed} tab${r.closed === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ').replace(/^./, c => c.toUpperCase()));
}

function run(item: LearnItem, view: LearnView): void {
  if (item.action.type === 'ask' && item.action.prompt) { fireOpen(item.id); void ask(item.action.prompt); return; }
  if (item.action.type === 'cleanup') { if (view.cleanup) void tidy(view.cleanup.tabs, 'bookmark_close'); return; }
  openItem(item);
}
const fireOpen = (id: string): void => fire('browser:learn:feedback', { id, action: 'open' });

// ── Pieces ──

function Section({ icon, title, hint, children, className }: { icon: string; title: string; hint?: string; children: React.ReactNode; className?: string }): React.ReactElement {
  return (
    <section className={cls('card p-3', className)}>
      <div className="mb-1.5 flex items-center gap-2 px-1 text-[13px] font-semibold">
        <Icon name={icon} size={14} className="text-aico-accent" />{title}
        {hint && <span className="ml-auto truncate text-[11.5px] font-normal text-aico-muted">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function NotInterested({ id, label = 'Not interested' }: { id: string; label?: string }): React.ReactElement {
  return (
    <button className="icon-btn-sm shrink-0 opacity-40 transition-opacity group-hover:opacity-100 focus-visible:opacity-100" title={`${label} — AICO shows less like this`} aria-label={label}
      onClick={(e) => { e.stopPropagation(); dismiss(id); }}>
      <Icon name="thumbs-down" size={13} />
    </button>
  );
}

function ItemRow({ item, view }: { item: LearnItem; view: LearnView }): React.ReactElement {
  const icon = item.url && (item.kind === 'routine' || item.kind === 'next')
    ? <Favicon url={item.url} size={18} />
    : <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-aico-accent-soft text-aico-accent"><Icon name={item.icon} size={14} /></span>;
  return (
    <div className="group flex items-start gap-2.5 rounded-xl px-2 py-1.5 hover:bg-aico-hover">
      <span className="mt-0.5 flex w-7 shrink-0 justify-center">{icon}</span>
      <button className="min-w-0 flex-1 text-left" onClick={() => run(item, view)} title={item.url ?? item.title}>
        <span className="block truncate text-[13px] font-medium">{item.title}</span>
        <span className="line-clamp-2 block text-[11.5px] leading-snug text-aico-muted">{item.why}</span>
      </button>
      <NotInterested id={item.id} />
    </div>
  );
}

function ThreadRow({ t }: { t: LearnThread }): React.ReactElement {
  return (
    <div className="group rounded-xl px-2 py-2 hover:bg-aico-hover">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">“{t.label}”</div>
          <div className="text-[11.5px] text-aico-muted">{t.why}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {t.sites.slice(0, 6).map(s => <span key={s} title={s}><Favicon url={`https://${s}/`} size={14} /></span>)}
          </div>
        </div>
        <NotInterested id={t.id} />
      </div>
      <button className="btn-outline btn-sm mt-1.5" onClick={() => { fireOpen(t.id); void ask(t.prompt); }}>
        <Icon name="sparkles" size={13} />Summarize this research with AICO
      </button>
    </div>
  );
}

function Cleanup({ c }: { c: NonNullable<LearnView['cleanup']> }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const shown = open ? c.tabs : c.tabs.slice(0, 3);
  return (
    <Section icon="layers" title="Tab clean-up" hint={`${c.tabs.length} idle for ${c.days}+ days`}>
      <div className="group flex items-start gap-2 px-1">
        <p className="min-w-0 flex-1 text-[12px] text-aico-secondary">{c.why}</p>
        <NotInterested id="cleanup:idle" label="Not now" />
      </div>
      <div className="mt-1">
        {shown.map(t => (
          <div key={t.id} className="flex items-center gap-2 rounded-lg px-2 py-1 text-[12.5px]" title={t.url}>
            <Favicon url={t.url} size={14} />
            <span className="min-w-0 flex-1 truncate">{t.title}</span>
            <span className="shrink-0 text-[11px] text-aico-muted">{Math.floor(t.idleFor / 86_400_000)} d</span>
          </div>
        ))}
        {c.tabs.length > 3 && <button className="px-2 text-[11.5px] text-aico-accent hover:underline" onClick={() => setOpen(!open)}>{open ? 'Show fewer' : `Show all ${c.tabs.length}`}</button>}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 px-1">
        <button className="btn-primary btn-sm" onClick={() => void tidy(c.tabs, 'bookmark_close')}><Icon name="bookmark" size={13} />Bookmark into a folder & close</button>
        <button className="btn-outline btn-sm" onClick={() => void tidy(c.tabs, 'close')}>Close them</button>
        <button className="btn-ghost btn-sm" onClick={() => void ask('Look at my idle tabs with browser_tabs_overview and tell me which are worth keeping and why. Do not close anything.')}>Ask AICO which to keep</button>
      </div>
    </Section>
  );
}

function OnDevice(): React.ReactElement {
  return <span className="badge bg-aico-success/10 text-aico-success" title="Learned and kept on this computer only"><Icon name="lock" size={11} className="mr-1" />On this device</span>;
}

// ── For you ──

/** The For-you cards: compact on the new tab page, complete (with routines) in Insights. */
export function ForYouCards({ place }: { place: 'ntp' | 'insights' }): React.ReactElement | null {
  const available = useAvailable('browser:learn:view');
  const view = useLearnView(place === 'insights' ? 60_000 : 0);
  if (!available || view === null) return null;
  if (view === undefined) return place === 'insights' ? <div className="skeleton h-32 w-full" /> : null;
  const ntp = place === 'ntp';
  const seen = new Set(view.priorities.map(p => p.id));
  const cont = view.unfinished.filter(u => !seen.has(u.id)).slice(0, ntp ? 4 : 8);
  const threads = view.threads.slice(0, ntp ? 2 : 6);
  const empty = !view.priorities.length && !cont.length && !threads.length && !view.cleanup && !view.next.length && !view.routines.length;
  if (ntp && empty) return null;

  return (
    <div className={cls('w-full', ntp ? 'mt-9' : 'mt-4')}>
      <div className="mb-2.5 flex items-center gap-2 text-[12.5px] font-medium text-aico-muted">
        <Icon name="sparkles" size={14} className="text-aico-accent" />
        <span className={ntp ? '' : 'text-[15px] font-semibold text-aico-primary'}>For you</span>
        <OnDevice />
        {view.paused && <span className="badge bg-aico-warning/10 text-aico-warning">Learning paused</span>}
        <div className="flex-1" />
        {ntp && <button className="text-[12px] font-normal text-aico-accent hover:underline" onClick={() => showInternal('insights')}>What AICO has learned</button>}
      </div>
      {empty && (
        <div className="card p-5 text-center text-[12.5px] text-aico-muted">
          Suggestions appear as you browse: where you left off, your routines, what you have been researching, and tabs you can tidy.
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {view.priorities.length > 0 && (
          <Section icon="zap" title="Priorities now" hint="ranked for this moment" className="md:col-span-2">
            <div className="grid grid-cols-1 gap-x-2 md:grid-cols-2">
              {view.priorities.map(p => <ItemRow key={p.id} item={p} view={view} />)}
            </div>
          </Section>
        )}
        {cont.length > 0 && (
          <Section icon="history" title="Continue where you left off">
            {cont.map(u => <ItemRow key={u.id} item={u} view={view} />)}
          </Section>
        )}
        {threads.length > 0 && (
          <Section icon="compass" title="Research threads">
            {threads.map(t => <ThreadRow key={t.id} t={t} />)}
          </Section>
        )}
        {!ntp && view.routines.length > 0 && (
          <Section icon="clock" title="Your routines">
            {view.routines.slice(0, 8).map(r => (
              <div key={r.id} className="group flex items-start gap-2.5 rounded-xl px-2 py-1.5 hover:bg-aico-hover">
                <span className="mt-0.5"><Favicon url={r.url} size={16} /></span>
                <button className="min-w-0 flex-1 text-left" onClick={() => openItem({ id: r.id, title: r.site, why: r.why, kind: 'routine', icon: 'clock', score: 0, action: { type: 'open', url: r.url } })}>
                  <span className="block truncate text-[13px] font-medium">{r.site} <span className="font-normal text-aico-muted">· {r.label}</span>{r.due && <span className="badge ml-1.5 bg-aico-accent-soft text-aico-accent">now</span>}</span>
                  <span className="block text-[11.5px] text-aico-muted">{r.why}</span>
                </button>
                <NotInterested id={r.id} />
              </div>
            ))}
          </Section>
        )}
        {view.cleanup && <div className={cls(ntp || view.routines.length % 2 === 0 ? 'md:col-span-2' : '')}><Cleanup c={view.cleanup} /></div>}
        {view.next.length > 0 && (
          <Section icon="compass" title="Suggested next" hint="from where you usually go" className="md:col-span-2">
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
              {view.next.slice(0, 6).map(n => (
                <div key={n.site} className="group flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-aico-hover" title={n.why}>
                  <Favicon url={n.url} size={16} />
                  <button className="min-w-0 flex-1 text-left" onClick={() => openItem({ id: `next:${n.site}`, title: n.site, why: n.why, kind: 'next', icon: 'globe', score: n.score, action: { type: 'open', url: n.url } })}>
                    <span className="block truncate text-[12.5px] font-medium">{n.site}</span>
                    <span className="block truncate text-[11px] text-aico-muted">{n.why}</span>
                  </button>
                  <NotInterested id={`next:${n.site}`} />
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}

// ── What AICO has learned ──

export function LearnedPanel(): React.ReactElement | null {
  const available = useAvailable('browser:learn:view');
  const view = useLearnView();
  const [site, setSite] = useState('');
  if (!available || view === null) return null;
  if (view === undefined) return <div className="skeleton mt-4 h-40 w-full" />;
  const forget = async (): Promise<void> => {
    const ok = await desktop.dialog.confirm({ title: 'Forget everything', message: 'Forget everything AICO has learned from your browsing?', detail: 'Interests, routines, research threads, unfinished items and tab history are removed from this device. Your history, bookmarks, excluded sites and the pause switch are kept.', ok: 'Forget everything', danger: true }).catch(() => false);
    if (ok) { await forgetLearning(); toast.success('AICO forgot what it had learned'); }
  };
  const exclude = (s: string): void => { const v = s.trim(); if (v) { void setExcludedSite(v, true); setSite(''); } };

  return (
    <section className="card mt-4 p-4" aria-label="What AICO has learned">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Icon name="brain" size={16} className="text-aico-accent" />
        <h2 className="text-[15px] font-semibold">What AICO has learned</h2>
        <OnDevice />
        <div className="flex-1" />
        <label className="flex items-center gap-2 text-[12.5px] text-aico-secondary">
          Learning {view.paused ? 'paused' : 'on'}
          <button role="switch" aria-checked={!view.paused} aria-label="Learn from my browsing" className="switch scale-[.8]" onClick={() => void setLearningPaused(!view.paused)}><span /></button>
        </label>
        <button className="btn-outline btn-sm" onClick={() => void forget()}><Icon name="trash" size={13} />Forget everything</button>
      </div>
      <p className="mb-3 text-[12px] text-aico-muted">
        AICO learns from your own browsing to suggest what’s next — on this computer only{view.since ? `, since ${new Date(view.since).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : ''}. It never keeps page contents or anything you type, and never learns from pages the agent opens, pages flagged as deceptive, or sites you exclude. The AI sees a summary only when you ask it about your browsing. “Clear browsing data” clears this too.
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <Sub title="Interests" />
          {!view.interests.length && <Muted text="None yet." />}
          <div className="flex flex-wrap gap-1.5">
            {view.interests.map(i => (
              <span key={i.id} className="chip group !pr-1" title={i.sites.join(', ')}>
                {i.label} <span className="tabular-nums text-aico-muted">{Math.round(i.share * 100)}%</span>
                <button className="icon-btn-sm !h-5 !w-5" title={`Forget ${i.label} (its sites)`} onClick={() => void removeLearned(i.id)}><Icon name="x" size={11} /></button>
              </span>
            ))}
          </div>
          <Sub title="Sites" className="mt-4" />
          {!view.sites.length && <Muted text="None yet." />}
          {view.sites.slice(0, 10).map(s => (
            <div key={s.id} className="group flex items-center gap-2 rounded-lg px-1.5 py-1 text-[12.5px] hover:bg-aico-hover">
              <Favicon url={`https://${s.site}/`} size={14} />
              <span className="min-w-0 flex-1 truncate">{s.site} <span className="text-aico-muted">· {s.topic} · {s.visits} visit{s.visits === 1 ? '' : 's'}{s.ms ? ` · ${fmtTime(s.ms)}` : ''}</span></span>
              <button className="icon-btn-sm opacity-0 group-hover:opacity-100" title="Never learn from this site" onClick={() => void setExcludedSite(s.site, true)}><Icon name="eye-off" size={12} /></button>
              <button className="icon-btn-sm opacity-0 group-hover:opacity-100" title="Forget this site" onClick={() => void removeLearned(s.id)}><Icon name="x" size={12} /></button>
            </div>
          ))}
        </div>
        <div>
          <Sub title="Routines" />
          {!view.routines.length && <Muted text="None clear yet — a site opened at the same time of day on 3+ days becomes one." />}
          {view.routines.map(r => (
            <Removable key={r.id} onRemove={() => void removeLearned(r.id)} title={`${r.site} · ${r.label}`} sub={r.why} />
          ))}
          <Sub title="Research threads" className="mt-4" />
          {!view.threads.length && <Muted text="None in the last two weeks." />}
          {view.threads.map(t => (
            <Removable key={t.id} onRemove={() => void removeLearned(t.id)} title={`“${t.label}”`} sub={`${t.why} Last ${ago(t.last)}.`} />
          ))}
          <Sub title="Never learn from" className="mt-4" />
          <div className="flex flex-wrap gap-1.5">
            {view.excluded.map(x => (
              <span key={x} className="chip !pr-1">{x}<button className="icon-btn-sm !h-5 !w-5" title="Learn from this site again" onClick={() => void setExcludedSite(x, false)}><Icon name="x" size={11} /></button></span>
            ))}
          </div>
          <form className="mt-2 flex gap-1.5" onSubmit={(e) => { e.preventDefault(); exclude(site); }}>
            <input className="input h-8 min-w-0 flex-1 text-[12.5px]" placeholder="example.com" value={site} onChange={e => setSite(e.target.value)} aria-label="Site to exclude from learning" />
            <button className="btn-outline btn-sm" type="submit" disabled={!site.trim()}>Exclude</button>
          </form>
        </div>
      </div>
      <div className="mt-3 text-[11.5px] text-aico-muted">
        {view.stats.sites} sites · {view.stats.pages} pages · {view.stats.searches} searches remembered (older ones fade and drop off after 60 days).
      </div>
    </section>
  );
}

function Sub({ title, className }: { title: string; className?: string }): React.ReactElement {
  return <div className={cls('mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-aico-muted', className)}>{title}</div>;
}
function Muted({ text }: { text: string }): React.ReactElement { return <div className="text-[12px] text-aico-muted">{text}</div>; }
function Removable({ title, sub, onRemove }: { title: string; sub: string; onRemove: () => void }): React.ReactElement {
  return (
    <div className="group flex items-start gap-2 rounded-lg px-1.5 py-1 hover:bg-aico-hover">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium">{title}</div>
        <div className="text-[11.5px] text-aico-muted">{sub}</div>
      </div>
      <button className="icon-btn-sm opacity-0 group-hover:opacity-100" title="Forget this" onClick={onRemove}><Icon name="x" size={12} /></button>
    </div>
  );
}
