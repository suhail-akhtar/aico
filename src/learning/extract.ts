/**
 * What a turn taught, read from its log — no model call, no guessing.
 *
 * The session log already holds every signal a reflection step would look for:
 * a 👎 with a note, a human message that arrived mid-turn to steer, a checks
 * gate that fired and a RunChecks that later passed, a VerifyApp that failed
 * and then passed on the same page, a tool error that repeated. Each extractor
 * here turns one of those into a *proposal*: a knowledge entry, a profile
 * fact, or a line about the user — pre-filled, marked as needing an edit when
 * it was inferred rather than said, and adopted only when a person keeps it.
 *
 * Pure over events, so the harness feeds it synthetic sessions and checks
 * exactly what comes out. Dedupe is word overlap, the same cheap matching the
 * knowledge store uses.
 *
 * @module learning/extract
 */

import { createHash } from 'crypto';
import type { Session } from '../session/session.js';
import type { SessionEvent } from '../session/events.js';
import type { KnowledgeEntry } from '../knowledge/types.js';
import { meaningfulWords } from '../knowledge/match.js';
import { suggestKnowledge } from '../../shared/knowledge-suggest.js';

export type ProposalKind = 'knowledge' | 'profile' | 'user';
export type ProposalStatus = 'open' | 'adopted' | 'dismissed';

export interface Proposal {
  id: string;
  kind: ProposalKind;
  /** For knowledge: when it applies, in the words the next task will use. */
  trigger?: string;
  /** The guidance, fact, or line itself. */
  content: string;
  /** Where it came from, in one sentence a reader can check. */
  why: string;
  /** `true` when the words were inferred (a fix, a repeat) rather than written by a person. */
  needsEdit: boolean;
  /** Where the evidence is: the session and the event seqs that led here. */
  evidence: { sessionId: string; seqs: number[]; turn?: number };
  /** For profile proposals: what adopting writes. */
  patch?: { packageManager?: string; command?: { name: string; command: string } };
  /** Knowledge for this project, or a line that follows the user everywhere. */
  scope: 'project' | 'global';
  status: ProposalStatus;
  createdAt: number;
  expiresAt: number;
}

/** A proposal lives this long unadopted before it is dropped as noise. */
export const PROPOSAL_TTL_MS = 30 * 86_400_000;
/** Two proposals whose meaningful words overlap this much are the same lesson. */
export const DEDUPE_OVERLAP = 0.8;

type Ev = SessionEvent;

function turnSlice(events: readonly Ev[], turn: number): Ev[] {
  let start = -1;
  let end = -1;
  events.forEach((e, i) => {
    if (e.type === 'turn/start' && (e.data as { turn: number }).turn === turn) start = i;
    if (e.type === 'turn/end' && (e.data as { turn: number }).turn === turn) end = i;
  });
  if (start < 0) return [];
  return events.slice(start, end < 0 ? events.length : end + 1);
}

function firstHumanText(slice: readonly Ev[]): { text: string; seq: number } | undefined {
  for (const e of slice) {
    if (e.type !== 'user/message') continue;
    const d = e.data as { content: string; source: { kind: string } };
    if (d.source.kind === 'human') return { text: d.content, seq: e.seq };
  }
  return undefined;
}

function stableId(kind: ProposalKind, key: string): string {
  return `${kind}-${createHash('sha1').update(key).digest('hex').slice(0, 10)}`;
}

function make(input: Omit<Proposal, 'id' | 'status' | 'createdAt' | 'expiresAt'> & { key: string }, now: number): Proposal {
  const { key, ...rest } = input;
  return {
    id: stableId(input.kind, key),
    ...rest,
    status: 'open',
    createdAt: now,
    expiresAt: now + PROPOSAL_TTL_MS,
  };
}

