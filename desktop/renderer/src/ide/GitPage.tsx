/**
 * Source control for any project — what VS Code's panel does, the way this
 * app does it.
 *
 * Left: branch, sync (fetch / pull / push with ahead-behind), the commit box,
 * and the changes — staged, unstaged, untracked, conflicted — each file with
 * stage / unstage / discard. Right: the selected file's diff, or the history
 * (reusing the shared GitPanel: open a commit, branch from it, revert it).
 * "Write message" asks the agent for a commit message from the staged diff.
 *
 * Every move goes through the engine's git-ops, which never force-pushes,
 * never resets, and only fast-forwards on pull.
 *
 * @module desktop/renderer/ide/GitPage
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type GitStatus, type GitStatusEntry, type BranchList, type GitRunAction } from '@web/api';
import { useStore } from '@web/store';
import { useProjects } from '@/lib/projects';
import { GitPanel } from '@web/components/GitPanel';
import { useDesk, go, toast } from '@/state/desk';
import { on } from '@/desktop';
import { Icon } from '@/lib/icons';
import { basename, cls, dirname } from '@/lib/util';
import { MenuButton, MenuItem, MenuSep } from '@/shell/Popover';
import { desktop, invoke } from '@/desktop';
import type { ViewProps } from '@/plugins/registry';
import { DiffView } from './DiffView';
import { newChat } from '@/chat/actions';

const LETTER: Record<string, { label: string; cls: string }> = {
  M: { label: 'M', cls: 'text-aico-warning' }, A: { label: 'A', cls: 'text-aico-success' }, D: { label: 'D', cls: 'text-aico-danger' },
  R: { label: 'R', cls: 'text-aico-info' }, C: { label: 'C', cls: 'text-aico-info' }, U: { label: 'U', cls: 'text-aico-danger' },
  '?': { label: 'U', cls: 'text-aico-success' }, T: { label: 'T', cls: 'text-aico-warning' },
};

export function GitPage({ params }: ViewProps): React.ReactElement {
  const project = useStore(s => s.project);
  const projects = useProjects();
  const [chosen, setChosen] = useState<string | null>(() => { try { return localStorage.getItem('desk.gitProject'); } catch { return null; } });
  const known = projects.filter(p => p.exists && !p.isWorkspace);
  const path = params?.path ?? (chosen && projects.some(p => p.path === chosen) ? chosen : null) ?? project ?? known[0]?.path ?? '';
  if (!path) return <div className="flex flex-1 items-center justify-center text-aico-muted">Open a project to use source control.</div>;
  const pick = (p: string): void => { setChosen(p); try { localStorage.setItem('desk.gitProject', p); } catch { /* fine */ } useDesk.getState().navigate({ view: 'git', params: { path: p } }, { replace: true }); };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-aico-border-subtle px-4 py-2">
        <Icon name="git" size={16} className="text-aico-secondary" />
        <select className="select h-8 w-64 py-0" value={path} onChange={e => pick(e.target.value)} aria-label="Repository">
          {projects.filter(p => p.exists).map(p => <option key={p.path} value={p.path}>{p.isWorkspace ? 'Workspace' : p.name}</option>)}
        </select>
        <span className="truncate font-mono text-[11.5px] text-aico-muted">{path}</span>
      </div>
      <SourceControl key={path} path={path} />
    </div>
  );
}

