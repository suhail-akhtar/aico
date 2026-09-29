/**
 * Privacy & security — the browser's settings page: Shields defaults,
 * protected browsing (and whether AICO checks flagged pages by itself),
 * notification prompts, every site's remembered permissions with a reset, the
 * per-site shield exceptions, insights, and what to clear when AICO closes.
 *
 * @module desktop/renderer/browser/PrivacyPage
 */

import React, { useEffect, useState } from 'react';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { toast } from '@/state/desk';
import type { ShieldSet, ShieldSettingsView, SitePermissions } from '@desk/browser-types';
import { call, useAvailable } from './ipc';
import { hostOf } from './urls';
import { showInternal } from './store';
import { ChromePage } from './Insights';
import { Toggle } from './Shields';
import { clearBrowsingData } from './Toolbar';

const PERMS: Array<[string, string, string]> = [
  ['camera', 'Camera', 'camera'], ['microphone', 'Microphone', 'mic'], ['camera-microphone', 'Camera and microphone', 'camera'],
  ['geolocation', 'Location', 'map'], ['notifications', 'Notifications', 'bell'], ['clipboard-read', 'Clipboard', 'copy'],
  ['popups', 'Pop-ups and redirects', 'external'], ['downloads', 'Automatic downloads', 'download'],
];
const permLabel = (p: string): [string, string] => { const hit = PERMS.find(x => x[0] === p); return hit ? [hit[1], hit[2]] : [p.replace(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase()), 'shield']; };

