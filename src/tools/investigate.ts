/**
 * Several read-only investigators on one question, at once.
 *
 * ## Why this exists and the build-team does not
 *
 * Multi-agent work pays off under three conditions: the sub-results would
 * pollute one context, the paths are genuinely independent, and the workers
 * want different tools. Breadth-first investigation satisfies all three.
 * Building software satisfies none of them — edits have dependencies, share a
 * working tree, and must happen in order. Anthropic's own guidance is explicit
 * that splitting a coding task by role (planner, implementer, tester,
 * reviewer) "creates particularly severe coordination problems", and their
 * measurements put multi-agent at 3-10x the tokens of a single agent, with
 * token spend alone explaining 80% of the quality difference. Most of what a
 * team appears to buy is simply spending more.
 *
 * So this fans out for *finding out* and never for *changing things*. One
 * agent — the caller — reads what comes back and does all the writing.
 *
 * ## What it enforces rather than requests
 *
 *   **Workers cannot write.** The `explore` tool set is read-only by
 *   construction. A prompt saying "do not edit anything" is a request; an
 *   absent Write tool is a fact.
 *
 *   **Fan-out is bounded and must be justified by distinct angles.** The
 *   failure Anthropic hit in production was agents spawning excessive
 *   sub-agents for simple queries and running redundant searches. Near-
 *   duplicate angles are refused, so the cost of a fan-out is at least
 *   proportional to the number of genuinely different questions asked.
 *
 *   **Cost is reported.** A parallel investigation is the most expensive
 *   single call in this codebase. Returning what it cost beside what it found
 *   is what lets a reader decide whether to do it again.
 *
 * @module tools/investigate
 */

import { runTask, type RunTaskOpts } from './task.js';
import { meaningfulWords } from '../knowledge/match.js';

/** Beyond this the coordination costs more than the parallelism returns. */
const MAX_ANGLES = 8;

/** Below this there is nothing to parallelise; ask directly instead. */
const MIN_ANGLES = 2;

export interface InvestigateInput {
  question?: string;
  angles?: string[];
  model?: string;
}

/**
 * Verbs that appear in almost every angle and so distinguish none of them.
 *
 * "Look at the auth code" and "examine the auth code" are one search billed
 * twice, and word overlap alone misses it: the shared subject is two words out
 * of three, and the third is a verb that could have been any of these. They
 * are stopwords for this comparison specifically — not for knowledge matching,
 * where "review" might be the subject rather than the instruction.
 *
 * Removing them is better than lowering the similarity threshold, which would
 * catch this pair by also catching genuinely different questions that happen
 * to share two words.
 */
const INVESTIGATION_VERBS = new Set([
  'look', 'examine', 'check', 'find', 'trace', 'review', 'inspect', 'analyse',
  'analyze', 'investigate', 'explore', 'search', 'identify', 'determine',
  'understand', 'audit', 'assess', 'evaluate', 'see', 'read', 'study',
]);

/**
 * Angles that ask the same thing twice.
 *
 * Compared on meaningful words rather than exact text, because the redundancy
 * that wastes money is semantic — "look at the auth code" and "examine the
 * authentication code" are one search billed twice. Word overlap catches the
 * common case and lets genuinely different phrasings through, which is the
 * right direction to be wrong in: a duplicate that slips past costs one
 * worker, while a false positive would refuse a real line of enquiry.
 */
export function findDuplicateAngles(angles: readonly string[]): Array<[number, number]> {
  const words = angles.map((angle) => {
    const set = meaningfulWords(angle);
    for (const verb of INVESTIGATION_VERBS) set.delete(verb);
    return set;
  });
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 1; j < words.length; j++) {
      const a = words[i]!;
      const b = words[j]!;
      if (a.size === 0 || b.size === 0) continue;
      let shared = 0;
      for (const word of a) if (b.has(word)) shared++;
      // Against the smaller set, so "auth code" inside "examine the auth code
      // for bugs" still reads as the same question rather than a broader one.
      if (shared / Math.min(a.size, b.size) >= 0.8) pairs.push([i, j]);
    }
  }
  return pairs;
}

