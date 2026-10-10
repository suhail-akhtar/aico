/**
 * Release trains: from the tasks that landed since the last tag to a version, release
 * notes, a version-bump commit and an annotated tag (ADR 0038).
 *
 * WHAT A RELEASE IS HERE. Two things on the trunk, both local: one commit that bumps the
 * project's version file(s) and adds a CHANGELOG section, and an annotated tag `vX.Y.Z` on
 * it. Nothing is pushed (the same rule as landing); publishing a tag is the person's to do,
 * and a deploy is a separate act with its own command (`index.deployRelease`).
 *
 * WHERE THE FACTS COME FROM. The trunk's own history decides what is unreleased: the last
 * `v<semver>` tag reachable from it, and every commit after that. The board adds only what
 * git cannot say: which of those commits arrived as which task (`Task.landed`, recorded at
 * landing) and what each task's evidence summary was. The next version is Conventional
 * Commits arithmetic over those commits — a breaking marker (`type!:` or a `BREAKING
 * CHANGE:` footer) is a major, `feat` a minor, anything else a patch — from the higher of
 * the last tag and the project's version file, because a project that already bumped its
 * file by hand must not be released at a lower number. A person may name another version;
 * it must still be a valid, higher one, and the tag must be new.
 *
 * HOW IT IS MADE WITHOUT TOUCHING THE PERSON'S CHECKOUT. The bump commit is built in a
 * throwaway worktree on its own branch (outside the task worktrees, so the orphan sweep
 * never sees it), tagged, and then lands exactly as a task does: fast-forward, with the
 * checkout updated when it is on the trunk and git refusing, loudly, if that would
 * overwrite the person's edits. The tag is created before the trunk moves and removed again
 * if the move is refused, so a failed release leaves nothing behind.
 *
 * Release notes are the tasks' titles with their evidence summaries, grouped by what the
 * change was. No author, no tool credit: the commit and the tag carry the repository's own
 * configured identity (AGENTS.md rule 1 holds in every repository AICO writes to).
 *
 * Deliberately not here: pushing, publishing to a registry, signing, and any model call.
 *
 * @module delivery/release
 */

import fs from 'node:fs';
import path from 'node:path';
import { aicoHome } from '../home.js';
import { projectKey } from '../learning/proposals.js';
import * as G from './git.js';
import type { ChangeKind, Release, ReleasePlan, Task } from './types.js';

// ── Conventional Commits ─────────────────────────────────────────────────

const KIND_RANK: ChangeKind[] = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'chore', 'other'];
const TYPE_TO_KIND: Record<string, ChangeKind> = {
  feat: 'feat', feature: 'feat', fix: 'fix', bugfix: 'fix', perf: 'perf', refactor: 'refactor',
  docs: 'docs', doc: 'docs', test: 'test', tests: 'test', chore: 'chore', build: 'chore', ci: 'chore', style: 'chore', revert: 'other',
};

/** `feat(scope)!: subject` → its kind and whether it is marked breaking. */
export function parseConventional(subject: string, body = ''): { kind: ChangeKind; breaking: boolean } {
  const m = /^(\w+)(?:\([^)]*\))?(!)?:\s/.exec(subject.trim());
  const kind = m ? TYPE_TO_KIND[m[1]!.toLowerCase()] ?? 'other' : 'other';
  const breaking = Boolean(m?.[2]) || /^BREAKING[ -]CHANGE:/m.test(body);
  return { kind, breaking };
}

/** The most significant kind among commits (feat over fix over the rest). */
export function strongestKind(kinds: readonly ChangeKind[]): ChangeKind {
  return kinds.reduce<ChangeKind>((best, k) => (KIND_RANK.indexOf(k) < KIND_RANK.indexOf(best) ? k : best), 'other');
}

/** What a landed range of commits is, for the task that landed it. */
export function classifyCommits(entries: ReadonlyArray<{ subject: string; body: string }>): { kind: ChangeKind; breaking: boolean } {
  const parsed = entries.map(e => parseConventional(e.subject, e.body));
  return { kind: strongestKind(parsed.map(p => p.kind)), breaking: parsed.some(p => p.breaking) };
}

// ── semver ───────────────────────────────────────────────────────────────

export interface Semver { major: number; minor: number; patch: number }

