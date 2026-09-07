/**
 * Create an app: say what you want, then pick how it starts.
 *
 * The idea comes first. Lovable and Replit both open on a prompt, and the
 * reason is not fashion: a person knows "invoices for my studio" long before
 * they know they want a Next.js App Router template. So step one is a
 * sentence; the catalogue is ranked against it with the matched words shown;
 * the best match is marked; a name is suggested from the words. Step two is
 * the name, one line, and — for a process app — whether to install now. The
 * brief becomes the agent's first message, so the build starts from the
 * person's words rather than from nothing.
 *
 * "Let the agent choose" is still here for the person who would rather talk:
 * it starts a conversation with the brief and lets AppManage pick the template.
 *
 * @module components/AppCreateWizard
 */

import React, { useEffect, useMemo, useState } from 'react';
import { api, type AppTemplate } from '../api';
import { useStore } from '../store';
import { categoryLabel, KindBadge } from './AppsPane';
import { KIND_WORDS, TemplateGallery } from './apps/TemplateGallery';

interface Props {
  templates: AppTemplate[];
  /** Pre-selected, when the reader clicked a template card. */
  initial?: AppTemplate;
  onClose: () => void;
  /** The app exists (and its session is bound); the pane opens the conversation. */
  onCreated: (slug: string) => void;
}

type Step = 'describe' | 'choose' | 'details';