export function SourceControl({ path, embedded }: { path: string; embedded?: boolean }): React.ReactElement {
  const projects = useProjects();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<BranchList | null>(null);
  const [selected, setSelected] = useState<{ file: string; staged: boolean } | null>(null);
  const [tab, setTab] = useState<'changes' | 'history'>('changes');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, b] = await Promise.all([api.gitStatus(path), api.gitBranches(path).catch(() => null)]);
      setStatus(s); setBranches(b); setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [path]);

  useEffect(() => { setStatus(null); setSelected(null); void load(); }, [load]);
  useEffect(() => {
    void invoke('fs:watch', path);
    const off = on<{ root: string }>('fs:changed', (e) => { if (e.root === path) void load(); });
    const t = setInterval(() => void load(), 8000);
    return () => { off(); clearInterval(t); };
  }, [path, load]);

  const act = async (action: GitRunAction, opts: Parameters<typeof api.gitRun>[2] = {}, label?: string): Promise<boolean> => {
    setBusy(action);
    try {
      const r = await api.gitRun(path, action, opts);
      setStatus(r.status); setBranches({ current: r.current, branches: r.branches });
      if (label) toast.success(label, typeof r.detail === 'string' ? r.detail.split('\n').slice(-2).join('\n') : undefined);
      return true;
    } catch (e) {
      toast.error(`git ${action} failed`, (e as Error).message);
      return false;
    } finally { setBusy(null); }
  };

  const name = projects.find(p => p.path === path)?.name ?? basename(path);

  if (status && !status.isRepo) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <Icon name="git" size={30} className="text-aico-muted" />
        <div className="text-[15px] font-medium">{name} is not a git repository</div>
        <p className="max-w-sm text-[13px] text-aico-muted">Start tracking its history — nothing is committed until you say so.</p>
        <button className="btn-primary" onClick={() => void act('init', {}, 'Repository created')}>Initialise repository</button>
      </div>
    );
  }

  const totalChanges = status ? status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length : 0;

  const commit = async (all = false): Promise<void> => {
    if (!message.trim()) { toast.warning('Write a commit message first'); return; }
    const ok = await act('commit', { message, all }, 'Committed');
    if (ok) setMessage('');
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[360px] shrink-0 flex-col border-r border-aico-border-subtle">
        {/* Branch and sync */}
        <div className="flex items-center gap-1.5 border-b border-aico-border-subtle px-3 py-2">
          <MenuButton className="flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] hover:bg-aico-hover" title="Branches" width={300}
            button={<><Icon name="git-branch" size={14} /><span className="truncate font-medium">{status?.branch ?? branches?.current ?? '(detached)'}</span><Icon name="chevron-down" size={12} /></>}>
            {close => (
              <>
                <div className="px-2.5 pb-1 pt-1.5 text-[12px] text-aico-muted">Switch branch</div>
                {branches?.branches.map(b => (
                  <MenuItem key={b.name} icon="git-branch" label={b.name} checked={b.current} hint={b.lastCommit}
                    onClick={() => { close(); if (!b.current) void act('switch', { name: b.name }, `On ${b.name}`); }} />
                ))}
                <MenuSep />
                <MenuItem icon="plus" label="New branch from here…" onClick={() => {
                  close();
                  const n = window.prompt('Name the new branch');
                  if (n?.trim()) void act('new-branch', { name: n.trim() }, `On ${n.trim()}`);
                }} />
                <MenuItem icon="trash" label="Delete a merged branch…" onClick={() => {
                  close();
                  const n = window.prompt('Which branch? (only fully merged branches are deleted)');
                  if (n?.trim()) void act('delete-branch', { name: n.trim() }, `Deleted ${n.trim()}`);
                }} />
              </>
            )}
          </MenuButton>
          <div className="flex-1" />
          {status?.upstream && (
            <span className="text-[11.5px] text-aico-muted" title={`Tracking ${status.upstream}`}>
              {status.behind > 0 && <span className="mr-1">↓{status.behind}</span>}{status.ahead > 0 && <span>↑{status.ahead}</span>}
            </span>
          )}
          <button className="icon-btn-sm" onClick={() => void act('fetch', {}, 'Fetched')} disabled={!!busy} title="Fetch" aria-label="Fetch">{busy === 'fetch' ? <span className="spinner h-3 w-3" /> : <Icon name="refresh" size={14} />}</button>
          <button className="icon-btn-sm" onClick={() => void act('pull', {}, 'Pulled')} disabled={!!busy} title="Pull (fast-forward only)" aria-label="Pull">{busy === 'pull' ? <span className="spinner h-3 w-3" /> : <Icon name="arrow-down" size={14} />}</button>
          <button className="icon-btn-sm" onClick={() => void act('push', {}, 'Pushed')} disabled={!!busy || !status?.remotes.length} title={status?.remotes.length ? 'Push' : 'No remote'} aria-label="Push">{busy === 'push' ? <span className="spinner h-3 w-3" /> : <Icon name="arrow-up" size={14} />}</button>
          <MenuButton className="icon-btn-sm" title="More" button={<Icon name="more" size={14} />} placement="bottom-end" width={240}>
            {close => (
              <>
                <MenuItem icon="archive" label="Stash changes" onClick={() => { close(); void act('stash', { includeUntracked: true, message: window.prompt('Stash message (optional)') ?? '' }, 'Stashed'); }} />
                <StashItems path={path} onPop={(ref) => { close(); void act('stash-pop', { ref }, 'Stash applied'); }} />
                <MenuSep />
                <MenuItem icon="terminal" label="Open terminal here" onClick={() => { close(); useDesk.getState().setPanel({ open: true, tab: 'terminal' }); window.dispatchEvent(new CustomEvent('desk:terminal', { detail: { cwd: path } })); }} />
                <MenuItem icon="github" label="GitHub" onClick={() => { close(); go('github', { path }); }} />
              </>
            )}
          </MenuButton>
        </div>

        <div className="flex gap-1 border-b border-aico-border-subtle px-3 py-1.5">
          {(['changes', 'history'] as const).map(t => (
            <button key={t} className={cls('rounded-md px-2.5 py-1 text-[12.5px]', tab === t ? 'bg-aico-hover font-medium' : 'text-aico-muted hover:text-aico-primary')} onClick={() => setTab(t)}>
              {t === 'changes' ? `Changes${totalChanges ? ` (${totalChanges})` : ''}` : 'History'}
            </button>
          ))}
        </div>

        {tab === 'changes' && (
          <>
            <div className="border-b border-aico-border-subtle p-3">
              <textarea className="input min-h-[64px] resize-y text-[13px]" placeholder={`Message (Ctrl+Enter to commit on ${status?.branch ?? 'HEAD'})`} value={message}
                onChange={e => setMessage(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void commit(); }} />
              <div className="mt-2 flex gap-1.5">
                <button className="btn-primary btn-sm flex-1" onClick={() => void commit(status ? status.staged.length === 0 : false)} disabled={!!busy || totalChanges === 0}>
                  {busy === 'commit' && <span className="spinner h-3 w-3" />}
                  <Icon name="check" size={13} />{status && status.staged.length === 0 ? 'Commit all' : 'Commit'}
                </button>
                <button className="btn-outline btn-sm" title="Ask the agent to write the message from the staged changes"
                  onClick={() => newChat({ project: path, prompt: 'Look at the staged changes in this repository (git diff --cached) and write a concise, conventional commit message for them. Reply with only the message.', send: true })}>
                  <Icon name="sparkles" size={13} />Write message
                </button>
              </div>
            </div>
            <div className="thin-scroll min-h-0 flex-1 overflow-y-auto py-1">
              {!status && <div className="space-y-2 p-3">{[0, 1, 2].map(i => <div key={i} className="skeleton h-6" />)}</div>}
              {error && <div className="p-3 text-[12.5px] text-aico-danger">{error}</div>}
              {status && totalChanges === 0 && <div className="p-6 text-center text-[13px] text-aico-muted">No changes. The working tree is clean.</div>}
              {status && (
                <>
                  <FileGroup title="Merge conflicts" files={status.conflicted} selected={selected} onSelect={f => setSelected({ file: f, staged: false })}
                    actions={f => <button className="icon-btn-sm" title="Mark resolved (stage)" onClick={() => void act('stage', { paths: [f] })}><Icon name="check" size={13} /></button>} />
                  <FileGroup title="Staged" files={status.staged} selected={selected} staged onSelect={f => setSelected({ file: f, staged: true })}
                    headerAction={<button className="icon-btn-sm" title="Unstage all" onClick={() => void act('unstage', { paths: 'all' })}><Icon name="minus" size={13} /></button>}
                    actions={f => <button className="icon-btn-sm" title="Unstage" onClick={() => void act('unstage', { paths: [f] })}><Icon name="minus" size={13} /></button>} />
                  <FileGroup title="Changes" files={status.unstaged} selected={selected} onSelect={f => setSelected({ file: f, staged: false })}
                    headerAction={<button className="icon-btn-sm" title="Stage all" onClick={() => void act('stage', { paths: 'all' })}><Icon name="plus" size={13} /></button>}
                    actions={f => (
                      <>
                        <button className="icon-btn-sm" title="Discard changes" onClick={() => void desktop.dialog.confirm({ title: 'Discard changes', message: `Discard your changes to ${basename(f)}?`, detail: 'The file goes back to its last committed state. This cannot be undone.', ok: 'Discard', danger: true })
                          .then(ok => { if (ok) void act('discard', { paths: [f] }, 'Discarded'); })}><Icon name="refresh" size={13} /></button>
                        <button className="icon-btn-sm" title="Stage" onClick={() => void act('stage', { paths: [f] })}><Icon name="plus" size={13} /></button>
                      </>
                    )} />
                  <FileGroup title="Untracked" files={status.untracked} selected={selected} onSelect={f => setSelected({ file: f, staged: false })}
                    actions={f => (
                      <>
                        <button className="icon-btn-sm" title="Move to trash" onClick={() => void desktop.dialog.confirm({ title: 'Move to trash', message: `Move ${basename(f)} to the trash?`, ok: 'Move to trash' })
                          .then(ok => { if (ok) void invoke('fs:trash', `${path}/${f}`).then(() => load()); })}><Icon name="trash" size={13} /></button>
                        <button className="icon-btn-sm" title="Stage" onClick={() => void act('stage', { paths: [f] })}><Icon name="plus" size={13} /></button>
                      </>
                    )} />
                </>
              )}
            </div>
          </>
        )}
        {tab === 'history' && (
          <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-3"><GitPanel path={path} /></div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <FileDiffPanel path={path} file={selected.file} staged={selected.staged} onOpen={() => go('files', { root: path, open: `${path}/${selected.file}` })} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-aico-muted">
            <Icon name="git-commit" size={28} />
            <div className="text-[13.5px]">{embedded ? 'Select a file to see its diff.' : `Select a changed file in ${name} to see its diff.`}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function StashItems({ path, onPop }: { path: string; onPop: (ref: string) => void }): React.ReactElement | null {
  const [stashes, setStashes] = useState<Array<{ ref: string; message: string }>>([]);
  useEffect(() => { void api.gitStashes(path).then(r => setStashes(r.stashes)).catch(() => {}); }, [path]);
  if (!stashes.length) return null;
  return (
    <>
      <div className="px-2.5 pb-1 pt-2 text-[12px] text-aico-muted">Apply a stash</div>
      {stashes.slice(0, 8).map(s => <MenuItem key={s.ref} icon="inbox" label={s.message || s.ref} hint={s.ref} onClick={() => onPop(s.ref)} />)}
    </>
  );
}

function FileGroup({ title, files, selected, onSelect, actions, headerAction, staged }: {
  title: string; files: GitStatusEntry[]; selected: { file: string; staged: boolean } | null; staged?: boolean;
  onSelect: (file: string) => void; actions: (file: string) => React.ReactNode; headerAction?: React.ReactNode;
}): React.ReactElement | null {
  const [open, setOpen] = useState(true);
  if (files.length === 0) return null;
  return (
    <div className="mb-1">
      <div className="group flex items-center px-3 py-1">
        <button className="flex flex-1 items-center gap-1 text-[11.5px] font-medium uppercase tracking-wide text-aico-muted" onClick={() => setOpen(o => !o)}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />{title}<span className="ml-1 rounded-full bg-aico-hover px-1.5 text-[10.5px]">{files.length}</span>
        </button>
        <span className="opacity-0 group-hover:opacity-100">{headerAction}</span>
      </div>
      {open && files.map(f => {
        const letter = staged ? f.index : f.worktree === ' ' ? f.index : f.worktree;
        const tone = LETTER[letter] ?? { label: letter, cls: 'text-aico-muted' };
        const active = selected?.file === f.path && selected.staged === Boolean(staged);
        return (
          <div key={`${title}:${f.path}`} className={cls('group flex items-center gap-2 px-3 py-[3px] text-[13px]', active ? 'bg-aico-accent-soft' : 'hover:bg-aico-hover')}>
            <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => onSelect(f.path)} title={f.from ? `${f.from} → ${f.path}` : f.path}>
              <Icon name="file" size={13} className="shrink-0 text-aico-muted" />
              <span className="truncate">{basename(f.path)}</span>
              <span className="truncate text-[11.5px] text-aico-muted">{dirname(f.path) !== f.path ? dirname(f.path) : ''}</span>
            </button>
            <span className="hidden shrink-0 items-center group-hover:flex">{actions(f.path)}</span>
            <span className={cls('w-3 shrink-0 text-center font-mono text-[11.5px] font-semibold', tone.cls)}>{tone.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function FileDiffPanel({ path, file, staged, onOpen }: { path: string; file: string; staged: boolean; onOpen: () => void }): React.ReactElement {
  const [diff, setDiff] = useState<{ diff: string; truncated: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setDiff(null); setErr(null);
    api.gitDiff(path, file, staged).then(setDiff).catch(e => setErr((e as Error).message));
  }, [path, file, staged]);
  const stats = useMemo(() => {
    const lines = diff?.diff.split('\n') ?? [];
    return { add: lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length, del: lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length };
  }, [diff]);
  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-aico-border-subtle px-4 text-[13px]">
        <Icon name="file" size={14} className="text-aico-muted" />
        <span className="truncate font-medium">{file}</span>
        <span className="text-aico-muted">{staged ? '(staged)' : ''}</span>
        <span className="font-mono text-[12px] text-aico-success">+{stats.add}</span>
        <span className="font-mono text-[12px] text-aico-danger">−{stats.del}</span>
        <div className="flex-1" />
        <button className="btn-ghost btn-sm" onClick={onOpen}><Icon name="code" size={13} />Open file</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {err && <div className="p-4 text-[13px] text-aico-danger">{err}</div>}
        {!diff && !err && <div className="space-y-1.5 p-4">{[0, 1, 2, 3, 4].map(i => <div key={i} className="skeleton h-4" />)}</div>}
        {diff && <DiffView diff={diff.diff} />}
        {diff?.truncated && <div className="p-3 text-[12px] text-aico-muted">The diff is larger than shown.</div>}
        {diff && !diff.diff && <div className="p-6 text-center text-[13px] text-aico-muted">No textual changes (binary, mode or whitespace only).</div>}
      </div>
    </>
  );
}
