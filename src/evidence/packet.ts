/**
 * The change packet: a neutral, factual record of a piece of work, built from
 * the session log and git (ADR 0034).
 *
 * Why it exists. A pull request description or a final message written from the
 * model's memory says what the model remembers, which is exactly the claim a
 * reviewer cannot check. The log already holds what a reviewer would ask — what
 * was run, what it returned, what a person allowed — so the report is a fold over
 * the events (ADR 0001) rather than a second source of truth. It states what the
 * log proves and nothing else: a check with no `check/run` record is "not run",
 * a field with no source is "no record", an estimate says it is one.
 *
 * It does not interpret. It never says a change is "safe", "correct" or "ready",
 * it never names an author or a tool that wrote the code, and it has no opinion
 * about the diff. Those are a reviewer's.
 *
 * Pure: `buildEvidence` takes events and facts in, returns data out. Reading git
 * is `gatherGit`, kept apart so the fold is testable with a synthetic log.
 *
 * Deliberately not done: re-running anything to fill a gap (a report that runs
 * the tests is a check, not a record of one), and reconstructing checks run by a
 * sub-agent or in a person's own terminal — those are in other logs or none, and
 * the packet says the log it read.
 *
 * @module evidence/packet
 */

import fs from 'fs';
import path from 'path';
import { runGit } from '../codegraph/git.js';
import { costFor } from '../tokens.js';
import { isBashReadOnly } from '../safety.js';
import type { AicoSettings } from '../settings.js';
import type { SessionEvent, SessionEventMap } from '../session/events.js';

type CheckRunData = SessionEventMap['check/run'];

// ── Shape ────────────────────────────────────────────────────────────────

export interface FileChange { path: string; added: number; removed: number; binary?: boolean; untracked?: boolean; bySession?: boolean }

export interface GitFacts {
  /** What the counts are against: a commit, `HEAD`, or the merge base. */
  base: string;
  files: FileChange[];
}

export interface CheckEntry {
  seq: number;
  at: number;
  name: string;
  command: string;
  cwd?: string;
  outcome: CheckRunData['outcome'];
  exitCode: number | null;
  ms: number;
  tests?: CheckRunData['tests'];
  retry?: CheckRunData['retry'];
  findings?: CheckRunData['findings'];
  /** Source-changing tool calls recorded after this run: it describes older code. */
  editsAfter: number;
  /** Shell commands after this run that are not provably read-only: they may have changed files. */
  shellAfter: number;
}

export interface EvidencePacket {
  schema: 1;
  session: { id?: string; title?: string; events: number; lastSeq: number; startedAt?: number; endedAt?: number; lastTurn?: string };
  goal: { text: string; source: 'goal' | 'first message' | 'stated' } | null;
  files: { source: 'git' | 'log' | 'none'; base?: string; list: FileChange[]; added: number; removed: number };
  checks: {
    ran: CheckEntry[];
    /** Latest run per check, in the order first seen. */
    latest: CheckEntry[];
    /** Project checks with no record of having run; undefined when the project's checks were not given. */
    notRun?: string[];
  };
  verifyApp: Array<{ seq: number; verdict: 'passed' | 'failed' | 'unclear'; summary: string[] }>;
  scans: Array<{ seq?: number; kind: string; result: string; findings?: string[] }>;
  decisions: {
    approvedByPerson: Array<{ name: string; count: number }>;
    deniedByPerson: Array<{ name: string; count: number }>;
    deniedByPolicy: Array<{ name: string; reason: string; count: number }>;
  };
  models: Array<{ provider?: string; model: string; requests: number; inputTokens: number; outputTokens: number; cachedTokens: number }>;
  cost: { usd: number; estimated: true; delegatedUsd: number; note: string };
  delegations: Array<{ type: string; description: string; status: string; model?: string; toolCalls?: number }>;
  open: { todos: Array<{ title: string; status: string }>; failingChecks: string[]; gaps: string[] };
}

// ── Helpers ──────────────────────────────────────────────────────────────

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'CodeRewrite', 'Refactor']);