export function PrivacyPage(): React.ReactElement {
  const [s, setS] = useState<ShieldSettingsView | null | undefined>(undefined);
  const [perms, setPerms] = useState<SitePermissions[]>([]);
  const available = useAvailable('browser:shield:settings');
  const load = (): void => {
    void call<ShieldSettingsView>('browser:shield:settings').then(r => setS(r ?? null)).catch(() => setS(null));
    void call<SitePermissions[]>('browser:permissions:list').then(r => setPerms(r ?? [])).catch(() => {});
  };
  useEffect(load, []);
  const set = (o: ShieldSet): void => {
    void call<ShieldSettingsView>('browser:shield:set', o).then(r => { if (r) setS(r); }).catch((e: Error) => toast.error('Could not change', e.message));
  };
  const global = (g: NonNullable<ShieldSet['global']>): void => set({ global: g });

  return (
    <ChromePage title="Privacy & security" icon="shield-check" actions={<button className="btn-outline btn-sm" onClick={() => showInternal('insights')}><Icon name="chart" size={13} />Insights</button>}>
      {!available && <p className="py-16 text-center text-[13px] text-aico-muted">These settings are not available in this version.</p>}
      {s === undefined && available && <div className="skeleton h-40 w-full" />}
      {s && (
        <div className="space-y-4">
          <Section title="Shields" hint="Applied to every site; change a single site from the shield in the address bar.">
            <Toggle label="Block trackers and ads" hint="Known analytics, advertising, fingerprinting and session-recording hosts, when loaded by another site" on={s.trackers}
              set={on => void call('browser:blocking:set', { enabled: on }).then(load).catch((e: Error) => toast.error('Could not change', e.message))} />
            <Toggle label="Block third-party cookies" hint="Embedded sites can’t follow you from site to site. Allow them per site if a sign-in needs it." on={s.cookies3p} set={on => global({ cookies3p: on })} />
            <Toggle label="Upgrade connections to HTTPS" hint="Tries https:// first and warns before opening a site over plain http (never localhost or your local network)" on={s.httpsFirst} set={on => global({ httpsFirst: on })} />
            <Toggle label="Send Global Privacy Control" hint="Tells sites not to sell or share your data (Sec-GPC and Do Not Track)" on={s.gpc} set={on => global({ gpc: on })} />
          </Section>

          <Section title="Protected browsing" hint="Checked on this device. Your addresses are never sent anywhere to be checked.">
            <Toggle label="Warn about deceptive sites" hint="Look-alike addresses, brand names on unrelated sites, sign-in pages over http or on bare IP addresses" on={s.protection.heuristics}
              set={on => global({ protection: { ...s.protection, heuristics: on } })} />
            <Toggle label="Use a public list of malware sites" on={s.protection.list} set={on => global({ protection: { ...s.protection, list: on } })}
              hint={`${s.list.source}; downloaded at most once a day — only the list, nothing about you. Free for non-commercial use.${s.protection.list ? ` ${s.list.hosts ? `${s.list.hosts.toLocaleString()} hosts` : 'Not downloaded yet'}${s.list.updatedAt ? `, updated ${new Date(s.list.updatedAt).toLocaleString()}` : ''}${s.list.error ? ` (last attempt failed: ${s.list.error})` : ''}.` : ''}`} />
            <Toggle label="Let AICO check suspicious pages automatically" hint="When a page is flagged, the copilot opens and explains why. It only looks — it never clicks, types or submits on a flagged page." on={s.protection.autoCheck}
              set={on => global({ protection: { ...s.protection, autoCheck: on } })} />
          </Section>

          <Section title="Site permissions" hint="What sites have been allowed or refused. A site not listed asks first.">
            <Toggle label="Let sites ask to show notifications" hint="Off: notification requests are refused without asking you" on={s.notificationsAsk} set={on => global({ notificationsAsk: on })} />
            {perms.length === 0 && <div className="px-2 py-3 text-[12.5px] text-aico-muted">No site has been given or refused a permission yet.</div>}
            {perms.map(p => (
              <div key={p.origin} className="rounded-xl border border-aico-border-subtle px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{hostOf(p.origin) || p.origin}</span>
                  <button className="btn-ghost btn-sm" onClick={() => void call('browser:permissions:reset', p.origin).then(load)}>Reset</button>
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {Object.entries(p.permissions).map(([k, v]) => {
                    const [label, icon] = permLabel(k);
                    return (
                      <span key={k} className="flex items-center gap-1.5 rounded-full bg-aico-hover px-2 py-0.5 text-[11.5px]">
                        <Icon name={icon} size={12} className="text-aico-secondary" />{label}
                        <span className={cls('font-medium', v === 'allow' ? 'text-aico-success' : 'text-aico-danger')}>{v === 'allow' ? 'Allowed' : 'Blocked'}</span>
                        <button className="text-aico-muted hover:text-aico-primary" title="Reset to Ask" onClick={() => void call('browser:permissions:set', { origin: p.origin, permission: k, value: 'ask' }).then(load)}><Icon name="x" size={11} /></button>
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
            {perms.length > 1 && <button className="btn-outline btn-sm" onClick={() => void call('browser:permissions:reset').then(load)}>Reset all sites</button>}
          </Section>

          <Section title="Site exceptions" hint="Sites where a shield is off, or that you marked as trusted.">
            {s.exceptions.length === 0 && <div className="px-2 py-3 text-[12.5px] text-aico-muted">No exceptions — every shield applies everywhere.</div>}
            {s.exceptions.map(e => (
              <div key={e.site} className="flex items-center gap-2 rounded-lg px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-[13px]">{hostOf(e.site) || e.site}</span>
                <span className="flex flex-wrap gap-1">
                  {e.trackers && <Chip>Trackers allowed</Chip>}
                  {e.cookies3p && <Chip>Third-party cookies allowed</Chip>}
                  {(e.httpsFirst || e.http) && <Chip>Opened over http</Chip>}
                  {e.trusted && <Chip>Trusted (not checked)</Chip>}
                </span>
                <button className="btn-ghost btn-sm" onClick={() => {
                  const jobs: Array<Promise<unknown>> = [];
                  if (e.trackers) jobs.push(call('browser:blocking:set', { disallowOrigin: e.site }));
                  if (e.cookies3p || e.httpsFirst || e.http || e.trusted) jobs.push(call('browser:shield:set', { site: e.site, reset: true }));
                  void Promise.all(jobs).then(load).catch((err: Error) => toast.error('Could not reset', err.message));
                }}>Reset</button>
              </div>
            ))}
          </Section>

          <Section title="Insights" hint="Time on sites, visits and what was blocked — kept on this device only.">
            <Toggle label="Record browsing insights" on={s.insights} set={on => global({ insights: on })} />
          </Section>

          <Section title="Clear data when AICO closes">
            {([['cookies', 'Cookies and site data', 'Signs you (and the agent) out of sites'], ['cache', 'Cached images and files', undefined], ['history', 'Browsing history', undefined], ['insights', 'Browsing insights', undefined]] as const).map(([k, label, hint]) => (
              <label key={k} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5">
                <input type="checkbox" className="accent-[var(--aico-accent)]" checked={s.clearOnExit[k]} onChange={ev => global({ clearOnExit: { ...s.clearOnExit, [k]: ev.target.checked } })} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px]">{label}</span>
                  {hint && <span className="block text-[11.5px] text-aico-muted">{hint}</span>}
                </span>
              </label>
            ))}
            <button className="btn-outline btn-sm mt-1" onClick={() => void clearBrowsingData().then(load)}><Icon name="cookie" size={13} />Clear browsing data now…</button>
          </Section>
        </div>
      )}
    </ChromePage>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section className="card p-4">
      <h2 className="text-[14px] font-semibold">{title}</h2>
      {hint && <p className="mb-2 mt-0.5 text-[12px] text-aico-muted">{hint}</p>}
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function Chip({ children }: { children: React.ReactNode }): React.ReactElement {
  return <span className="rounded-full bg-aico-hover px-2 py-0.5 text-[11px] text-aico-secondary">{children}</span>;
}
