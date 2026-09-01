/**
 * Which model this session runs on, and which provider it comes from.
 *
 * Two lists behind one control, because they answer two different questions and
 * a side bar has room for one popover. **Models** pins this conversation.
 * **Providers** changes the default every unpinned conversation follows. They
 * are deliberately not the same act, and conflating them is a real bug the
 * browser client already had once — a settings change that silently did nothing
 * because the open session had been pinned behind the reader's back.
 *
 * ## What is here and what is on the wide surface
 *
 * *Switching* provider is a routine choice and belongs where the work is.
 * *Adding* one means a base URL, a model list and an API key — a form, and a
 * secret being pasted, neither of which a 300px column does well. So this menu
 * switches and the portal configures, with a route from one to the other so the
 * dead end ("No models configured") is never the last thing on screen.
 *
 * The list is fetched on first open rather than at boot. Enumerating models is a
 * network round trip to the provider, and a panel that made it on every window
 * open would spend it for everyone who never changes model — which is most
 * people, most days.
 *
 * @module components/ModelMenu
 */

import React, { useEffect, useRef, useState } from 'react';
import { api, type ProviderInstance } from '@web/api';
import { useStore } from '@web/store';
import { host } from '../host';

export function ModelMenu(): React.ReactElement {
  const pinned = useStore(s => s.model);
  const fallback = useStore(s => s.defaultModel);
  const setModel = useStore(s => s.setModel);
  const providers = useStore(s => s.providers);
  const activeProvider = useStore(s => s.activeProvider);
  const refreshProviders = useStore(s => s.refreshProviders);

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'models' | 'providers'>('models');
  const [models, setModels] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [switching, setSwitching] = useState<string | null>(null);
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
  const usable = providers.filter(p => p.enabled !== false);

  /**
   * Make a provider the default.
   *
   * Sets the default deliberately, and does *not* pin the open conversation —
   * the same separation the settings screen makes. Afterwards the model list is
   * dropped so the next open re-enumerates against the provider now in charge,
   * rather than offering the previous one's catalogue.
   */
  const activate = async (instance: ProviderInstance): Promise<void> => {
    if (switching) return;
    setSwitching(instance.id);
    try {
      await api.activateProvider(instance.id, instance.defaultModel);
      await refreshProviders();
      setModels(null);
      setError(null);
      setTab('models');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSwitching(null);
    }
  };

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
        <div className="absolute bottom-full left-0 z-10 mb-1 flex max-h-[280px] w-[248px] flex-col rounded border border-aico-border bg-aico-elevated shadow-lg">
          <div className="flex shrink-0 border-b border-aico-border-subtle">
            <Tab label="Models" on={tab === 'models'} onPick={() => setTab('models')} />
            <Tab
              label={`Providers${usable.length ? ` (${usable.length})` : ''}`}
              on={tab === 'providers'}
              onPick={() => setTab('providers')}
            />
          </div>

          {tab === 'models' ? (
            <>
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
                  An error and a list are not exclusive. A provider can answer
                  with some models and a warning about the ones it could not
                  reach, and hiding the list because of the warning would be
                  worse than useless.
                */}
                {error && (
                  <p className="px-2 py-1 text-[11px] leading-relaxed text-aico-warning">{error}</p>
                )}

                {models !== null && shown.length === 0 && !error && (
                  <div className="px-2 py-1">
                    <p className="text-[11px] text-aico-muted">
                      {models.length === 0 ? 'No models configured.' : 'Nothing matches.'}
                    </p>
                    {/*
                      The one state that used to be a dead end. Somebody who has
                      just installed the extension sees exactly this, and telling
                      them what is wrong without offering the way out is how a
                      first run ends.
                    */}
                    {models.length === 0 && (
                      <button
                        type="button"
                        onClick={() => { setOpen(false); host.openSettings(); }}
                        className="mt-0.5 text-[11px] text-aico-accent underline-offset-2 hover:underline"
                      >
                        Add a provider…
                      </button>
                    )}
                  </div>
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
            </>
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto py-1">
                {usable.length === 0 && (
                  <p className="px-2 py-1 text-[11px] leading-relaxed text-aico-muted">
                    Nothing configured yet. aico needs one provider — a key, or a
                    local Ollama.
                  </p>
                )}

                {usable.map(instance => {
                  const active = instance.id === activeProvider;
                  /*
                    A provider with no key cannot be switched to, and saying so
                    here beats letting the switch appear to work and fail on the
                    next message with an authentication error.
                  */
                  const keyless = instance.keySource === 'none';
                  return (
                    <button
                      key={instance.id}
                      type="button"
                      disabled={switching !== null}
                      onClick={() => {
                        if (keyless) { setOpen(false); host.openSettings(); return; }
                        void activate(instance);
                      }}
                      className="block w-full px-2 py-1 text-left hover:bg-aico-hover disabled:opacity-50"
                    >
                      <span className="flex items-baseline gap-1.5">
                        <span className={`text-[9px] ${active ? 'text-aico-accent' : 'text-aico-muted'}`}>
                          {active ? '●' : '○'}
                        </span>
                        <span className={`min-w-0 flex-1 truncate text-[11px] ${
                          active ? 'text-aico-accent' : 'text-aico-primary'
                        }`}>
                          {instance.name}
                        </span>
                        {switching === instance.id && (
                          <span className="text-[9px] text-aico-muted">switching…</span>
                        )}
                        {keyless && switching !== instance.id && (
                          <span className="text-[9px] text-aico-warning">needs a key</span>
                        )}
                      </span>
                      {instance.defaultModel && (
                        <span className="block truncate pl-3 text-[10px] leading-[14px] text-aico-muted">
                          {instance.defaultModel}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              <p className="shrink-0 border-t border-aico-border-subtle px-2 py-1 text-[10px] leading-snug text-aico-muted">
                Switching sets the default for conversations that have not chosen
                a model. This one keeps {pinned ? 'its own' : 'following it'}.
              </p>
              <button
                type="button"
                onClick={() => { setOpen(false); host.openSettings(); }}
                className="shrink-0 border-t border-aico-border-subtle px-2 py-1 text-left text-[11px] text-aico-secondary hover:bg-aico-hover hover:text-aico-primary"
              >
                Keys, endpoints and models…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Tab({ label, on, onPick }: {
  label: string; on: boolean; onPick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={on}
      className={[
        'flex-1 px-2 py-1 text-[11px]',
        on
          ? 'border-b border-aico-accent text-aico-primary'
          : 'text-aico-muted hover:text-aico-primary',
      ].join(' ')}
    >
      {label}
    </button>
  );
}
