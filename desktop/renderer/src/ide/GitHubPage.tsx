/**
 * GitHub for the current project: pull requests, issues and Actions runs,
 * each opening to its detail (body, checks, files, diff, comments), with the
 * common moves — check out a PR, merge it, comment, open a PR or an issue,
 * re-run failed jobs — and "Ask AI" on anything (review this PR, fix this
 * issue, explain this failed run).
 *
 * @module desktop/renderer/ide/GitHubPage
 */

import React, { useCallback, useEffect, useState } from 'react';
import { MarkdownRenderer } from '@aico/ui';
import { useStore } from '@web/store';
import { useProjects } from '@/lib/projects';
import { invoke, desktop } from '@/desktop';
import { useDesk, toast } from '@/state/desk';
import { Icon } from '@/lib/icons';
import { ago, basename, cls } from '@/lib/util';
import { Modal } from '@/shell/Modal';
import { newChat } from '@/chat/actions';
import type { ViewProps } from '@/plugins/registry';
import { DiffView } from './DiffView';

interface GhStatus { installed: boolean; signedIn: boolean; version?: string; user?: { login: string; name?: string }; error?: string }
interface Pr { number: number; title: string; author: { login: string }; state: string; isDraft: boolean; headRefName: string; baseRefName: string; updatedAt: string; url: string; reviewDecision?: string; additions?: number; deletions?: number; changedFiles?: number; labels?: Array<{ name: string }> }
interface Issue { number: number; title: string; author: { login: string }; state: string; updatedAt: string; url: string; labels?: Array<{ name: string; color?: string }>; comments?: Array<{ author: { login: string }; body: string; createdAt: string }> }
interface Run { databaseId: number; displayTitle: string; workflowName: string; status: string; conclusion: string; headBranch: string; event: string; updatedAt: string; url: string }

export function GitHubPage({ params }: ViewProps): React.ReactElement {
  const project = useStore(s => s.project);
  const projects = useProjects();
  const [path, setPath] = useState(params?.path ?? (project && !projects.find(p => p.path === project)?.isWorkspace ? project : projects.find(p => !p.isWorkspace)?.path) ?? '');
  const [status, setStatus] = useState<GhStatus | null>(null);
  const [repo, setRepo] = useState<{ nameWithOwner: string; url: string; description?: string; stargazerCount: number; forkCount: number; isPrivate: boolean; defaultBranchRef?: { name: string } } | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [tab, setTab] = useState<'prs' | 'issues' | 'runs'>('prs');

  useEffect(() => { void invoke<GhStatus>('gh:status').then(setStatus); }, []);
  useEffect(() => {
    setRepo(null); setRepoError(null);
    if (!path || !status?.signedIn) return;
    invoke<typeof repo>('gh:repo', path).then(setRepo).catch(e => setRepoError((e as Error).message));
  }, [path, status?.signedIn]);

  if (!status) return <div className="p-8"><div className="skeleton h-8 w-64" /></div>;
  if (!status.installed || !status.signedIn) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="card max-w-md p-6 text-center">
          <Icon name="github" size={32} className="mx-auto" />
          <h2 className="mt-3 text-[17px] font-semibold">{status.installed ? 'Sign in to GitHub' : 'Install the GitHub CLI'}</h2>
          <p className="mt-2 text-[13px] text-aico-secondary">
            {status.installed
              ? 'AICO uses the GitHub CLI’s sign-in, so it never stores a GitHub token itself.'
              : 'AICO talks to GitHub through the official CLI, which keeps your sign-in in the system keychain.'}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            {status.installed ? (
              <button className="btn-primary" onClick={() => { useDesk.getState().setPanel({ open: true, tab: 'terminal' }); window.dispatchEvent(new CustomEvent('desk:terminal', { detail: { run: 'gh auth login --web' } })); }}>Sign in (in the terminal)</button>
            ) : (
              <button className="btn-primary" onClick={() => void desktop.shell.openExternal('https://cli.github.com')}>Get the GitHub CLI</button>
            )}
            <button className="btn-outline" onClick={() => void invoke<GhStatus>('gh:status').then(setStatus)}>Check again</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-aico-border-subtle px-6 py-3">
        <Icon name="github" size={20} />
        <select className="select w-56" value={path} onChange={e => setPath(e.target.value)} aria-label="Project">
          {projects.filter(p => !p.isWorkspace).map(p => <option key={p.path} value={p.path}>{p.name}</option>)}
        </select>
        {repo && (
          <button className="min-w-0 truncate text-[14px] font-medium hover:underline" onClick={() => void desktop.shell.openExternal(repo.url)}>{repo.nameWithOwner}</button>
        )}
        {repo && <span className="text-[12px] text-aico-muted">★ {repo.stargazerCount} · {repo.isPrivate ? 'private' : 'public'}</span>}
        <div className="flex-1" />
        <span className="text-[12px] text-aico-muted">Signed in as {status.user?.login}</span>
      </div>
      {repoError ? (
        <div className="p-8 text-center text-[13.5px] text-aico-muted">
          {basename(path)} is not a GitHub repository ({repoError.split('\n')[0]}).
        </div>
      ) : (
        <>
          <div className="flex gap-1 border-b border-aico-border-subtle px-6 py-2">
            {([['prs', 'Pull requests', 'git-pr'], ['issues', 'Issues', 'bug'], ['runs', 'Actions', 'play']] as const).map(([id, label, icon]) => (
              <button key={id} className={cls('flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px]', tab === id ? 'bg-aico-hover font-medium' : 'text-aico-secondary hover:text-aico-primary')} onClick={() => setTab(id)}>
                <Icon name={icon} size={14} />{label}
              </button>
            ))}
          </div>
          {tab === 'prs' && <PullRequests path={path} base={repo?.defaultBranchRef?.name} />}
          {tab === 'issues' && <Issues path={path} />}
          {tab === 'runs' && <Runs path={path} />}
        </>
      )}
    </div>
  );
}

