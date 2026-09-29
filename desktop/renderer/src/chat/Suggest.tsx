/**
 * The composer's inline menus — "/" for actions, "@" for files, folders and
 * agents.
 *
 * They belong to the text box, not to a popover: focus never leaves the
 * textarea, so typing keeps filtering, ↑/↓ move, Enter or Tab picks and Escape
 * closes, exactly as in every editor people already know. (The first version
 * opened a popover on "/" that took no typing and no arrows — it looked like a
 * menu and behaved like a list of links.)
 *
 * @module desktop/renderer/chat/Suggest
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { useOverlay } from '@/lib/overlay';

export { triggerAt, rankItems, dedupe, groupRanked, type SuggestItem, type Trigger } from './suggest-core';
import type { SuggestItem } from './suggest-core';

export function SuggestMenu({ title, items, active, onHover, onPick, loading, empty }: {
  title: string;
  items: SuggestItem[];
  active: number;
  onHover: (i: number) => void;
  onPick: (item: SuggestItem) => void;
  loading?: boolean;
  empty?: string;
}): React.ReactElement {
  useOverlay(true);
  const list = useRef<HTMLDivElement>(null);
  // Never taller than the room above the composer (the home screen centres it).
  const [room, setRoom] = useState(340);
  useLayoutEffect(() => {
    const host = list.current?.parentElement;
    if (host) setRoom(Math.max(160, Math.min(340, host.getBoundingClientRect().top - 64)));
  }, []);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  let group = '';
  return (
    <div className="menu absolute bottom-full left-0 right-0 z-30 mb-2 overflow-y-auto thin-scroll" style={{ maxHeight: room }} role="listbox" aria-label={title} ref={list}
      onMouseDown={e => e.preventDefault() /* keep the caret in the text box */}>
      {items.length === 0 && (
        <div className="flex items-center gap-2 px-3 py-2.5 text-[13px] text-aico-muted">
          {loading ? <><span className="spinner h-3.5 w-3.5" /> Searching…</> : (empty ?? 'Nothing matches')}
        </div>
      )}
      {items.map((item, i) => {
        const header = item.group !== group ? item.group : null;
        group = item.group;
        return (
          <React.Fragment key={item.id}>
            {header && <div className="px-2.5 pb-1 pt-2 text-[11.5px] font-medium uppercase tracking-wide text-aico-muted">{header}</div>}
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              data-index={i}
              className={cls('menu-item', i === active && 'bg-aico-hover text-aico-primary')}
              onMouseMove={() => { if (i !== active) onHover(i); }}
              onClick={() => onPick(item)}
            >
              <Icon name={item.icon} size={16} className="shrink-0 text-aico-secondary" />
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              {item.hint && <span className="max-w-[45%] truncate text-[11.5px] text-aico-muted">{item.hint}</span>}
              {item.checked && <Icon name="check" size={15} className="text-aico-accent" />}
            </button>
          </React.Fragment>
        );
      })}
      {items.length > 0 && loading && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-aico-muted"><span className="spinner h-3 w-3" /> Searching files…</div>
      )}
      <div className="sticky bottom-0 flex gap-3 border-t border-aico-border-subtle bg-aico-bg px-3 py-1.5 text-[11px] text-aico-muted">
        <span><span className="kbd">↑</span> <span className="kbd">↓</span> move</span><span><span className="kbd">Enter</span> pick</span><span><span className="kbd">Esc</span> close</span>
      </div>
    </div>
  );
}
