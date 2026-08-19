/**
 * What this session did to the repository, in one place.
 *
 * The diffs exist already — one per tool row, in the order they happened. What
 * did not exist was the answer to the question people actually ask at the end:
 * *what does my working tree look like now*, and *can I undo that one thing*.
 * Twenty scattered patches do not add up to that, and neither does trusting a
 * summary.
 *
 * **The session's own edits are marked, not filtered.** A change of your own,
 * sitting in the same tree, is exactly the thing you need to see before
 * reverting anything — so everything is listed and the agent's rows are
 * labelled.
 *
 * **Revert asks first, every time.** It is the only control in this
 * application that destroys work. A new file has no earlier version, so
 * reverting it means deleting it, and the confirmation says that in those
 * words rather than hiding behind "revert".
 *
 * @module components/ChangesPane
 */

import React, { useCallback, useEffect, useState } from 'react';
import { api, type FileChange } from '../api';
import { useStore } from '../store';

/** How each kind reads, and in what colour. */
const KINDS: Record<FileChange['kind'], { label: string; tone: string }> = {
  added: { label: 'added', tone: 'text-aico-success' },
  untracked: { label: 'new', tone: 'text-aico-success' },
  modified: { label: 'changed', tone: 'text-aico-accent' },
  deleted: { label: 'deleted', tone: 'text-aico-danger' },
  renamed: { label: 'renamed', tone: 'text-aico-accent' },
};

/** One line of a unified diff, coloured by what it does. */
function DiffLine({ text }: { text: string }): React.ReactElement {
  const tone = text.startsWith('+') && !text.startsWith('+++') ? 'bg-aico-success/10 text-aico-success'
    : text.startsWith('-') && !text.startsWith('---') ? 'bg-aico-danger/10 text-aico-danger'
    : text.startsWith('@@') ? 'text-aico-muted'
    : 'text-aico-secondary';
  return <div className={`whitespace-pre px-3 ${tone}`}>{text || ' '}</div>;
}