export async function investigate(
  input: InvestigateInput,
  opts: RunTaskOpts,
): Promise<string> {
  const question = input.question?.trim();
  const angles = (input.angles ?? []).map(a => a.trim()).filter(Boolean);

  if (!question) return 'investigate requires a question — what the findings are for.';
  if (angles.length < MIN_ANGLES) {
    return `investigate needs at least ${MIN_ANGLES} distinct angles. With one line of `
      + 'enquiry there is nothing to run in parallel — search directly instead.';
  }
  if (angles.length > MAX_ANGLES) {
    return `Refusing ${angles.length} angles; the limit is ${MAX_ANGLES}. Past that, `
      + 'coordination costs more than the parallelism returns. Narrow the question or '
      + 'run a second investigation with what the first one turns up.';
  }

  const duplicates = findDuplicateAngles(angles);
  if (duplicates.length > 0) {
    const [i, j] = duplicates[0]!;
    return `Angles ${i + 1} and ${j + 1} ask the same thing:\n  ${angles[i]}\n  ${angles[j]}\n`
      + 'Each angle costs a full agent, so near-duplicates are paid for twice and '
      + 'return the same finding. Make them genuinely different or drop one.';
  }

  const started = Date.now();
  // All at once. These are read-only and touch nothing shared, which is the
  // property that makes running them together safe — and is exactly what an
  // implementation fan-out would not have.
  const results = await Promise.all(angles.map(async (angle, index) => {
    try {
      const report = await runTask(
        {
          description: `investigate ${index + 1}/${angles.length}`,
          subagent_type: 'explore',
          ...input.model ? { model: input.model } : {},
          prompt: [
            `Overall question: ${question}`,
            '',
            `Your angle, and only this one: ${angle}`,
            '',
            'You are one of several investigators working in parallel on different',
            'angles of the same question. Report only what you found, with the file',
            'paths and evidence behind it. Do not attempt the other angles, and do',
            'not answer the overall question — someone else is doing that with every',
            'report in front of them. If your angle turns up nothing, say so plainly;',
            'a confident empty finding is worth more than a speculative one.',
          ].join('\n'),
        },
        opts,
      );
      return { angle, report, ok: true };
    } catch (error) {
      // One failed angle must not lose the other seven. They ran in parallel
      // and their findings are independent — that is the whole premise.
      return {
        angle,
        report: error instanceof Error ? error.message : String(error),
        ok: false,
      };
    }
  }));

  const seconds = Math.round((Date.now() - started) / 1000);
  const failed = results.filter(r => !r.ok).length;

  const body = results
    .map((r, i) => `### Angle ${i + 1}: ${r.angle}${r.ok ? '' : '  (FAILED)'}\n${r.report}`)
    .join('\n\n');

  return [
    `${angles.length} investigators ran in parallel for ${seconds}s`
      + `${failed > 0 ? `, ${failed} failed` : ''}.`,
    // Said out loud because a fan-out is the most expensive call available
    // here, and a reader who cannot see the cost cannot judge whether it was
    // worth it.
    `Each angle was a full agent; this cost roughly ${angles.length}x a single search.`,
    '',
    body,
    '',
    'These are raw findings from separate agents, none of which saw the others.',
    'Reconcile them yourself — where two disagree, check before believing either.',
  ].join('\n');
}

export const investigateDefinition = {
  name: 'Investigate',
  description: [
    'Run several read-only investigators in parallel on different angles of one',
    'question, and get their findings back together.',
    '',
    'Use it when a question genuinely splits into independent lines of enquiry that',
    'would each pollute your context if you did them yourself — auditing a subsystem',
    'from several directions, tracing how a behaviour is produced across unrelated',
    'areas, reviewing a change for correctness and security and performance at once.',
    '',
    'Do NOT use it to build something. The workers cannot write, and splitting',
    'implementation across agents produces conflicting edits and lost context; do the',
    'work yourself once you know what to do.',
    '',
    `Between ${MIN_ANGLES} and ${MAX_ANGLES} angles, and they must be genuinely`,
    'different — near-duplicates are refused, because each angle costs a full agent.',
    'One angle is not a fan-out; search directly instead.',
    '',
    'Pass a cheaper model for the workers when the angles are mechanical (finding',
    'where things live, listing usages); keep the default when they need judgement.',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      question: {
        type: 'string',
        description: 'The overall question the findings are for. Every worker sees it.',
      },
      angles: {
        type: 'array',
        items: { type: 'string' },
        description: `${MIN_ANGLES}-${MAX_ANGLES} distinct lines of enquiry, one per worker.`,
      },
      model: {
        type: 'string',
        description: 'Optional cheaper model for the workers. Defaults to yours.',
      },
    },
    required: ['question', 'angles'] as string[],
  },
};