function useList<T>(channel: string, path: string, state: string): { items: T[] | null; error: string | null; reload: () => void } {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    setItems(null); setError(null);
    invoke<T[]>(channel, path, state).then(setItems).catch(e => { setError((e as Error).message); setItems([]); });
  }, [channel, path, state]);
  useEffect(() => { reload(); }, [reload]);
  return { items, error, reload };
}

function PullRequests({ path, base }: { path: string; base?: string }): React.ReactElement {
  const [state, setState] = useState('open');
  const { items, error, reload } = useList<Pr>('gh:prList', path, state);
  const [open, setOpen] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[420px] shrink-0 flex-col border-r border-aico-border-subtle">
        <div className="flex items-center gap-2 px-4 py-2">
          <div className="segmented">{['open', 'merged', 'closed'].map(s => <button key={s} aria-pressed={state === s} onClick={() => setState(s)}>{s[0]!.toUpperCase() + s.slice(1)}</button>)}</div>
          <div className="flex-1" />
          <button className="icon-btn-sm" onClick={reload} aria-label="Refresh"><Icon name="refresh" size={14} /></button>
          <button className="btn-primary btn-sm" onClick={() => setCreating(true)}><Icon name="plus" size={13} />New PR</button>
        </div>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
          {items === null && <div className="space-y-2 p-4">{[0, 1, 2, 3].map(i => <div key={i} className="skeleton h-12" />)}</div>}
          {error && <div className="p-4 text-[12.5px] text-aico-danger">{error}</div>}
          {items?.length === 0 && !error && <div className="p-8 text-center text-[13px] text-aico-muted">No {state} pull requests.</div>}
          {items?.map(p => (
            <button key={p.number} className={cls('block w-full border-b border-aico-border-subtle px-4 py-2.5 text-left hover:bg-aico-hover', open === p.number && 'bg-aico-accent-soft')} onClick={() => setOpen(p.number)}>
              <div className="flex items-center gap-2 text-[13.5px]">
                <Icon name="git-pr" size={14} className={p.state === 'MERGED' ? 'text-purple-500' : p.state === 'CLOSED' ? 'text-aico-danger' : p.isDraft ? 'text-aico-muted' : 'text-aico-success'} />
                <span className="min-w-0 flex-1 truncate font-medium">{p.title}</span>
              </div>
              <div className="mt-0.5 flex gap-2 pl-6 text-[11.5px] text-aico-muted">
                <span>#{p.number}</span><span>{p.author.login}</span><span className="truncate font-mono">{p.headRefName}</span><span>{ago(Date.parse(p.updatedAt))}</span>
                {p.reviewDecision && <span className={p.reviewDecision === 'APPROVED' ? 'text-aico-success' : p.reviewDecision === 'CHANGES_REQUESTED' ? 'text-aico-danger' : ''}>{p.reviewDecision.toLowerCase().replace('_', ' ')}</span>}
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {open ? <PrDetail path={path} n={open} onChanged={reload} /> : <Empty icon="git-pr" text="Select a pull request." />}
      </div>
      <CreateDialog open={creating} onClose={() => setCreating(false)} kind="pr" path={path} base={base} onCreated={reload} />
    </div>
  );
}

function PrDetail({ path, n, onChanged }: { path: string; n: number; onChanged: () => void }): React.ReactElement {
  const [pr, setPr] = useState<(Pr & { body: string; files: Array<{ path: string; additions: number; deletions: number }>; comments: Array<{ author: { login: string }; body: string; createdAt: string }> }) | null>(null);
  type Check = { name: string; state: string; bucket: string; link: string };
  const [checks, setChecks] = useState<Check[]>([]);
  const [diff, setDiff] = useState<string | null>(null);
  const [view, setView] = useState<'overview' | 'files'>('overview');
  const [comment, setComment] = useState('');
  const load = useCallback(() => {
    setPr(null); setDiff(null);
    void invoke<typeof pr>('gh:prView', path, n).then(setPr).catch(e => toast.error('Could not load the PR', (e as Error).message));
    void invoke<Check[]>('gh:prChecks', path, n).then(c => setChecks(c ?? [])).catch(() => setChecks([]));
  }, [path, n]);
  useEffect(load, [load]);
  useEffect(() => { if (view === 'files' && diff === null) void invoke<string>('gh:prDiff', path, n).then(setDiff).catch(e => setDiff(`Could not load the diff: ${(e as Error).message}`)); }, [view, diff, path, n]);

  if (!pr) return <div className="space-y-3 p-8"><div className="skeleton h-7 w-2/3" /><div className="skeleton h-40" /></div>;
  const act = async (label: string, run: () => Promise<unknown>, confirm?: { message: string; detail?: string }): Promise<void> => {
    if (confirm && !(await desktop.dialog.confirm({ title: label, message: confirm.message, detail: confirm.detail, ok: label }))) return;
    try { await run(); toast.success(label); load(); onChanged(); } catch (e) { toast.error(`${label} failed`, (e as Error).message); }
  };
  const failing = checks.filter(c => c.bucket === 'fail').length;
  return (
    <div className="px-8 py-6">
      <div className="flex items-start gap-3">
        <h2 className="min-w-0 flex-1 text-[20px] font-semibold">{pr.title} <span className="font-normal text-aico-muted">#{pr.number}</span></h2>
        <button className="btn-outline btn-sm" onClick={() => void desktop.shell.openExternal(pr.url)}><Icon name="external" size={13} />GitHub</button>
      </div>
      <div className="mt-1 text-[12.5px] text-aico-muted">{pr.author.login} wants to merge <span className="font-mono">{pr.headRefName}</span> into <span className="font-mono">{pr.baseRefName}</span> · <span className="text-aico-success">+{pr.additions}</span> <span className="text-aico-danger">−{pr.deletions}</span> in {pr.changedFiles} files</div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button className="btn-primary btn-sm" onClick={() => newChat({ project: path, prompt: `Review pull request #${pr.number} ("${pr.title}") in this repository. Use \`gh pr diff ${pr.number}\` and \`gh pr view ${pr.number}\`. Point out bugs, risky changes and missing tests, with file and line references.`, send: true })}><Icon name="sparkles" size={13} />Review with AI</button>
        {failing > 0 && <button className="btn-outline btn-sm" onClick={() => newChat({ project: path, prompt: `The checks on PR #${pr.number} are failing. Find out why (gh pr checks ${pr.number}, gh run view --log-failed) and fix it.`, send: true })}><Icon name="bug" size={13} />Fix failing checks</button>}
        <button className="btn-outline btn-sm" onClick={() => void act('Checked out', () => invoke('gh:prCheckout', path, n), { message: `Check out #${n} locally?`, detail: 'Switches this project to the PR branch.' })}><Icon name="git-branch" size={13} />Check out</button>
        {pr.state === 'OPEN' && pr.isDraft && <button className="btn-outline btn-sm" onClick={() => void act('Marked ready', () => invoke('gh:prReady', path, n))}>Ready for review</button>}
        {pr.state === 'OPEN' && !pr.isDraft && (
          <button className="btn-outline btn-sm" onClick={() => void act('Merged', () => invoke('gh:prMerge', path, n, 'squash'), { message: `Squash and merge #${n} into ${pr.baseRefName}?`, detail: 'This changes the repository on GitHub.' })}><Icon name="check" size={13} />Squash & merge</button>
        )}
      </div>
      {checks.length > 0 && (
        <div className="mt-5 overflow-hidden rounded-xl border border-aico-border-subtle">
          {checks.map((c, i) => (
            <div key={i} className="flex items-center gap-2 border-b border-aico-border-subtle px-3 py-1.5 text-[12.5px] last:border-b-0">
              <Icon name={c.bucket === 'pass' ? 'check-circle' : c.bucket === 'fail' ? 'x-circle' : 'clock'} size={14} className={c.bucket === 'pass' ? 'text-aico-success' : c.bucket === 'fail' ? 'text-aico-danger' : 'text-aico-warning'} />
              <span className="flex-1 truncate">{c.name}</span>
              {c.link && <button className="text-aico-accent hover:underline" onClick={() => void desktop.shell.openExternal(c.link)}>Details</button>}
            </div>
          ))}
        </div>
      )}
      <div className="mt-5 flex gap-1">
        {(['overview', 'files'] as const).map(v => <button key={v} className={cls('rounded-md px-3 py-1 text-[13px]', view === v ? 'bg-aico-hover font-medium' : 'text-aico-muted')} onClick={() => setView(v)}>{v === 'overview' ? 'Conversation' : `Files (${pr.files?.length ?? 0})`}</button>)}
      </div>
      {view === 'overview' ? (
        <div className="mt-3 space-y-4">
          <div className="rounded-xl border border-aico-border-subtle p-4"><div className="markdown-body text-[14px]"><MarkdownRenderer content={pr.body || '_No description._'} /></div></div>
          {pr.comments?.map((c, i) => (
            <div key={i} className="rounded-xl border border-aico-border-subtle p-4">
              <div className="mb-2 text-[12px] text-aico-muted">{c.author.login} · {ago(Date.parse(c.createdAt))}</div>
              <div className="markdown-body text-[14px]"><MarkdownRenderer content={c.body} /></div>
            </div>
          ))}
          <div className="rounded-xl border border-aico-border-subtle p-3">
            <textarea className="input min-h-[80px]" placeholder="Leave a comment" value={comment} onChange={e => setComment(e.target.value)} />
            <div className="mt-2 flex justify-end"><button className="btn-primary btn-sm" disabled={!comment.trim()} onClick={() => void act('Commented', () => invoke('gh:prComment', path, n, comment), { message: 'Post this comment on GitHub?' }).then(() => setComment(''))}>Comment</button></div>
          </div>
        </div>
      ) : (
        <div className="mt-3 overflow-hidden rounded-xl border border-aico-border-subtle">{diff === null ? <div className="p-4"><div className="skeleton h-40" /></div> : <DiffView diff={diff} />}</div>
      )}
    </div>
  );
}

function Issues({ path }: { path: string }): React.ReactElement {
  const [state, setState] = useState('open');
  const { items, error, reload } = useList<Issue>('gh:issueList', path, state);
  const [open, setOpen] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[420px] shrink-0 flex-col border-r border-aico-border-subtle">
        <div className="flex items-center gap-2 px-4 py-2">
          <div className="segmented">{['open', 'closed'].map(s => <button key={s} aria-pressed={state === s} onClick={() => setState(s)}>{s[0]!.toUpperCase() + s.slice(1)}</button>)}</div>
          <div className="flex-1" />
          <button className="icon-btn-sm" onClick={reload} aria-label="Refresh"><Icon name="refresh" size={14} /></button>
          <button className="btn-primary btn-sm" onClick={() => setCreating(true)}><Icon name="plus" size={13} />New issue</button>
        </div>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
          {items === null && <div className="space-y-2 p-4">{[0, 1, 2].map(i => <div key={i} className="skeleton h-12" />)}</div>}
          {error && <div className="p-4 text-[12.5px] text-aico-danger">{error}</div>}
          {items?.length === 0 && !error && <div className="p-8 text-center text-[13px] text-aico-muted">No {state} issues.</div>}
          {items?.map(i => (
            <button key={i.number} className={cls('block w-full border-b border-aico-border-subtle px-4 py-2.5 text-left hover:bg-aico-hover', open === i.number && 'bg-aico-accent-soft')} onClick={() => setOpen(i.number)}>
              <div className="flex items-center gap-2 text-[13.5px]"><Icon name="bug" size={14} className={i.state === 'OPEN' ? 'text-aico-success' : 'text-aico-muted'} /><span className="min-w-0 flex-1 truncate font-medium">{i.title}</span></div>
              <div className="mt-0.5 flex flex-wrap gap-2 pl-6 text-[11.5px] text-aico-muted">
                <span>#{i.number}</span><span>{i.author.login}</span><span>{ago(Date.parse(i.updatedAt))}</span>
                {i.labels?.slice(0, 3).map(l => <span key={l.name} className="rounded-full border border-aico-border px-1.5">{l.name}</span>)}
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {open ? <IssueDetail path={path} n={open} onChanged={reload} /> : <Empty icon="bug" text="Select an issue." />}
      </div>
      <CreateDialog open={creating} onClose={() => setCreating(false)} kind="issue" path={path} onCreated={reload} />
    </div>
  );
}

function IssueDetail({ path, n, onChanged }: { path: string; n: number; onChanged: () => void }): React.ReactElement {
  const [issue, setIssue] = useState<(Issue & { body: string; comments: Array<{ author: { login: string }; body: string; createdAt: string }> }) | null>(null);
  const [comment, setComment] = useState('');
  const load = useCallback(() => { setIssue(null); void invoke<typeof issue>('gh:issueView', path, n).then(setIssue).catch(e => toast.error('Could not load the issue', (e as Error).message)); }, [path, n]);
  useEffect(load, [load]);
  if (!issue) return <div className="space-y-3 p-8"><div className="skeleton h-7 w-2/3" /><div className="skeleton h-40" /></div>;
  const act = async (label: string, run: () => Promise<unknown>, message: string): Promise<void> => {
    if (!(await desktop.dialog.confirm({ title: label, message, ok: label }))) return;
    try { await run(); toast.success(label); load(); onChanged(); } catch (e) { toast.error(`${label} failed`, (e as Error).message); }
  };
  return (
    <div className="px-8 py-6">
      <div className="flex items-start gap-3">
        <h2 className="min-w-0 flex-1 text-[20px] font-semibold">{issue.title} <span className="font-normal text-aico-muted">#{issue.number}</span></h2>
        <button className="btn-outline btn-sm" onClick={() => void desktop.shell.openExternal(issue.url)}><Icon name="external" size={13} />GitHub</button>
      </div>
      <div className="mt-4 flex gap-2">
        <button className="btn-primary btn-sm" onClick={() => newChat({ project: path, prompt: `Fix GitHub issue #${issue.number}: "${issue.title}".\n\n${issue.body}\n\nWork on a new branch, add tests, and summarise what you changed.`, send: true })}><Icon name="sparkles" size={13} />Fix with AI</button>
        {issue.state === 'OPEN' && <button className="btn-outline btn-sm" onClick={() => void act('Closed', () => invoke('gh:issueClose', path, n), `Close issue #${n} on GitHub?`)}>Close issue</button>}
      </div>
      <div className="mt-4 space-y-4">
        <div className="rounded-xl border border-aico-border-subtle p-4"><div className="markdown-body text-[14px]"><MarkdownRenderer content={issue.body || '_No description._'} /></div></div>
        {issue.comments?.map((c, i) => (
          <div key={i} className="rounded-xl border border-aico-border-subtle p-4">
            <div className="mb-2 text-[12px] text-aico-muted">{c.author.login} · {ago(Date.parse(c.createdAt))}</div>
            <div className="markdown-body text-[14px]"><MarkdownRenderer content={c.body} /></div>
          </div>
        ))}
        <div className="rounded-xl border border-aico-border-subtle p-3">
          <textarea className="input min-h-[80px]" placeholder="Leave a comment" value={comment} onChange={e => setComment(e.target.value)} />
          <div className="mt-2 flex justify-end"><button className="btn-primary btn-sm" disabled={!comment.trim()} onClick={() => void act('Commented', () => invoke('gh:issueComment', path, n, comment), 'Post this comment on GitHub?').then(() => setComment(''))}>Comment</button></div>
        </div>
      </div>
    </div>
  );
}

function Runs({ path }: { path: string }): React.ReactElement {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { setRuns(null); invoke<Run[]>('gh:runList', path).then(setRuns).catch(e => { setError((e as Error).message); setRuns([]); }); }, [path]);
  useEffect(load, [load]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
      <div className="mb-3 flex items-center"><div className="flex-1 text-[13px] text-aico-muted">Recent workflow runs</div><button className="icon-btn-sm" onClick={load} aria-label="Refresh"><Icon name="refresh" size={14} /></button></div>
      {runs === null && <div className="space-y-2">{[0, 1, 2].map(i => <div key={i} className="skeleton h-10" />)}</div>}
      {error && <div className="text-[12.5px] text-aico-danger">{error}</div>}
      <div className="overflow-hidden rounded-xl border border-aico-border-subtle">
        {runs?.map(r => (
          <div key={r.databaseId} className="flex items-center gap-3 border-b border-aico-border-subtle px-4 py-2.5 text-[13px] last:border-b-0">
            <Icon name={r.status !== 'completed' ? 'clock' : r.conclusion === 'success' ? 'check-circle' : r.conclusion === 'failure' ? 'x-circle' : 'minus'} size={15}
              className={r.status !== 'completed' ? 'text-aico-warning' : r.conclusion === 'success' ? 'text-aico-success' : r.conclusion === 'failure' ? 'text-aico-danger' : 'text-aico-muted'} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{r.displayTitle}</div>
              <div className="text-[11.5px] text-aico-muted">{r.workflowName} · <span className="font-mono">{r.headBranch}</span> · {r.event} · {ago(Date.parse(r.updatedAt))}</div>
            </div>
            {r.conclusion === 'failure' && (
              <>
                <button className="btn-ghost btn-sm" onClick={() => newChat({ project: path, prompt: `GitHub Actions run ${r.databaseId} ("${r.displayTitle}", ${r.workflowName}) failed. Read the failed logs with \`gh run view ${r.databaseId} --log-failed\`, explain the cause, and fix it.`, send: true })}><Icon name="sparkles" size={13} />Diagnose</button>
                <button className="btn-ghost btn-sm" onClick={() => void invoke('gh:runRerun', path, r.databaseId).then(() => { toast.success('Re-running failed jobs'); load(); }).catch(e => toast.error('Re-run failed', (e as Error).message))}><Icon name="refresh" size={13} />Re-run</button>
              </>
            )}
            <button className="icon-btn-sm" onClick={() => void desktop.shell.openExternal(r.url)} aria-label="Open on GitHub"><Icon name="external" size={13} /></button>
          </div>
        ))}
        {runs?.length === 0 && !error && <div className="p-6 text-center text-[13px] text-aico-muted">No workflow runs.</div>}
      </div>
    </div>
  );
}

function CreateDialog({ open, onClose, kind, path, base, onCreated }: { open: boolean; onClose: () => void; kind: 'pr' | 'issue'; path: string; base?: string; onCreated: () => void }): React.ReactElement {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const create = async (): Promise<void> => {
    setBusy(true);
    try {
      const out = kind === 'pr'
        ? await invoke<string>('gh:prCreate', path, { title, body, base, draft })
        : await invoke<string>('gh:issueCreate', path, { title, body });
      toast.success(kind === 'pr' ? 'Pull request opened' : 'Issue opened', out.trim().split('\n').pop());
      setTitle(''); setBody(''); onClose(); onCreated();
    } catch (e) { toast.error('Could not create it', (e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={kind === 'pr' ? 'Open a pull request' : 'Open an issue'} width={600}>
      <div className="space-y-3 px-5 pb-5 pt-2">
        {kind === 'pr' && <p className="text-[12.5px] text-aico-muted">From the current branch into {base ?? 'the default branch'}. Push the branch first.</p>}
        <input className="input" placeholder="Title" value={title} onChange={e => setTitle(e.target.value)} autoFocus />
        <textarea className="input min-h-[160px]" placeholder="Description (Markdown)" value={body} onChange={e => setBody(e.target.value)} />
        <div className="flex items-center gap-2">
          {kind === 'pr' && <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={draft} onChange={e => setDraft(e.target.checked)} />Draft</label>}
          <button className="btn-ghost btn-sm" onClick={() => { onClose(); newChat({ project: path, prompt: kind === 'pr' ? 'Write a pull request title and description for the changes on this branch compared to the default branch, then open it with gh pr create.' : 'Help me write a clear GitHub issue for: ', send: kind === 'pr' }); }}><Icon name="sparkles" size={13} />Draft with AI</button>
          <div className="flex-1" />
          <button className="btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!title.trim() || busy} onClick={() => void create()}>{busy && <span className="spinner h-3 w-3" />}Create</button>
        </div>
      </div>
    </Modal>
  );
}

function Empty({ icon, text }: { icon: string; text: string }): React.ReactElement {
  return <div className="flex h-full flex-col items-center justify-center gap-2 text-aico-muted"><Icon name={icon} size={26} /><div className="text-[13.5px]">{text}</div></div>;
}
