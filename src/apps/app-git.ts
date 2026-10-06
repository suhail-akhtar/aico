/**
 * Git for an app, the way a team would run it: a scaffold commit, one
 * Conventional Commit per finished story, an annotated baseline tag when the
 * first iteration passes its checks, and releases that bump SemVer, move the
 * CHANGELOG and tag.
 *
 * Why this exists: an app's git history was one silent first commit.
 * Per-story commits were a sentence in a skill ("after each story, git add -A
 * && git commit"), which a model skips when it is confident — the failure
 * AGENTS.md section 4.6 names. Now the completion gate refuses to end a turn
 * that wrote source and left the app's working tree dirty ({@link appCommitGate}),
 * and the commit itself is a tool action with a fixed shape.
 *
 * Safety rules, in code:
 *   - every git call is `execFile` with an argument array; commit text is model
 *     output and never reaches a shell;
 *   - the commit type, scope and subject are checked against a fixed charset and
 *     length, tag names must be `vMAJOR.MINOR.PATCH`;
 *   - the identity is the app repo's *local* config (`AICO Agent`), never the
 *     person's global one, and a missing one is set locally;
 *   - nothing here pushes, ever, and nothing forces, rewrites or deletes: `release`
 *     creates a commit and an annotated tag and refuses if the tag exists;
 *   - a staged path that looks like a credentials file refuses the commit
 *     (the same patterns the Git tool uses).
 * The tag is a person's decision: the AppManage action asks through the run's
 * always-ask channel before anything is written (ADR 0031 section 9).
 *
 * What it does not do: decide *when* to release, resolve merge conflicts, or
 * push. The version lives where the stack keeps it (package.json,
 * pyproject.toml, pom.xml, Gradle, csproj, composer.json); a stack with none
 * (Go) is versioned by its tags alone.
 *
 * @module apps/app-git
 */

import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { looksLikeSecretPath } from '../tools/git.js';

const execFileAsync = promisify(execFile);

export const COMMIT_TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'] as const;
export type CommitType = (typeof COMMIT_TYPES)[number];

/** Engine-written files that must not make the tree look dirty. */
const ENGINE_FILES = ['.aico/profile.json'];

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: dir, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return stdout;
}

export function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

/** Make sure commits here have an author without touching the person's global config. */
async function ensureIdentity(dir: string): Promise<void> {
  const has = async (key: string): Promise<boolean> => {
    try { return (await git(dir, 'config', '--get', key)).trim().length > 0; } catch { return false; }
  };
  if (!(await has('user.name'))) await git(dir, 'config', 'user.name', 'AICO Agent');
  if (!(await has('user.email'))) await git(dir, 'config', 'user.email', 'agent@aico.local');
}

/** Changed or untracked files, not counting what the engine itself writes. */
export async function dirtyFiles(dir: string): Promise<string[]> {
  const out = await git(dir, 'status', '--porcelain', '--untracked-files=all');
  return out.split(/\r?\n/).filter(Boolean)
    .map(line => line.slice(3).replace(/^"|"$/g, '').replace(/ -> .*/, ''))
    .filter(f => !ENGINE_FILES.includes(f.replace(/\\/g, '/')));
}

export interface CommitInput {
  type: string;
  scope?: string;
  /** The story title, imperative, no trailing period. */
  subject: string;
  /** What shows it is done: the "Done when" evidence. */
  body?: string;
}

/** What is wrong with a commit request, or null. */
export function validateCommit(c: CommitInput): string | null {
  if (!(COMMIT_TYPES as readonly string[]).includes(c.type)) return `type must be one of ${COMMIT_TYPES.join(', ')}`;
  if (c.scope !== undefined && !/^[a-z0-9][a-z0-9._/-]{0,30}$/i.test(c.scope)) return 'scope must be a short word (letters, digits, . _ / -)';
  const subject = c.subject?.trim() ?? '';
  if (!subject) return 'a commit needs a subject (the story title)';
  if (/[\r\n]/.test(subject)) return 'the subject is one line';
  if (subject.length > 72) return 'keep the subject to 72 characters; put detail in the body';
  if ((c.body ?? '').length > 4000) return 'keep the body under 4000 characters';
  return null;
}

