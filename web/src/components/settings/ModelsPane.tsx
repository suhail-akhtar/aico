/**
 * The providers you have, and which one runs your turns.
 *
 * A list of *your* providers, not a fixed roster of vendors. You add them, name
 * them, point them wherever you like, and delete them. Two accounts with the
 * same vendor are two rows; a gateway nobody has heard of is a row; a local
 * server is a row.
 *
 * Rows derived from environment variables or older settings are shown too, and
 * marked as such, because hiding a provider that is demonstrably in use would
 * make the screen disagree with the running system. Editing one turns it into
 * an ordinary saved provider.
 *
 * Keys are write-only throughout. The server never returns one — only whether a
 * provider has one and where it came from — so no field on this screen can ever
 * be populated with a secret.
 *
 * The row is a *statement of state*: name, where its key comes from, whether it
 * answered when last asked, and whether turns run on it. Everything else is
 * behind Edit, because a screen that shows the endpoint, the model list and the
 * key provenance of eight providers at once is a screen nobody reads.
 *
 * @module components/settings/ModelsPane
 */

import React, { useState } from 'react';
import { api, type ProviderInstance, type ProviderTestResult } from '../../api';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { ModelChooser, ProviderEditor, TestResult } from './ProviderEditor';

type TestMap = Record<string, ProviderTestResult & { running?: boolean }>;

export function ModelsPane(): React.ReactElement {
  const providers = useStore(s => s.providers);
  const providerTypes = useStore(s => s.providerTypes);
  const activeProvider = useStore(s => s.activeProvider);
  const model = useStore(s => s.model);
  const refreshProviders = useStore(s => s.refreshProviders);
  const setModel = useStore(s => s.setModel);

  /** Which row is expanded: an id, `'new'`, or nothing. */
  const [editing, setEditing] = useState<string | null>(null);
  const [tests, setTests] = useState<TestMap>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const test = async (id: string): Promise<void> => {
    setTests(t => ({ ...t, [id]: { ok: false, running: true } }));
    try {
      const result = await api.testProvider(id);
      setTests(t => ({ ...t, [id]: { ...result, running: false } }));
    } catch (err) {
      setTests(t => ({ ...t, [id]: { ok: false, error: (err as Error).message, running: false } }));
    }
  };

  const activate = async (instance: ProviderInstance, chosen?: string): Promise<void> => {
    const next = chosen ?? instance.defaultModel;
    await api.activateProvider(instance.id, next);
    if (next) setModel(next);
    await refreshProviders();
  };

  const remove = async (id: string): Promise<void> => {
    await api.deleteProvider(id);
    setConfirmDelete(null);
    if (editing === id) setEditing(null);
    await refreshProviders();
  };

  const activeInstance = providers.find(p => p.id === activeProvider);

  return (
    <div>
      {/* What is actually in effect, stated once at the top. Everything below
          is a way of changing this line. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-aico-border-subtle
                      bg-aico-surface px-4 py-3">
        <Icon name="bolt" size={15} className="text-aico-accent" />
        <span className="text-[13px] text-aico-secondary">Turns run on</span>
        <span className="text-[13px] font-medium text-aico-primary">
          {activeInstance?.name ?? (activeProvider ?? 'the first usable provider')}
        </span>
        {(model ?? activeInstance?.defaultModel) && (
          <span className="rounded-full bg-aico-elevated px-2 py-0.5 font-mono text-[11px] text-aico-secondary">
            {model ?? activeInstance?.defaultModel}
          </span>
        )}
      </div>

      <div className="mt-4 space-y-2">
        {providers.length === 0 && editing !== 'new' && (
          <div className="rounded-xl border border-dashed border-aico-border px-4 py-10 text-center">
            <p className="text-[13px] text-aico-secondary">No providers configured yet.</p>
            <button
              onClick={() => setEditing('new')}
              className="mt-3 rounded-full bg-aico-accent px-4 py-1.5 text-[12px] font-medium text-aico-on-accent
                         transition-colors hover:bg-aico-accent-hover"
            >
              Add your first one
            </button>
          </div>
        )}

        {providers.map(provider => {
          const state = tests[provider.id];
          const isActive = activeProvider === provider.id;
          const typeInfo = providerTypes.find(t => t.type === provider.type);
          const open = editing === provider.id;

          return (
            <section
              key={provider.id}
              className={`rounded-xl border transition-colors ${
                isActive ? 'border-aico-accent/50 bg-aico-accent-soft/40' : 'border-aico-border-subtle'
              }`}
            >
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-3">
                <HealthDot provider={provider} state={state} />
                <span className="text-[14px] font-medium text-aico-primary">{provider.name}</span>
                {/* Only when it adds something. Most providers are named after
                    their vendor, and "DeepSeek DeepSeek" is noise. */}
                {(typeInfo?.label ?? provider.type) !== provider.name && (
                  <span className="font-mono text-[11px] text-aico-muted">
                    {typeInfo?.label ?? provider.type}
                  </span>
                )}
                {isActive && (
                  <span className="rounded-full bg-aico-accent px-2 py-0.5 text-[10px] font-medium text-aico-on-accent">
                    active
                  </span>
                )}
                {provider.derived && (
                  <span
                    className="rounded-full bg-aico-info/15 px-2 py-0.5 text-[10px] text-aico-info"
                    title="Detected from your environment or older settings. Edit it to save it here."
                  >
                    detected
                  </span>
                )}

                <div className="flex-1" />

                <button
                  onClick={() => void test(provider.id)}
                  disabled={state?.running}
                  className="rounded-full px-2.5 py-1 text-[12px] text-aico-secondary transition-colors
                             hover:bg-aico-hover hover:text-aico-primary disabled:opacity-40"
                >
                  {state?.running ? 'Testing…' : 'Test'}
                </button>
                {!isActive && provider.keySource !== 'none' && (
                  <button
                    onClick={() => void activate(provider)}
                    className="rounded-full px-2.5 py-1 text-[12px] text-aico-secondary transition-colors
                               hover:bg-aico-hover hover:text-aico-primary"
                  >
                    Use this
                  </button>
                )}
                <button
                  onClick={() => setEditing(open ? null : provider.id)}
                  className="rounded-full border border-aico-border-subtle px-3 py-1 text-[12px]
                             text-aico-secondary transition-colors hover:bg-aico-hover hover:text-aico-primary"
                >
                  {open ? 'Close' : 'Edit'}
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pb-3 text-[11px] text-aico-muted">
                <KeyNote provider={provider} envVar={typeInfo?.envVar} />
                <span aria-hidden>·</span>
                <span className="font-mono">
                  {provider.baseUrl || typeInfo?.defaultBaseUrl || 'provider default'}
                </span>
                {provider.defaultModel && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="font-mono">{provider.defaultModel}</span>
                  </>
                )}
              </div>

              {state && !state.running && (
                <div className="px-4 pb-3">
                  <TestResult
                    ok={state.ok}
                    message={state.error ?? (state.models?.length
                      ? `Connected — ${state.models.length} models available`
                      : 'Connected, but this key has no models')}
                    {...(state.latencyMs !== undefined ? { latencyMs: state.latencyMs } : {})}
                  />
                  {state.ok && state.models && state.models.length > 0 && (
                    <div className="mt-2">
                      <div className="mb-1 text-[11px] text-aico-muted">
                        Pick the model this provider runs by default
                      </div>
                      <ModelChooser
                        models={state.models}
                        value={(isActive ? model ?? undefined : provider.defaultModel) ?? ''}
                        onPick={m => void activate(provider, m)}
                      />
                    </div>
                  )}
                </div>
              )}

              {open && (
                <div className="border-t border-aico-border-subtle p-4">
                  <ProviderEditor
                    types={providerTypes}
                    editing={provider}
                    takenIds={providers.map(p => p.id)}
                    onClose={() => setEditing(null)}
                    onSaved={() => void refreshProviders()}
                  />
                  <div className="mt-3 flex items-center gap-2">
                    {confirmDelete === provider.id ? (
                      <>
                        <span className="text-[12px] text-aico-danger">Remove {provider.name}?</span>
                        <button
                          onClick={() => void remove(provider.id)}
                          className="rounded-full bg-aico-danger/15 px-3 py-1 text-[12px] text-aico-danger
                                     transition-colors hover:bg-aico-danger/25"
                        >
                          Remove
                        </button>
                        <button
                          onClick={() => setConfirmDelete(null)}
                          className="rounded-full px-3 py-1 text-[12px] text-aico-muted hover:text-aico-primary"
                        >
                          Keep
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(provider.id)}
                        className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[12px]
                                   text-aico-muted transition-colors hover:text-aico-danger"
                      >
                        <Icon name="trash" size={13} /> Remove this provider
                      </button>
                    )}
                  </div>
                </div>
              )}
            </section>
          );
        })}

        {editing === 'new' && (
          <ProviderEditor
            types={providerTypes}
            takenIds={providers.map(p => p.id)}
            onClose={() => setEditing(null)}
            onSaved={() => void refreshProviders()}
          />
        )}
      </div>

      {editing !== 'new' && providers.length > 0 && (
        <button
          onClick={() => setEditing('new')}
          className="mt-3 flex items-center gap-1.5 rounded-full border border-aico-border-subtle px-3.5 py-1.5
                     text-[12px] text-aico-secondary transition-colors hover:bg-aico-hover hover:text-aico-primary"
        >
          <Icon name="plus" size={13} /> Add provider
        </button>
      )}
    </div>
  );
}

