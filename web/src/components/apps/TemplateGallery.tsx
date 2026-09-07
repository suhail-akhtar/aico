/**
 * The templates as a gallery, not a list of paragraphs.
 *
 * A template card says three things at a glance: what kind of thing it is (a
 * glyph and a category), what you get (three lines from the manifest), and
 * how it runs (in words, not a token: "served instantly", "its own server").
 * Search and category chips narrow nine cards to the one that fits; a brief,
 * when the caller has one, ranks them and marks the best matches.
 *
 * @module components/apps/TemplateGallery
 */

import React, { useMemo, useState } from 'react';
import type { AppTemplate } from '../../api';
import { categoryLabel } from '../AppsPane';

/** How a kind runs, in the words a person needs before choosing. */
export const KIND_WORDS: Record<string, string> = {
  page: 'served instantly · no install',
  static: 'static files · no install',
  process: 'its own server · installs first',
  nextjs: 'its own server · installs first',
  cli: 'command line · no server',
  mobile: 'mobile · web preview here',
};

/** A coloured tile per category, so nine cards are told apart before they are read. */
const GLYPH: Record<string, { text: string; tone: string }> = {
  'internal-tool': { text: 'Rt', tone: 'bg-sky-500/15 text-sky-600 dark:text-sky-300' },
  landing: { text: 'Ld', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  saas: { text: 'Ws', tone: 'bg-violet-500/15 text-violet-600 dark:text-violet-300' },
  api: { text: 'Api', tone: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300' },
  dashboard: { text: 'Db', tone: 'bg-rose-500/15 text-rose-600 dark:text-rose-300' },
  cli: { text: '>_', tone: 'bg-slate-500/15 text-slate-600 dark:text-slate-300' },
  docs: { text: 'Dx', tone: 'bg-teal-500/15 text-teal-600 dark:text-teal-300' },
  agent: { text: 'Ag', tone: 'bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-300' },
  mobile: { text: 'Mb', tone: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300' },
};

export function CategoryGlyph({ category, size = 36 }: { category?: string; size?: number }): React.ReactElement {
  const g = GLYPH[category ?? ''] ?? { text: (category ?? 'app').slice(0, 2), tone: 'bg-aico-hover text-aico-secondary' };
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-lg font-mono text-[12px] font-semibold ${g.tone}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {g.text}
    </span>
  );
}

export interface GalleryProps {
  templates: AppTemplate[];
  /** Ranked ids with the words that matched, when a brief was given. */
  suggested?: Array<{ id: string; matched: string[] }>;
  onPick: (template: AppTemplate) => void;
  /** Compact cards for the wizard; full cards for the Apps screen. */
  compact?: boolean;
  /** Whether to show the search and category filters. */
  filters?: boolean;
}

export function TemplateGallery({ templates, suggested, onPick, compact = false, filters = true }: GalleryProps): React.ReactElement {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);

  const categories = useMemo(() => [...new Set(templates.map(t => t.category))].sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b))), [templates]);
  const rank = new Map((suggested ?? []).map((s, i) => [s.id, { i, matched: s.matched }]));

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return templates
      .filter(t => !category || t.category === category)
      .filter(t => !q || [t.name, t.summary, t.category, ...(t.tags ?? []), ...(t.features ?? [])].join(' ').toLowerCase().includes(q))
      .sort((a, b) => {
        const ra = rank.get(a.id)?.i ?? 999;
        const rb = rank.get(b.id)?.i ?? 999;
        return ra - rb || categoryLabel(a.category).localeCompare(categoryLabel(b.category)) || a.name.localeCompare(b.name);
      });
  }, [templates, query, category, rank]);

  return (
    <div data-template-gallery>
      {filters && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search templates"
            aria-label="Search templates"
            className="w-48 rounded-lg border border-aico-border bg-aico-bg px-2.5 py-1.5 text-[12px] text-aico-primary outline-none focus:ring-2 focus:ring-aico-accent/40"
            data-template-search
          />
          <div className="flex flex-wrap gap-1">
            <Chip active={category === null} onClick={() => setCategory(null)}>All</Chip>
            {categories.map(c => <Chip key={c} active={category === c} onClick={() => setCategory(category === c ? null : c)}>{categoryLabel(c)}</Chip>)}
          </div>
        </div>
      )}
      {shown.length === 0 && <p className="text-[12px] text-aico-muted">Nothing matches. Clear the search, or describe what you want and let the agent choose.</p>}
      <div className={`grid gap-3 ${compact ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3'}`}>
        {shown.map(t => {
          const r = rank.get(t.id);
          const best = r !== undefined && r.i === 0 && r.matched.length > 0;
          return (
            <button
              key={t.id}
              onClick={() => onPick(t)}
              data-template={t.id}
              className={`group relative flex flex-col rounded-xl border bg-aico-surface p-4 text-left transition-colors hover:bg-aico-hover/40 ${
                best ? 'border-aico-accent shadow-[0_0_0_3px] shadow-aico-accent/15' : 'border-aico-border-subtle hover:border-aico-accent/50'
              }`}
            >
              <div className="flex items-start gap-3">
                <CategoryGlyph category={t.category} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14px] font-medium text-aico-primary">{t.name}</span>
                    {best && <span className="rounded-full bg-aico-accent px-1.5 py-0.5 text-[10px] font-medium text-white" data-best-match>best match</span>}
                  </div>
                  <div className="text-[11px] text-aico-muted">{categoryLabel(t.category)} · {KIND_WORDS[t.kind] ?? t.kind}</div>
                </div>
              </div>
              {!compact && <p className="mt-2 line-clamp-2 text-[12px] text-aico-secondary">{t.summary}</p>}
              {(t.features?.length ?? 0) > 0 && (
                <ul className="mt-2 space-y-0.5 text-[11px] text-aico-muted">
                  {t.features!.slice(0, 3).map(f => <li key={f} className="flex gap-1.5"><span className="text-aico-accent">•</span><span className="min-w-0">{f}</span></li>)}
                </ul>
              )}
              {r && r.matched.length > 0 && (
                <p className="mt-2 text-[10px] text-aico-muted">matches: {[...new Set(r.matched)].slice(0, 5).join(', ')}</p>
              )}
              {t.requires?.node && <p className="mt-2 text-[10px] text-aico-muted">Node {t.requires.node}{t.source !== 'bundled' ? ` · ${t.source} template` : ''}</p>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): React.ReactElement {
  return (
    <button onClick={onClick} className={`rounded-full px-2.5 py-1 text-[11px] ${active ? 'bg-aico-accent text-white' : 'bg-aico-hover text-aico-secondary hover:text-aico-primary'}`}>
      {children}
    </button>
  );
}
