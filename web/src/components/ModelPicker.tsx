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
  // Two values, and the difference between them is the whole point. `pinned` is
  // what this session chose for itself, null when it never chose; `fallback` is
  // the configured default. A session that never chose follows the default when
  // it moves in Settings, and a session that did chose does not — so the fact
  // that it is pinned has to be visible, or a settings change appears to do
  // nothing for a reason nobody can see.
  const pinned = useStore(s => s.model);
  const fallback = useStore(s => s.defaultModel);
  const model = pinned ?? fallback;
  const setModel = useStore(s => s.setModel);
  const providers = useStore(s => s.providers);
  const activeProvider = useStore(s => s.activeProvider);

  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [caps, setCaps] = useState<Record<string, ModelCapabilities>>({});
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
      setCaps(result.capabilities ?? {});
      if (result.error) setError(result.error);
    } catch (err) {
      setError((err as Error).message);
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // The catalogue belongs to the provider, so a different one invalidates it.
  useEffect(() => { setModels(null); setCaps({}); }, [activeProvider]);

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

  const choose = (next: string | null): void => {
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

              {pinned && (
                <button
                  role="option"
                  aria-selected={false}
                  onClick={() => choose(null)}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left
                             text-[12px] text-aico-secondary transition-colors
                             hover:bg-aico-hover hover:text-aico-primary"
                >
                  <span className="w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    Follow the default{fallback ? ` (${fallback})` : ''}
                  </span>
                </button>
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
                  <span className="min-w-0 flex-1 truncate">{entry}</span>
                  <ModalityBadges caps={caps[entry]} />
                </button>
              ))}
            </div>

            <div className="border-t border-aico-border-subtle px-3 py-2 text-[11px] leading-relaxed text-aico-muted">
              {pinned
                ? 'Pinned to this chat, so changing the default in Settings will not move it.'
                : 'Following the default from Settings. Choosing here pins this chat.'}
              {' '}Badges say what a model accepts beyond text; unbadged means text only,
              {' '}and a red one is not a chat model.
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}

/** What a model takes beyond text, or nothing when the answer is "just text". */
interface ModelCapabilities {
  input: string[];
  output: string[];
  chat: boolean;
  known: boolean;
}

/**
 * The extra modalities, as initials.
 *
 * Text is left out on purpose. Every model here takes text, so a badge saying
 * so would appear on all two hundred rows and distinguish none of them — the
 * only informative thing about a text-only model is the *absence* of a badge.
 *
 * A model nothing describes gets a dim mark instead of being left blank, so
 * "we have not been told" does not read as "it cannot". They call for
 * different actions: one means pick another model, the other means say what
 * this one does.
 */
function ModalityBadges({ caps }: { caps?: ModelCapabilities }): React.ReactElement | null {
  if (!caps) return null;
  // Said first, because it is the only badge that changes whether to pick the
  // row at all. An image generator listed beside the chat models is not a
  // worse model, it is the wrong kind of thing, and finding that out from a
  // failed run is finding out too late.
  if (!caps.chat) {
    return (
      <span title={`Not a chat model — produces ${caps.output.join(', ')}. `
        + 'The agent needs a model that takes and returns text.'}
            className="shrink-0 rounded bg-aico-danger/15 px-1 text-[9px] uppercase text-aico-danger">
        {/*
          What makes it not a chat model, in one word. Usually that is what it
          emits — an image, a video. For transcription it is the opposite end:
          the output is text, and the reason it cannot be talked to is that the
          input is audio. Falling back to the input side keeps that row from
          reading "n/a", which explains nothing.
        */}
        {caps.output.find(m => m !== 'text')
          ?? caps.input.find(m => m !== 'text')
          ?? 'n/a'}
      </span>
    );
  }
  if (!caps.known) {
    return (
      <span title="Nothing describes this model, so it is treated as text-only"
            className="shrink-0 text-[10px] text-aico-muted opacity-50">?</span>
    );
  }
  const extra = caps.input.filter(m => m !== 'text');
  if (extra.length === 0) return null;
  return (
    <span title={`Accepts ${caps.input.join(', ')}`}
          className="flex shrink-0 gap-0.5">
      {extra.map(m => (
        <span key={m}
              className="rounded bg-aico-accent-soft px-1 text-[9px] uppercase text-aico-accent">
          {m[0]}
        </span>
      ))}
    </span>
  );
}
