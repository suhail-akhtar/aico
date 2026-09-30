/**
 * Starting points for a new AICO Docs document — the ten kinds of document
 * people most often ask an assistant to draft.
 *
 * Each template is a skeleton, not boilerplate prose: headings, the few
 * visual blocks that kind of document usually has, and a pending placeholder
 * (`<!-- aico:pending … -->`) under each heading saying what belongs there.
 * The person can write any section themselves ("Write it myself" on the
 * card) or ask AICO to fill them in, section by section, with the same
 * `write_section` flow the agent uses for its own outlines. Filler text would
 * have to be found and deleted; a placeholder disappears when it is written.
 *
 * @module shared/ui/canvas/templates
 */

import { pendingLine } from './blocks';
import { TOC_LINE, infographicTemplate } from './visual';

export interface DocTemplate {
  id: string;
  /** The engine's template id for `Canvas outline {template}` (its section plan and export defaults). */
  engineId?: string;
  label: string;
  description: string;
  /** Markdown for a document titled `title`. */
  build(title: string, date: string): string;
}

const P = (id: string, heading: string, intent: string): string => `${pendingLine(id, intent, heading)}`;
const join = (...parts: string[]): string => `${parts.join('\n\n')}\n`;

export const DOC_TEMPLATES: readonly DocTemplate[] = [
  {
    id: 'blank', label: 'Blank document', description: 'An empty page.',
    build: t => join(`# ${t}`),
  },
  {
    id: 'report', engineId: 'report', label: 'Report', description: 'Executive summary, findings, recommendations.',
    build: (t, d) => join(`# ${t}`, `_${d}_`, TOC_LINE,
      P('s1', 'Executive summary', 'The situation, the main finding and the recommendation in one paragraph'),
      infographicTemplate('stats'),
      P('s2', 'Background', 'Why this report exists and what was examined'),
      P('s3', 'Findings', 'What the evidence shows, one subsection per finding'),
      P('s4', 'Recommendations', 'Numbered, each with an owner and a date'),
      P('s5', 'Appendix', 'Data sources and method')),
  },
  {
    id: 'proposal', engineId: 'proposal', label: 'Proposal', description: 'Problem, solution, plan, cost.',
    build: (t, d) => join(`# ${t}`, `_Prepared ${d}_`,
      P('s1', 'Summary', 'What is proposed and why it is worth it'),
      P('s2', 'The problem', 'Who has it, what it costs today'),
      P('s3', 'Proposed solution', 'What will be delivered'),
      infographicTemplate('comparison'),
      P('s4', 'Plan and timeline', 'Phases with dates'),
      infographicTemplate('timeline'),
      P('s5', 'Cost', 'A table of costs by item'),
      P('s6', 'Next steps', 'What is needed to start')),
  },
  {
    id: 'brief', engineId: 'project-brief', label: 'Project brief', description: 'One page: goals, scope, timeline, risks.',
    build: t => join(`# ${t}`,
      P('s1', 'Summary', 'One paragraph on what the project is'),
      P('s2', 'Goals', 'Three to five measurable outcomes'),
      P('s3', 'Scope', 'In scope and out of scope'),
      P('s4', 'Timeline', 'A small table of phases and dates'),
      P('s5', 'Risks', 'The main risks and how each is handled')),
  },
  {
    id: 'memo', engineId: 'memo', label: 'Memo', description: 'To, from, subject — short and direct.',
    build: (t, d) => join(`# ${t}`, `**To:** \n**From:** \n**Date:** ${d}\n**Subject:** ${t}`,
      P('s1', 'Purpose', 'The decision or information this memo is about, in two sentences'),
      P('s2', 'Details', 'The facts the reader needs'),
      P('s3', 'Action required', 'Who does what by when')),
  },
  {
    id: 'letter', engineId: 'letter', label: 'Letter', description: 'A formal letter.',
    build: (t, d) => join(`# ${t}`, d, 'Dear ,',
      P('s1', 'Body', 'The letter: why you are writing, the details, what you ask for'),
      'Yours sincerely,\n\n'),
  },
  {
    id: 'minutes', engineId: 'meeting-minutes', label: 'Meeting minutes', description: 'Attendees, decisions, actions.',
    build: (t, d) => join(`# ${t}`, `**Date:** ${d}  \n**Attendees:** `,
      P('s1', 'Agenda', 'The items discussed'),
      P('s2', 'Discussion', 'Key points per agenda item'),
      '## Decisions\n\n- ',
      '## Action items\n\n- [ ] ',
      P('s3', 'Next meeting', 'Date and topics')),
  },
  {
    id: 'spec', engineId: 'spec', label: 'Spec / PRD', description: 'Problem, users, requirements, success metrics.',
    build: t => join(`# ${t}`, TOC_LINE,
      P('s1', 'Problem', 'The user problem and the evidence for it'),
      P('s2', 'Users and use cases', 'Who, and the top use cases'),
      P('s3', 'Requirements', 'Functional requirements as a numbered list; non-functional after'),
      P('s4', 'Design', 'The approach, with a diagram if it helps'),
      P('s5', 'Success metrics', 'How we will know it worked'),
      P('s6', 'Open questions', 'What is not decided yet')),
  },
  {
    id: 'policy', engineId: 'policy', label: 'Policy / SOP', description: 'Purpose, scope, procedure, responsibilities.',
    build: (t, d) => join(`# ${t}`, `**Effective:** ${d}  \n**Owner:** `, TOC_LINE,
      P('s1', 'Purpose', 'Why this policy exists'),
      P('s2', 'Scope', 'Who and what it applies to'),
      P('s3', 'Procedure', 'The steps, in order'),
      infographicTemplate('steps'),
      P('s4', 'Responsibilities', 'Roles and what each is accountable for'),
      P('s5', 'Exceptions and review', 'How exceptions are approved; review cadence')),
  },
  {
    id: 'one-pager', engineId: 'one-pager', label: 'One-pager', description: 'The pitch on a single page.',
    build: t => join(`# ${t}`,
      P('s1', 'The idea', 'One sentence, then one paragraph'),
      infographicTemplate('stats'),
      P('s2', 'Why now', 'What changed'),
      P('s3', 'How it works', 'Three steps'),
      P('s4', 'The ask', 'What you need from the reader')),
  },
  {
    id: 'research', engineId: 'research-summary', label: 'Research summary', description: 'Question, method, findings, implications.',
    build: (t, d) => join(`# ${t}`, `_${d}_`,
      P('s1', 'Question', 'What we wanted to learn'),
      P('s2', 'Method', 'Who, how many, how'),
      P('s3', 'Key findings', 'Findings, strongest first, each with evidence'),
      P('s4', 'Implications', 'What we should do differently'),
      P('s5', 'Limitations', 'What this research cannot tell us')),
  },
];

export function templateById(id: string): DocTemplate {
  return DOC_TEMPLATES.find(t => t.id === id) ?? DOC_TEMPLATES[0]!;
}

/** Today as "30 September 2026". */
export function longDate(at = Date.now()): string {
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
