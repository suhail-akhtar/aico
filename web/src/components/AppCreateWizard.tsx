/**
 * Create an app from a template: pick, name, go.
 *
 * Two steps, not five. The template card already said what the app is; the
 * only things the reader adds are a name, a line about it, and — optionally —
 * the brief that starts the build. The install for a process app starts the
 * moment the app exists, so the minutes it takes overlap with typing.
 *
 * The one warning that matters is stated once, where it applies: a process
 * app runs model-authored code with the reader's permissions.
 *
 * @module components/AppCreateWizard
 */

import React, { useEffect, useMemo, useState } from 'react';
import { api, type AppTemplate } from '../api';
import { useStore } from '../store';
import { categoryLabel, KindBadge } from './AppsPane';

interface Props {
  templates: AppTemplate[];
  /** Pre-selected, when the reader clicked a template card. */
  initial?: AppTemplate;
  onClose: () => void;
  /** The app exists (and its session is bound); the pane opens the conversation. */
  onCreated: (slug: string) => void;
}

export function AppCreateWizard({ templates, initial, onClose, onCreated }: Props): React.ReactElement {
  const submit = useStore(s => s.submit);
  const [template, setTemplate] = useState<AppTemplate | undefined>(initial);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [brief, setBrief] = useState('');
  const [install, setInstall] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const byCategory = useMemo(() => {
    const m = new Map<string, AppTemplate[]>();
    for (const t of templates) m.set(t.category, [...(m.get(t.category) ?? []), t]);
    return [...m.entries()].sort((a, b) => categoryLabel(a[0]).localeCompare(categoryLabel(b[0])));
  }, [templates]);

  const isProcess = template?.kind === 'process' || template?.kind === 'mobile';
  const canCreate = Boolean(template) && title.trim().length > 0 && !creating;

  const create = async (): Promise<void> => {
    if (!template || !canCreate) return;
    setCreating(true);
    setError(null);
    try {
      const made = await api.createApp({
        template: template.id,
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        install: isProcess ? install : false,
      });
      onCreated(made.slug);
      /*
        The brief is the first message of the app's own conversation, sent
        after the pane has switched to it. It is not the pointer the tool
        returns — the bound session's system prompt already carries the app's
        AICO.md — so the message is the reader's words and nothing else.
      */
      if (brief.trim()) {
        setTimeout(() => {
          void submit(`${brief.trim()}\n\nStart from this app's AICO.md and docs/EXTENDING.md, use the app-plan skill to turn this into the backlog, and build it by copying the worked feature.`);
        }, 400);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 sm:p-6"
      onClick={onClose}
      data-app-wizard
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-wizard-title"
        onClick={e => e.stopPropagation()}
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-aico-border bg-aico-surface"
      >
        <div className="flex items-center gap-3 border-b border-aico-border-subtle px-5 py-3">
          <h2 id="app-wizard-title" className="text-[14px] font-semibold text-aico-primary">
            {template ? `New ${template.name.toLowerCase()}` : 'Create an app'}
          </h2>
          <div className="flex-1" />
          <button onClick={onClose} aria-label="Close" className="rounded-lg px-2 py-1 text-[12px] text-aico-muted hover:bg-aico-hover hover:text-aico-primary">
            Esc
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {!template ? (
            <div className="space-y-4">
              <p className="text-[12px] text-aico-muted">
                Pick what it starts from. Every template copies in as files — a worked feature, tests, notes for
                the agent and a Dockerfile — with nothing generated.
              </p>
              {byCategory.map(([category, list]) => (
                <div key={category}>
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-aico-muted">{categoryLabel(category)}</h3>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {list.map(t => (
                      <button
                        key={t.id}
                        onClick={() => setTemplate(t)}
                        data-wizard-template={t.id}
                        className="flex flex-col rounded-lg border border-aico-border-subtle p-3 text-left transition-colors
                                   hover:border-aico-accent/50 hover:bg-aico-hover/40"
                      >
                        <div className="flex items-start gap-2">
                          <span className="min-w-0 flex-1 text-[13px] font-medium text-aico-primary">{t.name}</span>
                          <KindBadge kind={t.kind} />
                        </div>
                        <span className="mt-1 line-clamp-2 text-[12px] text-aico-muted">{t.summary}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {templates.length === 0 && (
                <p className="text-[13px] text-aico-primary">No templates are installed.</p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-lg border border-aico-border-subtle bg-aico-hover/30 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-aico-primary">{template.name}</span>
                    <KindBadge kind={template.kind} />
                    <span className="text-[11px] text-aico-muted">{categoryLabel(template.category)}</span>
                  </div>
                  <p className="mt-1 text-[12px] text-aico-muted">{template.summary}</p>
                  {template.requires?.node && (
                    <p className="mt-1 text-[11px] text-aico-muted">Needs Node {template.requires.node}.</p>
                  )}
                </div>
                {!initial && (
                  <button onClick={() => setTemplate(undefined)} className="shrink-0 text-[12px] text-aico-accent hover:underline">
                    Change
                  </button>
                )}
              </div>

              <label className="block">
                <span className="text-[12px] font-medium text-aico-primary">Name</span>
                <input
                  autoFocus
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && canCreate) void create(); }}
                  placeholder="Invoice Desk"
                  data-wizard-title
                  className="mt-1 w-full rounded-lg border border-aico-border bg-aico-bg px-3 py-2 text-[13px] text-aico-primary
                             outline-none focus:ring-2 focus:ring-aico-accent/40"
                />
              </label>

              <label className="block">
                <span className="text-[12px] font-medium text-aico-primary">One line about it <span className="font-normal text-aico-muted">(optional)</span></span>
                <input
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="Invoices for a small studio: customers, line items, PDF export"
                  className="mt-1 w-full rounded-lg border border-aico-border bg-aico-bg px-3 py-2 text-[13px] text-aico-primary
                             outline-none focus:ring-2 focus:ring-aico-accent/40"
                />
              </label>

              <label className="block">
                <span className="text-[12px] font-medium text-aico-primary">Brief for the agent <span className="font-normal text-aico-muted">(optional — starts the build)</span></span>
                <textarea
                  value={brief}
                  onChange={e => setBrief(e.target.value)}
                  rows={3}
                  placeholder="Who uses it, what they do most often, what must be true when it is done."
                  className="mt-1 w-full rounded-lg border border-aico-border bg-aico-bg px-3 py-2 text-[13px] text-aico-primary
                             outline-none focus:ring-2 focus:ring-aico-accent/40"
                />
              </label>

              {isProcess && (
                <div className="rounded-lg border border-aico-border-subtle p-3">
                  <label className="flex items-start gap-2">
                    <input type="checkbox" checked={install} onChange={e => setInstall(e.target.checked)} className="mt-0.5" />
                    <span className="text-[12px] text-aico-primary">
                      Install dependencies now
                      <span className="block text-aico-muted">
                        Runs {template.run?.install ?? 'the install'} in the background. A first install takes minutes;
                        it overlaps with the conversation.
                      </span>
                    </span>
                  </label>
                  <p className="mt-2 text-[11px] text-aico-muted">
                    A process app runs code the agent writes with your permissions, on a port of its own.
                  </p>
                </div>
              )}

              {error && <p className="text-[12px] text-aico-danger" role="alert">{error}</p>}
            </div>
          )}
        </div>

        {template && (
          <div className="flex items-center justify-end gap-2 border-t border-aico-border-subtle px-5 py-3">
            <button onClick={onClose} className="rounded-lg border border-aico-border px-3 py-1.5 text-[13px] text-aico-primary hover:bg-aico-hover">
              Cancel
            </button>
            <button
              onClick={() => void create()}
              disabled={!canCreate}
              data-wizard-create
              className="rounded-lg bg-aico-accent px-3 py-1.5 text-[13px] font-medium text-white
                         transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {creating ? 'Creating…' : brief.trim() ? 'Create and start building' : 'Create'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
