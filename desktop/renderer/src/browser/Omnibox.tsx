/**
 * The address bar: an address or a search, with suggestions from history and
 * bookmarks as you type (↑/↓ to choose, Enter to go, Esc to put it back), and
 * the sites AICO predicts you will open next — offered on focus before you
 * type, and lifted (labelled with why) when they match what you type
 * (ForYouSuggest.ts).
 *
 * While the suggestions are open they cover part of the page, and the page is
 * a native view drawn above the interface — so they count as an overlay and
 * the page steps aside for a still of itself.
 *
 * @module desktop/renderer/browser/Omnibox
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { useOverlay } from '@/lib/overlay';
import { call } from './ipc';
import { SEARCH_NAME, displayUrl, hostOf, isBlankUrl, parseOmnibox, rankSuggestions } from './urls';
import { openUrl, useBrowser } from './store';
import type { HistoryEntry } from './types';
import type { LearnPrediction } from '@desk/browser-learn-types';
import { blendPredictions, predictionRows, type RankedSuggestion } from './ForYouSuggest';

export function Favicon({ src, url, size = 16, className }: { src?: string; url?: string; size?: number; className?: string }): React.ReactElement {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (src && !broken) return <img src={src} width={size} height={size} className={cls('shrink-0 rounded-[3px]', className)} alt="" onError={() => setBroken(true)} draggable={false} />;
  const host = url ? hostOf(url) : '';
  if (host) {
    return (
      <span className={cls('inline-flex shrink-0 items-center justify-center rounded-[4px] bg-aico-hover font-semibold uppercase text-aico-secondary', className)}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.62) }} aria-hidden>{host[0]}</span>
    );
  }
  return <Icon name="globe" size={size - 2} className={cls('shrink-0 text-aico-muted', className)} />;
}

export function Omnibox({ url, big, autoFocus, placeholder, onGo, prefix, suffix }: {
  url: string;
  /** The new tab page's large search box. */
  big?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  /** Instead of opening the URL here (the new tab page opens in the current tab too, but says so). */
  onGo?: (url: string) => void;
  prefix?: React.ReactNode;
  /** At the right end while not editing (the saved-passwords key). */
  suffix?: React.ReactNode;
}): React.ReactElement {
  const [value, setValue] = useState(displayUrl(url));
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  /** Typed since focusing: before that, the list is the predictions and nothing is chosen (Enter still goes to the address). */
  const [typed, setTyped] = useState(false);
  const [preds, setPreds] = useState<LearnPrediction[]>([]);
  const bookmarks = useBrowser(s => s.bookmarks);
  const focusTick = useBrowser(s => s.focusOmnibox);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!editing) setValue(displayUrl(url)); }, [url, editing]);
  useEffect(() => {
    if (big || focusTick === 0) return;
    input.current?.focus();
    input.current?.select();
  }, [focusTick, big]);

  // History matching what is typed, asked of main a moment after typing stops.
  const query = editing ? value.trim() : '';
  useEffect(() => {
    if (!query) { setHistory([]); return; }
    const t = setTimeout(() => {
      void call<HistoryEntry[]>('browser:history:list', { query, limit: 40 }).then(h => setHistory(h ?? [])).catch(() => setHistory([]));
    }, 90);
    return () => clearTimeout(t);
  }, [query]);

  // Learned predictions (browser-learn.ts): on focus for the toolbar's bar, and matching what is typed.
  const zero = editing && !typed && !big;
  useEffect(() => {
    if (!editing || (big && !query)) { setPreds([]); return; }
    const t = setTimeout(() => {
      void call<LearnPrediction[]>('browser:learn:predict', { query: typed ? query : undefined }).then(p => setPreds(p ?? [])).catch(() => setPreds([]));
    }, 90);
    return () => clearTimeout(t);
  }, [editing, typed, query, big]);

  const suggestions = useMemo<RankedSuggestion[]>(() => {
    if (zero && preds.length) return predictionRows(preds);
    return query ? blendPredictions(rankSuggestions(query, history, bookmarks, { limit: big ? 7 : 8 }), typed ? preds : [], big ? 7 : 8) : [];
  }, [zero, query, history, bookmarks, big, preds, typed]);
  useEffect(() => { setActive(zero ? -1 : 0); setDismissed(false); }, [query, zero]);
  const open = editing && suggestions.length > 0 && !dismissed;
  useOverlay(open && !big);

  const go = (target: string, row?: RankedSuggestion): void => {
    if (row?.predicted) void call('browser:learn:feedback', { id: `next:${hostOf(row.url).replace(/^www\./, '')}`, action: 'open' }).catch(() => {});
    setEditing(false);
    input.current?.blur();
    if (onGo) onGo(target); else openUrl(target);
  };
  const submit = (): void => {
    const pick = open ? suggestions[active] : undefined;
    if (pick) { go(pick.url, pick); return; }
    const parsed = parseOmnibox(value);
    if (parsed) go(parsed.url);
  };

  return (
    <div className={cls('relative min-w-0 flex-1', big && 'w-full')}>
      <div className={cls('bx-omni', big && '!h-[52px] !gap-3 !pl-5 !pr-3 shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_28px_rgba(0,0,0,.07)] !border-aico-border-subtle !bg-aico-bg')}>
        {prefix}
        {big && <Icon name="search" size={18} className="shrink-0 text-aico-muted" />}
        <input
          ref={input}
          value={value}
          autoFocus={autoFocus}
          spellCheck={false}
          onChange={e => { setValue(e.target.value); setEditing(true); setTyped(true); }}
          onFocus={e => { setEditing(true); setTyped(false); if (!big) e.target.select(); }}
          onBlur={() => setTimeout(() => { setEditing(false); setTyped(false); }, 120)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            else if (e.key === 'ArrowDown' && open) { e.preventDefault(); setActive(a => Math.min(suggestions.length - 1, a + 1)); }
            else if (e.key === 'ArrowUp' && open) { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
            else if (e.key === 'Escape') {
              e.stopPropagation();
              if (open) { setDismissed(true); return; }
              setValue(displayUrl(url)); setEditing(false); input.current?.blur();
            }
          }}
          placeholder={placeholder ?? 'Search Google or type a URL'}
          aria-label="Address and search bar"
          aria-autocomplete="list"
          aria-expanded={open}
          className={cls('min-w-0 flex-1 bg-transparent outline-none placeholder:text-aico-muted', big ? '!text-[16px]' : '')}
        />
        {editing && value && (
          <button className="icon-btn-sm h-6 w-6 shrink-0" onMouseDown={e => e.preventDefault()} onClick={() => { setValue(''); input.current?.focus(); }} title="Clear" aria-label="Clear">
            <Icon name="x" size={13} />
          </button>
        )}
        {!editing && suffix}
      </div>
      {open && (
        <div className="bx-suggest" role="listbox" aria-label="Suggestions" onMouseDown={e => e.preventDefault()}>
          {suggestions.map((s, i) => (
            <SuggestionRow key={`${s.kind}:${s.url}`} s={s} active={i === active} onHover={() => setActive(i)} onPick={() => go(s.url, s)} />
          ))}
        </div>
      )}
    </div>
  );
}

