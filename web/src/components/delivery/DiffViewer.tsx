/**
 * A task's diff, file by file.
 *
 * A reviewer's first question is "what did it touch?", the second "show me the
 * risky file" — so the viewer opens with a one-line total, lists files as
 * collapsible sections with +/- counts, and opens small diffs while folding
 * large ones (a 900-line lockfile should not push the real change off screen).
 * Line numbers and the add/remove tints use the theme's diff tokens
 * (`--aico-diff-*`), the same ones the Changes pane and Source control use, so
 * light and dark come for free.
 *
 * Parsing is `delivery-diff.ts` (tested); this file only draws it. Long diffs
 * are capped per file until asked for, because a task branch can be large and
 * the drawer is not a code editor.
 *
 * @module web/components/delivery/DiffViewer
 */

import React, { useMemo, useState } from 'react';
import { diffTotals, extOf, highlightLine, parseUnifiedDiff, type DiffFile, type DiffLine, type TokenKind } from '../../delivery-diff';
import { DvIcon } from './icons';
import { BTN_GHOST } from './ui';

/** Files with more changed lines than this start folded. */
const FOLD_OVER = 160;
/** Lines drawn per file before "Show all". */
const LINE_CAP = 400;

const TOKEN: Record<TokenKind, string> = {
  kw: 'text-aico-accent',
  str: 'text-aico-warning',
  com: 'italic text-aico-muted',
  num: 'text-aico-info',
};

const STATUS_WORD: Record<DiffFile['status'], string> = { added: 'new', deleted: 'deleted', renamed: 'renamed', modified: 'changed' };

export function DiffViewer({ diff, onOpenFile }: { diff: string; onOpenFile?: ((path: string) => void) | undefined }): React.ReactElement {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const totals = useMemo(() => diffTotals(files), [files]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (f: DiffFile): boolean => open[f.path] ?? (f.added + f.removed <= FOLD_OVER && !f.binary);

  if (files.length === 0) {
    return <p className="rounded-lg border border-dashed border-aico-border px-3 py-4 text-[12.5px] text-aico-secondary">This task has no changes against the trunk yet.</p>;
  }

  const allOpen = files.every(isOpen);
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-[12px] text-aico-secondary">
        <span><span className="tabular-nums">{totals.files}</span> {totals.files === 1 ? 'file' : 'files'}</span>
        <span className="tabular-nums text-aico-success">+{totals.added}</span>
        <span className="tabular-nums text-aico-danger">−{totals.removed}</span>
        <span className="flex-1" />
        <button type="button" className={`${BTN_GHOST} !px-2 !py-0.5 !text-[12px]`} onClick={() => setOpen(Object.fromEntries(files.map(f => [f.path, !allOpen])))}>
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>
      <div className="space-y-2">
        {files.map(f => (
          <FileSection key={f.path + (f.oldPath ?? '')} file={f} open={isOpen(f)} onToggle={() => setOpen(o => ({ ...o, [f.path]: !isOpen(f) }))} onOpenFile={onOpenFile} />
        ))}
      </div>
    </div>
  );
}

function FileSection({ file, open, onToggle, onOpenFile }: {
  file: DiffFile; open: boolean; onToggle: () => void; onOpenFile?: ((path: string) => void) | undefined;
}): React.ReactElement {
  const [all, setAll] = useState(false);
  const ext = extOf(file.path);
  const total = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  let budget = all ? Infinity : LINE_CAP;
  return (
    <section className="overflow-hidden rounded-lg border border-aico-border-subtle">
      <header className="flex items-center gap-2 bg-aico-surface px-2.5 py-1.5 text-[12px]">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent"
        >
          <DvIcon name="chevron" size={13} className={`shrink-0 text-aico-muted transition-transform ${open ? 'rotate-90' : ''}`} />
          <span className="truncate font-mono text-aico-primary" title={file.path}>{file.path}</span>
          {file.oldPath && file.status === 'renamed' && <span className="truncate text-aico-muted">← {file.oldPath}</span>}
          {file.status !== 'modified' && (
            <span className="shrink-0 rounded bg-aico-hover px-1.5 text-[11px] text-aico-secondary">{STATUS_WORD[file.status]}</span>
          )}
        </button>
        <span className="shrink-0 tabular-nums text-aico-success">+{file.added}</span>
        <span className="shrink-0 tabular-nums text-aico-danger">−{file.removed}</span>
        {onOpenFile && file.status !== 'deleted' && (
          <button type="button" onClick={() => onOpenFile(file.path)} className="shrink-0 rounded px-1 text-aico-muted hover:bg-aico-hover hover:text-aico-accent" title="Show this file in the Code map" aria-label={`Show ${file.path} in the Code map`}>
            <DvIcon name="map" size={13} />
          </button>
        )}
      </header>
      {open && (
        file.binary ? (
          <p className="px-3 py-2 text-[12px] text-aico-muted">Binary file; not shown.</p>
        ) : file.hunks.length === 0 ? (
          <p className="px-3 py-2 text-[12px] text-aico-muted">{file.status === 'renamed' ? 'Renamed without changes.' : 'No textual changes.'}</p>
        ) : (
          <div className="overflow-x-auto bg-aico-bg font-mono text-[11.5px] leading-[1.55]">
            <div className="min-w-max">
              {file.hunks.map((h, i) => {
                if (budget <= 0) return null;
                const lines = h.lines.slice(0, budget);
                budget -= lines.length;
                return (
                  <div key={i}>
                    <div className="select-none bg-aico-surface px-3 py-0.5 text-aico-muted">{h.header}</div>
                    {lines.map((l, j) => <Line key={j} line={l} ext={ext} />)}
                  </div>
                );
              })}
              {!all && total > LINE_CAP && (
                <button type="button" onClick={() => setAll(true)} className="w-full border-t border-aico-border-subtle bg-aico-surface px-3 py-1.5 text-left text-[12px] text-aico-accent hover:bg-aico-hover">
                  Show all {total} lines
                </button>
              )}
            </div>
          </div>
        )
      )}
    </section>
  );
}

const Line = React.memo(function Line({ line, ext }: { line: DiffLine; ext: string }): React.ReactElement {
  const bg = line.kind === 'add' ? 'bg-[var(--aico-diff-add-bg)]' : line.kind === 'del' ? 'bg-[var(--aico-diff-remove-bg)]' : '';
  const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ';
  const signTone = line.kind === 'add' ? 'text-[var(--aico-diff-add-gutter)]' : line.kind === 'del' ? 'text-[var(--aico-diff-remove-gutter)]' : 'text-transparent';
  if (line.kind === 'note') return <div className="px-3 py-0.5 pl-[5.5rem] italic text-aico-muted">{line.text}</div>;
  return (
    <div className={`flex ${bg}`}>
      <span className="w-9 shrink-0 select-none pr-1.5 text-right tabular-nums text-aico-muted opacity-70">{line.oldNo ?? ''}</span>
      <span className="w-9 shrink-0 select-none pr-1.5 text-right tabular-nums text-aico-muted opacity-70">{line.newNo ?? ''}</span>
      <span className={`w-4 shrink-0 select-none text-center ${signTone}`} aria-hidden="true">{sign}</span>
      <span className="whitespace-pre pr-3 text-aico-primary">
        {line.text === '' ? ' ' : highlightLine(line.text, ext).map((t, i) => (t.kind ? <span key={i} className={TOKEN[t.kind]}>{t.text}</span> : t.text))}
      </span>
    </div>
  );
});
