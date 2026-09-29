/**
 * The browser's toolbar: back / forward / reload, the site button and the
 * address bar, then bookmark, reader, downloads, the AI copilot and the
 * browser menu.
 *
 * @module desktop/renderer/browser/Toolbar
 */

import React, { useEffect, useState } from 'react';
import { Icon } from '@/lib/icons';
import { bytes, cls } from '@/lib/util';
import { desktop } from '@/desktop';
import { toast, useDesk } from '@/state/desk';
import { MenuItem, MenuSep, Popover } from '@/shell/Popover';
import { call, fire, useAvailable, wasMissing } from './ipc';
import { hostOf, isBlankUrl } from './urls';
import { Favicon, Omnibox } from './Omnibox';
import {
  closeTab, newTab, openFind, refreshDownloads, showInternal, toggleBookmark, toggleReader, useActiveTab, useBrowser,
} from './store';
import { useCopilotUi, toggleCopilot } from './copilot-ui';
import type { DownloadItem, PermissionValue, SiteInfo, TabState } from './types';

export function Toolbar({ compact }: { compact?: boolean }): React.ReactElement {
  const tab = useActiveTab();
  const blank = !tab || isBlankUrl(tab.url);
  const bookmarked = useBrowser(s => Boolean(tab && s.bookmarks.some(b => b.url === tab.url)));
  const reader = useBrowser(s => s.reader !== null);
  const copilotOpen = useCopilotUi(s => s.open && !s.minimized);
  const canRead = useAvailable('browser:read');
  const canMark = useAvailable('browser:bookmarks:add');

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-aico-border-subtle bg-aico-bg px-2">
      <button className="icon-btn-sm" disabled={!tab?.canGoBack} onClick={() => fire('browser:back')} title="Back (Alt+←)"><Icon name="arrow-left" size={16} /></button>
      <button className="icon-btn-sm" disabled={!tab?.canGoForward} onClick={() => fire('browser:forward')} title="Forward (Alt+→)"><Icon name="arrow-right" size={16} /></button>
      <button className="icon-btn-sm" disabled={!tab} onClick={() => fire(tab?.loading ? 'browser:stop' : 'browser:reload')} title={tab?.loading ? 'Stop loading (Esc)' : 'Reload (Ctrl+R)'}>
        <Icon name={tab?.loading ? 'x' : 'refresh'} size={15} />
      </button>
      {!compact && <button className="icon-btn-sm" onClick={() => newTab()} title="New tab page"><Icon name="home" size={15} /></button>}
      <div className="mx-1 flex min-w-0 flex-1">
        <Omnibox url={tab?.url ?? ''} prefix={<SiteButton tab={tab} />} />
      </div>
      {tab && tab.zoom !== 1 && (
        <button className="chip h-7 py-0 tabular-nums" onClick={() => fire('browser:zoom', 0)} title="Reset zoom (Ctrl+0)">{Math.round(tab.zoom * 100)}%</button>
      )}
      {!compact && (
        <>
          <button className={cls('icon-btn-sm', bookmarked && 'text-aico-warning hover:text-aico-warning')} disabled={blank || !canMark}
            onClick={() => void toggleBookmark().then(r => { if (r !== undefined) toast.success(r ? 'Bookmarked' : 'Bookmark removed', tab?.title); })}
            title={canMark ? (bookmarked ? 'Edit bookmark — remove (Ctrl+D)' : 'Bookmark this tab (Ctrl+D)') : 'Bookmarks are not available in this version'}>
            <Icon name="star" size={16} style={bookmarked ? { fill: 'currentColor' } : undefined} />
          </button>
          <button className={cls('icon-btn-sm', reader && 'bg-aico-accent-soft text-aico-accent hover:text-aico-accent')} disabled={blank || !canRead}
            onClick={() => void toggleReader()} aria-pressed={reader}
            title={canRead ? (reader ? 'Leave reader mode' : 'Reader mode') : 'Reader mode is not available in this version'}>
            <Icon name="book-open" size={16} />
          </button>
          <DownloadsButton />
        </>
      )}
      <button className="bx-ai-btn ml-1" aria-pressed={!compact && copilotOpen} onClick={() => toggleCopilot(compact ? true : undefined)}
        title={compact ? 'Open the full browser with the AICO copilot' : 'Ask AICO about this page (Ctrl+Shift+A)'}>
        <span className={cls('bx-orb', copilotOpen ? 'h-[15px] w-[15px] opacity-95' : 'h-[15px] w-[15px]')} />
        {compact ? null : 'Ask AICO'}
      </button>
      <BrowserMenu compact={compact} tab={tab} />
    </div>
  );
}