function argsOf(e: SessionEvent): Record<string, unknown> {
  try { const v = JSON.parse((e.data as { arguments?: string }).arguments ?? '{}') as unknown; return v && typeof v === 'object' ? v as Record<string, unknown> : {}; }
  catch { return {}; }
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Files a tool call says it wrote, as given in its arguments. */
function writtenPaths(e: SessionEvent): string[] {
  const a = argsOf(e);
  const found = [a.file_path, a.notebook_path, a.path].filter((x): x is string => typeof x === 'string');
  const edits = Array.isArray(a.files) ? a.files : [];
  for (const f of edits) if (f && typeof f === 'object' && typeof (f as { file_path?: unknown }).file_path === 'string') found.push((f as { file_path: string }).file_path);
  return found;
}

const norm = (p: string): string => p.replace(/\\/g, '/');

// ── Fold ─────────────────────────────────────────────────────────────────

export interface EvidenceOptions {
  /** The session's id and title, when known (the events carry the title; the id lives in the header). */
  sessionId?: string;
  /** Names of the checks the project defines, so unrun ones can be listed. */
  projectChecks?: string[];
  git?: GitFacts;
  /**
   * What the work was for, when the caller knows it better than the first message does.
   * An unattended run's first message is its own instructions, which are not a goal.
   */
  goal?: string;
  /** The project root, to relate absolute paths in tool calls to git's relative ones. */
  root?: string;
  settings?: AicoSettings;
}

/** Fold a session log into the packet. */
export function buildEvidence(events: readonly SessionEvent[], opts: EvidenceOptions = {}): EvidencePacket {
  const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;

  // Title: the last one logged.
  let title: string | undefined;
  for (const e of events) if (e.type === 'session/title') title = (e.data as SessionEventMap['session/title']).title;

  // Goal: a standing goal wins; else the first thing the person typed.
  let goal: EvidencePacket['goal'] = null;
  for (const e of events) {
    if (e.type !== 'goal/set') continue;
    const d = e.data as SessionEventMap['goal/set'];
    goal = d.status === 'cleared' ? null : { text: clip(oneLine(d.text), 400), source: 'goal' };
  }
  if (opts.goal) goal = { text: clip(oneLine(opts.goal), 400), source: 'stated' };
  if (!goal) {
    const first = events.find(e => e.type === 'user/message' && (e.data as SessionEventMap['user/message']).source.kind === 'human');
    if (first) goal = { text: clip(oneLine((first.data as SessionEventMap['user/message']).content), 400), source: 'first message' };
  }

  // Edits: seqs of source-changing calls, to say which check runs predate them.
  const editSeqs: number[] = [];
  const shellSeqs: number[] = [];
  const writtenBySession = new Set<string>();
  for (const e of events) {
    if (e.type !== 'tool/call') continue;
    const name = (e.data as SessionEventMap['tool/call']).name;
    if (name === 'Bash' || name === 'Terminal') {
      const command = String(argsOf(e).command ?? argsOf(e).input ?? '');
      if (!isBashReadOnly(command)) shellSeqs.push(e.seq);
      continue;
    }
    if (!WRITE_TOOLS.has(name)) continue;
    editSeqs.push(e.seq);
    for (const p of writtenPaths(e)) writtenBySession.add(norm(opts.root && path.isAbsolute(p) ? path.relative(opts.root, p) : p));
  }

  // Files.
  let files: EvidencePacket['files'];
  if (opts.git) {
    const list = opts.git.files.map(f => ({ ...f, bySession: writtenBySession.has(norm(f.path)) }));
    files = { source: 'git', base: opts.git.base, list, added: list.reduce((n, f) => n + f.added, 0), removed: list.reduce((n, f) => n + f.removed, 0) };
  } else if (writtenBySession.size > 0) {
    files = { source: 'log', list: [...writtenBySession].sort().map(p => ({ path: p, added: 0, removed: 0, bySession: true })), added: 0, removed: 0 };
  } else {
    files = { source: 'none', list: [], added: 0, removed: 0 };
  }

  // Checks.
  const ran: CheckEntry[] = [];
  for (const e of events) {
    if (e.type !== 'check/run') continue;
    const d = e.data as CheckRunData;
    ran.push({
      seq: e.seq, at: e.timestamp, name: d.name, command: d.command, ...(d.cwd ? { cwd: d.cwd } : {}),
      outcome: d.outcome, exitCode: d.exitCode, ms: d.ms,
      ...(d.tests ? { tests: d.tests } : {}), ...(d.retry ? { retry: d.retry } : {}), ...(d.findings ? { findings: d.findings } : {}),
      editsAfter: editSeqs.filter(s => s > e.seq).length,
      shellAfter: shellSeqs.filter(s => s > e.seq).length,
    });
  }
  const keyOf = (c: CheckEntry): string => `${c.cwd ?? ''}\u0000${c.name}`;
  const latestMap = new Map<string, CheckEntry>();
  for (const c of ran) latestMap.set(keyOf(c), c);
  const latest = [...latestMap.values()];
  const notRun = opts.projectChecks
    ? opts.projectChecks.filter(n => !ran.some(c => c.name === n || c.name.endsWith(`:${n}`)))
    : undefined;

  // VerifyApp: the verdict and what it said, as returned to the model.
  const callOf = new Map<string, SessionEvent>();
  for (const e of events) if (e.type === 'tool/call') callOf.set((e.data as SessionEventMap['tool/call']).callId, e);
  const verifyApp: EvidencePacket['verifyApp'] = [];
  const scans: EvidencePacket['scans'] = [];
  for (const e of events) {
    if (e.type !== 'tool/result') continue;
    const d = e.data as SessionEventMap['tool/result'];
    if (d.name === 'VerifyApp') {
      const text = d.content.replace(/^"|"$/g, '');
      const lines = text.split(/\\n|\n/).map(l => oneLine(l)).filter(Boolean);
      const verdict = /^PASSED/.test(lines[0] ?? '') ? 'passed' : /^FAILED/.test(lines[0] ?? '') ? 'failed' : 'unclear';
      verifyApp.push({ seq: e.seq, verdict: d.isError && verdict === 'unclear' ? 'failed' : verdict, summary: lines.slice(0, 6).map(l => clip(l, 220)) });
    } else if (d.name === 'DependencyAudit') {
      const lines = d.content.split(/\\n|\n/).map(l => oneLine(l)).filter(Boolean);
      scans.push({ seq: e.seq, kind: 'DependencyAudit', result: clip(lines[0] ?? '(no output)', 240), ...(lines.length > 1 ? { findings: lines.slice(1, 6).map(l => clip(l, 200)) } : {}) });
    }
  }
  for (const c of ran) {
    if (c.name !== 'security' && !c.findings) continue;
    const f = c.findings;
    scans.push({
      seq: c.seq, kind: 'security check',
      result: c.outcome === 'passed' ? 'passed' : c.outcome,
      ...(f ? { findings: [`secrets ${f.secrets}`, `high ${f.high}`, `medium ${f.medium}`, `advisories ${f.advisories}`] } : {}),
    });
  }
  // Findings of the supply-chain, secret, SAST and test-tamper controls (ADR 0033), one event each.
  // A control that found nothing leaves no event, so absence here is not proof it did not run.
  const byControl = new Map<string, Array<{ seq: number; d: SessionEventMap['safety/finding'] }>>();
  for (const e of events) {
    if (e.type !== 'safety/finding') continue;
    const d = e.data as SessionEventMap['safety/finding'];
    byControl.set(d.control, [...(byControl.get(d.control) ?? []), { seq: e.seq, d }]);
  }
  for (const [control, list] of byControl) {
    const outcomes = new Map<string, number>();
    for (const { d } of list) outcomes.set(d.outcome, (outcomes.get(d.outcome) ?? 0) + 1);
    scans.push({
      seq: list[0]!.seq, kind: control,
      result: `${list.length} finding${list.length === 1 ? '' : 's'} (${[...outcomes].map(([o, n]) => `${o} ×${n}`).join(', ')})`,
      findings: list.slice(0, 8).map(({ d }) => clip(oneLine(`${d.severity} ${d.rule}${d.file ? ` ${d.file}${d.line ? `:${d.line}` : ''}` : ''}${d.subject ? ` [${d.subject}]` : ''} — ${d.detail}`), 240)),
    });
  }

  // Approvals and denials.
  const approved = new Map<string, number>();
  const deniedPerson = new Map<string, number>();
  const deniedPolicy = new Map<string, { name: string; reason: string; count: number }>();
  const decided = new Set<string>();
  const bump = (m: Map<string, number>, k: string): void => { m.set(k, (m.get(k) ?? 0) + 1); };
  for (const e of events) {
    if (e.type !== 'tool/decision') continue;
    const d = e.data as SessionEventMap['tool/decision'];
    decided.add(d.callId);
    if (d.by === 'person') bump(d.decision === 'approved' ? approved : deniedPerson, d.name);
    else if (d.decision === 'denied') {
      // `stage` is the guard that refused, when the log records it (ADR 0035 adds it).
      const stage = (d as { stage?: string }).stage;
      const reason = clip(oneLine(`${stage ? `${stage}: ` : ''}${d.reason ?? 'refused by a guard'}`), 200);
      const k = `${d.name}\u0000${reason}`;
      const seen = deniedPolicy.get(k);
      deniedPolicy.set(k, { name: d.name, reason, count: (seen?.count ?? 0) + 1 });
    }
  }
  // Older logs recorded no decision events; a refusal is still in the result text.
  for (const e of events) {
    if (e.type !== 'tool/result') continue;
    const d = e.data as SessionEventMap['tool/result'];
    if (!d.isError || decided.has(d.callId)) continue;
    const m = /"error":"((?:User denied this tool call|Blocked by |BLOCKED:|Plan mode:|Refused:)[^"]{0,200})/.exec(d.content);
    if (!m) continue;
    if (/^User denied/.test(m[1]!)) { bump(deniedPerson, d.name); continue; }
    const reason = clip(oneLine(m[1]!), 200);
    const k = `${d.name}\u0000${reason}`;
    const seen = deniedPolicy.get(k);
    deniedPolicy.set(k, { name: d.name, reason, count: (seen?.count ?? 0) + 1 });
  }
  const tally = (m: Map<string, number>): Array<{ name: string; count: number }> => [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  // Models and cost.
  const models = new Map<string, EvidencePacket['models'][number]>();
  let provider: string | undefined; let model: string | undefined;
  let usd = 0;
  for (const e of events) {
    if (e.type === 'request/header') {
      const h = (e.data as SessionEventMap['request/header']).header;
      provider = h.provider; model = h.model;
    } else if (e.type === 'assistant/message') {
      const d = e.data as SessionEventMap['assistant/message'];
      const m = model ?? 'unknown';
      const row = models.get(`${provider ?? ''}\u0000${m}`) ?? { ...(provider ? { provider } : {}), model: m, requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
      row.requests++;
      if (d.usage) {
        row.inputTokens += d.usage.inputTokens; row.outputTokens += d.usage.outputTokens; row.cachedTokens += d.usage.cachedTokens;
        usd += costFor(m, d.usage, opts.settings);
      }
      models.set(`${provider ?? ''}\u0000${m}`, row);
    }
  }
  const spawns = new Map<string, SessionEventMap['agent/spawn']>();
  const delegations: EvidencePacket['delegations'] = [];
  let delegatedUsd = 0;
  for (const e of events) {
    if (e.type === 'agent/spawn') spawns.set((e.data as SessionEventMap['agent/spawn']).agentId, e.data as SessionEventMap['agent/spawn']);
    if (e.type === 'agent/done') {
      const d = e.data as SessionEventMap['agent/done'];
      const s = spawns.get(d.agentId);
      if (s) delegatedUsd += costFor(s.model, { inputTokens: d.inputTokens, outputTokens: d.outputTokens });
      delegations.push({ type: s?.agentType ?? 'agent', description: clip(oneLine(s?.description ?? ''), 160), status: d.status, ...(s?.model ? { model: s.model } : {}), toolCalls: d.toolCalls });
    }
  }

  // Open items.
  let todos: EvidencePacket['open']['todos'] = [];
  for (const e of events) {
    if (e.type !== 'tool/call' || (e.data as SessionEventMap['tool/call']).name !== 'TodoWrite') continue;
    const list = argsOf(e).todos;
    if (Array.isArray(list)) todos = list.filter((t): t is Record<string, unknown> => !!t && typeof t === 'object').map(t => ({ title: clip(oneLine(String(t.title ?? t.content ?? '')), 160), status: String(t.status ?? 'pending') }));
  }
  const openTodos = todos.filter(t => t.status !== 'done' && t.status !== 'completed' && t.status !== 'cancelled');
  const failingChecks = latest.filter(c => c.outcome !== 'passed').map(c => `${c.name} (${c.outcome})`);
  let lastTurn: string | undefined;
  for (const e of events) if (e.type === 'turn/end') { const r = (e.data as SessionEventMap['turn/end']).reason; lastTurn = r.kind === 'completed' ? 'completed' : r.kind === 'aborted' ? `aborted (${r.cause})` : r.kind === 'error' ? `error (${r.code})` : r.kind; }

  const gaps: string[] = [];
  if (ran.length === 0) gaps.push('No check/run record in this log: no project check is recorded as having run (a check run in another session, a sub-agent or a terminal would not appear here).');
  for (const c of latest) {
    if (c.outcome !== 'passed' || (c.editsAfter === 0 && c.shellAfter === 0)) continue;
    const after = [c.editsAfter > 0 ? `${c.editsAfter} edit${c.editsAfter === 1 ? '' : 's'}` : '', c.shellAfter > 0 ? `${c.shellAfter} shell command${c.shellAfter === 1 ? '' : 's'} that may have changed files` : ''].filter(Boolean).join(' and ');
    gaps.push(`${c.name} last ran before ${after} recorded in this log; that result may describe older code.`);
  }
  if (notRun && notRun.length > 0) gaps.push(`Not run: ${notRun.join(', ')}.`);
  for (const d of delegations) if (d.status !== 'completed') gaps.push(`A delegated ${d.type} agent ${d.status}${d.description ? `: ${d.description}` : ''}.`);
  if (lastTurn && lastTurn !== 'completed') gaps.push(`The last turn ended: ${lastTurn}.`);
  if (delegations.length > 0) gaps.push('Checks run by delegated agents are in their own logs and are not counted here.');

  const startedAt = events[0]?.timestamp;
  const endedAt = events[events.length - 1]?.timestamp;
  return {
    schema: 1,
    session: { ...(opts.sessionId ? { id: opts.sessionId } : {}), ...(title ? { title } : {}), events: events.length, lastSeq, ...(startedAt ? { startedAt } : {}), ...(endedAt ? { endedAt } : {}), ...(lastTurn ? { lastTurn } : {}) },
    goal,
    files,
    checks: { ran, latest, ...(notRun ? { notRun } : {}) },
    verifyApp,
    scans,
    decisions: { approvedByPerson: tally(approved), deniedByPerson: tally(deniedPerson), deniedByPolicy: [...deniedPolicy.values()].sort((a, b) => b.count - a.count) },
    models: [...models.values()],
    cost: { usd: Math.round(usd * 10_000) / 10_000, estimated: true, delegatedUsd: Math.round(delegatedUsd * 10_000) / 10_000, note: 'Estimated from token counts and the price table; a model with no listed price is costed at a default rate. Delegated agents are shown separately.' },
    delegations,
    open: { todos: openTodos, failingChecks, gaps },
  };
}

// ── Git ──────────────────────────────────────────────────────────────────

/** Count lines of an untracked text file, bounded; a binary or huge one counts 0 and is marked. */
function countLines(file: string): { lines: number; binary: boolean } {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1_000_000) return { lines: 0, binary: stat.size > 1_000_000 };
    const text = fs.readFileSync(file);
    if (text.includes(0)) return { lines: 0, binary: true };
    const s = text.toString('utf8');
    return { lines: s.length === 0 ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0), binary: false };
  } catch { return { lines: 0, binary: false }; }
}

