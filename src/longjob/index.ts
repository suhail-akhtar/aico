/**
 * Long jobs: work estimated past a few hours, run only with a person's yes.
 *
 * **Not a mode.** Normal and medium work runs exactly as it always did. The
 * model sizes a request with the `estimate_hours` it already gives
 * `ProposePlan`; only an estimate above `longJobs.thresholdHours` (default 3)
 * turns the plan into a *proposal* — research and requirements, design,
 * milestones with acceptance criteria, time and cost, and a budget cap — and
 * the run stops there. Nothing else runs in that session until a person
 * approves or declines it:
 *
 *  - the turn ends on the proposal (agent loop), and
 *  - a deny-only guard refuses every tool that is not read-only while a
 *    proposal is pending (agent.ts `long-job` stage). A chat message saying
 *    "go ahead" does not approve it, and neither does the API token: the
 *    approve route asks the decision gate for a person (`checkHuman`).
 *
 * **After approval it runs across turns.** Each turn is bounded as today
 * (`maxIterations`, the session cost breaker — which is set to the job's
 * remaining budget for the turn). When a turn ends, {@link afterTurn} decides:
 * all milestones closed → done; budget or time spent → stopped at budget;
 * cancelled or failed → paused; too many turns with no milestone closed →
 * paused; otherwise the next turn is queued with the current milestone and
 * its criteria. A milestone closes only through the `LongJob` tool, and only
 * when the project's checks gate passes and each acceptance criterion has
 * its evidence (tools/long-job.ts).
 *
 * **The journal is the truth.** One append-only JSONL file per job under
 * `aicoHome()/long-jobs/<project>/`, the same shape as the approve-later
 * inbox: a `proposed` event with the whole proposal, then `status`,
 * `milestone`, `decision` and `turn` events. Read fresh on every call; a
 * restart finds `running` jobs there and resumes them ({@link resumable}).
 * The work ledger gets a mirror row (kind `run`) so the Activity page shows
 * the job, its milestone and spend, and its Stop button stops it — the ledger
 * marks rows `lost` on restart, which is why the journal, not the ledger, is
 * what recovery reads.
 *
 * Honest scope: the time budget is agent working time (the sum of turn
 * durations), checked between turns; the cost budget is also enforced inside
 * a turn. Acceptance evidence is the model's own statement — what is
 * *verified* by code is that every criterion has some, and that the checks
 * pass. Destructive steps still go through the ordinary approvals and the
 * inbox; approving a long job approves its plan, not its tool calls.
 *
 * Deliberately not here: a second planner, a team of agents, or a new
 * approval surface. It reuses ProposePlan, the decision gate, the checks
 * gate, the ledger and the session's queue.
 *
 * @module longjob
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { aicoHome } from '../home.js';
import { projectKey } from '../learning/proposals.js';
import { pushNotification } from '../background/notifications.js';
import { ledger } from '../work/ledger.js';
import { isTerminal } from '../work/types.js';
import { registerStopHandle, clearStopHandle } from '../work/handles.js';
import type { AicoSettings } from '../settings.js';

export const DEFAULT_THRESHOLD_HOURS = 3;
/** Sub-agent ceiling inside a long job; outside one, task.ts keeps its own defaults. */
export const DEFAULT_SUBAGENT_MINUTES = 60;
/** Turns in a row that may close no milestone before the job pauses for a person. */
export const NO_PROGRESS_TURNS = 4;

export type LongJobStatus =
  | 'pending' | 'declined' | 'superseded'
  | 'running' | 'paused'
  | 'done' | 'stopped' | 'budget';

const ENDED: ReadonlySet<LongJobStatus> = new Set(['declined', 'superseded', 'done', 'stopped', 'budget']);

export interface Milestone {
  title: string;
  detail?: string;
  acceptance: string[];
  doneAt?: number;
  evidence?: string[];
  checks?: string;
}

