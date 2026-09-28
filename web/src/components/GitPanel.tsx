/**
 * A workspace's git: branches, history, and the everyday moves.
 *
 * The history used to be a list you could only read. Now a commit opens to its
 * files and diff, a branch can be switched to, a new branch can be made at any
 * commit ("restore" without losing anything — the branch you were on keeps all
 * of it), and a commit can be reverted by a new commit. Every move is checked
 * by the server first (see `server/git-ops.ts`): uncommitted changes block a
 * switch or a revert rather than being carried along, and a conflicting revert
 * is cancelled. Errors are shown where the action was taken.
 *
 * @module components/GitPanel
 */

import React, { useCallback, useEffect, useState } from 'react';
import { api, type BranchList, type CommitDetail, type CommitInfo, type GitLogPage } from '../api';
import { Icon } from './Icon';

export function GitPanel({ path }: { path: string }): React.ReactElement {
  const [log, setLog] = useState<GitLogPage | null>(null);
  const [branches, setBranches] = useState<BranchList | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const [nextLog, nextBranches] = await Promise.all([
      api.gitLog(path, { limit: 20 }).catch(() => null),
      api.gitBranches(path).catch(() => null),
    ]);
    setLog(nextLog);
    setBranches(nextBranches);
  }, [path]);

  useEffect(() => {
    setLog(null);
    setBranches(null);
    setOpen(null);
    setMessage(null);
    void reload();
  }, [reload]);

  const act = async (label: string, run: () => Promise<unknown>): Promise<boolean> => {
    setMessage(null);
    try {
      await run();
      setMessage({ kind: 'ok', text: label });
      await reload();
      return true;
    } catch (err) {
      setMessage({ kind: 'error', text: (err as Error).message });
      return false;
    }
  };

  const loadMore = async (): Promise<void> => {
    const last = log?.commits[log.commits.length - 1];
    if (!log?.hasMore || !last || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await api.gitLog(path, { limit: 20, before: last.hash });
      setLog(prev => (prev ? { ...next, commits: [...prev.commits, ...next.commits] } : next));
    } finally {
      setLoadingMore(false);
    }
  };

  if (!log) return <p className="py-3 text-[12px] text-aico-muted">Loading…</p>;
  if (!log.isRepo) return <p className="py-3 text-[12px] text-aico-muted">This workspace is not a git repository.</p>;

  return (
    <div className="space-y-3">
      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'}
          className={`rounded-lg px-3 py-2 text-[12px] ${message.kind === 'error'
            ? 'bg-aico-danger/10 text-aico-danger' : 'bg-aico-accent-soft text-aico-accent'}`}>
          {message.text}
        </p>
      )}

      {branches && branches.branches.length > 0 && (
        <div>
          <h3 className="mb-1 text-[12px] font-medium text-aico-secondary">
            Branches {branches.current ? <>· on <span className="font-mono text-aico-primary">{branches.current}</span></> : null}
          </h3>
          <ul className="flex flex-wrap gap-1.5">
            {branches.branches.map(b => (
              <li key={b.name}>
                <button
                  disabled={b.current}
                  onClick={() => void act(`Switched to ${b.name}.`, () => api.gitAction(path, 'switch', { name: b.name }))}
                  title={b.current ? 'The current branch' : `Switch to ${b.name}`}
                  className={`flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors
                              ${b.current ? 'border-aico-accent/50 bg-aico-accent-soft text-aico-accent'
                                : 'border-aico-border-subtle text-aico-secondary hover:bg-aico-hover'}`}
                >
                  {b.current && <Icon name="check" size={11} />}{b.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {log.commits.length === 0 ? (
        <p className="py-3 text-[12px] text-aico-muted">No commits yet.</p>
      ) : (
        <>
          <ul className="divide-y divide-aico-border-subtle">
            {log.commits.map(commit => (
              <CommitItem
                key={commit.hash}
                commit={commit}
                path={path}
                open={open === commit.hash}
                onToggle={() => setOpen(open === commit.hash ? null : commit.hash)}
                act={act}
              />
            ))}
          </ul>
          {log.hasMore && (
            <button
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="w-full rounded-lg border border-aico-border-subtle py-1.5 text-[12px] text-aico-secondary
                         transition-colors hover:bg-aico-hover disabled:opacity-50"
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function CommitItem({ commit, path, open, onToggle, act }: {
  commit: CommitInfo;
  path: string;
  open: boolean;
  onToggle: () => void;
  act: (label: string, run: () => Promise<unknown>) => Promise<boolean>;
}): React.ReactElement {
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [branchName, setBranchName] = useState('');
  const [switchTo, setSwitchTo] = useState(true);
  const [confirmRevert, setConfirmRevert] = useState(false);

  useEffect(() => {
    if (!open || detail) return;
    void api.gitShow(path, commit.hash).then(setDetail).catch(err => setError((err as Error).message));
  }, [open, detail, path, commit.hash]);

  const small = 'rounded-lg border px-2.5 py-1 text-[12px] transition-colors disabled:opacity-50';
  return (
    <li>
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 py-1.5 text-left transition-colors hover:bg-aico-hover"
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} className="shrink-0 text-aico-muted" />
        <span className="shrink-0 rounded bg-aico-hover px-1.5 py-0.5 font-mono text-[11px] text-aico-secondary" title={commit.hash}>
          {commit.shortHash}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-aico-primary">{commit.subject}</span>
        <span className="shrink-0 text-[11px] text-aico-muted">{commit.author}</span>
        <span className="shrink-0 text-[11px] text-aico-muted" title={commit.date}>
          {Number.isNaN(Date.parse(commit.date)) ? '' : new Date(commit.date).toLocaleDateString()}
        </span>
      </button>

      {open && (
        <div className="mb-3 ml-5 space-y-2 rounded-lg border border-aico-border-subtle bg-aico-surface p-3">
          {error && <p role="alert" className="text-[12px] text-aico-danger">{error}</p>}
          {!detail && !error && <p className="text-[12px] text-aico-muted">Loading…</p>}
          {detail && (
            <>
              {detail.body && <pre className="whitespace-pre-wrap text-[12px] text-aico-secondary">{detail.body}</pre>}
              <ul className="space-y-0.5">
                {detail.files.map(f => (
                  <li key={f.path} className="flex gap-2 font-mono text-[11px]">
                    <span className={`w-3 shrink-0 ${f.status === 'A' ? 'text-emerald-500' : f.status === 'D' ? 'text-aico-danger' : 'text-aico-accent'}`}>
                      {f.status}
                    </span>
                    <span className="min-w-0 truncate text-aico-primary">{f.path}</span>
                  </li>
                ))}
              </ul>
              <pre className="max-h-80 overflow-auto rounded border border-aico-border-subtle bg-aico-bg p-2 text-[11px] leading-snug">
                {detail.diff.split('\n').map((line, i) => (
                  <div key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'text-emerald-600'
                    : line.startsWith('-') && !line.startsWith('---') ? 'text-aico-danger'
                    : line.startsWith('@@') ? 'text-aico-accent' : 'text-aico-secondary'}>
                    {line || ' '}
                  </div>
                ))}
                {detail.truncated && <div className="text-aico-muted">… diff cut here; it is larger than the page shows.</div>}
              </pre>

              <div className="flex flex-wrap items-center gap-2 border-t border-aico-border-subtle pt-2">
                <input
                  value={branchName}
                  onChange={e => setBranchName(e.target.value)}
                  placeholder="new-branch-name"
                  aria-label="Name for a new branch at this commit"
                  className="w-44 rounded-lg border border-aico-border-subtle bg-aico-bg px-2.5 py-1 font-mono text-[12px]
                             text-aico-primary placeholder:text-aico-muted focus:border-aico-accent/60 focus:outline-none"
                />
                <label className="flex items-center gap-1 text-[12px] text-aico-secondary">
                  <input type="checkbox" checked={switchTo} onChange={() => setSwitchTo(v => !v)} className="accent-aico-accent" />
                  and switch to it
                </label>
                <button
                  disabled={!branchName.trim()}
                  onClick={() => void act(`Branch ${branchName.trim()} created at ${commit.shortHash}.`,
                    () => api.gitAction(path, 'branch', { name: branchName.trim(), at: commit.hash, switchTo }))
                    .then(ok => { if (ok) setBranchName(''); })}
                  title="Restore this point as a new branch — the current branch is left exactly as it is"
                  className={`${small} border-aico-border-subtle hover:bg-aico-hover`}
                >
                  Branch from here
                </button>
                {!confirmRevert ? (
                  <button onClick={() => setConfirmRevert(true)}
                    className={`${small} border-aico-danger/40 text-aico-danger hover:bg-aico-danger/10`}>
                    Revert…
                  </button>
                ) : (
                  <span className="flex items-center gap-2">
                    <span className="text-[12px] text-aico-danger">Add a commit undoing {commit.shortHash}?</span>
                    <button onClick={() => void act(`Reverted ${commit.shortHash} with a new commit.`,
                      () => api.gitAction(path, 'revert', { at: commit.hash })).then(() => setConfirmRevert(false))}
                      className={`${small} border-aico-danger/40 bg-aico-danger/10 text-aico-danger`}>Revert</button>
                    <button onClick={() => setConfirmRevert(false)}
                      className={`${small} border-aico-border-subtle hover:bg-aico-hover`}>Keep</button>
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </li>
  );
}