/**
 * Per-file added/removed lines against a base, from git: the merge base with the
 * default branch when one exists, else `HEAD`. Compares the working tree, so
 * committed and uncommitted work both count, plus untracked files.
 * Undefined when `root` is not a git work tree.
 */
export async function gatherGit(root: string, base?: string): Promise<GitFacts | undefined> {
  const inside = await runGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out.trim() !== 'true') return undefined;
  // A ref comes from a flag, a query string or a tool argument: never one git could read as an option.
  if (base !== undefined && (!/^[\w./~^@{}-]{1,200}$/.test(base) || base.startsWith('-'))) return undefined;
  let ref = base;
  if (!ref) {
    for (const candidate of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
      const mb = await runGit(root, ['merge-base', 'HEAD', candidate]);
      const sha = mb.out.trim();
      if (mb.ok && sha) {
        // On the default branch itself the merge base is HEAD: then "the change" is the uncommitted work.
        ref = sha;
        break;
      }
    }
    ref ??= 'HEAD';
  }
  const verified = await runGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!verified.ok) return undefined;
  const files = new Map<string, FileChange>();
  const numstat = await runGit(root, ['diff', '--numstat', '--no-renames', ref, '--'], 30_000);
  if (numstat.ok) {
    for (const line of numstat.out.split('\n')) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!m) continue;
      files.set(m[3]!, { path: m[3]!, added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]), ...(m[1] === '-' ? { binary: true } : {}) });
    }
  }
  const untracked = await runGit(root, ['ls-files', '--others', '--exclude-standard'], 30_000);
  if (untracked.ok) {
    for (const rel of untracked.out.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 500)) {
      const { lines, binary } = countLines(path.join(root, rel));
      files.set(rel, { path: rel, added: lines, removed: 0, untracked: true, ...(binary ? { binary: true } : {}) });
    }
  }
  const short = await runGit(root, ['rev-parse', '--short', ref]);
  return { base: ref === 'HEAD' ? 'HEAD' : (short.out.trim() || ref), files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}