export interface LongJob {
  id: string;
  sessionId: string;
  cwd: string;
  title: string;
  research: string;
  design: string;
  milestones: Milestone[];
  estimateHours: number;
  costUsd?: number;
  budget: { usd: number; hours: number };
  risks: string[];
  openQuestions: string[];
  /** What the proposal still lacks; an incomplete proposal cannot be approved. */
  missing: string[];
  status: LongJobStatus;
  createdAt: number;
  decidedAt?: number;
  decidedVia?: string;
  /** Why it last changed state (paused because…, stopped at budget…). */
  note?: string;
  spentUsd: number;
  activeMs: number;
  turns: number;
  turnsSinceProgress: number;
  decisions: Array<{ at: number; text: string }>;
}

type JournalEvent =
  | { t: 'proposed'; at: number; job: LongJob }
  | { t: 'status'; at: number; status: LongJobStatus; via?: string; note?: string }
  | { t: 'milestone'; at: number; index: number; evidence: string[]; checks: string }
  | { t: 'decision'; at: number; text: string }
  | { t: 'turn'; at: number; usd: number; ms: number };

// ── settings ─────────────────────────────────────────────────────────

export function thresholdHours(settings?: AicoSettings): number {
  const n = Number(settings?.longJobs?.thresholdHours);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_THRESHOLD_HOURS;
}

export function subAgentMaxMs(settings?: AicoSettings): number {
  const n = Number(settings?.longJobs?.subAgentMaxMinutes);
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_SUBAGENT_MINUTES) * 60_000;
}

/** Above the threshold: a proposal, not a plan. At or below: nothing changes. */
export function isLongEstimate(hours: unknown, settings?: AicoSettings): boolean {
  const n = Number(hours);
  return Number.isFinite(n) && n > thresholdHours(settings);
}

// ── journal ──────────────────────────────────────────────────────────

export function longJobsDir(): string {
  return path.join(aicoHome(), 'long-jobs');
}

function journalFile(job: Pick<LongJob, 'id' | 'cwd'>): string {
  return path.join(longJobsDir(), projectKey(job.cwd), `${job.id}.jsonl`);
}

function append(job: Pick<LongJob, 'id' | 'cwd'>, event: JournalEvent): void {
  const file = journalFile(job);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A crash mid-append leaves a torn last line; start on a fresh one so the
  // next event is not glued to it (and lost with it).
  fs.appendFileSync(file, `${tornTail(file) ? '\n' : ''}${JSON.stringify(event)}\n`, 'utf8');
}

function tornTail(file: string): boolean {
  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size;
    if (size === 0) return false;
    fd = fs.openSync(file, 'r');
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } catch {
    return false; // no file yet
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Fold one journal into its job. A torn last line (a crash mid-append) is skipped. */
function fold(text: string): LongJob | undefined {
  let job: LongJob | undefined;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev: JournalEvent;
    try { ev = JSON.parse(line) as JournalEvent; } catch { continue; }
    if (ev.t === 'proposed') { job = structuredClone(ev.job); continue; }
    if (!job) continue;
    if (ev.t === 'status') {
      job.status = ev.status;
      // Approval and every resume are a person looking: the idle count restarts.
      if (ev.status === 'running') job.turnsSinceProgress = 0;
      if (ev.note !== undefined) job.note = ev.note;
      if (ev.via && !job.decidedVia && (ev.status === 'running' || ev.status === 'declined')) { job.decidedVia = ev.via; job.decidedAt = ev.at; }
    } else if (ev.t === 'milestone') {
      const m = job.milestones[ev.index];
      if (m) { m.doneAt = ev.at; m.evidence = ev.evidence; m.checks = ev.checks; }
      job.turnsSinceProgress = 0;
    } else if (ev.t === 'decision') {
      job.decisions.push({ at: ev.at, text: ev.text });
    } else if (ev.t === 'turn') {
      job.spentUsd += ev.usd;
      job.activeMs += ev.ms;
      job.turns++;
      job.turnsSinceProgress++;
    }
  }
  return job;
}

