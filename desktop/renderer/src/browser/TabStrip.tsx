/**
 * The tab strip: favicon (a spinner while loading), title, the sound
 * indicator that mutes on click, close — middle-click closes too — and a
 * right-click menu. A tab the agent is driving wears an "AI" badge.
 *
 * @module desktop/renderer/browser/TabStrip
 */

import React, { useState } from 'react';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { toast } from '@/state/desk';
import { MenuItem, MenuSep, Popover } from '@/shell/Popover';
import { fire, useAvailable } from './ipc';
import { isBlankUrl } from './urls';
import { Favicon } from './Omnibox';
import { closeTab, newTab, openUrl, toggleBookmark, useBrowser } from './store';
import type { TabState } from './types';

export function TabStrip(): React.ReactElement {
  const tabs = useBrowser(s => s.state.tabs);
  const activeId = useBrowser(s => s.state.activeId);
  return (
    <div className="bx-tabstrip flex h-10 shrink-0 items-end gap-0 overflow-x-auto px-2 pt-1.5 thin-scroll" role="tablist" aria-label="Browser tabs">
      {tabs.map(t => <Tab key={t.id} tab={t} active={t.id === activeId} />)}
      <button className="icon-btn-sm mb-[3px] ml-1 shrink-0" onClick={() => newTab()} title="New tab (Ctrl+T)"><Icon name="plus" size={15} /></button>
      <div className="min-w-4 flex-1" />
    </div>
  );
}

function tabTitle(t: TabState): string {
  if (isBlankUrl(t.url)) return 'New tab';
  return t.title || t.url || 'Untitled';
}

function Tab({ tab, active }: { tab: TabState; active: boolean }): React.ReactElement {
  const [menu, setMenu] = useState(false);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const canMute = useAvailable('browser:mute');
  return (
    <>
      <div ref={setEl} role="tab" aria-selected={active} tabIndex={0}
        className={cls('bx-tab group cursor-default select-none', tab.agentActive && 'bx-agent')}
        onMouseDown={e => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } else if (e.button === 0 && !active) fire('browser:select', tab.id); }}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fire('browser:select', tab.id); }}
        onContextMenu={e => { e.preventDefault(); setMenu(true); }}
        title={`${tabTitle(tab)}${isBlankUrl(tab.url) ? '' : `\n${tab.url}`}`}>
        <span className="bx-tab-icon flex h-4 w-4 shrink-0 items-center justify-center">
          {tab.loading ? <span className="spinner h-3.5 w-3.5" /> : isBlankUrl(tab.url) ? <span className="bx-orb h-3.5 w-3.5" /> : <Favicon src={tab.favicon} url={tab.url} size={16} />}
        </span>
        <span className="min-w-0 flex-1 truncate">{tabTitle(tab)}</span>
        {tab.agentActive && <span className="bx-ai-badge" title="AICO is using this tab">AI</span>}
        {(tab.audible || tab.muted) && (
          <button className={cls('icon-btn-sm h-5 w-5 shrink-0', tab.muted && 'text-aico-muted')} disabled={!canMute}
            onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); fire('browser:mute', tab.id, !tab.muted); }}
            title={tab.muted ? 'Unmute site' : 'Mute site'}>
            <Icon name={tab.muted ? 'volume-x' : 'volume'} size={13} />
          </button>
        )}
        <button className="bx-tab-close icon-btn-sm h-5 w-5 shrink-0 rounded-full"
          onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); closeTab(tab.id); }} title="Close tab (Ctrl+W)">
          <Icon name="x" size={12} />
        </button>
      </div>
      <Popover anchor={el} open={menu} onClose={() => setMenu(false)} width={230}>
        <TabMenu tab={tab} close={() => setMenu(false)} />
      </Popover>
    </>
  );
}

function TabMenu({ tab, close }: { tab: TabState; close: () => void }): React.ReactElement {
  const tabs = useBrowser(s => s.state.tabs);
  const bookmarked = useBrowser(s => s.bookmarks.some(b => b.url === tab.url));
  const blank = isBlankUrl(tab.url);
  const run = (fn: () => void) => () => { close(); fn(); };
  return (
    <>
      <MenuItem icon="plus" label="New tab" onClick={run(() => newTab())} />
      <MenuSep />
      <MenuItem icon="refresh" label="Reload" disabled={blank} onClick={run(() => { fire('browser:select', tab.id); setTimeout(() => fire('browser:reload'), 60); })} />
      <MenuItem icon="copy" label="Duplicate" disabled={blank} onClick={run(() => openUrl(tab.url, true))} />
      <MenuItem icon={tab.muted ? 'volume' : 'volume-x'} label={tab.muted ? 'Unmute site' : 'Mute site'} onClick={run(() => fire('browser:mute', tab.id, !tab.muted))} />
      <MenuItem icon="star" label={bookmarked ? 'Remove bookmark' : 'Bookmark tab'} disabled={blank}
        onClick={run(() => void toggleBookmark(tab).then(r => { if (r !== undefined) toast.success(r ? 'Bookmarked' : 'Bookmark removed', tab.title); }))} />
      <MenuItem icon="link" label="Copy address" disabled={blank} onClick={run(() => { void navigator.clipboard.writeText(tab.url); toast.success('Address copied'); })} />
      <MenuSep />
      <MenuItem icon="x" label="Close" hint="Ctrl+W" onClick={run(() => closeTab(tab.id))} />
      <MenuItem icon="x-circle" label="Close other tabs" disabled={tabs.length < 2} onClick={run(() => { for (const t of tabs) if (t.id !== tab.id) closeTab(t.id); })} />
      <MenuItem icon="chevron-right" label="Close tabs to the right" disabled={tabs[tabs.length - 1]?.id === tab.id}
        onClick={run(() => { const i = tabs.findIndex(t => t.id === tab.id); for (const t of tabs.slice(i + 1)) closeTab(t.id); })} />
    </>
  );
}