function SuggestionRow({ s, active, onHover, onPick }: { s: RankedSuggestion; active: boolean; onHover: () => void; onPick: () => void }): React.ReactElement {
  const icon = s.kind === 'search' ? <Icon name="search" size={15} className="shrink-0 text-aico-muted" />
    : s.kind === 'go' ? <Icon name="globe" size={15} className="shrink-0 text-aico-muted" />
      : <Favicon src={s.favicon} url={s.url} size={16} />;
  return (
    <button role="option" aria-selected={active} className="bx-suggest-row" onMouseEnter={onHover} onClick={onPick}>
      {icon}
      <span className="min-w-0 flex-1 truncate">
        {s.kind === 'search' && <><span className="text-aico-primary">{s.title}</span><span className="text-aico-muted"> — {SEARCH_NAME} Search</span></>}
        {s.kind === 'go' && <><span className="text-aico-primary">{displayUrl(s.url)}</span><span className="text-aico-muted"> — Go to address</span></>}
        {s.predicted && s.why && <><span className="text-aico-primary">{s.title}</span><span className="text-aico-muted"> — {s.why}</span></>}
        {!s.predicted && (s.kind === 'history' || s.kind === 'bookmark') && (
          <>
            <span className="text-aico-primary">{s.title}</span>
            {!isBlankUrl(s.url) && <span className="text-aico-muted"> — {displayUrl(s.url)}</span>}
          </>
        )}
      </span>
      {s.predicted && <span className="flex shrink-0 items-center gap-1 text-[11px] text-aico-accent" title={s.why}><Icon name="sparkles" size={12} />Predicted</span>}
      {!s.predicted && s.kind === 'bookmark' && <Icon name="star" size={13} className="shrink-0 text-aico-warning" style={{ fill: 'currentColor' }} />}
      {!s.predicted && s.kind === 'history' && <Icon name="history" size={13} className="shrink-0 text-aico-muted" />}
    </button>
  );
}