/** Every job in the store, newest first. Small files, read fresh (a terminal and a server may share them). */
export function listJobs(filter: { sessionId?: string } = {}): LongJob[] {
  const out: LongJob[] = [];
  let projects: string[] = [];
  try { projects = fs.readdirSync(longJobsDir()); } catch { return out; /* no long job yet */ }
  for (const p of projects) {
    let files: string[] = [];
    try { files = fs.readdirSync(path.join(longJobsDir(), p)).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      let text = '';
      try { text = fs.readFileSync(path.join(longJobsDir(), p, f), 'utf8'); } catch { continue; }
      const job = fold(text);
      if (job && (!filter.sessionId || job.sessionId === filter.sessionId)) out.push(job);
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function getJob(id: string): LongJob | undefined {
  return listJobs().find(j => j.id === id);
}

/** The proposal waiting for a person in this session, if any. */
export function pendingJob(sessionId: string): LongJob | undefined {
  return listJobs({ sessionId }).find(j => j.status === 'pending');
}

/** The approved job this session is working on (running or paused), if any. */
export function activeJob(sessionId: string): LongJob | undefined {
  return listJobs({ sessionId }).find(j => j.status === 'running' || j.status === 'paused');
}

export function currentMilestone(job: LongJob): { index: number; milestone: Milestone } | undefined {
  const index = job.milestones.findIndex(m => !m.doneAt);
  return index < 0 ? undefined : { index, milestone: job.milestones[index]! };
}

function setStatus(job: LongJob, status: LongJobStatus, extra: { via?: string; note?: string } = {}): LongJob {
  const at = Date.now();
  append(job, { t: 'status', at, status, ...(extra.via ? { via: extra.via } : {}), ...(extra.note !== undefined ? { note: extra.note } : {}) });
  job.status = status;
  if (status === 'running') job.turnsSinceProgress = 0;
  if (extra.note !== undefined) job.note = extra.note;
  if (extra.via && !job.decidedVia && (status === 'running' || status === 'declined')) { job.decidedVia = extra.via; job.decidedAt = at; }
  syncLedger(job);
  return job;
}

// ── proposing ────────────────────────────────────────────────────────

export interface ProposalInput {
  title?: unknown;
  steps?: unknown;
  risks?: unknown;
  open_questions?: unknown;
  estimate_hours?: unknown;
  long_job?: unknown;
}

const strings = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(s => s.trim()) : [];
const text = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');
const positive = (raw: unknown): number | undefined => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * Record a long-job proposal from a ProposePlan call whose estimate is over
 * the threshold. Always records — an incomplete proposal still blocks the
 * session (otherwise leaving fields out would be the way round the gate) —
 * and says what is missing so the next call can complete it. A newer
 * proposal supersedes a pending one in the same session.
 */
export function propose(input: ProposalInput, ctx: { sessionId: string; cwd: string }): LongJob {
  const lj = (input.long_job && typeof input.long_job === 'object' ? input.long_job : {}) as Record<string, unknown>;
  const steps = Array.isArray(input.steps) ? input.steps : [];
  const milestones: Milestone[] = steps.flatMap((raw): Milestone[] => {
    if (!raw || typeof raw !== 'object') return [];
    const s = raw as Record<string, unknown>;
    const title = text(s.title);
    if (!title) return [];
    const detail = text(s.detail);
    return [{ title, ...(detail ? { detail } : {}), acceptance: strings(s.acceptance) }];
  });
  const budgetUsd = positive(lj.budget_usd);
  const budgetHours = positive(lj.budget_hours);
  const missing: string[] = [];
  if (!text(lj.research)) missing.push('long_job.research (findings and requirements)');
  if (!text(lj.design)) missing.push('long_job.design (architecture approach)');
  if (milestones.length === 0) missing.push('steps (the milestones)');
  const noCriteria = milestones.map((m, i) => (m.acceptance.length ? 0 : i + 1)).filter(Boolean);
  if (noCriteria.length) missing.push(`acceptance criteria for milestone ${noCriteria.join(', ')}`);
  if (!budgetUsd) missing.push('long_job.budget_usd');
  if (!budgetHours) missing.push('long_job.budget_hours');

  for (const old of listJobs({ sessionId: ctx.sessionId }).filter(j => j.status === 'pending')) {
    setStatus(old, 'superseded', { note: 'A newer proposal replaced it.' });
  }

  const now = Date.now();
  const estimate = positive(input.estimate_hours) ?? 0;
  const costUsd = positive(lj.cost_usd);
  const job: LongJob = {
    id: `lj-${now.toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    sessionId: ctx.sessionId,
    cwd: path.resolve(ctx.cwd),
    title: text(input.title) || 'Long job',
    research: text(lj.research),
    design: text(lj.design),
    milestones,
    estimateHours: estimate,
    ...(costUsd ? { costUsd } : {}),
    // A missing cap is recorded as the estimate so the card has a number;
    // the proposal cannot be approved until the model states one (`missing`).
    budget: { usd: budgetUsd ?? costUsd ?? 0, hours: budgetHours ?? estimate },
    risks: strings(input.risks),
    openQuestions: strings(input.open_questions),
    missing,
    status: 'pending',
    createdAt: now,
    spentUsd: 0, activeMs: 0, turns: 0, turnsSinceProgress: 0,
    decisions: [],
  };
  append(job, { t: 'proposed', at: now, job });
  pushNotification({
    title: `Long job waiting for you: ${job.title}`,
    body: `Estimated ${estimate}h. Review the proposal and approve or decline it in the AICO window.`,
    level: 'warning',
    sourceId: `longjob:${job.id}`,
  });
  return job;
}

/** What ProposePlan answers when the plan became a long-job proposal. */
export function proposalResult(job: LongJob, settings?: AicoSettings): string {
  const head = `Estimated ${job.estimateHours}h, above the ${thresholdHours(settings)}h long-job threshold, so this is a long-job proposal (${job.id}), not a plan you may start.`;
  if (job.missing.length) {
    return `${head} It cannot be approved yet — it is missing: ${job.missing.join('; ')}. `
      + 'Call ProposePlan again with the complete proposal. Nothing that changes files runs in this session until a person approves or declines one.';
  }
  return `${head} It is with the person to approve or decline in the AICO window; a chat message does not approve it. `
    + 'Stop here. Nothing that changes files runs in this session until they decide.';
}

// ── deciding ─────────────────────────────────────────────────────────

export interface LongJobResult { ok: boolean; message: string; job?: LongJob }

/** A person's answer. The caller proved a person for an approval (decision gate); `via` records how. */
export function decide(id: string, decision: 'approve' | 'decline', via: string): LongJobResult {
  const job = getJob(id);
  if (!job) return { ok: false, message: `No long job ${id}.` };
  if (job.status !== 'pending') return { ok: false, message: `That proposal was already ${job.status}.`, job };
  if (decision === 'decline') {
    setStatus(job, 'declined', { via, note: 'Declined by the person.' });
    return { ok: true, message: 'Declined; the job will not run.', job };
  }
  if (job.missing.length) {
    return { ok: false, message: `This proposal is incomplete (${job.missing.join('; ')}); ask for a complete one before approving.`, job };
  }
  setStatus(job, 'running', { via, note: 'Approved.' });
  host?.start(job.sessionId, kickoffMessage(job));
  return { ok: true, message: `Approved; ${job.title} is starting.`, job };
}

/**
 * Pause, resume or stop. Pausing and stopping are always safe; resuming
 * spends money again, so the route asks for a person first (as for approve).
 */
export function control(id: string, action: 'pause' | 'resume' | 'stop', via: string): LongJobResult {
  const job = getJob(id);
  if (!job) return { ok: false, message: `No long job ${id}.` };
  if (action === 'resume') {
    if (job.status !== 'paused') return { ok: false, message: `Only a paused job can resume (this one is ${job.status}).`, job };
    if (overBudget(job)) return { ok: false, message: 'Its budget is spent; it cannot resume without a new proposal.', job };
    setStatus(job, 'running', { via, note: 'Resumed by the person.' });
    host?.start(job.sessionId, continueMessage(job, 'Resumed by the person.'));
    return { ok: true, message: 'Resumed.', job };
  }
  if (job.status !== 'running' && job.status !== 'paused' && !(action === 'stop' && job.status === 'pending')) {
    return { ok: false, message: `That job is ${job.status}.`, job };
  }
  if (action === 'pause') {
    if (job.status !== 'running') return { ok: false, message: `That job is ${job.status}.`, job };
    setStatus(job, 'paused', { via, note: 'Paused by the person; the current turn finishes and no next one starts.' });
    return { ok: true, message: 'Paused after the current turn.', job };
  }
  const was = job.status;
  setStatus(job, 'stopped', { via, note: 'Stopped by the person.' });
  if (was === 'running') host?.cancel(job.sessionId);
  writeReport(job);
  return { ok: true, message: 'Stopped.', job };
}

// ── progress ─────────────────────────────────────────────────────────

/** Close the current milestone. The tool has already run the gates. */
export function recordMilestone(job: LongJob, index: number, evidence: string[], checks: string): LongJob {
  const at = Date.now();
  append(job, { t: 'milestone', at, index, evidence, checks });
  const m = job.milestones[index]!;
  m.doneAt = at; m.evidence = evidence; m.checks = checks;
  job.turnsSinceProgress = 0;
  if (!currentMilestone(job)) {
    setStatus(job, 'done', { note: 'Every milestone closed with its acceptance criteria and checks.' });
    writeReport(job);
  } else {
    syncLedger(job);
  }
  return job;
}

export function recordDecision(job: LongJob, decisionText: string): void {
  const t = decisionText.trim().slice(0, 2000);
  append(job, { t: 'decision', at: Date.now(), text: t });
  job.decisions.push({ at: Date.now(), text: t });
}

function overBudget(job: LongJob): boolean {
  return (job.budget.usd > 0 && job.spentUsd >= job.budget.usd)
    || (job.budget.hours > 0 && job.activeMs >= job.budget.hours * 3_600_000);
}

/** USD left to spend, for the turn's cost ceiling. */
export function remainingUsd(job: LongJob): number {
  return Math.max(0, job.budget.usd - job.spentUsd);
}

/**
 * A turn of this session ended. Records its spend and returns the next
 * turn's message when the job should carry on — or nothing, having settled
 * the job (done, at budget, paused) and said so.
 */
export function afterTurn(
  sessionId: string,
  turn: { usd: number; ms: number; cancelled?: boolean; failed?: string },
  /**
   * The job that was live when the turn began. Needed because the turn that
   * closes the last milestone ends the job inside it — found live: looking
   * the job up afterwards missed that turn's spend, and the report said $0.
   */
  jobId?: string,
): string | undefined {
  const job = (jobId ? getJob(jobId) : undefined) ?? activeJob(sessionId);
  if (!job || job.sessionId !== sessionId) return undefined;
  const at = Date.now();
  const usd = Number.isFinite(turn.usd) && turn.usd > 0 ? turn.usd : 0;
  const ms = Number.isFinite(turn.ms) && turn.ms > 0 ? turn.ms : 0;
  append(job, { t: 'turn', at, usd, ms });
  job.spentUsd += usd; job.activeMs += ms; job.turns++; job.turnsSinceProgress++;
  if (ENDED.has(job.status)) { writeReport(job, false); return undefined; }   // the report now counts this turn
  if (job.status !== 'running') { syncLedger(job); return undefined; }
  if (!currentMilestone(job)) return undefined;

  if (overBudget(job)) {
    setStatus(job, 'budget', { note: `Stopped at the approved budget ($${job.spentUsd.toFixed(2)} of $${job.budget.usd}, ${hours(job.activeMs)} of ${job.budget.hours}h).` });
    writeReport(job);
    notify(job, 'warning', `Stopped at its budget. ${progressLine(job)}`);
    return undefined;
  }
  // No host: the server is shutting down and ended the turn. Left running,
  // so the next start resumes it from the journal.
  if (turn.cancelled && !host) { syncLedger(job); return undefined; }
  if (turn.cancelled) {
    setStatus(job, 'paused', { note: 'Paused: the turn was cancelled. Resume it from the job card.' });
    return undefined;
  }
  if (turn.failed) {
    setStatus(job, 'paused', { note: `Paused: the turn failed (${turn.failed.slice(0, 200)}). Resume it from the job card.` });
    notify(job, 'warning', `Paused after a failed turn. ${progressLine(job)}`);
    return undefined;
  }
  if (job.turnsSinceProgress >= NO_PROGRESS_TURNS) {
    setStatus(job, 'paused', { note: `Paused: ${NO_PROGRESS_TURNS} turns closed no milestone. A person should look before more is spent.` });
    notify(job, 'warning', `Paused — no milestone closed in ${NO_PROGRESS_TURNS} turns. ${progressLine(job)}`);
    return undefined;
  }
  syncLedger(job);
  return continueMessage(job);
}

/** Jobs a restart left running: resumed from the journal by the server at boot. */
export function resumable(): LongJob[] {
  return listJobs().filter(j => j.status === 'running');
}

/** Called once by the server at boot, after `setLongJobHost`. */
export function resumeAfterRestart(): number {
  const jobs = resumable();
  for (const job of jobs) {
    recordDecision(job, 'Resumed from the journal after AICO restarted.');
    syncLedger(job);
    host?.start(job.sessionId, continueMessage(job, 'AICO restarted; resuming from the journal.'));
  }
  return jobs.length;
}

// ── messages ─────────────────────────────────────────────────────────

const hours = (ms: number): string => `${(ms / 3_600_000).toFixed(1)}h`;

function progressLine(job: LongJob): string {
  const done = job.milestones.filter(m => m.doneAt).length;
  return `${done}/${job.milestones.length} milestones · $${job.spentUsd.toFixed(2)} of $${job.budget.usd} · ${hours(job.activeMs)} of ${job.budget.hours}h`;
}

function milestoneBrief(job: LongJob): string {
  const cur = currentMilestone(job);
  if (!cur) return 'Every milestone is closed.';
  const { index, milestone } = cur;
  return [
    `Milestone ${index + 1}/${job.milestones.length}: ${milestone.title}${milestone.detail ? ` — ${milestone.detail}` : ''}`,
    'Acceptance criteria:',
    ...milestone.acceptance.map((a, i) => `  ${i + 1}. ${a}`),
    'Build and test it, run RunChecks, then close it with LongJob action "complete_milestone" and one piece of evidence per criterion, in order. '
    + 'Record design decisions with action "decision". Destructive steps still need the person\'s approval.',
  ].join('\n');
}

export function kickoffMessage(job: LongJob): string {
  return `[Long job ${job.id}] Approved by the person: ${job.title}. Budget $${job.budget.usd}, ${job.budget.hours}h of agent time.\n`
    + `Design: ${job.design.slice(0, 600)}\n\n${milestoneBrief(job)}`;
}

export function continueMessage(job: LongJob, why?: string): string {
  return `[Long job ${job.id}] ${why ? `${why} ` : ''}Continue: ${progressLine(job)}.\n\n${milestoneBrief(job)}`;
}

function notify(job: LongJob, level: 'info' | 'warning' | 'success', body: string): void {
  pushNotification({ title: `Long job: ${job.title}`, body, level, sourceId: `longjob:${job.id}` });
}

// ── report ───────────────────────────────────────────────────────────

export function reportFile(job: Pick<LongJob, 'id' | 'cwd'>): string {
  return journalFile(job).replace(/\.jsonl$/, '.report.md');
}

/** The final report, from the journal alone: what was agreed, what was done, the evidence. */
export function renderReport(job: LongJob): string {
  const lines = [
    `# Long job: ${job.title}`,
    '',
    `Status: **${job.status}**${job.note ? ` — ${job.note}` : ''}`,
    `Approved via: ${job.decidedVia ?? 'n/a'} · Estimate: ${job.estimateHours}h${job.costUsd ? `, $${job.costUsd}` : ''} · Budget: $${job.budget.usd}, ${job.budget.hours}h`,
    `Spent: $${job.spentUsd.toFixed(2)} over ${job.turns} turn(s), ${hours(job.activeMs)} of agent time`,
    '',
    '## Research and requirements', '', job.research || '(none)', '',
    '## Design', '', job.design || '(none)', '',
    '## Milestones', '',
  ];
  job.milestones.forEach((m, i) => {
    lines.push(`### ${i + 1}. ${m.title} — ${m.doneAt ? `done ${new Date(m.doneAt).toISOString()}` : 'not done'}`);
    m.acceptance.forEach((a, k) => lines.push(`- ${a}${m.evidence?.[k] ? `\n  - Evidence: ${m.evidence[k]}` : ''}`));
    if (m.checks) lines.push(`- Checks: ${m.checks}`);
    lines.push('');
  });
  if (job.decisions.length) {
    lines.push('## Decisions', '', ...job.decisions.map(d => `- ${new Date(d.at).toISOString()} — ${d.text}`), '');
  }
  return lines.join('\n');
}

function writeReport(job: LongJob, announce = true): void {
  try {
    fs.writeFileSync(reportFile(job), renderReport(job), 'utf8');
  } catch { /* best effort: the journal holds everything the report says */ }
  if (announce && job.status === 'done') notify(job, 'success', `Done. ${progressLine(job)}. Report: ${reportFile(job)}`);
}

// ── the Activity row ─────────────────────────────────────────────────

/**
 * Mirror the job into the work ledger. The ledger forgets in-process rows
 * across a restart (it marks them lost), so a missing or ended row is opened
 * again under the job's id while the job itself is still live.
 */
function syncLedger(job: LongJob): void {
  try {
    const live = job.status === 'running' || job.status === 'paused';
    const row = ledger.get(job.id);
    const cur = currentMilestone(job);
    const note = `${cur ? `M${cur.index + 1}/${job.milestones.length} ${cur.milestone.title}` : 'all milestones closed'} · ${progressLine(job)}${job.status === 'paused' ? ' · paused' : ''}`;
    if (live && (!row || isTerminal(row.state))) {
      ledger.open({ id: job.id, kind: 'run', title: `Long job: ${job.title}`, origin: 'user', sessionId: job.sessionId });
      registerStopHandle(job.id, () => { control(job.id, 'stop', 'activity'); });
    }
    if (!ledger.get(job.id) || isTerminal(ledger.get(job.id)!.state)) return;
    if (live) {
      // The note carries milestones and spend; steps and cost stay unset so
      // the row does not say them twice.
      ledger.beat(job.id, { note });
      ledger.setState(job.id, job.status === 'paused' ? 'blocked' : 'running', note);
    } else if (ENDED.has(job.status)) {
      clearStopHandle(job.id);
      ledger.close(job.id, job.status === 'done' ? 'done' : 'cancelled', `${job.note ?? job.status} ${progressLine(job)}`);
    }
  } catch { /* best effort: the Activity row is a view; the journal is the record */ }
}

// ── the server's hand ────────────────────────────────────────────────

/**
 * How a job reaches its session: start (or queue) a turn, or cancel the
 * running one. Injected by the server at boot, like the watchers' wake
 * delivery, so this module does not depend on the run manager. Without one
 * (the terminal), approval is recorded and the job starts on the next turn.
 */
export interface LongJobHost {
  start(sessionId: string, message: string): void;
  cancel(sessionId: string): void;
}

let host: LongJobHost | undefined;

export function setLongJobHost(next: LongJobHost | undefined): void {
  host = next;
}