export function parseSemver(v: string): Semver | undefined {
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(v.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : undefined;
}

export function formatSemver(s: Semver): string { return `${s.major}.${s.minor}.${s.patch}`; }

export function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function bumpSemver(base: Semver, bump: 'major' | 'minor' | 'patch'): Semver {
  if (bump === 'major') return { major: base.major + 1, minor: 0, patch: 0 };
  if (bump === 'minor') return { major: base.major, minor: base.minor + 1, patch: 0 };
  return { major: base.major, minor: base.minor, patch: base.patch + 1 };
}

/** The bump Conventional Commits ask for. With no base version the first release is the base itself (see `planRelease`). */
export function bumpFor(commits: ReadonlyArray<{ kind: ChangeKind; breaking: boolean }>): { bump: 'major' | 'minor' | 'patch'; reason: string } {
  const breaking = commits.filter(c => c.breaking).length;
  if (breaking > 0) return { bump: 'major', reason: `${breaking} breaking change${breaking === 1 ? '' : 's'}` };
  const feats = commits.filter(c => c.kind === 'feat').length;
  if (feats > 0) return { bump: 'minor', reason: `${feats} new feature${feats === 1 ? '' : 's'}` };
  return { bump: 'patch', reason: 'fixes and maintenance only' };
}

// ── version files ────────────────────────────────────────────────────────

export interface VersionFile { file: string; version: string }

const eolOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n');

function readText(p: string): string | undefined { try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; } }

/** `version = "x"` under `[project]` / `[tool.poetry]` / `[package]`; returns the line index. */
function tomlVersionLine(lines: string[], tables: readonly string[]): number {
  let table = '';
  for (let i = 0; i < lines.length; i++) {
    const t = /^\s*\[([^\]]+)\]\s*$/.exec(lines[i]!);
    if (t) { table = t[1]!.trim(); continue; }
    if (tables.includes(table) && /^\s*version\s*=\s*["'][^"']*["']/.test(lines[i]!)) return i;
  }
  return -1;
}

/** The project's version files that carry a readable version, in the folder given. */
export function readVersionFiles(dir: string): VersionFile[] {
  const out: VersionFile[] = [];
  const pkg = readText(path.join(dir, 'package.json'));
  if (pkg !== undefined) {
    try {
      const v = (JSON.parse(pkg) as { version?: unknown }).version;
      if (typeof v === 'string' && parseSemver(v)) out.push({ file: 'package.json', version: v });
    } catch { /* not JSON: not a version file */ }
  }
  for (const [file, tables] of [['pyproject.toml', ['project', 'tool.poetry']], ['Cargo.toml', ['package']]] as const) {
    const text = readText(path.join(dir, file));
    if (text === undefined) continue;
    const lines = text.split(/\r?\n/);
    const at = tomlVersionLine(lines, tables);
    const v = at >= 0 ? /["']([^"']*)["']/.exec(lines[at]!)?.[1] : undefined;
    if (v && parseSemver(v)) out.push({ file, version: v });
  }
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter(n => /\.csproj$/i.test(n)); } catch { /* unreadable folder */ }
  for (const file of names.slice(0, 3)) {
    const v = /<Version>\s*([^<\s]+)\s*<\/Version>/.exec(readText(path.join(dir, file)) ?? '')?.[1];
    if (v && parseSemver(v)) out.push({ file, version: v });
  }
  return out;
}