// ── Site information ──

const PERMISSION_LABELS: Record<string, [string, string]> = {
  geolocation: ['Location', 'map'], media: ['Camera and microphone', 'camera'], camera: ['Camera', 'camera'], microphone: ['Microphone', 'mic'],
  notifications: ['Notifications', 'bell'], 'clipboard-read': ['Clipboard', 'copy'], 'clipboard-sanitized-write': ['Clipboard (write)', 'copy'],
  midi: ['MIDI devices', 'keyboard'], fullscreen: ['Full screen', 'expand'], pointerLock: ['Mouse lock', 'cursor'], openExternal: ['Open other apps', 'external'],
  'window-management': ['Window management', 'monitor'], 'idle-detection': ['Idle detection', 'clock'], hid: ['HID devices', 'plug'], serial: ['Serial ports', 'plug'], usb: ['USB devices', 'plug'],
};

function securityOf(tab: TabState | undefined): { icon: string; label: string; tone: string } {
  if (!tab || isBlankUrl(tab.url)) return { icon: 'search', label: '', tone: 'text-aico-muted' };
  if (tab.error && tab.error.code <= -200 && tab.error.code > -300) return { icon: 'alert', label: 'Not secure', tone: 'bx-danger' };
  switch (tab.security) {
    case 'secure': return { icon: 'lock', label: '', tone: '' };
    case 'insecure': return { icon: 'alert', label: 'Not secure', tone: 'bx-danger' };
    case 'error': return { icon: 'alert', label: 'Not secure', tone: 'bx-danger' };
    default: return { icon: 'info', label: '', tone: '' };
  }
}

function SiteButton({ tab }: { tab: TabState | undefined }): React.ReactElement {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const sec = securityOf(tab);
  const blank = !tab || isBlankUrl(tab.url);
  if (blank) return <span className="flex h-6 w-6 shrink-0 items-center justify-center text-aico-muted"><Icon name="search" size={14} /></span>;
  return (
    <>
      <button ref={setAnchor} className={cls('bx-site shrink-0', sec.tone)} onClick={() => setOpen(o => !o)}
        title={tab!.security === 'secure' ? 'View site information — connection is secure' : 'View site information'} aria-label="Site information">
        <Icon name={sec.icon} size={13} />
        {sec.label && <span>{sec.label}</span>}
        {tab!.trackersBlocked > 0 && <span className="rounded-full bg-aico-hover px-1.5 text-[10.5px] tabular-nums text-aico-secondary">{tab!.trackersBlocked}</span>}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={360}>
        {open && <SiteInfoPanel tab={tab!} close={() => setOpen(false)} />}
      </Popover>
    </>
  );
}

