/**
 * Settings.
 *
 * A dialog rather than a destination. Settings are almost always opened *in
 * order to change something about the run you are looking at* — which model,
 * how much it may spend, whether it may write outside the workspace — and a
 * full-page route throws that context away and makes coming back an act of
 * navigation. Here the transcript stays behind the sheet, and Escape puts you
 * back exactly where you were.
 *
 * Three things this screen does that a settings screen usually does not:
 *
 *   - **It is searchable.** Five panes hide things. Typing matches labels,
 *     explanations, keys and synonyms across every pane at once and shows the
 *     matching rows together, each tagged with where it lives. Nobody has to
 *     guess whether "compaction" is under Context or under Agent.
 *   - **It says what you changed.** Every row knows what the engine does when
 *     the setting is unset, so the rail can carry a count per pane and each row
 *     can offer to put itself back. Settings screens are usually write-only in
 *     this respect: they will happily show you a value and never tell you it is
 *     not the default.
 *   - **It writes immediately.** No Save button, because a Save button on a
 *     preferences screen is a trap — you change three things, close the sheet,
 *     and find out later that none of them took. Each change is a request; the
 *     header says when the last one landed.
 *
 * @module components/settings/SettingsModal
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { useStore } from '../../store';
import {
  PANES, changedPaths, patchFor, readPath, searchFields,
  type Pane,
} from '../../settings-schema';
import { Icon } from '../Icon';
import { Field } from './Field';
import { ModelsPane } from './ModelsPane';

export interface SettingsModalProps {
  onClose: () => void;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

export function SettingsModal({ onClose }: SettingsModalProps): React.ReactElement {
  const settings = useStore(s => s.settings);
  const refreshSettings = useStore(s => s.refreshSettings);
  const refreshProviders = useStore(s => s.refreshProviders);

  const [paneId, setPaneId] = useState(PANES[0]!.id);
  const [query, setQuery] = useState('');
  const [save, setSave] = useState<SaveState>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void refreshSettings();
    void refreshProviders();
  }, [refreshSettings, refreshProviders]);

  // Escape closes; ⌘/Ctrl-F puts the cursor in the filter rather than opening
  // the browser's own find, which would search a sheet that mostly is not here.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { onClose(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const changed = useMemo(() => new Set(changedPaths(settings)), [settings]);
  const hits = useMemo(() => searchFields(query), [query]);
  const pane = PANES.find(p => p.id === paneId) ?? PANES[0]!;

  const write = async (path: string, value: unknown): Promise<void> => {
    setSave('saving');
    setFailure(null);
    try {
      await api.saveSettings(patchFor(settings, path, value));
      await refreshSettings();
      setSave('saved');
    } catch (err) {
      setSave('failed');
      setFailure((err as Error).message);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-0 sm:p-6"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <div
        onMouseDown={e => e.stopPropagation()}
        className="flex h-full w-full max-w-4xl flex-col overflow-hidden bg-aico-bg shadow-2xl
                   sm:h-[min(46rem,92vh)] sm:rounded-2xl sm:border sm:border-aico-border"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-aico-border-subtle px-5 py-3.5">
          <h2 className="text-[17px] font-semibold tracking-tight text-aico-primary">Settings</h2>

          <div className="ml-2 flex min-w-0 flex-1 items-center gap-2 rounded-full border
                          border-aico-border-subtle bg-aico-surface px-3 py-1.5
                          transition-colors focus-within:border-aico-accent/60">
            <Icon name="search" size={14} className="text-aico-muted" />
            <input
              ref={searchRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search every setting"
              className="w-full min-w-0 bg-transparent text-[13px] text-aico-primary
                         placeholder:text-aico-muted focus:outline-none"
            />
            {query && (
              <button onClick={() => setQuery('')} className="text-aico-muted hover:text-aico-primary" aria-label="Clear search">
                <Icon name="close" size={13} />
              </button>
            )}
          </div>

          <SaveBadge state={save} />

          <button
            onClick={onClose}
            aria-label="Close settings"
            className="rounded-full p-1.5 text-aico-muted transition-colors hover:bg-aico-hover hover:text-aico-primary"
          >
            <Icon name="close" size={16} />
          </button>
        </header>

        {failure && (
          <div className="shrink-0 border-b border-aico-danger/30 bg-aico-danger/10 px-5 py-2 text-[12px] text-aico-danger">
            {failure}
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          {!query && (
            <nav className="hidden w-48 shrink-0 overflow-y-auto border-r border-aico-border-subtle p-2 sm:block">
              {PANES.map(entry => (
                <RailButton
                  key={entry.id}
                  pane={entry}
                  active={entry.id === pane.id}
                  count={countFor(entry, changed)}
                  onClick={() => setPaneId(entry.id)}
                />
              ))}
            </nav>
          )}

          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7">
            {query ? (
              <SearchResults
                hits={hits}
                query={query}
                settings={settings}
                changed={changed}
                onChange={write}
              />
            ) : (
              <>
                {/* On a phone the rail is gone, so the panes become a scrolling
                    row of chips — the same choice, in the space available. */}
                <div className="-mx-1 mb-4 flex gap-1 overflow-x-auto pb-1 sm:hidden">
                  {PANES.map(entry => (
                    <button
                      key={entry.id}
                      onClick={() => setPaneId(entry.id)}
                      className={`shrink-0 rounded-full px-3 py-1.5 text-[13px] transition-colors ${
                        entry.id === pane.id
                          ? 'bg-aico-elevated text-aico-primary'
                          : 'text-aico-secondary hover:bg-aico-hover'
                      }`}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>

                <h3 className="text-[19px] font-semibold tracking-tight text-aico-primary">{pane.label}</h3>
                {pane.blurb && (
                  <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-aico-secondary">{pane.blurb}</p>
                )}

                <div className="mt-5">
                  {pane.custom === 'models' ? <ModelsPane /> : (
                    pane.groups.map(group => (
                      <section key={group.title} className="mb-7 last:mb-0">
                        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-aico-muted">
                          {group.title}
                        </h4>
                        {group.hint && (
                          <p className="mt-1 max-w-xl text-[12px] leading-relaxed text-aico-secondary">
                            {group.hint}
                          </p>
                        )}
                        <div className="mt-1">
                          {group.fields.map(field => (
                            <Field
                              key={field.path}
                              spec={field}
                              value={readPath(settings, field.path)}
                              changed={changed.has(field.path)}
                              onChange={value => void write(field.path, value)}
                            />
                          ))}
                        </div>
                      </section>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-aico-border-subtle px-5 py-2.5
                           text-[11px] text-aico-muted">
          <span>Saved to ~/.aico/settings.json</span>
          <div className="flex-1" />
          {changed.size > 0 && (
            <span>{changed.size} setting{changed.size === 1 ? '' : 's'} differ from the defaults</span>
          )}
        </footer>
      </div>
    </div>
  );
}

function SearchResults(
  { hits, query, settings, changed, onChange }: {
    hits: ReturnType<typeof searchFields>;
    query: string;
    settings: Record<string, unknown>;
    changed: Set<string>;
    onChange: (path: string, value: unknown) => void;
  },
): React.ReactElement {
  const modelsMatch = 'models providers api key endpoint vendor'.includes(query.trim().toLowerCase());

  if (hits.length === 0 && !modelsMatch) {
    return (
      <div className="py-16 text-center">
        <p className="text-[14px] text-aico-secondary">Nothing matches “{query}”.</p>
        <p className="mt-1 text-[12px] text-aico-muted">
          API keys and endpoints live under Models, and are not searchable.
        </p>
      </div>
    );
  }

  return (
    <div>
      <p className="mb-3 text-[12px] text-aico-muted">
        {hits.length} setting{hits.length === 1 ? '' : 's'} matching “{query}”
      </p>
      {hits.map(hit => (
        <Field
          key={hit.field.path}
          spec={hit.field}
          value={readPath(settings, hit.field.path)}
          changed={changed.has(hit.field.path)}
          breadcrumb={`${hit.pane.label} · ${hit.group.title}`}
          onChange={value => onChange(hit.field.path, value)}
        />
      ))}
    </div>
  );
}

function RailButton(
  { pane, active, count, onClick }: {
    pane: Pane; active: boolean; count: number; onClick: () => void;
  },
): React.ReactElement {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px]
                  transition-colors ${active
                    ? 'bg-aico-elevated font-medium text-aico-primary'
                    : 'text-aico-secondary hover:bg-aico-hover hover:text-aico-primary'}`}
    >
      <Icon name={pane.icon} size={16} className={active ? 'text-aico-accent' : 'text-aico-muted'} />
      <span className="min-w-0 flex-1 truncate">{pane.label}</span>
      {count > 0 && (
        <span
          className="rounded-full bg-aico-accent-soft px-1.5 py-0.5 text-[10px] tabular-nums text-aico-accent"
          title={`${count} changed from the default`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

/** Shows only while something is in flight, and briefly after it lands. */
function SaveBadge({ state }: { state: SaveState }): React.ReactElement | null {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (state === 'idle') return;
    setVisible(true);
    if (state !== 'saved') return;
    const timer = setTimeout(() => setVisible(false), 1600);
    return () => clearTimeout(timer);
  }, [state]);

  if (!visible || state === 'idle') return null;
  if (state === 'saving') return <span className="shrink-0 text-[12px] text-aico-muted">Saving…</span>;
  if (state === 'failed') return <span className="shrink-0 text-[12px] text-aico-danger">Not saved</span>;
  return (
    <span className="flex shrink-0 items-center gap-1 text-[12px] text-aico-success">
      <Icon name="check" size={13} /> Saved
    </span>
  );
}

function countFor(pane: Pane, changed: Set<string>): number {
  return pane.groups
    .flatMap(group => group.fields)
    .filter(field => changed.has(field.path))
    .length;
}