export function AppCreateWizard({ templates, initial, onClose, onCreated }: Props): React.ReactElement {
  const submit = useStore(s => s.submit);
  const askAgentFor = useStore(s => s.askAgentFor);
  const [step, setStep] = useState<Step>(initial ? 'details' : 'describe');
  const [brief, setBrief] = useState('');
  const [template, setTemplate] = useState<AppTemplate | undefined>(initial);
  const [suggested, setSuggested] = useState<Array<{ id: string; matched: string[] }>>([]);
  const [suggestedName, setSuggestedName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [install, setInstall] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Rank as the person types, after a pause: the ranking is cheap and the
  // "best match" badge moving while they write is the feedback.
  useEffect(() => {
    const text = brief.trim();
    if (text.length < 8) { setSuggested([]); setSuggestedName(''); return; }
    const t = setTimeout(() => {
      api.suggestApps(text).then(r => { setSuggested(r.suggested); setSuggestedName(r.name); }).catch(() => setSuggested([]));
    }, 250);
    return () => clearTimeout(t);
  }, [brief]);

  const best = useMemo(() => (suggested[0] && suggested[0].matched.length > 0 ? templates.find(t => t.id === suggested[0]!.id) : undefined), [suggested, templates]);
  const isProcess = template?.kind === 'process' || template?.kind === 'mobile';
  const canCreate = Boolean(template) && title.trim().length > 0 && !creating;

  const choose = (t: AppTemplate): void => {
    setTemplate(t);
    if (!title.trim() && suggestedName) setTitle(suggestedName);
    if (!description.trim() && brief.trim()) setDescription(brief.trim().split(/[.\n]/)[0]!.slice(0, 120));
    setStep('details');
  };

  const letAgentChoose = (): void => {
    const text = brief.trim();
    onClose();
    askAgentFor(`${text}\n\nUse AppManage templates to pick the template that fits this best, create the app from it, then use the app-plan skill to turn this into the backlog and build the first iteration.`);
  };

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
      if (brief.trim()) {
        setTimeout(() => {
          void submit(`${brief.trim()}\n\nStart from this app's AICO.md and docs/EXTENDING.md, use the app-plan skill to turn this into docs/PRD.md and the first iteration of .aico/backlog.md, then build the first story and verify it in the browser.`);
        }, 400);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  };

  const steps: Array<{ id: Step; label: string }> = [{ id: 'describe', label: 'Describe' }, { id: 'choose', label: 'Start from' }, { id: 'details', label: 'Name it' }];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 sm:p-6" onClick={onClose} data-app-wizard>
      <div role="dialog" aria-modal="true" aria-labelledby="app-wizard-title" onClick={e => e.stopPropagation()}
           className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-aico-border bg-aico-surface">
        <div className="flex items-center gap-3 border-b border-aico-border-subtle px-5 py-3">
          <h2 id="app-wizard-title" className="text-[14px] font-semibold text-aico-primary">Create an app</h2>
          <ol className="ml-2 flex items-center gap-1 text-[11px]" aria-label="Steps">
            {steps.map((s, i) => (
              <li key={s.id} className="flex items-center gap-1">
                <button
                  onClick={() => { if (s.id === 'describe' || (s.id === 'choose') || (s.id === 'details' && template)) setStep(s.id); }}
                  className={`rounded-full px-2 py-0.5 ${step === s.id ? 'bg-aico-accent text-white' : 'text-aico-muted hover:text-aico-primary'}`}
                  data-wizard-step={s.id}
                >
                  {i + 1}. {s.label}
                </button>
                {i < steps.length - 1 && <span className="text-aico-muted">›</span>}
              </li>
            ))}
          </ol>
          <div className="flex-1" />
          <button onClick={onClose} aria-label="Close" className="rounded-lg px-2 py-1 text-[12px] text-aico-muted hover:bg-aico-hover hover:text-aico-primary">Esc</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {step === 'describe' && (
            <div className="space-y-4">
              <label className="block">
                <span className="text-[15px] font-medium text-aico-primary">What do you want to build?</span>
                <textarea
                  autoFocus
                  value={brief}
                  onChange={e => setBrief(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && brief.trim()) setStep('choose'); }}
                  rows={4}
                  placeholder="An invoice desk for a small studio: customers, line items with tax, a status that goes draft → sent → paid, and a page that shows who has not paid."
                  data-wizard-brief
                  className="mt-2 w-full rounded-xl border border-aico-border bg-aico-bg px-3 py-2.5 text-[14px] text-aico-primary outline-none focus:ring-2 focus:ring-aico-accent/40"
                />
                <span className="mt-1 block text-[11px] text-aico-muted">Who uses it, what they do most often, what must be true when it is done. This becomes the agent's brief.</span>
              </label>

              {best && (
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-aico-accent/40 bg-aico-accent/5 px-4 py-3" data-wizard-best={best.id}>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] text-aico-muted">Best match</div>
                    <div className="flex items-center gap-2 text-[14px] font-medium text-aico-primary">{best.name} <KindBadge kind={best.kind} /></div>
                    <div className="text-[11px] text-aico-muted">{categoryLabel(best.category)} · {KIND_WORDS[best.kind]} · matches {[...new Set(suggested[0]!.matched)].slice(0, 4).join(', ')}</div>
                  </div>
                  <button onClick={() => choose(best)} className="rounded-lg bg-aico-accent px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90" data-wizard-use-best>
                    Use {best.name}
                  </button>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button onClick={() => setStep('choose')} className="rounded-lg border border-aico-border px-3 py-1.5 text-[13px] text-aico-primary hover:bg-aico-hover" data-wizard-see-all>
                  {best ? 'See all templates' : 'Choose a template'}
                </button>
                <button onClick={letAgentChoose} disabled={brief.trim().length < 8} className="rounded-lg px-3 py-1.5 text-[13px] text-aico-accent hover:bg-aico-accent/10 disabled:opacity-50" data-wizard-agent>
                  Let the agent choose and start
                </button>
                <span className="text-[11px] text-aico-muted">Ctrl+Enter continues</span>
              </div>
            </div>
          )}

          {step === 'choose' && (
            <div className="space-y-3">
              <p className="text-[12px] text-aico-muted">
                {brief.trim() ? 'Ranked against your brief; the matched words are shown on each card.' : 'Every template copies in as files — a worked feature, tests, notes for the agent and a Dockerfile — with nothing generated.'}
              </p>
              <TemplateGallery templates={templates} suggested={suggested} onPick={choose} compact />
              {templates.length === 0 && <p className="text-[13px] text-aico-primary">No templates are installed.</p>}
            </div>
          )}

          {step === 'details' && template && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-lg border border-aico-border-subtle bg-aico-hover/30 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-aico-primary">{template.name}</span>
                    <KindBadge kind={template.kind} />
                    <span className="text-[11px] text-aico-muted">{categoryLabel(template.category)} · {KIND_WORDS[template.kind]}</span>
                  </div>
                  <p className="mt-1 text-[12px] text-aico-muted">{template.summary}</p>
                  {(template.features?.length ?? 0) > 0 && (
                    <ul className="mt-1.5 space-y-0.5 text-[11px] text-aico-muted">{template.features!.map(f => <li key={f}>• {f}</li>)}</ul>
                  )}
                  {template.requires?.node && <p className="mt-1 text-[11px] text-aico-muted">Needs Node {template.requires.node}.</p>}
                </div>
                <button onClick={() => setStep('choose')} className="shrink-0 text-[12px] text-aico-accent hover:underline">Change</button>
              </div>

              <label className="block">
                <span className="text-[12px] font-medium text-aico-primary">Name</span>
                <input
                  autoFocus
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && canCreate) void create(); }}
                  placeholder={suggestedName || 'Invoice Desk'}
                  data-wizard-title
                  className="mt-1 w-full rounded-lg border border-aico-border bg-aico-bg px-3 py-2 text-[13px] text-aico-primary outline-none focus:ring-2 focus:ring-aico-accent/40"
                />
                {suggestedName && !title && <button onClick={() => setTitle(suggestedName)} className="mt-1 text-[11px] text-aico-accent hover:underline">Use “{suggestedName}”</button>}
              </label>

              <label className="block">
                <span className="text-[12px] font-medium text-aico-primary">One line about it <span className="font-normal text-aico-muted">(shown on the card)</span></span>
                <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Invoices for a small studio: customers, line items, PDF export"
                       className="mt-1 w-full rounded-lg border border-aico-border bg-aico-bg px-3 py-2 text-[13px] text-aico-primary outline-none focus:ring-2 focus:ring-aico-accent/40" />
              </label>

              {!brief.trim() && (
                <label className="block">
                  <span className="text-[12px] font-medium text-aico-primary">Brief for the agent <span className="font-normal text-aico-muted">(optional — starts the build)</span></span>
                  <textarea value={brief} onChange={e => setBrief(e.target.value)} rows={3} placeholder="Who uses it, what they do most often, what must be true when it is done."
                            className="mt-1 w-full rounded-lg border border-aico-border bg-aico-bg px-3 py-2 text-[13px] text-aico-primary outline-none focus:ring-2 focus:ring-aico-accent/40" />
                </label>
              )}
              {brief.trim() && (
                <div className="rounded-lg border border-aico-border-subtle p-3 text-[12px]">
                  <div className="text-[10px] uppercase tracking-wide text-aico-muted">The agent's brief</div>
                  <p className="mt-0.5 text-aico-secondary">{brief.trim()}</p>
                  <button onClick={() => setStep('describe')} className="mt-1 text-[11px] text-aico-accent hover:underline">Edit</button>
                </div>
              )}

              {isProcess && (
                <div className="rounded-lg border border-aico-border-subtle p-3">
                  <label className="flex items-start gap-2">
                    <input type="checkbox" checked={install} onChange={e => setInstall(e.target.checked)} className="mt-0.5" />
                    <span className="text-[12px] text-aico-primary">
                      Install dependencies now
                      <span className="block text-aico-muted">Runs {template.run?.install ?? 'the install'} in the background while you talk. A first install takes a few minutes.</span>
                    </span>
                  </label>
                  <p className="mt-2 text-[11px] text-aico-muted">A process app runs code the agent writes with your permissions, on a port of its own.</p>
                </div>
              )}

              {error && <p className="text-[12px] text-aico-danger" role="alert">{error}</p>}
            </div>
          )}
        </div>

        {step === 'details' && template && (
          <div className="flex items-center justify-end gap-2 border-t border-aico-border-subtle px-5 py-3">
            <button onClick={onClose} className="rounded-lg border border-aico-border px-3 py-1.5 text-[13px] text-aico-primary hover:bg-aico-hover">Cancel</button>
            <button onClick={() => void create()} disabled={!canCreate} data-wizard-create
                    className="rounded-lg bg-aico-accent px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50">
              {creating ? 'Creating…' : brief.trim() ? 'Create and start building' : 'Create'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
