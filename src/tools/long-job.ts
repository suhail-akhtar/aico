/**
 * The model's side of a long job (see `longjob/`): read where the job is,
 * close a milestone, record a decision.
 *
 * Offered only to the conversation itself, and only while its session has an
 * approved job — an ordinary session never pays for this schema, which is how
 * the always-sent tool list stays flat.
 *
 * **A milestone closes here or not at all**, and only through two gates the
 * code runs rather than asks for: the project's checks (RunChecks is run by
 * this tool, then the same `checkProjectGate` the completion gate uses must
 * pass) and one piece of evidence per acceptance criterion. The evidence is
 * the model's statement and is recorded as such in the journal and report;
 * what is enforced is that none is skipped and that the checks are green.
 *
 * Deliberately no "finish" action: the job is done when its last milestone
 * closes, so there is no way to declare it done around the gates.
 *
 * @module tools/long-job
 */

import { activeJob, currentMilestone, recordDecision, recordMilestone, renderReport, reportFile } from '../longjob/index.js';
import { checkProjectGate } from '../checks.js';
import { gateChecks, runChecks } from './run-checks.js';

export interface LongJobInput {
  action?: string;
  evidence?: unknown;
  text?: unknown;
}

export async function longJobTool(input: LongJobInput, ctx: { sessionId: string }): Promise<string> {
  const job = activeJob(ctx.sessionId);
  if (!job) return 'This session has no approved long job.';
  const cur = currentMilestone(job);

  switch (input.action) {
    case 'status':
      return renderReport(job);

    case 'decision': {
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!text) return 'Give the decision in `text`: what was decided and why.';
      recordDecision(job, text);
      return 'Decision recorded in the job journal.';
    }

    case 'complete_milestone': {
      if (!cur) return 'Every milestone is already closed; the job is done.';
      const { index, milestone } = cur;
      const evidence = Array.isArray(input.evidence)
        ? input.evidence.map(e => (typeof e === 'string' ? e.trim() : '')) : [];
      const missing = milestone.acceptance.map((_, i) => i + 1).filter(i => !evidence[i - 1]);
      if (missing.length) {
        return `Milestone ${index + 1} is not closed: no evidence for criterion ${missing.join(', ')}. `
          + `Give \`evidence\` as ${milestone.acceptance.length} strings, one per criterion in order — `
          + 'what you ran or observed that shows it holds:\n'
          + milestone.acceptance.map((a, i) => `  ${i + 1}. ${a}`).join('\n');
      }
      // The checks gate, run here so "green" describes the code as it is now.
      const checks = gateChecks();
      let checksLine = 'This project defines no checks.';
      if (checks.length > 0) {
        const out = await runChecks({});
        const gate = checkProjectGate(checks);
        if (!gate.ok || /^FAILED/m.test(out)) {
          return `Milestone ${index + 1} is not closed: the project's checks do not pass.\n\n${gate.message ?? out.slice(0, 3000)}`;
        }
        checksLine = out.split('\n')[0]!.slice(0, 300);
      }
      const after = recordMilestone(job, index, evidence.slice(0, milestone.acceptance.length), checksLine);
      const next = currentMilestone(after);
      return next
        ? `Milestone ${index + 1} closed (${checksLine}). Next — milestone ${next.index + 1}/${after.milestones.length}: ${next.milestone.title}\n`
          + next.milestone.acceptance.map((a, i) => `  ${i + 1}. ${a}`).join('\n')
        : `Milestone ${index + 1} closed; that was the last. The job is done — the report is at ${reportFile(after)}. `
          + 'Summarise what was delivered for the person, with the evidence, and stop.';
    }

    default:
      return 'Unknown action. Use "status", "complete_milestone" (with evidence) or "decision" (with text).';
  }
}

export const longJobDefinition = {
  name: 'LongJob',
  description:
    'The approved long job in this session: "status" shows the journal; "complete_milestone" closes the current '
    + 'milestone — it runs the project\'s checks and needs one piece of evidence per acceptance criterion, in order; '
    + '"decision" records a design decision and why. The job ends when its last milestone closes.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['status', 'complete_milestone', 'decision'] },
      evidence: { type: 'array', items: { type: 'string' }, description: 'complete_milestone: what shows each criterion holds.' },
      text: { type: 'string', description: 'decision: what was decided and why.' },
    },
    required: ['action'],
  },
};