/**
 * Whether this provider is likely to work, in one dot.
 *
 * Three states, and the middle one is the honest default: green once it has
 * answered a real request, red once it has failed one, and hollow until it has
 * been asked. Showing "healthy" for a provider nobody has tested would be a
 * guess dressed as a fact — a key can be present, well-formed and revoked.
 */
function HealthDot(
  { provider, state }: { provider: ProviderInstance; state?: ProviderTestResult & { running?: boolean } },
): React.ReactElement {
  if (state?.running) {
    return <span className="aico-thinking text-[10px] text-aico-accent" title="Testing…">●</span>;
  }
  if (state) {
    return state.ok
      ? <span className="text-[10px] text-aico-success" title="Answered when last tested">●</span>
      : <span className="text-[10px] text-aico-danger" title={state.error ?? 'Failed when last tested'}>●</span>;
  }
  const usable = provider.keySource && provider.keySource !== 'none';
  return (
    <span
      className={`text-[10px] ${usable ? 'text-aico-muted' : 'text-aico-warning'}`}
      title={usable ? 'Configured, not yet tested' : 'No key configured'}
    >
      ○
    </span>
  );
}

function KeyNote(
  { provider, envVar }: { provider: ProviderInstance; envVar?: string },
): React.ReactElement {
  switch (provider.keySource) {
    case 'settings': return <span>key saved here</span>;
    case 'environment': return <span>key from {envVar ?? 'the environment'}</span>;
    case 'not-required': return <span>no key needed</span>;
    default: return (
      <span className="text-aico-warning">
        no key{envVar ? ` — set ${envVar} or add one` : ''}
      </span>
    );
  }
}