export function ChangesPane(): React.ReactElement {
  const sessionId = useStore(s => s.sessionId);
  const busy = useStore(s => s.busy);

  const [report, setReport] = useState<Awaited<ReturnType<typeof api.changes>> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>('');
  const [confirming, setConfirming] = useState<FileChange | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try { setReport(await api.changes(sessionId)); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, [sessionId]);

  // Refreshed when the turn ends rather than polled: the tree only moves when
  // the agent moves it, and a timer would re-read git every few seconds for the
  // whole time somebody sits reading a diff.
  useEffect(() => { void refresh(); }, [refresh, busy]);

  const show = async (file: FileChange): Promise<void> => {
    if (open === file.path) { setOpen(null); setDiff(''); return; }
    setOpen(file.path);
    setDiff('');
    try { setDiff((await api.changesDiff(sessionId, file.path)).diff); }
    catch (err) { setDiff(`Could not read the diff: ${err instanceof Error ? err.message : String(err)}`); }
  };

  const revert = async (file: FileChange): Promise<void> => {
    setError(null);
    const result = await api.revert(sessionId, file.path, file.kind === 'untracked');
    if (!result.ok) setError(result.error ?? 'revert failed');
    setConfirming(null);
    setOpen(null);
    await refresh();
  };

  if (!report) {
    return <div className="px-5 py-6 text-[13px] text-aico-muted">Reading the working tree…</div>;
  }

  if (!report.isRepo) {
    return (
      <div className="mx-auto w-full max-w-column px-5 py-6">
        <p className="text-[13px] text-aico-secondary">This project is not a git repository.</p>
        <p className="mt-1 text-[12px] text-aico-muted">
          Changes are read from git, which is also the only thing that can put a file back.
          Run <code className="font-mono">git init</code> here and this fills in.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-column overflow-y-auto px-5 py-4">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[15px] font-medium text-aico-primary">Changes</h2>
        <span className="text-[12px] text-aico-muted">
          {report.files.length === 0
            ? 'working tree clean'
            : `${report.files.length} file${report.files.length === 1 ? '' : 's'}`}
        </span>
        {report.files.length > 0 && (
          <span className="tabular-nums text-[12px]">
            <span className="text-aico-success">+{report.added}</span>
            <span className="ml-1 text-aico-danger">−{report.removed}</span>
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => void refresh()}
          className="rounded-lg px-2 py-1 text-[12px] text-aico-muted transition-colors hover:bg-aico-hover"
        >
          Refresh
        </button>
      </div>

      {error && (
        <p className="mt-2 rounded-lg bg-aico-danger/10 px-3 py-2 text-[12px] text-aico-danger">{error}</p>
      )}

      {report.files.length === 0 && (
        <p className="mt-3 text-[13px] text-aico-muted">
          Nothing differs from the last commit.
          {report.reverted.length > 0
            && ` ${report.reverted.length} file(s) this session wrote are back to their committed state.`}
        </p>
      )}

      <ul className="mt-3 space-y-1">
        {report.files.map(file => (
          <li key={file.path} className="rounded-xl border border-aico-border">
            <div className="flex items-center gap-2 px-3 py-2">
              <button onClick={() => void show(file)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <span className={`shrink-0 text-[11px] ${KINDS[file.kind].tone}`}>
                  {KINDS[file.kind].label}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-aico-primary"
                      title={file.from ? `${file.from} → ${file.path}` : file.path}>
                  {file.path}
                </span>
                {file.bySession && (
                  <span className="shrink-0 rounded bg-aico-accent-soft px-1.5 py-0.5 text-[10px] text-aico-accent">
                    this session
                  </span>
                )}
                {file.binary
                  ? <span className="shrink-0 text-[11px] text-aico-muted">binary</span>
                  : (
                    <span className="shrink-0 tabular-nums text-[11px]">
                      {file.added > 0 && <span className="text-aico-success">+{file.added}</span>}
                      {file.removed > 0 && <span className="ml-1 text-aico-danger">−{file.removed}</span>}
                    </span>
                  )}
              </button>
              <button
                onClick={() => setConfirming(file)}
                disabled={busy}
                title={busy ? 'Wait for the turn to finish' : undefined}
                className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-aico-muted transition-colors
                           hover:bg-aico-danger/10 hover:text-aico-danger disabled:opacity-40"
              >
                Revert
              </button>
            </div>

            {/*
              The confirmation says what will actually happen. "Revert" and
              "delete this file permanently" are different promises, and a new
              file gets the second one.
            */}
            {confirming?.path === file.path && (
              <div className="border-t border-aico-border bg-aico-danger/5 px-3 py-2">
                <p className="text-[12px] text-aico-primary">
                  {file.kind === 'untracked'
                    ? <>Delete <span className="font-mono">{file.path}</span>? It was never committed,
                        so there is no earlier version to go back to — this removes it for good.</>
                    : <>Restore <span className="font-mono">{file.path}</span> to the last commit?
                        Every change to it, including any of your own, is lost.</>}
                </p>
                <div className="mt-1.5 flex gap-1.5">
                  <button
                    onClick={() => void revert(file)}
                    className="rounded-lg bg-aico-danger px-2 py-1 text-[11px] font-medium text-white
                               transition-opacity hover:opacity-90"
                  >
                    {file.kind === 'untracked' ? 'Delete it' : 'Restore it'}
                  </button>
                  <button
                    onClick={() => setConfirming(null)}
                    className="rounded-lg px-2 py-1 text-[11px] text-aico-secondary
                               transition-colors hover:bg-aico-hover"
                  >
                    Keep it
                  </button>
                </div>
              </div>
            )}

            {open === file.path && (
              <div className="max-h-[28rem] overflow-auto border-t border-aico-border bg-aico-code py-2
                              font-mono text-[12px] leading-[19px] selectable">
                {diff
                  ? diff.split('\n').map((line, i) => <DiffLine key={i} text={line} />)
                  : <div className="px-3 text-aico-muted">Reading…</div>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