/** The first line of an error, with paths, numbers and hashes replaced so two occurrences compare equal. */
export function normaliseError(text: string): string {
  const first = text.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
  return first
    .replace(/[A-Za-z]:\\[^\s:]+|\/[^\s:]+/g, '<path>')
    .replace(/\b[0-9a-f]{7,}\b/gi, '<hash>')
    .replace(/\d+/g, '<n>')
    .slice(0, 160);
}

/** Overlap of two texts' meaningful words, 0..1 by the smaller set. */
export function overlap(a: string, b: string): number {
  const wa = meaningfulWords(a);
  const wb = meaningfulWords(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let hits = 0;
  for (const w of wa) if (wb.has(w)) hits++;
  return hits / Math.min(wa.size, wb.size);
}

// ── Extractors ──────────────────────────────────────────────────────────────

/** A 👎 with a note on a message of this turn → knowledge in the user's own words. */
export function fromFeedback(session: Session, turn: number, now = Date.now()): Proposal[] {
  const events = session.events;
  const slice = turnSlice(events, turn);
  if (slice.length === 0) return [];
  const asked = firstHumanText(slice);
  const seqsInTurn = new Set(slice.map(e => e.seq));
  const out: Proposal[] = [];
  // Feedback may arrive after turn/end; the latest rating per target wins.
  const latest = new Map<number, { rating: string; note?: string; seq: number }>();
  for (const e of events) {
    if (e.type !== 'message/feedback') continue;
    const d = e.data as { targetSeq: number; rating: string; note?: string };
    if (!seqsInTurn.has(d.targetSeq)) continue;
    latest.set(d.targetSeq, { rating: d.rating, ...(d.note ? { note: d.note } : {}), seq: e.seq });
  }
  for (const [target, fb] of latest) {
    if (fb.rating !== 'down' || !fb.note?.trim()) continue;
    const suggestion = suggestKnowledge(asked?.text, fb.note);
    out.push(make({
      kind: 'knowledge',
      trigger: suggestion.trigger,
      content: suggestion.content,
      why: 'You rated a reply down and said why. This keeps the note as guidance for tasks like that one.',
      needsEdit: false,
      evidence: { sessionId: session.header.id, seqs: [target, fb.seq], turn },
      scope: 'project',
      key: `feedback:${session.header.id}:${target}:${fb.note.trim()}`,
    }, now));
  }
  return out;
}

/** A human message that arrived mid-turn is a steer: guidance the first message lacked. */
export function fromSteering(session: Session, turn: number, now = Date.now()): Proposal[] {
  const slice = turnSlice(session.events, turn);
  const asked = firstHumanText(slice);
  if (!asked) return [];
  const out: Proposal[] = [];
  let steps = 0;
  for (const e of slice) {
    if (e.type === 'step/start') steps++;
    if (e.type !== 'user/message' || e.seq === asked.seq) continue;
    const d = e.data as { content: string; source: { kind: string } };
    // Only a human's words, only after work began: a plugin nudge is not a steer.
    if (d.source.kind !== 'human' || steps === 0) continue;
    const text = d.content.trim();
    if (text.length < 8 || text.length > 400) continue;
    const suggestion = suggestKnowledge(asked.text, text);
    out.push(make({
      kind: 'knowledge',
      trigger: suggestion.trigger,
      content: text,
      why: 'You steered the agent mid-turn. If this applies to every task like it, keep it; edit it into a rule first if it was one-off.',
      needsEdit: true,
      evidence: { sessionId: session.header.id, seqs: [asked.seq, e.seq], turn },
      scope: 'project',
      key: `steer:${session.header.id}:${e.seq}`,
    }, now));
  }
  return out;
}

/** The checks gate fired, and RunChecks later passed in the same turn: something was learned about that failure. */
export function fromChecksFix(session: Session, turn: number, now = Date.now()): Proposal[] {
  const slice = turnSlice(session.events, turn);
  const gate = slice.find(e => e.type === 'user/message'
    && (e.data as { source: { kind: string; plugin?: string } }).source.kind === 'plugin'
    && (e.data as { source: { plugin?: string } }).source.plugin === 'checks-gate');
  if (!gate) return [];
  const gateText = (gate.data as { content: string }).content;
  const pass = slice.find(e => e.seq > gate.seq && e.type === 'tool/result'
    && (e.data as { name: string; content: string }).name === 'RunChecks'
    && /^PASSED/.test((e.data as { content: string }).content));
  if (!pass) return [];
  // The check and the first error line the gate quoted, so the trigger names the failure class.
  const check = /^\s+(\w+) — /m.exec(gateText)?.[1] ?? /checks: (\w+)/.exec(gateText)?.[1] ?? 'checks';
  const errorLine = gateText.split('\n').map(l => l.trim()).find(l => /error|fail|cannot|expected/i.test(l) && !/^The project|^You changed|^Fix these/.test(l)) ?? '';
  const touched = slice.filter(e => e.type === 'tool/call' && /^(Write|Edit)$/.test((e.data as { name: string }).name))
    .map(e => { try { return String((JSON.parse((e.data as { arguments: string }).arguments) as { file_path?: string }).file_path ?? ''); } catch { return ''; } })
    .filter(Boolean);
  const files = [...new Set(touched)].slice(-3).map(f => f.replace(/\\/g, '/').split('/').slice(-2).join('/'));
  return [make({
    kind: 'knowledge',
    trigger: `${check} fails${errorLine ? ` with ${normaliseError(errorLine).replace(/<[^>]+>/g, '').trim()}` : ''}`.slice(0, 120),
    content: `When ${check} fails${errorLine ? ` like "${errorLine.slice(0, 120)}"` : ''}, the fix last time was in ${files.length ? files.join(', ') : 'the files touched that turn'}. Check there first.`,
    why: 'The checks gate objected and a later RunChecks passed in the same turn — the fix is worth remembering by its failure.',
    needsEdit: true,
    evidence: { sessionId: session.header.id, seqs: [gate.seq, pass.seq], turn },
    scope: 'project',
    key: `checksfix:${check}:${normaliseError(errorLine)}`,
  }, now)];
}

/** VerifyApp failed on a page and later passed on the same URL: the problem class is the lesson. */
export function fromVerifyFix(session: Session, turn: number, now = Date.now()): Proposal[] {
  const slice = turnSlice(session.events, turn);
  const verdicts = slice.filter(e => e.type === 'tool/result' && (e.data as { name: string }).name === 'VerifyApp');
  const out: Proposal[] = [];
  const byUrl = new Map<string, Ev[]>();
  for (const v of verdicts) {
    const content = (v.data as { content: string }).content;
    const url = /https?:\/\/\S+|file:\/\/\S+/.exec(content)?.[0] ?? 'the page';
    byUrl.set(url, [...(byUrl.get(url) ?? []), v]);
  }
  for (const [url, list] of byUrl) {
    const failed = list.find(v => /FAIL|does not work|problems?:/i.test((v.data as { content: string }).content));
    const passed = list.find(v => failed && v.seq > failed.seq && /PASS/i.test((v.data as { content: string }).content) && !/FAIL/i.test((v.data as { content: string }).content));
    if (!failed || !passed) continue;
    const content = (failed.data as { content: string }).content;
    const problem = content.split('\n').map(l => l.trim()).find(l => /^-\s|error|exception|undefined|null|failed/i.test(l)) ?? content.split('\n')[0] ?? '';
    out.push(make({
      kind: 'knowledge',
      trigger: `browser check fails with ${normaliseError(problem).replace(/<[^>]+>/g, '').trim()}`.slice(0, 120),
      content: `A page verified as failing with "${problem.slice(0, 140)}" then passed after the fix in this turn. Look for that class of problem first when a check fails the same way.`,
      why: `VerifyApp failed and then passed on ${url.replace(/^file:\/\/\/?/, '')} in one turn.`,
      needsEdit: true,
      evidence: { sessionId: session.header.id, seqs: [failed.seq, passed.seq], turn },
      scope: 'project',
      key: `verifyfix:${normaliseError(problem)}`,
    }, now));
  }
  return out;
}

/** The same tool error twice or more in a turn: a wall the agent kept walking into. */
export function fromRepeatedErrors(session: Session, turn: number, now = Date.now()): Proposal[] {
  const slice = turnSlice(session.events, turn);
  const seen = new Map<string, { count: number; seqs: number[]; name: string; sample: string }>();
  for (const e of slice) {
    if (e.type !== 'tool/result') continue;
    const d = e.data as { name: string; content: string; isError?: boolean };
    if (!d.isError) continue;
    const key = `${d.name}:${normaliseError(d.content)}`;
    const entry = seen.get(key) ?? { count: 0, seqs: [], name: d.name, sample: d.content.split('\n')[0]?.trim() ?? '' };
    entry.count++;
    entry.seqs.push(e.seq);
    seen.set(key, entry);
  }
  const out: Proposal[] = [];
  for (const [key, entry] of seen) {
    if (entry.count < 2) continue;
    const missingPm = /'(pnpm|yarn|bun)' is not recognized|(pnpm|yarn|bun): command not found|(pnpm|yarn|bun): not found/i.exec(entry.sample);
    if (missingPm) {
      const pm = (missingPm[1] ?? missingPm[2] ?? missingPm[3] ?? '').toLowerCase();
      out.push(make({
        kind: 'profile',
        content: `${pm} is not installed on this machine; use npm for this project.`,
        why: `The same "${pm} is not recognized" error came back ${entry.count} times in one turn.`,
        needsEdit: false,
        evidence: { sessionId: session.header.id, seqs: entry.seqs, turn },
        patch: { packageManager: 'npm' },
        scope: 'project',
        key: `pm:${pm}`,
      }, now));
      continue;
    }
    out.push(make({
      kind: 'knowledge',
      trigger: `${entry.name} fails with ${normaliseError(entry.sample).replace(/<[^>]+>/g, '').trim()}`.slice(0, 120),
      content: `${entry.name} failed the same way ${entry.count} times in one turn: "${entry.sample.slice(0, 140)}". Say what to do instead of retrying.`,
      why: 'An identical tool error repeated; a rule that names the way round it saves the retries next time.',
      needsEdit: true,
      evidence: { sessionId: session.header.id, seqs: entry.seqs, turn },
      scope: 'project',
      key: `repeat:${key}`,
    }, now));
  }
  return out;
}

/**
 * Drop proposals that say what another proposal, or an existing knowledge
 * entry, already says. Earlier wins, so the extractors' order — feedback
 * first, because a person wrote it — decides which survives.
 */
export function dedupe(proposals: Proposal[], existing: readonly KnowledgeEntry[] = []): Proposal[] {
  const kept: Proposal[] = [];
  const known = existing.map(e => `${e.trigger} ${e.content}`);
  for (const p of proposals) {
    const text = `${p.trigger ?? ''} ${p.content}`;
    if (known.some(k => overlap(text, k) >= DEDUPE_OVERLAP)) continue;
    if (kept.some(k => k.id === p.id || overlap(text, `${k.trigger ?? ''} ${k.content}`) >= DEDUPE_OVERLAP)) continue;
    kept.push(p);
  }
  return kept;
}

/** Everything one turn proposes, deduplicated. */
export function extractFromTurn(
  session: Session,
  turn: number,
  existing: readonly KnowledgeEntry[] = [],
  now = Date.now(),
): Proposal[] {
  return dedupe([
    ...fromFeedback(session, turn, now),
    ...fromSteering(session, turn, now),
    ...fromChecksFix(session, turn, now),
    ...fromVerifyFix(session, turn, now),
    ...fromRepeatedErrors(session, turn, now),
  ], existing);
}