/** `type(scope): subject`, and the body. */
export function formatCommit(c: CommitInput): { subject: string; body?: string } {
  const subject = `${c.type}${c.scope ? `(${c.scope})` : ''}: ${c.subject.trim().replace(/\.$/, '')}`;
  const body = c.body?.trim();
  return body ? { subject, body } : { subject };
}

export type CommitResult = { ok: true; sha: string; subject: string; files: number } | { ok: false; message: string };

/** Stage everything not ignored and commit it as one Conventional Commit. */
export async function commitAll(dir: string, input: CommitInput): Promise<CommitResult> {
  if (!isGitRepo(dir)) return { ok: false, message: 'This app has no git repository (no .git). Create it with `git init -b main` first.' };
  const problem = validateCommit(input);
  if (problem) return { ok: false, message: `Not committed: ${problem}.` };
  const dirty = await dirtyFiles(dir);
  if (dirty.length === 0) return { ok: false, message: 'Nothing to commit: the working tree is clean.' };
  const secret = dirty.find(looksLikeSecretPath);
  if (secret) {
    return { ok: false, message: `Not committed: ${secret} looks like a credentials file. Add it to .gitignore (or remove it) and commit again; secrets never go into history.` };
  }
  await ensureIdentity(dir);
  await git(dir, 'add', '-A');
  // `git add -A` also stages the engine's profile file when it is not ignored; that is harmless and accurate.
  const { subject, body } = formatCommit(input);
  try {
    await git(dir, 'commit', '--quiet', '-m', subject, ...(body ? ['-m', body] : []));
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `git commit failed: ${text.split('\n').slice(0, 3).join(' ').slice(0, 300)}` };
  }
  const sha = (await git(dir, 'rev-parse', '--short', 'HEAD')).trim();
  return { ok: true, sha, subject, files: dirty.length };
}

/** The completion gate's objection: source written this turn, tree not committed. */
export function appCommitGate(root: string, touchedSource: number): { ok: boolean; message?: string } {
  if (touchedSource === 0) return { ok: true };
  if (!fs.existsSync(path.join(root, 'app.json')) || !isGitRepo(root)) return { ok: true };
  let dirty: string[];
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8', timeout: 15_000, windowsHide: true });
    dirty = out.split(/\r?\n/).filter(Boolean).map(l => l.slice(3).replace(/^"|"$/g, '')).filter(f => !ENGINE_FILES.includes(f.replace(/\\/g, '/')));
  } catch {
    return { ok: true }; // no usable git: the gate must not invent a failure
  }
  if (dirty.length === 0) return { ok: true };
  const slug = path.basename(root);
  return {
    ok: false,
    message:
      `You changed source in this app and left ${dirty.length} file(s) uncommitted (${dirty.slice(0, 4).join(', ')}${dirty.length > 4 ? ', …' : ''}). `
      + 'A story is not done until it is committed: one Conventional Commit per story, with the evidence it is done in the body. Tick the story in .aico/backlog.md first, then call\n'
      + `  AppManage {"action":"commit","name":"${slug}","type":"feat","message":"<the story title>","body":"Done when: <what you verified>"}\n`
      + 'type is feat, fix, refactor, test, docs, chore or another Conventional Commit type. If a change is deliberately left uncommitted, say why once and stop.',
  };
}

// ───────────────────────── versions and releases ─────────────────────────

export interface VersionSource { file: string; kind: 'package.json' | 'pyproject.toml' | 'pom.xml' | 'gradle' | 'gradle.properties' | 'csproj' | 'composer.json' }

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function isSemver(v: string): boolean {
  return SEMVER.test(v);
}