function SiteInfoPanel({ tab, close }: { tab: TabState; close: () => void }): React.ReactElement {
  const [info, setInfo] = useState<SiteInfo | null | undefined>(undefined);
  const [showTrackers, setShowTrackers] = useState(false);
  const blockingOn = useBrowser(s => s.state.blocking.enabled);
  const load = (): void => { void call<SiteInfo>('browser:siteInfo').then(r => setInfo(r ?? null)).catch(() => setInfo(null)); };
  useEffect(load, [tab.url]);
  const host = hostOf(tab.url);
  const secure = (info?.security ?? tab.security) === 'secure';
  const trackers = info?.trackers ?? [];
  const blocked = info?.trackersBlocked ?? tab.trackersBlocked;
  // `blockingAllowedHere` is true when blocking applies to this site; the switch is "allow trackers here".
  const allowedHere = info ? !info.blockingAllowedHere : false;
  const [allPerms, setAllPerms] = useState(false);
  const everyPerm = Object.entries(info?.permissions ?? {});
  const setPerms = everyPerm.filter(([, v]) => v !== 'ask');
  const perms = allPerms ? everyPerm : setPerms;

  return (
    <div className="p-1.5">
      <div className="flex items-center gap-2.5 px-2 pb-2 pt-1">
        <Favicon src={tab.favicon} url={tab.url} size={20} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">{host || tab.url}</div>
          <div className="truncate text-[11.5px] text-aico-muted">{tab.title}</div>
        </div>
      </div>
      <div className="rounded-xl bg-aico-hover/60 px-3 py-2.5">
        <div className={cls('flex items-center gap-2 text-[13px] font-medium', !secure && 'text-aico-danger')}>
          <Icon name={secure ? 'lock' : 'alert'} size={15} />
          {secure ? 'Connection is secure' : tab.security === 'internal' ? 'This is a local or internal page' : 'Your connection to this site is not secure'}
        </div>
        <div className="mt-1 text-[12px] leading-relaxed text-aico-muted">
          {secure ? 'Information you send to this site (like passwords or card numbers) is private in transit.'
            : tab.security === 'internal' ? 'It was not loaded over the network.'
              : 'Don’t enter sensitive information — passwords, card numbers — on this site.'}
        </div>
        {info?.certificate && (
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px]">
            <span className="text-aico-muted">Issued to</span><span className="truncate selectable">{info.certificate.subject}</span>
            <span className="text-aico-muted">Issued by</span><span className="truncate selectable">{info.certificate.issuer}</span>
            <span className="text-aico-muted">Valid until</span><span>{fmtDate(info.certificate.validTo)}</span>
          </div>
        )}
      </div>

      <div className="mt-2 px-2 text-[11.5px] font-medium uppercase tracking-wide text-aico-muted">Tracking prevention</div>
      <div className="mt-1 flex items-center gap-3 rounded-lg px-2 py-1.5">
        <Icon name={blockingOn && !allowedHere ? 'shield-check' : 'shield-off'} size={16} className={blockingOn && !allowedHere ? 'text-aico-success' : 'text-aico-muted'} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px]">{!blockingOn ? 'Tracker blocking is off' : allowedHere ? 'Trackers allowed on this site' : `${blocked} tracker${blocked === 1 ? '' : 's'} blocked`}</div>
          {trackers.length > 0 && (
            <button className="text-[11.5px] text-aico-accent hover:underline" onClick={() => setShowTrackers(v => !v)}>{showTrackers ? 'Hide list' : 'Show which'}</button>
          )}
        </div>
        {blockingOn && info && (
          <button role="switch" aria-checked={allowedHere} className="switch scale-[.8]" title="Allow trackers on this site"
            onClick={() => { void call('browser:blocking:set', allowedHere ? { disallowOrigin: info.origin } : { allowOrigin: info.origin }).then(load).catch((e: Error) => toast.error('Could not change', e.message)); }}>
            <span />
          </button>
        )}
      </div>
      {blockingOn && info && <div className="-mt-1 px-2 pl-9 text-[11.5px] text-aico-muted">Allow trackers on this site</div>}
      {showTrackers && (
        <div className="mx-2 mt-1 max-h-32 overflow-y-auto rounded-lg border border-aico-border-subtle p-2 font-mono text-[11px] text-aico-secondary thin-scroll selectable">
          {trackers.map(t => <div key={t} className="truncate">{t}</div>)}
        </div>
      )}

      {everyPerm.length > 0 && (
        <>
          <div className="mt-3 flex items-center px-2 text-[11.5px] font-medium uppercase tracking-wide text-aico-muted">
            <span className="flex-1">Permissions</span>
            <button className="normal-case tracking-normal text-aico-accent hover:underline" onClick={() => setAllPerms(v => !v)}>
              {allPerms ? 'Show fewer' : setPerms.length ? `All ${everyPerm.length}` : 'Show all'}
            </button>
          </div>
          {perms.length === 0 && <div className="px-2 py-1.5 text-[12px] text-aico-muted">This site has not been given or refused anything — it asks first.</div>}
          {perms.map(([key, value]) => <PermissionRow key={key} origin={info!.origin} perm={key} value={value} onChanged={load} />)}
        </>
      )}
      {info === null && (
        <div className="mt-2 px-2 text-[12px] text-aico-muted">More site details (certificate, permissions, trackers) are not available in this version.</div>
      )}
      <MenuSep />
      <MenuItem icon="cookie" label="Clear browsing data…" onClick={() => { close(); void clearBrowsingData(); }} />
    </div>
  );
}

