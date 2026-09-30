/**
 * AICO Shields in the toolbar: a shield with a count of what was blocked on
 * this page, and a panel that says what — trackers and ads by company,
 * third-party cookies, the HTTPS upgrade, fingerprinting scripts, pop-ups and
 * notification prompts — with this site's switches and the way to Insights and
 * Privacy & security. Everything it shows was decided and counted on this
 * device (electron/browser-privacy.ts).
 *
 * @module desktop/renderer/browser/Shields
 */

import React, { useEffect, useState } from 'react';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { toast } from '@/state/desk';
import { Popover } from '@/shell/Popover';
import type { ShieldSite, ShieldTracker } from '@desk/browser-types';
import { call, useAvailable } from './ipc';
import { hostOf, isBlankUrl } from './urls';
import { showInternal, useBrowser } from './store';
import type { TabState } from './types';

const CATEGORY: Record<ShieldTracker['category'], string> = {
  ads: 'Advertising', analytics: 'Analytics', social: 'Social tracking', fingerprinting: 'Fingerprinting', 'session-replay': 'Session recording',
};

export function ShieldButton({ tab }: { tab: TabState | undefined }): React.ReactElement | null {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const blockingOn = useBrowser(s => s.state.blocking.enabled);
  const available = useAvailable('browser:shield:site');
  if (!tab || isBlankUrl(tab.url) || !/^https?:/i.test(tab.url)) return null;
  const count = tab.trackersBlocked + (tab.cookiesBlocked ?? 0);
  const warned = Boolean(tab.threat);
  return (
    <>
      <button ref={setAnchor} className={cls('icon-btn-sm relative', warned ? 'text-aico-danger hover:text-aico-danger' : blockingOn && 'text-aico-success hover:text-aico-success')}
        onClick={() => setOpen(o => !o)} aria-haspopup="dialog" aria-expanded={open}
        title={warned ? 'AICO Shields — this page was flagged as possibly deceptive' : `AICO Shields — ${count} blocked on this page`}>
        <Icon name={warned ? 'alert' : blockingOn ? 'shield-check' : 'shield-off'} size={16} />
        {count > 0 && !warned && <span className="bx-shield-badge tabular-nums">{count > 99 ? '99+' : count}</span>}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-end" width={360}>
        {open && (available ? <ShieldPanel tab={tab} close={() => setOpen(false)} /> : <div className="p-4 text-[12.5px] text-aico-muted">Shields are not available in this version.</div>)}
      </Popover>
    </>
  );
}

