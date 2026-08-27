/**
 * Git, as something the agent can do rather than something it can describe.
 *
 * The agent could already run `git` through Bash, so the question this has to
 * answer is what a dedicated tool adds. Three things, and only the first is
 * about convenience:
 *
 *   **Guards that hold.** "Do not commit straight to main", "never force-push",
 *   "do not commit a `.env`" are, through Bash, requests in a prompt — and a
 *   prompt is a thing a model may decline. Here they are conditions on the
 *   call. The default branch is refused unless the caller says so explicitly;
 *   `--force` and `--no-verify` are not spelled anywhere in this file, so there
 *   is no argument that reaches them.
 *
 *   **No shell.** Every invocation is `execFile` with an argument array. A
 *   commit message is model-generated text, and model-generated text reaching
 *   a shell is one backtick away from running as a command.
 *
 *   **An ending.** Without a way to commit and open a pull request, a run
 *   finishes at a dirty working tree and a person has to do the last mile by
 *   hand. That is the difference between work being done and work being
 *   shipped.
 *
 * @module tools/git
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { currentCwd } from '../run-context.js';

const run = promisify(execFile);

/** Output past this is truncated rather than flooding the transcript. */
const MAX_OUTPUT = 20_000;

/**
 * Paths that must never be committed by an agent.
 *
 * Not a security boundary — a determined model can still write a key into a
 * source file — but it stops the overwhelmingly common accident, which is a
 * `.env` swept up by staging everything. Refusing is right rather than
 * filtering silently: a commit that quietly omits a file the caller asked for
 * is a different commit from the one it thinks it made.
 */
const SECRET_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|pfx|p12|keystore|jks)$/i,
  /(^|\/)credentials?\.(json|ya?ml)$/i,
  /(^|\/)\.aws\//i,
  /(^|\/)service-account.*\.json$/i,
];

export interface GitInput {
  action?: 'status' | 'diff' | 'log' | 'branch' | 'commit' | 'push' | 'pr';
  /** Commit message, branch name, or PR title depending on the action. */
  message?: string;
  /** Paths to stage. Omit on commit to stage every tracked modification. */
  paths?: string[];
  /** PR body. */
  body?: string;
  /** Diff the staged set rather than the working tree. */
  staged?: boolean;
  /**
   * Permit committing onto the repository's default branch.
   *
   * Off by default and named for what it does, so a model that wants it has to
   * ask for it in a way a reader can see in the transcript.
   */
  allowDefaultBranch?: boolean;
}

async function git(args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await run('git', args, {
      cwd: currentCwd(),
      maxBuffer: 10 * 1024 * 1024,
      // No shell: arguments are passed as an array, so a commit message
      // containing backticks is a commit message and not a command.
      shell: false,
    });
    return { ok: true, out: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const shaped = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      out: `${shaped.stdout ?? ''}${shaped.stderr ?? ''}`.trim() || shaped.message || 'git failed',
    };
  }
}

function clip(text: string): string {
  return text.length > MAX_OUTPUT
    ? `${text.slice(0, MAX_OUTPUT)}\n… [truncated — ${text.length - MAX_OUTPUT} more characters]`
    : text;
}

/** The branch this repository treats as its trunk. */
async function defaultBranch(): Promise<string> {
  const symbolic = await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (symbolic.ok && symbolic.out) {
    const name = symbolic.out.split('/').pop();
    if (name) return name;
  }
  // No remote, or no HEAD ref for it. Both are normal; fall back to whichever
  // conventional name actually exists rather than assuming one.
  for (const candidate of ['main', 'master']) {
    const exists = await git(['rev-parse', '--verify', '--quiet', candidate]);
    if (exists.ok) return candidate;
  }
  return 'main';
}

async function currentBranch(): Promise<string> {
  const head = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  return head.ok ? head.out : '';
}

export async function gitTool(input: GitInput): Promise<string> {
  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok) return 'Not a git repository (or git is unavailable).';

  switch (input.action ?? 'status') {
    case 'status': return status();
    case 'diff': return diff(input);
    case 'log': return log();
    case 'branch': return branch(input);
    case 'commit': return commit(input);
    case 'push': return push();
    case 'pr': return pullRequest(input);
    default: return status();
  }
}

