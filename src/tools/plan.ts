/**
 * A plan you can answer, rather than a plan you can only read.
 *
 * Plan mode already stopped the agent from changing anything — the tool set is
 * filtered to read-only — but what came out the other end was prose. Prose can
 * be read and cannot be answered: there is nothing to approve, nothing to
 * amend, and no way to say "yes, but not the third step" except by writing a
 * paragraph and hoping it lands.
 *
 * So a plan is a value. Steps, what will be touched, what is risky, and what
 * the agent still does not know. Once it has a shape, the interface can offer
 * the four answers a plan actually deserves: go ahead, change this, not now,
 * and no.
 *
 * **The open questions matter most.** A plan built on a guess is the expensive
 * kind of wrong, and the moment to catch it is before any of it runs. Asking
 * for them explicitly gets them stated instead of silently resolved.
 *
 * **It is the last word of a plan-mode turn, not a step within one.** Calling
 * it is how the agent stops planning and hands over — which is why it takes the
 * whole plan at once rather than being built up across calls.
 *
 * **It is also the sizing step.** `estimate_hours` above the long-job
 * threshold turns the plan into a proposal only a person can approve; the
 * conversation's handler for that lives in agent.ts and `longjob/`, because
 * this function knows no session. Below the threshold nothing changes.
 *
 * @module tools/plan
 */

export interface PlanStep {
  /** What will be done, in one line. */
  title: string;
  /** Why, or how — anything the reader needs to judge the step. */
  detail?: string;
  /** Files or areas this step touches, so the blast radius is visible. */
  touches?: string[];
  /** Long jobs: the checks that prove this milestone done (longjob/). */
  acceptance?: string[];
}

export interface PlanInput {
  /** The whole intent in one line, for the panel header. */
  title: string;
  steps: PlanStep[];
  /** Things that could go wrong, or that the reader should weigh before agreeing. */
  risks?: string[];
  /** What the agent could not determine and had to assume. */
  open_questions?: string[];
  /**
   * The sizing step. Above `longJobs.thresholdHours` the plan becomes a
   * long-job proposal that only a person can approve (agent.ts, longjob/).
   */
  estimate_hours?: number;
  /** The rest of a long-job proposal; ignored at or below the threshold. */
  long_job?: { research?: string; design?: string; cost_usd?: number; budget_usd?: number; budget_hours?: number };
}

/**
 * Record a plan for the person to answer.
 *
 * Returns a plain confirmation. The panel reads the *arguments* from the log,
 * not this string — the same projection the task list uses — so the wording
 * here is for the model's benefit rather than the interface's.
 */
export async function proposePlan(input: PlanInput): Promise<string> {
  const steps = Array.isArray(input.steps) ? input.steps : [];
  if (steps.length === 0) {
    throw new Error(
      'A plan needs at least one step. If the work is a single obvious action, '
      + 'there is nothing to plan — say so and stop, rather than proposing a plan of one.',
    );
  }

  const unanswered = input.open_questions?.length ?? 0;
  return [
    `Plan recorded: ${input.title} (${steps.length} step${steps.length === 1 ? '' : 's'}).`,
    unanswered > 0
      ? `${unanswered} open question${unanswered === 1 ? '' : 's'} went with it — the reader `
        + 'may answer them before approving.'
      : '',
    'It is now with the person to approve, amend, defer or decline. Stop here and wait; '
    + 'do not begin the work and do not restate the plan as prose.',
  ].filter(Boolean).join(' ');
}

export const proposePlanDefinition = {
  name: 'ProposePlan',
  description:
    'Put a plan forward for the person to approve, amend, defer or decline. Use this to '
    + 'finish a planning turn instead of describing the plan in prose — a written-out plan '
    + 'can only be read, while this one can be answered. '
    + 'State the open questions honestly: a plan built on a guess is the expensive kind of '
    + 'wrong, and before anything runs is the only cheap moment to catch it. '
    + 'Call it once, with the whole plan, and then stop. Before work of more than a few hours, call it first.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'The whole intent in one line.' },
      steps: {
        type: 'array',
        description: 'The steps, in the order they would happen.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'What this step does, in one line.' },
            detail: { type: 'string', description: 'Anything the reader needs to judge it, and the check that will prove it done.' },
            touches: {
              type: 'array',
              items: { type: 'string' },
              description: 'Files or areas this step changes, so the blast radius is visible.',
            },
            acceptance: { type: 'array', items: { type: 'string' } },
          },
          required: ['title'],
        },
      },
      risks: {
        type: 'array',
        items: { type: 'string' },
        description: 'What could go wrong, or what the reader should weigh before agreeing.',
      },
      open_questions: {
        type: 'array',
        items: { type: 'string' },
        description:
          'What you could not determine and had to assume. Say these plainly — an assumption '
          + 'the reader would have corrected is the cheapest bug there is.',
      },
      estimate_hours: {
        type: 'number',
        description: 'Honest hours of work. Over the long-job threshold (default 3h) a person must approve first: then fill long_job, and give each step (a milestone) acceptance; the last step is end-to-end verification and docs.',
      },
      long_job: {
        type: 'object',
        description: 'Over the threshold only. Research = findings and requirements; budget = the cap to approve.',
        properties: {
          research: { type: 'string' }, design: { type: 'string' },
          cost_usd: { type: 'number' }, budget_usd: { type: 'number' }, budget_hours: { type: 'number' },
        },
      },
    },
    required: ['title', 'steps'],
  },
};
