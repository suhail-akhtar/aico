/**
 * GitHub through the official CLI (`gh`).
 *
 * `gh` already holds the person's GitHub sign-in (in the OS keychain) and
 * speaks every API; wrapping it means AICO never sees or stores a GitHub token.
 * If `gh` is missing or signed out, the page says how to fix that — signing in
 * runs `gh auth login` in a terminal the person drives.
 *
 * Reads are free. Anything that changes GitHub (open, merge, close, comment)
 * is only ever called after the person confirmed it in the interface.
 *
 * @module desktop/electron/github
 */

import { execFile } from 'node:child_process';
import type { DesktopContext } from './context';

function gh(args: string[], cwd?: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('gh', args, {
      cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 60_000,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') reject(new Error('The GitHub CLI (gh) is not installed. Install it from https://cli.github.com and sign in with `gh auth login`.'));
        else reject(new Error((stderr || err.message).trim()));
        return;
      }
      resolve(stdout);
    });
    if (input !== undefined) { child.stdin?.write(input); child.stdin?.end(); }
  });
}

async function json<T>(args: string[], cwd?: string): Promise<T> {
  const out = await gh(args, cwd);
  return JSON.parse(out || 'null') as T;
}

const PR_FIELDS = 'number,title,author,state,isDraft,headRefName,baseRefName,updatedAt,createdAt,url,reviewDecision,labels,additions,deletions,changedFiles,mergeable';
const ISSUE_FIELDS = 'number,title,author,state,updatedAt,createdAt,url,labels,comments,assignees';

export function registerGitHub(ctx: DesktopContext): void {
  ctx.handle('gh:status', async () => {
    try {
      const version = (await gh(['--version'])).split('\n')[0]?.trim() ?? '';
      try {
        const user = await json<{ login: string; name?: string; avatar_url?: string }>(['api', 'user']);
        return { installed: true, version, signedIn: true, user };
      } catch (err) {
        return { installed: true, version, signedIn: false, error: (err as Error).message };
      }
    } catch (err) {
      return { installed: false, signedIn: false, error: (err as Error).message };
    }
  });

  ctx.handle('gh:repo', (cwd: string) => json(['repo', 'view', '--json', 'nameWithOwner,url,description,defaultBranchRef,stargazerCount,forkCount,isPrivate,viewerPermission,pushedAt,homepageUrl'], cwd));
  ctx.handle('gh:prList', (cwd: string, state?: string) => json(['pr', 'list', '--state', state ?? 'open', '--limit', '60', '--json', PR_FIELDS], cwd));
  ctx.handle('gh:prView', (cwd: string, n: number) => json(['pr', 'view', String(n), '--json', `${PR_FIELDS},body,files,comments,commits,statusCheckRollup,reviews`], cwd));
  ctx.handle('gh:prDiff', (cwd: string, n: number) => gh(['pr', 'diff', String(n), '--color', 'never'], cwd));
  ctx.handle('gh:prChecks', async (cwd: string, n: number) => {
    try { return await json(['pr', 'checks', String(n), '--json', 'name,state,bucket,link,workflow,startedAt,completedAt'], cwd); }
    catch (err) { if (/no checks/i.test((err as Error).message)) return []; throw err; }
  });
  ctx.handle('gh:prCreate', (cwd: string, o: { title: string; body: string; base?: string; draft?: boolean }) => {
    const args = ['pr', 'create', '--title', o.title, '--body', o.body || ' '];
    if (o.base) args.push('--base', o.base);
    if (o.draft) args.push('--draft');
    return gh(args, cwd);
  });
  ctx.handle('gh:prCheckout', (cwd: string, n: number) => gh(['pr', 'checkout', String(n)], cwd));
  ctx.handle('gh:prMerge', (cwd: string, n: number, method: 'merge' | 'squash' | 'rebase') => gh(['pr', 'merge', String(n), `--${method}`, '--delete-branch=false'], cwd));
  ctx.handle('gh:prComment', (cwd: string, n: number, body: string) => gh(['pr', 'comment', String(n), '--body-file', '-'], cwd, body));
  ctx.handle('gh:prReady', (cwd: string, n: number) => gh(['pr', 'ready', String(n)], cwd));
  ctx.handle('gh:issueList', (cwd: string, state?: string) => json(['issue', 'list', '--state', state ?? 'open', '--limit', '60', '--json', ISSUE_FIELDS], cwd));
  ctx.handle('gh:issueView', (cwd: string, n: number) => json(['issue', 'view', String(n), '--json', `${ISSUE_FIELDS},body`], cwd));
  ctx.handle('gh:issueCreate', (cwd: string, o: { title: string; body: string }) => gh(['issue', 'create', '--title', o.title, '--body', o.body || ' '], cwd));
  ctx.handle('gh:issueComment', (cwd: string, n: number, body: string) => gh(['issue', 'comment', String(n), '--body-file', '-'], cwd, body));
  ctx.handle('gh:issueClose', (cwd: string, n: number) => gh(['issue', 'close', String(n)], cwd));
  ctx.handle('gh:runList', (cwd: string) => json(['run', 'list', '--limit', '30', '--json', 'databaseId,displayTitle,workflowName,status,conclusion,headBranch,event,createdAt,updatedAt,url'], cwd));
  ctx.handle('gh:runRerun', (cwd: string, id: number) => gh(['run', 'rerun', String(id), '--failed'], cwd));
  ctx.handle('gh:myRepos', () => json(['repo', 'list', '--limit', '60', '--json', 'nameWithOwner,description,url,updatedAt,isPrivate,primaryLanguage']));
  ctx.handle('gh:clone', (repo: string, dir: string) => gh(['repo', 'clone', repo, dir]));
  ctx.handle('gh:search', (q: string) => json(['search', 'repos', q, '--limit', '20', '--json', 'fullName,description,url,stargazersCount,updatedAt']));
}