function PermissionRow({ origin, perm, value, onChanged }: { origin: string; perm: string; value: PermissionValue; onChanged: () => void }): React.ReactElement {
  const [label, icon] = PERMISSION_LABELS[perm] ?? [perm.replace(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase()), 'shield'];
  const [missing, setMissing] = useState(false);
  const set = async (next: PermissionValue): Promise<void> => {
    const r = await call('browser:permissions:set', { origin, permission: perm, value: next }).catch((e: Error) => { toast.error('Could not change', e.message); return null; });
    if (r === undefined && wasMissing('browser:permissions:set')) setMissing(true); else onChanged();
  };
  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-1.5">
      <Icon name={icon} size={15} className="text-aico-secondary" />
      <span className="min-w-0 flex-1 truncate text-[13px]">{label}</span>
      <div className="segmented scale-[.88]" title={missing ? 'Changing this is not available in this version' : undefined}>
        {(['allow', 'ask', 'deny'] as const).map(v => (
          <button key={v} aria-pressed={value === v} disabled={missing} onClick={() => void set(v)}>{v === 'deny' ? 'Block' : v[0]!.toUpperCase() + v.slice(1)}</button>
        ))}
      </div>
    </div>
  );
}

function fmtDate(v: number | string): string {
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export async function clearBrowsingData(): Promise<void> {
  const ok = await desktop.dialog.confirm({
    title: 'Clear browsing data',
    message: 'Clear history, cookies, site data and the cache of the AICO browser?',
    detail: 'You will be signed out of sites you signed in to here — the agent’s sign-ins too. Bookmarks and downloaded files are kept.',
    ok: 'Clear data', danger: true,
  }).catch(() => false);
  if (!ok) return;
  try {
    await call('browser:history:clear');
    await call('browser:clearData');
    toast.success('Browsing data cleared');
  } catch (err) { toast.error('Could not clear browsing data', (err as Error).message); }
}

// ── Downloads ──

function DownloadsButton(): React.ReactElement {
  const downloads = useBrowser(s => s.downloads);
  const open = useBrowser(s => s.downloadsOpen);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const active = downloads.filter(d => d.state === 'progressing');
  const total = active.reduce((n, d) => n + (d.total || 0), 0);
  const got = active.reduce((n, d) => n + d.received, 0);
  const pct = total > 0 ? got / total : active.length ? 0.1 : 0;
  const setOpen = (v: boolean): void => { useBrowser.setState({ downloadsOpen: v }); if (v) void refreshDownloads(); };
  const r = 13; const c = 2 * Math.PI * r;
  return (
    <>
      <button ref={setAnchor} className={cls('icon-btn-sm relative', active.length > 0 && 'text-aico-accent')} onClick={() => setOpen(!open)}
        title={active.length ? `Downloading ${active.length} file${active.length === 1 ? '' : 's'} — ${Math.round(pct * 100)}% (Ctrl+J)` : 'Downloads (Ctrl+J)'}>
        <Icon name="download" size={15} />
        {active.length > 0 && (
          <svg className="bx-ring" viewBox="0 0 30 30" aria-hidden>
            <circle cx="15" cy="15" r={r} fill="none" stroke="var(--aico-border)" strokeWidth="2" />
            <circle cx="15" cy="15" r={r} fill="none" stroke="var(--aico-accent)" strokeWidth="2" strokeLinecap="round"
              strokeDasharray={c} strokeDashoffset={c * (1 - pct)} transform="rotate(-90 15 15)" style={{ transition: 'stroke-dashoffset .3s ease' }} />
          </svg>
        )}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-end" width={380}>
        <DownloadsPanel close={() => setOpen(false)} />
      </Popover>
    </>
  );
}

export function DownloadsPanel({ close, full }: { close?: () => void; full?: boolean }): React.ReactElement {
  const downloads = useBrowser(s => s.downloads);
  const available = useAvailable('browser:downloads:list');
  return (
    <div className={full ? '' : 'p-1'}>
      {!full && (
        <div className="flex items-center gap-2 px-2 pb-1.5 pt-1">
          <span className="flex-1 text-[14px] font-semibold">Downloads</span>
          <button className="btn-ghost btn-sm" disabled={!downloads.some(d => d.state !== 'progressing')} onClick={() => { void call('browser:downloads:clear').then(refreshDownloads).catch(() => {}); }}>Clear</button>
          <button className="icon-btn-sm" onClick={() => { close?.(); showInternal('downloads'); }} title="Open the downloads page"><Icon name="external" size={13} /></button>
        </div>
      )}
      {downloads.length === 0 && (
        <div className="px-3 py-6 text-center text-[12.5px] text-aico-muted">{available ? 'Files you download appear here.' : 'The download list is not available in this version — finished downloads still show a notice.'}</div>
      )}
      <div className={cls(!full && 'max-h-[360px] overflow-y-auto thin-scroll')}>
        {downloads.map(d => <DownloadRow key={d.id} d={d} />)}
      </div>
    </div>
  );
}

function DownloadRow({ d }: { d: DownloadItem }): React.ReactElement {
  const pct = d.total > 0 ? Math.min(1, d.received / d.total) : 0;
  const running = d.state === 'progressing';
  const status = running ? `${bytes(d.received)}${d.total ? ` of ${bytes(d.total)}` : ''}`
    : d.state === 'completed' ? `${bytes(d.total || d.received)} · ${hostOf(d.url) || 'done'}`
      : d.state === 'awaiting-confirmation' ? 'Waiting for you to allow it' : d.state === 'cancelled' ? 'Cancelled' : 'Failed — interrupted';
  return (
    <div className="group flex items-center gap-3 rounded-xl px-2.5 py-2 hover:bg-aico-hover">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-aico-hover text-aico-secondary">
        <Icon name={d.state === 'completed' ? 'file' : d.state === 'progressing' ? 'download' : 'alert'} size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <button className={cls('block max-w-full truncate text-left text-[13px]', d.state === 'completed' ? 'hover:underline' : 'cursor-default', (d.state === 'cancelled' || d.state === 'interrupted') && 'text-aico-muted line-through')}
          onClick={() => { if (d.state === 'completed') fire('browser:downloads:open', d.id); }} title={d.path || d.filename}>
          {d.filename}
        </button>
        <div className="flex items-center gap-1.5 text-[11.5px] text-aico-muted">
          {d.byAgent && <span className="bx-ai-badge !h-[14px] !text-[8.5px]">AI</span>}
          <span className="truncate">{status}</span>
        </div>
        {running && (
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-aico-border-subtle">
            <div className="h-full rounded-full bg-aico-accent transition-[width]" style={{ width: `${Math.max(4, pct * 100)}%` }} />
          </div>
        )}
      </div>
      {running && <button className="icon-btn-sm" onClick={() => fire('browser:downloads:cancel', d.id)} title="Cancel download"><Icon name="x" size={14} /></button>}
      {d.state === 'interrupted' && <button className="icon-btn-sm" onClick={() => fire('browser:downloads:retry', d.id)} title="Try again"><Icon name="refresh" size={14} /></button>}
      {d.state === 'completed' && <button className="icon-btn-sm opacity-0 group-hover:opacity-100" onClick={() => fire('browser:downloads:show', d.id)} title="Show in folder"><Icon name="folder-open" size={14} /></button>}
    </div>
  );
}

// ── The ⋯ menu ──

function BrowserMenu({ compact, tab }: { compact?: boolean; tab: TabState | undefined }): React.ReactElement {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const blocking = useBrowser(s => s.state.blocking.enabled);
  const modern = useBrowser(s => s.modern);
  const blank = !tab || isBlankUrl(tab.url);
  const close = (): void => setOpen(false);
  const run = (fn: () => void) => () => { close(); fn(); };
  return (
    <>
      <button ref={setAnchor} className="icon-btn-sm" onClick={() => setOpen(o => !o)} title="Browser menu" aria-haspopup="menu" aria-expanded={open}>
        <Icon name="more-v" size={16} />
      </button>
      <Popover anchor={anchor} open={open} onClose={close} placement="bottom-end" width={272}>
        <MenuItem icon="plus" label="New tab" hint="Ctrl+T" onClick={run(() => newTab())} />
        <MenuItem icon="x" label="Close tab" hint="Ctrl+W" disabled={!tab} onClick={run(() => closeTab())} />
        <MenuSep />
        <MenuItem icon="history" label="History" hint="Ctrl+H" onClick={run(() => showInternal('history'))} />
        <MenuItem icon="star" label="Bookmarks" onClick={run(() => showInternal('bookmarks'))} />
        <MenuItem icon="download" label="Downloads" hint="Ctrl+J" onClick={run(() => showInternal('downloads'))} />
        <MenuSep />
        <div className="flex items-center gap-2 px-2.5 py-1 text-[13.5px]">
          <Icon name="zoom-in" size={16} className="text-aico-secondary" />
          <span className="flex-1">Zoom</span>
          <div className="flex items-center rounded-full border border-aico-border-subtle">
            <button className="icon-btn-sm h-7 w-8 rounded-l-full" disabled={!tab} onClick={() => fire('browser:zoom', -0.1)} title="Zoom out (Ctrl+-)"><Icon name="minus" size={13} /></button>
            <button className="min-w-[48px] text-center text-[12px] tabular-nums hover:text-aico-accent" disabled={!tab} onClick={() => fire('browser:zoom', 0)} title="Reset zoom (Ctrl+0)">{Math.round((tab?.zoom ?? 1) * 100)}%</button>
            <button className="icon-btn-sm h-7 w-8 rounded-r-full" disabled={!tab} onClick={() => fire('browser:zoom', 0.1)} title="Zoom in (Ctrl+=)"><Icon name="plus" size={13} /></button>
          </div>
        </div>
        <MenuSep />
        <MenuItem icon="search" label="Find on page" hint="Ctrl+F" disabled={blank} onClick={run(openFind)} />
        <MenuItem icon="printer" label="Print…" hint="Ctrl+P" disabled={blank} onClick={run(() => { void call('browser:print').then(() => { if (wasMissing('browser:print')) toast.info('Printing is not available in this version'); }).catch((e: Error) => toast.error('Could not print', e.message)); })} />
        <MenuItem icon="file-text" label="Save page as PDF…" disabled={blank} onClick={run(() => void savePdf())} />
        <MenuSep />
        <MenuItem icon={blocking ? 'shield-check' : 'shield-off'} label="Block trackers" checked={blocking} disabled={!modern}
          title={modern ? undefined : 'Tracker blocking is not available in this version'}
          onClick={run(() => { void call('browser:blocking:set', { enabled: !blocking }).then(() => toast.info(blocking ? 'Tracker blocking is off' : 'Tracker blocking is on')).catch((e: Error) => toast.error('Could not change', e.message)); })} />
        <MenuItem icon="cookie" label="Clear browsing data…" onClick={run(() => void clearBrowsingData())} />
        <MenuSep />
        <MenuItem icon="code" label="Developer tools" hint="F12" disabled={!tab} onClick={run(() => fire('browser:devtools'))} />
        <MenuItem icon="external" label="Open in your browser" disabled={blank} onClick={run(() => fire('browser:external'))} />
        {compact && <MenuItem icon="expand" label="Open full size" onClick={run(() => window.dispatchEvent(new Event('aico:browser-full')))} />}
      </Popover>
    </>
  );
}

async function savePdf(): Promise<void> {
  try {
    const out = await call<string | null>('browser:savePdf');
    if (out === undefined && wasMissing('browser:savePdf')) { toast.info('Saving as PDF is not available in this version'); return; }
    if (out) {
      useDesk.getState().toast({ kind: 'success', title: 'Saved as PDF', body: out, action: { label: 'Show in folder', run: () => void desktop.shell.showItemInFolder(out) } });
    }
  } catch (err) { toast.error('Could not save as PDF', (err as Error).message); }
}