/** The next version for a bump. */
export function bumpVersion(current: string, bump: 'major' | 'minor' | 'patch'): string {
  const m = SEMVER.exec(current);
  if (!m) throw new Error(`"${current}" is not MAJOR.MINOR.PATCH`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Where this stack keeps its version, and the version, or null (Go, or nothing declared). */
export function findVersion(dir: string): { source: VersionSource; version: string } | null {
  const read = (n: string): string | undefined => { try { return fs.readFileSync(path.join(dir, n), 'utf8'); } catch { return undefined; } };
  const pkg = read('package.json');
  if (pkg) {
    const v = /"version"\s*:\s*"(\d+\.\d+\.\d+)"/.exec(pkg)?.[1];
    if (v) return { source: { file: 'package.json', kind: 'package.json' }, version: v };
  }
  const py = read('pyproject.toml');
  if (py) {
    const v = /^\[(?:project|tool\.poetry)\][^[]*?^version\s*=\s*"(\d+\.\d+\.\d+)"/ms.exec(py)?.[1];
    if (v) return { source: { file: 'pyproject.toml', kind: 'pyproject.toml' }, version: v };
  }
  const pom = read('pom.xml');
  if (pom) {
    const start = pom.includes('</parent>') ? pom.indexOf('</parent>') : 0;
    const m = /<version>(\d+\.\d+\.\d+)(?:-SNAPSHOT)?<\/version>/.exec(pom.slice(start));
    const stop = Math.min(...['<dependencies', '<build', '<properties'].map(t => { const i = pom.indexOf(t, start); return i < 0 ? Infinity : i; }));
    if (m && start + m.index < stop) return { source: { file: 'pom.xml', kind: 'pom.xml' }, version: m[1]! };
  }
  for (const f of ['build.gradle', 'build.gradle.kts']) {
    const g = read(f);
    const v = g && /^version\s*=\s*['"](\d+\.\d+\.\d+)(?:-SNAPSHOT)?['"]/m.exec(g)?.[1];
    if (v) return { source: { file: f, kind: 'gradle' }, version: v };
  }
  const props = read('gradle.properties');
  if (props) {
    const v = /^version\s*=\s*(\d+\.\d+\.\d+)(?:-SNAPSHOT)?\s*$/m.exec(props)?.[1];
    if (v) return { source: { file: 'gradle.properties', kind: 'gradle.properties' }, version: v };
  }
  const csproj = fs.readdirSync(dir).find(n => /\.csproj$/i.test(n));
  if (csproj) {
    const v = /<(?:Version|VersionPrefix)>(\d+\.\d+\.\d+)<\/(?:Version|VersionPrefix)>/.exec(read(csproj) ?? '')?.[1];
    if (v) return { source: { file: csproj, kind: 'csproj' }, version: v };
  }
  const composer = read('composer.json');
  if (composer) {
    const v = /"version"\s*:\s*"(\d+\.\d+\.\d+)"/.exec(composer)?.[1];
    if (v) return { source: { file: 'composer.json', kind: 'composer.json' }, version: v };
  }
  return null;
}

/** Write the new version into the manifest it came from, touching only that one value. */
export function writeVersion(dir: string, source: VersionSource, from: string, to: string): void {
  const file = path.join(dir, source.file);
  const text = fs.readFileSync(file, 'utf8');
  const esc = from.replace(/\./g, '\\.');
  let next: string;
  switch (source.kind) {
    case 'package.json':
    case 'composer.json':
      next = text.replace(new RegExp(`("version"\\s*:\\s*")${esc}(")`), `$1${to}$2`); break;
    case 'pyproject.toml':
      next = text.replace(new RegExp(`(^version\\s*=\\s*")${esc}(")`, 'm'), `$1${to}$2`); break;
    case 'pom.xml': {
      const start = text.includes('</parent>') ? text.indexOf('</parent>') : 0;
      next = text.slice(0, start) + text.slice(start).replace(new RegExp(`<version>${esc}((?:-SNAPSHOT)?)</version>`), `<version>${to}$1</version>`);
      break;
    }
    case 'gradle':
      next = text.replace(new RegExp(`(^version\\s*=\\s*['"])${esc}((?:-SNAPSHOT)?['"])`, 'm'), `$1${to}$2`); break;
    case 'gradle.properties':
      next = text.replace(new RegExp(`(^version\\s*=\\s*)${esc}`, 'm'), `$1${to}`); break;
    case 'csproj':
      next = text.replace(new RegExp(`(<(?:Version|VersionPrefix)>)${esc}(</(?:Version|VersionPrefix)>)`), `$1${to}$2`); break;
  }
  if (next === text) throw new Error(`could not rewrite the version in ${source.file}`);
  fs.writeFileSync(file, next, 'utf8');
}

/** The newest `v*` tag reachable from HEAD, or undefined. */
export async function latestTag(dir: string): Promise<string | undefined> {
  try {
    const t = (await git(dir, 'describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*')).trim();
    return /^v\d+\.\d+\.\d+$/.test(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

export async function tagExists(dir: string, tag: string): Promise<boolean> {
  try { await git(dir, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}`); return true; } catch { return false; }
}

export interface CommitLine { sha: string; subject: string }

/** Commit subjects since a tag (or all of them). */
export async function commitsSince(dir: string, tag: string | undefined): Promise<CommitLine[]> {
  try {
    const out = await git(dir, 'log', tag ? `${tag}..HEAD` : 'HEAD', '--no-merges', '--pretty=format:%h\t%s');
    return out.split(/\r?\n/).filter(Boolean).map(l => { const [sha, ...rest] = l.split('\t'); return { sha: sha!, subject: rest.join('\t') }; });
  } catch {
    return [];
  }
}

/** The bump the commits since the last release call for. */
export function inferBump(commits: CommitLine[], current: string): 'major' | 'minor' | 'patch' {
  const breaking = commits.some(c => /^[a-z]+(\([^)]*\))?!:/.test(c.subject) || /BREAKING CHANGE/.test(c.subject));
  const major0 = current.startsWith('0.');
  if (breaking) return major0 ? 'minor' : 'major';
  if (commits.some(c => /^feat(\(|:)/.test(c.subject))) return 'minor';
  return 'patch';
}

const SECTION_FOR: Record<string, string> = {
  feat: 'Added', fix: 'Fixed', perf: 'Changed', refactor: 'Changed', docs: 'Documentation', build: 'Changed', revert: 'Changed',
};

/** Keep a Changelog entries from Conventional Commit subjects. Skips chore/test/ci/style/release noise. */
export function changelogFromCommits(commits: CommitLine[]): string {
  const groups = new Map<string, string[]>();
  for (const c of commits) {
    const m = /^([a-z]+)(?:\(([^)]*)\))?!?:\s*(.+)$/.exec(c.subject);
    if (!m) continue;
    const section = SECTION_FOR[m[1]!];
    if (!section) continue;
    if (/^chore\(release\)/.test(c.subject)) continue;
    const line = `- ${m[2] ? `**${m[2]}:** ` : ''}${m[3]}`;
    groups.set(section, [...(groups.get(section) ?? []), line]);
  }
  return ['Added', 'Changed', 'Fixed', 'Documentation'].filter(s => groups.has(s))
    .map(s => `### ${s}\n${groups.get(s)!.join('\n')}`).join('\n\n');
}

const CHANGELOG_HEADER = '# Changelog\n\nAll notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).\n\n## [Unreleased]\n';

/**
 * Move `## [Unreleased]` to `## [version] - date` and open a fresh Unreleased.
 * An empty Unreleased is filled from `fallback` (the commits), so a release is
 * never an empty heading.
 */
export function releaseChangelog(text: string | undefined, version: string, date: string, fallback: string): { text: string; entries: string } {
  let base = text ?? '';
  if (!/^## \[Unreleased\]/m.test(base)) {
    if (!base.trim()) base = CHANGELOG_HEADER;
    else {
      // Open an Unreleased section above the newest release (or at the end of a file that has none).
      const first = /^## \[/m.exec(base);
      base = first ? `${base.slice(0, first.index)}## [Unreleased]\n\n${base.slice(first.index)}` : `${base.trimEnd()}\n\n## [Unreleased]\n`;
    }
  }
  const m = /^## \[Unreleased\][^\n]*\n([\s\S]*?)(?=^## \[|(?![\s\S]))/m.exec(base)!;
  const entries = m[1]!.trim() || fallback.trim() || '- Maintenance release.';
  const head = base.slice(0, m.index);
  const rest = base.slice(m.index + m[0].length);
  const out = `${head}## [Unreleased]\n\n## [${version}] - ${date}\n\n${entries}\n\n${rest.replace(/^\s+/, '')}`;
  return { text: `${out.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`, entries };
}

export interface ReleasePlan {
  current: string;
  next: string;
  bump: 'major' | 'minor' | 'patch' | 'explicit';
  tag: string;
  versionFile?: string;
  commits: CommitLine[];
  entries: string;
  dirty: string[];
  tagTaken: boolean;
}

/** Work out a release without writing anything. */
export async function planRelease(dir: string, opts: { bump?: 'major' | 'minor' | 'patch'; version?: string } = {}): Promise<ReleasePlan | { error: string }> {
  if (!isGitRepo(dir)) return { error: 'This app has no git repository.' };
  const found = findVersion(dir);
  const last = await latestTag(dir);
  const current = found?.version ?? last?.slice(1) ?? '0.0.0';
  const commits = await commitsSince(dir, last);
  let next: string;
  let bump: ReleasePlan['bump'];
  if (opts.version) {
    if (!isSemver(opts.version)) return { error: `"${opts.version}" is not MAJOR.MINOR.PATCH.` };
    next = opts.version; bump = 'explicit';
  } else {
    bump = opts.bump ?? inferBump(commits, current);
    next = bumpVersion(current, bump);
  }
  const tag = `v${next}`;
  const changelog = (() => { try { return fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'); } catch { return undefined; } })();
  const { entries } = releaseChangelog(changelog, next, '1970-01-01', changelogFromCommits(commits));
  return {
    current, next, bump, tag, ...(found ? { versionFile: found.source.file } : {}), commits, entries,
    dirty: await dirtyFiles(dir), tagTaken: await tagExists(dir, tag),
  };
}

/**
 * Execute a planned release: bump the manifest, move the CHANGELOG, write the
 * release notes, commit `chore(release): vX.Y.Z`, create the annotated tag.
 * The caller has already obtained a person's yes and run the checks.
 */
export async function performRelease(dir: string, plan: ReleasePlan, date = new Date().toISOString().slice(0, 10)): Promise<{ ok: true; commit: string; tag: string; notes: string } | { ok: false; message: string }> {
  if (!/^v\d+\.\d+\.\d+$/.test(plan.tag)) return { ok: false, message: `refusing odd tag "${plan.tag}"` };
  if (plan.tagTaken) return { ok: false, message: `${plan.tag} already exists; tags are never moved. Pick another version.` };
  if (plan.dirty.length) return { ok: false, message: `The working tree has uncommitted changes (${plan.dirty.slice(0, 3).join(', ')}). Commit them first: a release is exactly what is in git.` };
  const found = findVersion(dir);
  if (found) writeVersion(dir, found.source, found.version, plan.next);
  const logPath = path.join(dir, 'CHANGELOG.md');
  let existing: string | undefined;
  try { existing = fs.readFileSync(logPath, 'utf8'); } catch { /* new */ }
  const commits = plan.commits;
  const { text, entries } = releaseChangelog(existing, plan.next, date, changelogFromCommits(commits));
  fs.writeFileSync(logPath, text, 'utf8');
  const notesRel = path.posix.join('docs', 'releases', `${plan.next}.md`);
  fs.mkdirSync(path.join(dir, 'docs', 'releases'), { recursive: true });
  const notes = `# ${plan.tag} (${date})\n\n${entries}\n\n## Commits\n\n${commits.map(c => `- ${c.sha} ${c.subject}`).join('\n') || '- (none since the previous release)'}\n`;
  fs.writeFileSync(path.join(dir, notesRel), notes, 'utf8');
  await ensureIdentity(dir);
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '--quiet', '-m', `chore(release): ${plan.tag}`, '-m', `Release notes: ${notesRel}`);
  await git(dir, 'tag', '-a', plan.tag, '-m', `${plan.tag}\n\n${entries}`);
  return { ok: true, commit: (await git(dir, 'rev-parse', '--short', 'HEAD')).trim(), tag: plan.tag, notes: notesRel };
}

/** The annotated baseline tag `v0.1.0`, once Iteration 0's checks have passed. Refuses a dirty tree or an existing tag. */
export async function tagBaseline(dir: string): Promise<{ ok: true; tag: string } | { ok: false; message: string }> {
  if (!isGitRepo(dir)) return { ok: false, message: 'This app has no git repository.' };
  const tag = 'v0.1.0';
  if (await tagExists(dir, tag)) return { ok: false, message: `${tag} already exists (tags are never moved).` };
  const dirty = await dirtyFiles(dir);
  if (dirty.length) return { ok: false, message: `Commit first (${dirty.slice(0, 3).join(', ')}): the baseline tag must describe exactly what is in git.` };
  await ensureIdentity(dir);
  await git(dir, 'tag', '-a', tag, '-m', `${tag}\n\nBaseline: Iteration 0 passes the project's checks.`);
  return { ok: true, tag };
}