async function status(): Promise<string> {
  const [porcelain, head, upstream] = await Promise.all([
    git(['status', '--porcelain=v1']),
    currentBranch(),
    git(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']),
  ]);

  const lines = porcelain.out.split('\n').filter(Boolean);
  const tracking = upstream.ok && upstream.out
    ? (() => {
      const [ahead, behind] = upstream.out.split(/\s+/).map(Number);
      return ` — ${ahead ?? 0} ahead, ${behind ?? 0} behind upstream`;
    })()
    : ' — no upstream set';

  if (lines.length === 0) return `On ${head}${tracking}. Working tree clean.`;
  return clip(`On ${head}${tracking}. ${lines.length} changed path(s):\n${lines.join('\n')}`);
}

async function diff(input: GitInput): Promise<string> {
  const args = ['diff', '--stat', '--patch'];
  if (input.staged) args.push('--staged');
  if (input.paths?.length) args.push('--', ...input.paths);
  const result = await git(args);
  if (!result.ok) return `git diff failed: ${result.out}`;
  return result.out ? clip(result.out) : 'No differences.';
}

async function log(): Promise<string> {
  const result = await git(['log', '--oneline', '--decorate', '-15']);
  return result.ok ? clip(result.out || 'No commits yet.') : `git log failed: ${result.out}`;
}

async function branch(input: GitInput): Promise<string> {
  const name = input.message?.trim();
  if (!name) return 'branch requires a name in `message`.';
  // A leading dash is the one that matters. Arguments go to `execFile` as an
  // array with no shell, which stops quoting and command substitution — but it
  // does not stop git reading `--force` as an option rather than as the branch
  // name it was passed as. `--` terminates option parsing for paths elsewhere
  // in this file; `checkout -b` takes no such separator, so the name itself has
  // to be refused.
  if (name.startsWith('-') || name.includes('..') || !/^[\w./-]+$/.test(name)) {
    return `Refusing "${name}" as a branch name — letters, numbers, dot, slash, dash `
      + 'and underscore, not starting with a dash.';
  }
  const existing = await git(['rev-parse', '--verify', '--quiet', name]);
  const result = existing.ok
    ? await git(['checkout', name])
    : await git(['checkout', '-b', name]);
  return result.ok
    ? `${existing.ok ? 'Switched to' : 'Created and switched to'} branch ${name}.`
    : `Could not switch to ${name}: ${result.out}`;
}

async function commit(input: GitInput): Promise<string> {
  const message = input.message?.trim();
  if (!message) return 'commit requires a message.';

  const head = await currentBranch();
  const trunk = await defaultBranch();
  if (head === trunk && input.allowDefaultBranch !== true) {
    return `Refusing to commit directly to ${trunk}. Create a branch first `
      + `(action: "branch"), or pass allowDefaultBranch: true if this repository `
      + 'genuinely works that way.';
  }

  // What would actually be committed, checked before anything is staged.
  const candidates = input.paths?.length
    ? input.paths
    : (await git(['diff', '--name-only'])).out.split('\n').filter(Boolean);
  const secrets = candidates.filter(p => SECRET_PATTERNS.some(rx => rx.test(p)));
  if (secrets.length > 0) {
    return `Refusing to commit what looks like credentials: ${secrets.join(', ')}. `
      + 'Add them to .gitignore, or commit them yourself if they are genuinely safe.';
  }

  const staged = input.paths?.length
    ? await git(['add', '--', ...input.paths])
    : await git(['add', '--update']);
  if (!staged.ok) return `Could not stage changes: ${staged.out}`;

  const anything = await git(['diff', '--staged', '--name-only']);
  if (!anything.out) return 'Nothing staged to commit.';

  const result = await git(['commit', '-m', message]);
  if (!result.ok) return `Commit failed: ${result.out}`;
  return `Committed to ${head}:\n${clip(result.out)}`;
}

async function push(): Promise<string> {
  const head = await currentBranch();
  if (!head || head === 'HEAD') return 'Cannot push from a detached HEAD.';
  // `-u` rather than a bare push, so a branch created locally gets an upstream
  // on its first push instead of failing with advice about setting one.
  const result = await git(['push', '-u', 'origin', head]);
  return result.ok ? `Pushed ${head}.\n${clip(result.out)}` : `Push failed: ${result.out}`;
}

/**
 * Open a pull request, through `gh` if it is installed.
 *
 * Not reimplemented over the API. A PR needs a host, an auth token and a
 * default branch, and `gh` already knows all three from the repository it is
 * standing in — reimplementing that would mean asking the agent for a token,
 * which is the one thing it must never handle.
 */
async function pullRequest(input: GitInput): Promise<string> {
  const title = input.message?.trim();
  if (!title) return 'pr requires a title in `message`.';

  const head = await currentBranch();
  const trunk = await defaultBranch();
  if (head === trunk) return `Cannot open a pull request from ${trunk} into itself.`;

  const pushed = await push();
  if (pushed.startsWith('Push failed')) return pushed;

  try {
    const { stdout, stderr } = await run(
      'gh',
      ['pr', 'create', '--title', title, '--body', input.body ?? '', '--base', trunk],
      { cwd: currentCwd(), maxBuffer: 2 * 1024 * 1024, shell: false },
    );
    return `Pull request opened:\n${`${stdout}${stderr}`.trim()}`;
  } catch (error) {
    const shaped = error as { stderr?: string; message?: string; code?: string };
    if (shaped.code === 'ENOENT') {
      return `${pushed}\n\nThe branch is pushed, but the GitHub CLI (gh) is not installed, `
        + 'so the pull request was not opened. Install gh, or open it in the browser.';
    }
    return `${pushed}\n\nPull request could not be created: ${shaped.stderr ?? shaped.message}`;
  }
}

export const gitDefinition = {
  name: 'Git',
  description: [
    'Version control: inspect the repository, commit work, and open a pull request.',
    '',
    'actions:',
    '  status  — branch, upstream position, and changed paths.',
    '  diff    — what changed. staged:true for the staged set; paths to narrow it.',
    '  log     — the last 15 commits.',
    '  branch  — create or switch. message = branch name.',
    '  commit  — stage and commit. message = commit message; paths to stage only some.',
    '  push    — push the current branch, setting upstream on first push.',
    '  pr      — push, then open a pull request via gh. message = title, body = description.',
    '',
    'Refuses, rather than asking you not to: committing directly to the default',
    'branch (pass allowDefaultBranch:true if the repository genuinely works that way),',
    'and committing files that look like credentials. Force-push and --no-verify are',
    'not available through this tool at all.',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'diff', 'log', 'branch', 'commit', 'push', 'pr'],
        description: 'What to do. Defaults to status.',
      },
      message: { type: 'string', description: 'Commit message, branch name, or PR title.' },
      body: { type: 'string', description: 'Pull request description.' },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Paths to stage or diff. Omit on commit to stage all tracked changes.',
      },
      staged: { type: 'boolean', description: 'Diff the staged set instead of the working tree.' },
      allowDefaultBranch: {
        type: 'boolean',
        description: 'Permit committing onto the default branch. Off unless asked for.',
      },
    },
    required: [] as string[],
  },
};
