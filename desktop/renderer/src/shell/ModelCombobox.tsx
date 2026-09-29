/**
 * A model field you can search.
 *
 * A provider serves hundreds of ids and nobody remembers them exactly, so a
 * bare text box turned choosing a default model into guessing a string. This
 * lists what the provider actually serves (asked once, remembered by the
 * engine), filters as you type, moves with the arrow keys, and marks what each
 * model can take in — the eye for images — and what cannot run the agent at
 * all. Typing an id that is not listed is still allowed: a catalogue can lag a
 * release, and the field should never refuse a correct answer.
 *
 * @module desktop/renderer/shell/ModelCombobox
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { useOverlay } from '@/lib/overlay';

export interface ModelOption {
  id: string;
  /** Input modalities, when known. */
  input?: string[];
  /** False for catalogue entries that cannot drive the agent (embeddings, TTS…). */
  chat?: boolean;
  known?: boolean;
}

export function ModelCombobox({ value, onChange, load, probe, placeholder, id }: {
  value: string;
  onChange: (v: string) => void;
  /** Fetches the options; called the first time the list opens (and on Refresh). */
  load: () => Promise<{ models: ModelOption[]; error?: string }>;
  /** Shows the chosen model a tiny picture to learn whether it reads images; the engine remembers the answer. */
  probe?: (model: string) => Promise<{ verdict: 'image' | 'text-only' | 'unknown'; reason: string }>;
  placeholder?: string;
  id?: string;
}): React.ReactElement {
  const [probing, setProbing] = useState(false);
  const [probed, setProbed] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ModelOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useOverlay(open);

  const fetchOptions = async (): Promise<void> => {
    setLoading(true); setError(null);
    try {
      const r = await load();
      setOptions(r.models);
      if (r.error) setError(r.error);
    } catch (e) { setError((e as Error).message); setOptions([]); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (open && options === null && !loading) void fetchOptions(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);

  // The filter is what was typed since opening; the value itself is the choice.
  const q = (query ?? '').trim().toLowerCase();
  const shown = useMemo(() => {
    const all = options ?? [];
    if (!q) return all.slice(0, 400);
    const starts: ModelOption[] = []; const has: ModelOption[] = [];
    for (const o of all) {
      const idl = o.id.toLowerCase();
      if (idl.startsWith(q) || idl.split(/[/:-]/).some(p => p.startsWith(q))) starts.push(o);
      else if (idl.includes(q) || q.split(/\s+/).every(w => idl.includes(w))) has.push(o);
    }
    return [...starts, ...has].slice(0, 400);
  }, [options, q]);
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const choose = (v: string): void => { onChange(v); setQuery(null); setOpen(false); };

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (!input.current?.parentElement?.parentElement?.contains(t)) { setOpen(false); setQuery(null); }
    };
    window.addEventListener('mousedown', down, true);
    return () => window.removeEventListener('mousedown', down, true);
  }, [open]);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); else setActive(i => Math.min(i + 1, Math.max(0, shown.length - 1))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && shown[active]) choose(shown[active]!.id);
      else if (query !== null) choose(query.trim());
    } else if (e.key === 'Escape') { if (open) { e.preventDefault(); e.stopPropagation(); setOpen(false); setQuery(null); } }
  };

  return (
    <div className="relative">
      <div className="relative">
        <input
          ref={input}
          id={id}
          className="input pr-16 font-mono"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          value={query ?? value}
          placeholder={placeholder}
          // Selected on focus, so typing searches instead of appending to the current id.
          onFocus={e => { setOpen(true); e.currentTarget.select(); }}
          onClick={() => setOpen(true)}
          onChange={e => { setQuery(e.target.value); onChange(e.target.value); setOpen(true); }}
          onKeyDown={onKey}
          spellCheck={false}
          autoComplete="off"
        />
        <div className="absolute inset-y-0 right-1.5 flex items-center gap-0.5">
          {value && <button type="button" className="icon-btn-sm h-6 w-6" onClick={() => { choose(''); input.current?.focus(); }} aria-label="Clear" title="Clear — use the provider's default"><Icon name="x" size={12} /></button>}
          <button type="button" className="icon-btn-sm h-6 w-6" onClick={() => { setOpen(o => !o); input.current?.focus(); }} aria-label="Show models"><Icon name="chevron-down" size={14} /></button>
        </div>
      </div>
      {open && (
        <div ref={list} role="listbox" className="menu absolute left-0 right-0 top-full z-40 mt-1 max-h-[300px] overflow-y-auto thin-scroll" onMouseDown={e => e.preventDefault()}>
          <div className="flex items-center gap-2 px-2.5 pb-1 pt-1 text-[11.5px] text-aico-muted">
            <span>{options === null ? 'Loading models…' : `${shown.length} of ${options.length} models`}</span>
            <span className="flex-1" />
            <button type="button" className="flex items-center gap-1 rounded px-1 hover:text-aico-primary" onClick={() => void fetchOptions()} disabled={loading}>
              {loading ? <span className="spinner h-3 w-3" /> : <Icon name="refresh" size={11} />} Refresh
            </button>
          </div>
          {error && <div className="px-2.5 py-1 text-[12px] text-aico-warning">{error}</div>}
          {probe && value && (
            <button type="button" className="menu-item text-[12.5px]" disabled={probing}
              onClick={async () => {
                setProbing(true); setProbed(null);
                try {
                  const r = await probe(value);
                  setProbed(r.verdict === 'image' ? `${value} reads images — remembered` : r.verdict === 'text-only' ? `${value} is text-only — remembered` : `Could not tell: ${r.reason}`);
                  if (r.verdict !== 'unknown') await fetchOptions();
                } catch (e) { setProbed(`Check failed: ${(e as Error).message}`); }
                finally { setProbing(false); }
              }}>
              {probing ? <span className="spinner h-3.5 w-3.5" /> : <Icon name="eye" size={14} className="text-aico-secondary" />}
              <span className="min-w-0 flex-1 truncate">{probed ?? `Check whether ${value} reads images`}</span>
              {!probed && <span className="text-[11px] text-aico-muted">one tiny request</span>}
            </button>
          )}
          {query && query.trim() && !shown.some(o => o.id === query.trim()) && (
            <button type="button" className="menu-item" onClick={() => choose(query.trim())}>
              <Icon name="edit" size={14} className="text-aico-secondary" /><span className="truncate">Use “{query.trim()}”</span>
            </button>
          )}
          {shown.map((o, i) => (
            <button type="button" key={o.id} data-i={i} role="option" aria-selected={i === active}
              className={cls('menu-item', i === active && 'bg-aico-hover', o.chat === false && 'opacity-60')}
              onMouseMove={() => setActive(i)} onClick={() => choose(o.id)}
              title={o.chat === false ? 'Listed by the provider, but cannot run the agent' : undefined}>
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{o.id}</span>
              {o.input?.includes('image') && <span title="Reads images" className="text-aico-accent"><Icon name="eye" size={13} /></span>}
              {o.input?.includes('audio') && <span title="Hears audio" className="text-aico-muted"><Icon name="mic" size={13} /></span>}
              {o.chat === false && <span className="text-[11px] text-aico-muted">not a chat model</span>}
              {o.id === value && <Icon name="check" size={14} className="text-aico-accent" />}
            </button>
          ))}
          {options !== null && shown.length === 0 && !query && <div className="px-3 py-2 text-[12.5px] text-aico-muted">No models listed — type an id.</div>}
        </div>
      )}
    </div>
  );
}