function ShieldPanel({ tab, close }: { tab: TabState; close: () => void }): React.ReactElement {
  const [info, setInfo] = useState<ShieldSite | null | undefined>(undefined);
  const [showList, setShowList] = useState(false);
  const blockingOn = useBrowser(s => s.state.blocking.enabled);
  const load = (): void => { void call<ShieldSite | null>('browser:shield:site').then(r => setInfo(r ?? null)).catch(() => setInfo(null)); };
  useEffect(load, [tab.url, tab.trackersBlocked, tab.cookiesBlocked]);
  const change = (channel: string, arg: unknown): void => {
    void call(channel, arg).then(load).catch((e: Error) => toast.error('Could not change', e.message));
  };
  const host = hostOf(info?.url ?? tab.url);
  const total = (info?.trackersBlocked ?? tab.trackersBlocked) + (info?.cookiesBlocked ?? 0);

  return (
    <div className="p-1.5" role="dialog" aria-label="AICO Shields">
      <div className="flex items-center gap-2.5 px-2 pb-2 pt-1">
        <span className={cls('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', info?.threat ? 'bg-aico-danger/10 text-aico-danger' : 'bg-aico-success/10 text-aico-success')}>
          <Icon name={info?.threat ? 'alert' : 'shield-check'} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">AICO Shields</div>
          <div className="truncate text-[11.5px] text-aico-muted">{host}</div>
        </div>
        <div className="text-right">
          <div className="text-[20px] font-semibold leading-none tabular-nums">{total}</div>
          <div className="text-[10.5px] text-aico-muted">blocked here</div>
        </div>
      </div>

      {info?.threat && (
        <div className="mx-1 mb-1.5 rounded-xl bg-aico-danger/10 px-3 py-2 text-[12.5px] text-aico-danger">
          <div className="font-medium">{info.threat.level === 'block' ? 'Flagged as likely deceptive' : 'This page may be deceptive'}</div>
          <div className="mt-0.5 text-aico-secondary">{info.threat.reasons[0]?.label}</div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-1 px-1">
        <Stat icon="shield" label="Trackers & ads" value={info?.trackersBlocked ?? tab.trackersBlocked} />
        <Stat icon="cookie" label="Third-party cookies" value={info?.cookiesBlocked ?? tab.cookiesBlocked ?? 0} />
        <Stat icon="eye-off" label="Fingerprinting" value={info?.fingerprinting ?? 0} />
        <Stat icon="lock" label="HTTPS upgrade" value={info?.httpsUpgraded || tab.httpsUpgraded ? 'Yes' : /^https:/.test(tab.url) ? 'Not needed' : 'No'} />
        <Stat icon="external" label="Pop-ups" value={info?.popupsBlocked ?? tab.popupsBlocked ?? 0} />
        <Stat icon="bell" label="Notification prompts" value={info?.notificationsBlocked ?? 0} />
      </div>

      {info && info.companies.length > 0 && (
        <div className="mt-2 px-2">
          <button className="flex w-full items-center gap-1 text-[11.5px] font-medium uppercase tracking-wide text-aico-muted hover:text-aico-secondary" onClick={() => setShowList(v => !v)} aria-expanded={showList}>
            <span className="flex-1 text-left">Blocked, by company</span>
            <Icon name={showList ? 'chevron-up' : 'chevron-down'} size={13} />
          </button>
          <div className="mt-1 max-h-44 overflow-y-auto thin-scroll">
            {(showList ? info.companies : info.companies.slice(0, 4)).map(c => (
              <div key={c.company} className="flex items-center gap-2 rounded-lg px-1 py-1 text-[12.5px]">
                <span className="min-w-0 flex-1 truncate">{c.company}</span>
                <span className="shrink-0 text-[11px] text-aico-muted">{CATEGORY[c.category]}</span>
                <span className="w-7 shrink-0 text-right tabular-nums text-aico-secondary">{c.count}</span>
              </div>
            ))}
            {showList && (
              <div className="mt-1 rounded-lg border border-aico-border-subtle p-2 font-mono text-[10.5px] text-aico-muted selectable">
                {info.trackers.map(t => <div key={t.host} className="truncate">{t.host} × {t.count}</div>)}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mt-2 px-2 text-[11.5px] font-medium uppercase tracking-wide text-aico-muted">On {info?.site || host}</div>
      {info && (
        <div className="px-1">
          <Toggle label="Block trackers & ads" hint={blockingOn ? undefined : 'Off for every site (browser menu)'} on={info.trackersOn} disabled={!blockingOn}
            set={on => change('browser:blocking:set', on ? { disallowOrigin: info.origin } : { allowOrigin: info.origin })} />
          <Toggle label="Block third-party cookies" hint="Turn off if a sign-in here keeps failing" on={info.cookiesOn}
            set={on => change('browser:shield:set', { site: info.site, cookies3p: on })} />
          <Toggle label="Upgrade connections to HTTPS" on={info.httpsOn}
            set={on => change('browser:shield:set', { site: info.site, httpsFirst: on })} />
          {info.trusted && (
            <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-aico-muted">
              <Icon name="check-circle" size={14} />You marked this site as trusted — it is not checked for deception.
              <button className="ml-auto text-aico-accent hover:underline" onClick={() => change('browser:shield:set', { site: info.site, trusted: false })}>Undo</button>
            </div>
          )}
        </div>
      )}
      {info === null && <div className="px-2 py-2 text-[12px] text-aico-muted">Shield details are not available for this page.</div>}
      <InjectionGuardRow tab={tab} />
      <div className="mt-1.5 flex items-center gap-1 border-t border-aico-border-subtle px-1 pt-1.5">
        <span className="flex-1 truncate px-1 text-[11px] text-aico-muted" title="Global Privacy Control and Do Not Track are sent to every site">
          {info?.gpc ? 'Sending “Do not sell or share” (GPC)' : ''}
        </span>
        <button className="btn-ghost btn-sm" onClick={() => { close(); showInternal('insights'); }}><Icon name="chart" size={13} />Insights</button>
        <button className="btn-ghost btn-sm" onClick={() => { close(); showInternal('privacy'); }}><Icon name="settings" size={13} />Settings</button>
      </div>
    </div>
  );
}

/** What the prompt-injection guard found when the agent read this page (shared/injection-guard.ts). */
function InjectionGuardRow({ tab }: { tab: TabState }): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const g = tab.injectionGuard;
  if (!g) return null;
  const alert = g.flagged > 0 || g.snippets.length > 0;
  return (
    <div className={cls('mx-1 mt-2 rounded-xl px-3 py-2 text-[12.5px]', alert ? 'bg-aico-warning/10' : 'bg-aico-hover/60')}>
      <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(v => !v)} aria-expanded={open} disabled={!g.snippets.length}>
        <Icon name={alert ? 'alert' : 'shield-check'} size={14} className={alert ? 'text-aico-warning' : 'text-aico-muted'} />
        <span className="min-w-0 flex-1">Prompt-injection guard: <span className="tabular-nums">{g.hidden}</span> hidden / <span className="tabular-nums">{g.flagged}</span> flagged on this page</span>
        {g.snippets.length > 0 && <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} />}
      </button>
      {open && (
        <div className="mt-1.5 max-h-40 space-y-1 overflow-y-auto thin-scroll">
          {g.snippets.map((sn, i) => (
            <div key={i} className="rounded-lg border border-aico-border-subtle px-2 py-1 text-[11.5px] text-aico-secondary selectable">
              <span className="mr-1 text-[10.5px] uppercase tracking-wide text-aico-muted">{sn.hidden ? 'hidden' : 'flagged'}</span>{sn.text}
            </div>
          ))}
          <div className="text-[11px] text-aico-muted">The agent was told to treat this text as data, never as instructions.</div>
        </div>
      )}
    </div>
  );
}

function Stat({ icon, label, value }: { icon: string; label: string; value: number | string }): React.ReactElement {
  const zero = value === 0 || value === 'No';
  return (
    <div className="flex items-center gap-2 rounded-xl bg-aico-hover/60 px-2.5 py-2">
      <Icon name={icon} size={14} className={zero ? 'text-aico-muted' : 'text-aico-secondary'} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] text-aico-muted">{label}</div>
        <div className={cls('text-[13.5px] font-medium tabular-nums', zero && 'text-aico-muted')}>{value}</div>
      </div>
    </div>
  );
}

export function Toggle({ label, hint, on, set, disabled }: { label: string; hint?: string; on: boolean; set: (on: boolean) => void; disabled?: boolean }): React.ReactElement {
  return (
    <div className={cls('flex items-center gap-3 rounded-lg px-2 py-1.5', disabled && 'opacity-60')}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px]">{label}</div>
        {hint && <div className="text-[11.5px] text-aico-muted">{hint}</div>}
      </div>
      <button role="switch" aria-checked={on} aria-label={label} className="switch scale-[.8]" disabled={disabled} onClick={() => set(!on)}><span /></button>
    </div>
  );
}