/** Write `version` into one version file, keeping its formatting and line endings. Returns the files changed. */
export function writeVersionFile(dir: string, file: string, version: string): string[] {
  const p = path.join(dir, file);
  const text = readText(p);
  if (text === undefined) return [];
  const changed: string[] = [];
  if (file === 'package.json') {
    const next = text.replace(/("version"\s*:\s*")[^"]*(")/, (_m, a: string, b: string) => `${a}${version}${b}`);
    if (next !== text) { fs.writeFileSync(p, next); changed.push(file); }
    // The lockfile repeats the project's own version in two places.
    const lockPath = path.join(dir, 'package-lock.json');
    const lock = readText(lockPath);
    if (lock !== undefined) {
      try {
        const parsed = JSON.parse(lock) as { version?: string; packages?: Record<string, { version?: string }> };
        const old = (JSON.parse(text) as { version?: string }).version;
        if (parsed.version === old || parsed.packages?.['']?.version === old) {
          const indent = /^\{\r?\n([ \t]+)"/.exec(lock)?.[1] ?? '  ';
          if (parsed.version === old) parsed.version = version;
          if (parsed.packages?.[''] && parsed.packages[''].version === old) parsed.packages[''].version = version;
          const eol = eolOf(lock);
          let outText = JSON.stringify(parsed, null, indent).replace(/\n/g, eol);
          if (/\r?\n$/.test(lock)) outText += eol;
          fs.writeFileSync(lockPath, outText);
          changed.push('package-lock.json');
        }
      } catch { /* an unreadable lockfile is left exactly as it is */ }
    }
  } else if (file === 'pyproject.toml' || file === 'Cargo.toml') {
    const eol = eolOf(text);
    const lines = text.split(/\r?\n/);
    const at = tomlVersionLine(lines, file === 'Cargo.toml' ? ['package'] : ['project', 'tool.poetry']);
    if (at >= 0) {
      lines[at] = lines[at]!.replace(/(["'])[^"']*(["'])/, `$1${version}$2`);
      fs.writeFileSync(p, lines.join(eol));
      changed.push(file);
    }
  } else if (/\.csproj$/i.test(file)) {
    const next = text.replace(/(<Version>\s*)[^<\s]+(\s*<\/Version>)/, (_m, a: string, b: string) => `${a}${version}${b}`);
    if (next !== text) { fs.writeFileSync(p, next); changed.push(file); }
  }
  return changed;
}

// ── notes ────────────────────────────────────────────────────────────────

export interface NoteTask { id: string; title: string; kind: ChangeKind; breaking: boolean; summary?: string }

const SECTIONS: Array<{ title: string; kinds: ChangeKind[] }> = [
  { title: 'Added', kinds: ['feat'] },
  { title: 'Fixed', kinds: ['fix'] },
  { title: 'Changed', kinds: ['perf', 'refactor'] },
  { title: 'Other', kinds: ['docs', 'test', 'chore', 'other'] },
];

/** One line of an evidence summary, short enough to sit under a release note. */
export function noteSummary(task: Pick<Task, 'evidence'>): string | undefined {
  const line = task.evidence?.summary?.split('\n').map(s => s.trim()).find(Boolean);
  if (!line) return undefined;
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/** Markdown release notes (no heading): breaking changes first, then by what the change was. */
export function buildNotes(tasks: readonly NoteTask[], other: ReadonlyArray<{ subject: string }> = []): string {
  const bullet = (t: NoteTask): string => `- ${t.title}${t.summary ? ` (${t.summary})` : ''}`;
  const out: string[] = [];
  const breaking = tasks.filter(t => t.breaking);
  if (breaking.length > 0) out.push('### Breaking changes', '', ...breaking.map(bullet), '');
  for (const s of SECTIONS) {
    const items = tasks.filter(t => !t.breaking && s.kinds.includes(t.kind));
    if (items.length > 0) out.push(`### ${s.title}`, '', ...items.map(bullet), '');
  }
  const extras = other.map(o => o.subject).filter(Boolean).slice(0, 20);
  if (extras.length > 0) out.push('### Also on the trunk', '', ...extras.map(s => `- ${s}`), ...(other.length > extras.length ? [`- and ${other.length - extras.length} more`] : []), '');
  return out.join('\n').trimEnd() || 'No changes recorded.';
}

/** Insert a section into CHANGELOG text: below an Unreleased section, else after the title, else at the top. */
export function insertChangelog(text: string, section: string): string {
  const eol = eolOf(text);
  const body = section.replace(/\n/g, eol);
  if (!text.trim()) return `# Changelog${eol}${eol}${body}${eol}`;
  const lines = text.split(/\r?\n/);
  const heading = (i: number): boolean => /^##\s/.test(lines[i]!);
  const unreleased = lines.findIndex(l => /^##\s*\[?unreleased\]?/i.test(l));
  let at: number;
  if (unreleased >= 0) {
    at = unreleased + 1;
    while (at < lines.length && !heading(at)) at++;
  } else {
    const firstSection = lines.findIndex((_l, i) => heading(i));
    at = firstSection >= 0 ? firstSection : lines.length;
  }
  const before = lines.slice(0, at).join(eol).replace(/\s+$/, '');
  const after = lines.slice(at).join(eol);
  return `${before}${before ? `${eol}${eol}` : ''}${body}${eol}${after ? `${eol}${after}` : ''}`;
}

// ── the plan ─────────────────────────────────────────────────────────────

export interface PlanInput {
  project: string;
  repo: string;
  trunk: string;
  tasks: readonly Task[];
  /** The app's or the setting's deploy command, resolved by the caller. */
  deploy: ReleasePlan['deploy'];
  /** A version the person asked for instead of the proposal. */
  version?: string;
  now?: Date;
}

const norm = (p: string): string => p.replace(/\\/g, '/');

/** Where release worktrees live: beside, never inside, the task worktrees the sweep manages. */
export function releaseWorktree(project: string, version: string): string {
  return path.join(aicoHome(), 'worktrees', 'release', projectKey(project), version);
}

/** The project's folder inside the repository (empty when the project is the repository). */
function insideRepo(repo: string, project: string): string {
  const rel = path.relative(repo, path.resolve(project));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : '';
}

export async function planRelease(input: PlanInput): Promise<ReleasePlan> {
  const { repo, trunk } = input;
  const blockers: string[] = [];
  const plan: ReleasePlan = {
    trunk, versionFiles: [], tasks: [], other: [], commitCount: 0, notes: '', deploy: input.deploy, blockers,
  };
  if (!(await G.revParse(repo, G.headRef(trunk)))) { blockers.push(`The trunk branch "${trunk}" does not exist yet; make a first commit.`); return plan; }

  const tags = (await G.tagsMerged(repo, G.headRef(trunk))).filter(t => parseSemver(t) && /^v\d+\.\d+\.\d+$/.test(t));
  tags.sort((a, b) => compareSemver(parseSemver(b)!, parseSemver(a)!));
  const lastTag = tags[0];
  if (lastTag) { plan.lastTag = lastTag; plan.lastVersion = formatSemver(parseSemver(lastTag)!); }

  const commits = await G.logRange(repo, lastTag ? `${lastTag}..${G.headRef(trunk)}` : G.headRef(trunk));
  plan.commitCount = commits.length;
  if (commits.length === 0) blockers.push(lastTag ? `Nothing has landed on ${trunk} since ${lastTag}.` : `${trunk} has no commits.`);

  // Which of those commits came from the board: each unreleased merged task's landed range.
  const fromBoard = new Set<string>();
  const unreleased: Task[] = [];
  for (const t of input.tasks) {
    if (t.status !== 'merged' || !t.landed) continue;
    if (lastTag && await G.isAncestor(repo, t.landed.to, lastTag)) continue;
    if (!(await G.isAncestor(repo, t.landed.to, G.headRef(trunk)))) continue;
    unreleased.push(t);
    for (const sha of await G.revList(repo, `${t.landed.from}..${t.landed.to}`)) fromBoard.add(sha);
  }
  unreleased.sort((a, b) => (a.landed!.at < b.landed!.at ? -1 : 1));
  plan.tasks = unreleased.map(t => {
    const summary = noteSummary(t);
    return { id: t.id, title: t.title, kind: t.landed!.kind, breaking: t.landed!.breaking, ...(summary ? { summary } : {}) };
  });
  plan.other = commits.filter(c => !fromBoard.has(c.sha)).map(c => ({ sha: c.sha.slice(0, 10), subject: c.subject }));

  const folder = path.join(repo, insideRepo(repo, input.project));
  const files = readVersionFiles(folder);
  plan.versionFiles = files.map(f => norm(path.join(insideRepo(repo, input.project), f.file)));
  const fileHigh = files.map(f => parseSemver(f.version)!).sort(compareSemver).at(-1);
  const tagV = lastTag ? parseSemver(lastTag)! : undefined;
  const base = [fileHigh, tagV].filter((x): x is Semver => Boolean(x)).sort(compareSemver).at(-1);
  if (base) plan.baseVersion = formatSemver(base);

  const parsed = commits.map(c => parseConventional(c.subject, c.body));
  const wanted = input.version?.trim();
  if (wanted) {
    const v = parseSemver(wanted);
    if (!v) blockers.push(`"${wanted}" is not a version (use major.minor.patch, for example 1.4.0).`);
    else if (base && compareSemver(v, base) <= 0) blockers.push(`${formatSemver(v)} is not higher than ${formatSemver(base)}.`);
    else plan.next = { version: formatSemver(v), bump: base ? (v.major > base.major ? 'major' : v.minor > base.minor ? 'minor' : 'patch') : 'minor', reason: 'chosen by you' };
  } else if (commits.length > 0) {
    if (!lastTag && fileHigh) {
      // Never released, but the project already declares a version: that is the first release.
      plan.next = { version: formatSemver(fileHigh), bump: 'none', reason: 'the first release, at the version your project already declares' };
    } else if (base) {
      const b = bumpFor(parsed);
      plan.next = { version: formatSemver(bumpSemver(base, b.bump)), bump: b.bump, reason: b.reason };
    } else {
      // Nothing was ever released and the project declares no version: the first release.
      plan.next = { version: '0.1.0', bump: 'minor', reason: 'the first release (no tag and no version file yet)' };
    }
  }
  if (plan.next && await G.tagExists(repo, `v${plan.next.version}`)) {
    blockers.push(`The tag v${plan.next.version} already exists; pick another version.`);
  }
  plan.notes = buildNotes(plan.tasks, plan.other);
  return plan;
}

// ── making the release ───────────────────────────────────────────────────

export interface MakeInput extends PlanInput {
  version: string;
  changelog: boolean;
  plan: ReleasePlan;
  /** Isolation point for tests of failure handling. */
  today?: string;
}

export type MakeResult =
  | { ok: true; release: Release }
  | { ok: false; reason: string; status?: number };

/** Build the bump commit in a throwaway worktree, tag it, land it by fast-forward. */
export async function makeRelease(input: MakeInput): Promise<MakeResult> {
  const { repo, trunk, version, plan } = input;
  const tag = `v${version}`;
  const branch = `aico/release-${version}`;
  const wt = releaseWorktree(input.project, version);
  const rel = insideRepo(repo, input.project);
  const date = input.today ?? (input.now ?? new Date()).toISOString().slice(0, 10);
  const cleanup = async (): Promise<void> => {
    await G.worktreeRemove(repo, wt, true);
    try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* busy: the next release's prune handles it */ }
    await G.worktreePrune(repo);
    if (await G.branchExists(repo, branch)) await G.branchDelete(repo, branch, true);
  };
  await cleanup();   // leftovers of an earlier failed attempt at this same version
  const made = await G.worktreeAdd(repo, wt, branch, G.headRef(trunk));
  if (!made.ok) return { ok: false, reason: `Could not prepare the release: ${(made.err || made.out).trim().slice(0, 300)}`, status: 409 };
  try {
    const folder = path.join(wt, rel);
    const changed: string[] = [];
    for (const f of readVersionFiles(folder)) for (const c of writeVersionFile(folder, f.file, version)) changed.push(norm(path.join(rel, c)));
    if (input.changelog) {
      const file = path.join(folder, 'CHANGELOG.md');
      const section = `## ${version} - ${date}\n\n${plan.notes}\n`;
      fs.writeFileSync(file, insertChangelog(readText(file) ?? '', section));
      changed.push(norm(path.join(rel, 'CHANGELOG.md')));
    }
    if (changed.length === 0) {
      // Nothing to write (no version file, changelog off): the tag alone marks the release, on the trunk's tip.
      const tip = await G.revParse(repo, G.headRef(trunk));
      if (!tip) return { ok: false, reason: `The trunk branch "${trunk}" does not exist.`, status: 409 };
      const t = await G.tagCreate(repo, tag, tip, `${tag}\n\n${plan.notes}`);
      if (!t.ok) return { ok: false, reason: `Could not create the tag: ${(t.err || t.out).trim().slice(0, 300)}`, status: 409 };
      return { ok: true, release: asRelease(input, version, tag, tip, changed) };
    }
    const add = await G.git(['add', '--', ...changed.map(f => path.relative(rel, f))], folder);
    if (!add.ok) return { ok: false, reason: `Could not stage the release files: ${add.err.trim().slice(0, 300)}`, status: 409 };
    const commit = await G.git(['commit', '-m', `chore(release): ${tag}`], wt);
    if (!commit.ok) {
      return { ok: false, reason: `Could not commit the release (is git's user.name and user.email set?): ${(commit.err || commit.out).trim().slice(0, 300)}`, status: 409 };
    }
    const sha = await G.revParse(wt, 'HEAD');
    if (!sha) return { ok: false, reason: 'Could not read the release commit.', status: 409 };
    const t = await G.tagCreate(repo, tag, sha, `${tag}\n\n${plan.notes}`);
    if (!t.ok) return { ok: false, reason: `Could not create the tag: ${(t.err || t.out).trim().slice(0, 300)}`, status: 409 };
    const ff = await G.fastForward(repo, trunk, branch);
    if (!ff.ok) {
      await G.tagDelete(repo, tag);   // a refused release leaves no tag behind
      return { ok: false, reason: `Could not land the release on ${trunk}: ${ff.message || 'git refused'}. Check out ${trunk} with no changes the release would overwrite, then try again.`, status: 409 };
    }
    return { ok: true, release: asRelease(input, version, tag, sha, changed) };
  } finally {
    await cleanup();
  }
}

function asRelease(input: MakeInput, version: string, tag: string, commit: string, files: string[]): Release {
  return {
    version, tag, commit, at: (input.now ?? new Date()).toISOString(),
    bump: input.plan.next?.version === version ? input.plan.next.bump : 'none',
    notes: input.plan.notes,
    tasks: input.plan.tasks.map(t => ({ ...t })),
    files,
  };
}
