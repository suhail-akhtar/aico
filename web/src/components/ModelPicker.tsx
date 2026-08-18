/**
 * Choosing the model for this session, from the composer.
 *
 * It lives next to the send button because that is where the decision is made.
 * A model choice buried in a settings screen is one you make once and then
 * forget you made — and the cost of being wrong is paid on every turn after.
 *
 * Three things it does that a `<select>` cannot:
 *
 * **It is searchable.** Real catalogues are two hundred entries of
 * `vendor/family-version-variant`, and the question people arrive with is
 * "which one is the cheap fast one" — a substring away, and not answerable by
 * scrolling.
 *
 * **It fetches on open, not on mount.** The list is the provider's, and asking
 * for it costs a network call. Every page load paying for a menu most sessions
 * never open is the wrong trade; the first open pays, and the answer is
 * remembered from then on.
 *
 * **It says what is happening.** "Reading the catalogue…", "this provider
 * returned none", and the failure — because a menu that opens empty and silent
 * is indistinguishable from one that is broken.
 *
 * @module components/ModelPicker
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { Portal } from './Portal';
import { Icon } from './Icon';

export function ModelPicker(): React.ReactElement {
  const model = useStore(s => s.model);
  const setModel = useStore(s => s.setModel);
  const providers = useStore(s => s.providers);
  const activeProvider = useStore(s => s.activeProvider);

  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [at, setAt] = useState({ bottom: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);

  const provider = providers.find(p => p.id === activeProvider) ?? providers[0];

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.providerModels();
      setModels(result.models);
      if (result.error) setError(result.error);
    } catch (err) {
      setError((err as Error).message);
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // The catalogue belongs to the provider, so a different one invalidates it.
  useEffect(() => { setModels(null); }, [activeProvider]);

  useEffect(() => {
    if (!open) return;
    if (models === null) void load();

    const box = buttonRef.current?.getBoundingClientRect();
    if (box) {
      // Opens *upward*: the composer sits at the bottom of the window, so a
      // menu dropping down would be mostly off-screen.
      setAt({ bottom: window.innerHeight - box.top + 6, left: Math.min(box.left, window.innerWidth - 340) });
    }

    const dismiss = (event: MouseEvent): void => {
      if (buttonRef.current?.contains(event.target as Node)) return;
      if ((event.target as HTMLElement).closest('[data-model-picker]')) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', dismiss, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', dismiss, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, models, load]);

  const needle = filter.trim().toLowerCase();
  const shown = (models ?? []).filter(m => !needle || m.toLowerCase().includes(needle));

  const choose = (next: string): void => {
    setModel(next);
    setOpen(false);
    setFilter('');
  };

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => setOpen(v => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Model for this session"
        title={provider ? `${provider.name} · ${model ?? 'provider default'}` : model ?? ''}
        className="flex max-w-[220px] items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px]
                   text-aico-muted transition-colors hover:bg-aico-hover hover:text-aico-primary"
      >
        <span className="min-w-0 truncate">{model ?? 'default model'}</span>
        <Icon name="chevron-down" size={13} />
      </button>

      {open && (
        <Portal>
          <div
            data-model-picker
            style={{ bottom: at.bottom, left: at.left }}
            className="fixed z-50 w-[330px] overflow-hidden rounded-xl border border-aico-border
                       bg-aico-bg shadow-2xl"
          >
            <div className="flex items-center gap-2 border-b border-aico-border-subtle px-3 py-2">
              <Icon name="search" size={15} className="text-aico-muted" />
              <input
                value={filter}
                onChange={e => setFilter(e.target.value)}
                autoFocus
                placeholder={models?.length ? `Filter ${models.length} models` : 'Filter models'}
                onKeyDown={e => {
                  if (e.key === 'Enter' && shown[0]) choose(shown[0]);
                  if (e.key === 'Escape') setOpen(false);
                }}
                className="w-full min-w-0 bg-transparent text-[13px] text-aico-primary
                           placeholder:text-aico-muted focus:outline-none"
              />
              <button
                onClick={() => void load()}
                title="Ask the provider again"
                aria-label="Refresh model list"
                className="shrink-0 rounded p-1 text-aico-muted hover:text-aico-primary"
              >
                <Icon name="undo" size={14} />
              </button>
            </div>

            {provider && (
              <div className="border-b border-aico-border-subtle px-3 py-1.5 text-[11px] text-aico-muted">
                from <span className="text-aico-secondary">{provider.name}</span>
              </div>
            )}

            <div className="max-h-[46vh] overflow-y-auto p-1">
              {loading && <p className="px-3 py-3 text-[12px] text-aico-muted">Reading the catalogue…</p>}

              {!loading && error && (
                <p className="px-3 py-3 text-[12px] text-aico-danger">{error}</p>
              )}

              {!loading && !error && models?.length === 0 && (
                <p className="px-3 py-3 text-[12px] leading-relaxed text-aico-muted">
                  This provider returned no catalogue. You can still type a model id in
                  Settings → Models; unlisted ids are sent as given.
                </p>
              )}

              {!loading && shown.length === 0 && (models?.length ?? 0) > 0 && (
                <p className="px-3 py-3 text-[12px] text-aico-muted">Nothing matches that.</p>
              )}

              {shown.map(entry => (
                <button
                  key={entry}
                  role="option"
                  aria-selected={entry === model}
                  onClick={() => choose(entry)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left
                              font-mono text-[12px] transition-colors ${entry === model
                                ? 'bg-aico-accent-soft text-aico-accent'
                                : 'text-aico-secondary hover:bg-aico-hover hover:text-aico-primary'}`}
                >
                  <span className="w-4 shrink-0">
                    {entry === model && <Icon name="check" size={14} />}
                  </span>
                  <span className="min-w-0 truncate">{entry}</span>
                </button>
              ))}
            </div>

            <div className="border-t border-aico-border-subtle px-3 py-2 text-[11px] leading-relaxed text-aico-muted">
              Applies to this session from your next message.
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}
