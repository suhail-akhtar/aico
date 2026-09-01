/**
 * Which model this session runs on.
 *
 * A deliberately smaller thing than the browser client's picker: no capability
 * badges, no provider grouping, no positioned popover. A side bar is 300px wide,
 * and a menu that needs its own layout logic to fit is a menu that will one day
 * open off-screen.
 *
 * The list is fetched on first open rather than at boot. Enumerating models is a
 * network round trip to the provider, and a panel that made it on every window
 * open would spend it for every person who never changes model — which is most
 * of them, most days.
 *
 * @module components/ModelMenu
 */

import React, { useEffect, useRef, useState } from 'react';
import { api } from '@web/api';
import { useStore } from '@web/store';

export function ModelMenu(): React.ReactElement {
  const pinned = useStore(s => s.model);
  const fallback = useStore(s => s.defaultModel);
  const setModel = useStore(s => s.setModel);

  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const box = useRef<HTMLDivElement>(null);

  const current = pinned ?? fallback;

  useEffect(() => {
    if (!open || models !== null) return;
    let cancelled = false;
    void api.providerModels()
      .then(result => {
        if (cancelled) return;
        setModels(result.models);
        if (result.error) setError(result.error);
      })
      .catch((err: Error) => { if (!cancelled) { setModels([]); setError(err.message); } });
    return () => { cancelled = true; };
  }, [open, models]);

  // Close on an outside click or Escape. A popover in a webview cannot rely on
  // the workbench dismissing it, because the workbench cannot see it.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const needle = filter.trim().toLowerCase();
  const shown = (models ?? []).filter(m => !needle || m.toLowerCase().includes(needle));

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        title={current ? `Model: ${current}` : 'Choose a model'}
        className="max-w-[130px] truncate rounded px-1.5 py-0.5 text-[11px] text-aico-secondary hover:bg-aico-hover hover:text-aico-primary"
      >
        {current ?? 'Model'}
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-10 mb-1 flex max-h-[240px] w-[240px] flex-col rounded border border-aico-border bg-aico-elevated shadow-lg">
          <input
            autoFocus
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder={models?.length ? `Filter ${models.length} models` : 'Loading…'}
            className="shrink-0 border-b border-aico-border-subtle bg-transparent px-2 py-1.5 text-[11px] text-aico-primary placeholder:text-aico-muted focus:outline-none"
          />

          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {models === null && (
              <p className="px-2 py-1 text-[11px] text-aico-muted">Asking the provider…</p>
            )}

            {/*
              An error and a list are not exclusive. A provider can answer with
              some models and a warning about the ones it could not reach, and
              hiding the list because of the warning would be worse than useless.
            */}
            {error && (
              <p className="px-2 py-1 text-[11px] leading-relaxed text-aico-warning">{error}</p>
            )}

            {models !== null && shown.length === 0 && !error && (
              <p className="px-2 py-1 text-[11px] text-aico-muted">
                {models.length === 0 ? 'No models configured.' : 'Nothing matches.'}
              </p>
            )}

            {shown.map(model => (
              <button
                key={model}
                type="button"
                onClick={() => { setModel(model); setOpen(false); setFilter(''); }}
                className={[
                  'block w-full truncate px-2 py-1 text-left text-[11px] hover:bg-aico-hover',
                  model === current ? 'text-aico-accent' : 'text-aico-primary',
                ].join(' ')}
              >
                {model}
              </button>
            ))}
          </div>

          {pinned && (
            <button
              type="button"
              onClick={() => { setModel(null); setOpen(false); }}
              title="Follow the configured default instead of a fixed choice"
              className="shrink-0 border-t border-aico-border-subtle px-2 py-1 text-left text-[11px] text-aico-muted hover:text-aico-primary"
            >
              Use the default{fallback ? ` (${fallback})` : ''}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
