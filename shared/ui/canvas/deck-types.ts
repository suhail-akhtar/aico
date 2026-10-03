/**
 * Deck types — what a professional audience expects of each kind of
 * presentation: its storyline (the slides, their layouts and what each must
 * say), the theme it starts in, how dense a slide may be, and a short brief.
 *
 * The same idea as the document types (`src/canvas/doc-types.ts`): the
 * agent's Canvas `create {kind: "deck", template}` lays the storyline down as
 * planned slides the person sees at once, and the brief is returned only then
 * — never in the system prompt, where it would cost tokens on every turn.
 * The editor's "New presentation" picker reads the same list.
 *
 * `maxBullets` is enforced by the layout engine's validation (a pitch slide
 * with seven bullets is reported, not just discouraged), because a limit the
 * model is merely told about is a limit it forgets by slide nine.
 *
 * @module shared/ui/canvas/deck-types
 */

import type { DeckLayout } from './deck-model';

export interface DeckTypeSlide { layout: DeckLayout; title: string; intent: string }

export interface DeckType {
  id: string;
  title: string;
  description: string;
  aliases: string[];
  /** Matched against a deck's title when no type is named. */
  match: RegExp;
  theme: string;
  /** Most bullets on one slide. */
  maxBullets: number;
  /** Words per content slide, a guide. */
  words: [number, number];
  slides: DeckTypeSlide[];
  brief: string;
}

export const DECK_TYPES: readonly DeckType[] = [
  {
    id: 'pitch', title: 'Pitch deck', description: 'Investor or partner pitch: problem, solution, market, traction, ask',
    aliases: ['investor pitch', 'startup pitch', 'fundraising'], match: /\bpitch|investor|fundrais|seed round|series [a-c]\b/i,
    theme: 'ember', maxBullets: 4, words: [10, 40],
    slides: [
      { layout: 'title', title: 'Company — one-line promise', intent: 'Name, the one-line value proposition, presenter and date' },
      { layout: 'bullets', title: 'The problem', intent: 'Who hurts, how much, and why existing options fail (3 bullets, one number)' },
      { layout: 'image-text', title: 'Our solution', intent: 'What the product does for that customer, in their words' },
      { layout: 'kpi', title: 'Market', intent: 'TAM / SAM / SOM as three big numbers with their basis' },
      { layout: 'chart', title: 'Traction', intent: 'Growth over time (revenue, users or pilots) with the one takeaway' },
      { layout: 'two-column', title: 'Business model', intent: 'How it makes money (pricing, unit economics) vs. how it reaches customers' },
      { layout: 'comparison', title: 'Why we win', intent: 'Us vs. the alternative customers use today' },
      { layout: 'timeline', title: 'Roadmap', intent: 'The next 3–5 milestones the money buys' },
      { layout: 'kpi', title: 'The ask', intent: 'Amount, runway, and the 2–3 uses of funds' },
      { layout: 'closing', title: 'Thank you', intent: 'Contact details' },
    ],
    brief: 'One idea per slide; titles are claims ("Revenue tripled in 2026"), not labels. Use real numbers only — mark unknowns [To confirm]. Keep bullets to 4 short lines.',
  },
  {
    id: 'technical-briefing', title: 'Technical briefing', description: 'Architecture or system briefing: context, design, data, risks, recommendations',
    aliases: ['technical', 'architecture briefing', 'tech briefing', 'architecture review', 'design review', 'engineering briefing'],
    match: /\btechnical|architecture|platform|farm|infrastructure|system design|engineering|migration\b/i,
    theme: 'slate', maxBullets: 6, words: [20, 70],
    slides: [
      { layout: 'title', title: 'System — briefing', intent: 'What system, for which audience, presenter and date' },
      { layout: 'agenda', title: 'Agenda', intent: 'The 4–6 parts of the briefing' },
      { layout: 'bullets', title: 'Context and goals', intent: 'Why this matters now, the constraints, what success looks like' },
      { layout: 'diagram', title: 'Architecture', intent: 'Component diagram (Mermaid flowchart) with the 2–3 things to notice' },
      { layout: 'table', title: 'Components', intent: 'Each component: role, technology, scale/sizing, owner' },
      { layout: 'chart', title: 'Performance and capacity', intent: 'Measured load, latency or capacity vs. target' },
      { layout: 'table', title: 'Risks and mitigations', intent: 'Risk, likelihood/impact, mitigation, owner' },
      { layout: 'bullets', title: 'Recommendations', intent: 'What to decide or do, in priority order' },
      { layout: 'timeline', title: 'Next steps', intent: 'Dated actions' },
      { layout: 'closing', title: 'Questions', intent: 'Contacts and where the detail lives' },
    ],
    brief: 'Precise and checkable: name versions, sizes and numbers; every diagram has a title that says what it shows. Tables beat bullets for comparisons. Never invent figures.',
  },
  {
    id: 'project-status', title: 'Project status', description: 'Status report: RAG summary, milestones, progress, risks, decisions',
    aliases: ['status report', 'status update', 'project update', 'steering committee', 'progress report'],
    match: /\bstatus|progress|steer(ing)?\b|weekly update|monthly update|sprint review/i,
    theme: 'ocean', maxBullets: 5, words: [15, 60],
    slides: [
      { layout: 'title', title: 'Project — status update', intent: 'Project, reporting period, presenter' },
      { layout: 'kpi', title: 'Summary', intent: 'Overall status (RAG), % complete, budget used, schedule variance' },
      { layout: 'timeline', title: 'Milestones', intent: 'Done / current / next milestones with dates' },
      { layout: 'chart', title: 'Progress', intent: 'Planned vs. actual (burn-up, spend or delivery)' },
      { layout: 'two-column', title: 'This period / next period', intent: 'Achieved vs. planned for the next period' },
      { layout: 'table', title: 'Risks and issues', intent: 'Item, impact, RAG, action, owner, due' },
      { layout: 'bullets', title: 'Decisions needed', intent: 'What the audience must decide today, with the recommendation' },
      { layout: 'closing', title: 'Questions', intent: 'Next update date and contacts' },
    ],
    brief: 'Lead with the status and what you need from the audience. Use RAG words (Green/Amber/Red) explicitly. Every risk has an owner and a date.',
  },
  {
    id: 'training', title: 'Training session', description: 'Teaching deck: objectives, concepts, examples, exercise, recap',
    aliases: ['training', 'workshop', 'course', 'lesson', 'tutorial', 'onboarding'],
    match: /\btrain|workshop|course|lesson|tutorial|onboard|introduction to|101\b/i,
    theme: 'meadow', maxBullets: 5, words: [15, 50],
    slides: [
      { layout: 'title', title: 'Topic — training', intent: 'Topic, audience, trainer, date' },
      { layout: 'agenda', title: 'Agenda', intent: 'The modules of the session' },
      { layout: 'bullets', title: 'Learning objectives', intent: 'By the end you will be able to… (3–4 objectives)' },
      { layout: 'section', title: 'Module 1', intent: 'The first concept' },
      { layout: 'image-text', title: 'Key concept', intent: 'The concept explained with one picture or example' },
      { layout: 'diagram', title: 'How it works', intent: 'A process or flow diagram' },
      { layout: 'bullets', title: 'Exercise', intent: 'Hands-on task with clear steps and expected result' },
      { layout: 'bullets', title: 'Recap', intent: 'The 3–5 things to remember' },
      { layout: 'closing', title: 'Thank you', intent: 'Resources and contact' },
    ],
    brief: 'Teach one concept per slide, with an example. Objectives use action verbs. Put the detail in speaker notes, not on the slide.',
  },
  {
    id: 'sales-proposal', title: 'Sales proposal', description: 'Client proposal: their challenge, our approach, value, plan, pricing',
    aliases: ['proposal', 'sales deck', 'client proposal', 'bid', 'rfp response'],
    match: /\bproposal|sales|offer|bid\b|rfp|quote for/i,
    theme: 'coral', maxBullets: 5, words: [15, 50],
    slides: [
      { layout: 'title', title: 'Proposal for Client', intent: 'Client, what is proposed, presenter, date' },
      { layout: 'bullets', title: 'Your challenge', intent: 'The client\'s situation and goals in their words' },
      { layout: 'diagram', title: 'Our approach', intent: 'How we will solve it (a short process)' },
      { layout: 'kpi', title: 'Expected value', intent: 'The outcomes in numbers (savings, time, revenue)' },
      { layout: 'timeline', title: 'Delivery plan', intent: 'Phases and dates' },
      { layout: 'table', title: 'Investment', intent: 'Options/line items with prices' },
      { layout: 'comparison', title: 'Why us', intent: 'Us vs. the alternative' },
      { layout: 'bullets', title: 'Next steps', intent: 'What happens after a yes' },
      { layout: 'closing', title: 'Thank you', intent: 'Contacts' },
    ],
    brief: 'About the client, not about us: start from their goal. Quantify value; prices must match the table exactly. Close with a clear next step.',
  },
  {
    id: 'board-update', title: 'Board update', description: 'Board or executive update: summary, KPIs, financials, risks, decisions',
    aliases: ['board', 'board pack', 'executive update', 'qbr', 'quarterly business review', 'investor update'],
    match: /\bboard|executive|qbr|quarterly|investor update|leadership update/i,
    theme: 'boardroom', maxBullets: 5, words: [15, 60],
    slides: [
      { layout: 'title', title: 'Board update — period', intent: 'Company, period, presenter, date' },
      { layout: 'bullets', title: 'Executive summary', intent: 'The 3–4 things the board must know' },
      { layout: 'kpi', title: 'Key metrics', intent: '3–4 KPIs with change vs. last period' },
      { layout: 'chart', title: 'Financial performance', intent: 'Revenue/costs vs. plan with the takeaway' },
      { layout: 'comparison', title: 'Highlights and lowlights', intent: 'What went well vs. what did not' },
      { layout: 'table', title: 'Risks', intent: 'Top risks, trend, mitigation' },
      { layout: 'bullets', title: 'Decisions requested', intent: 'Each decision with the recommendation' },
      { layout: 'closing', title: 'Discussion', intent: 'Questions' },
    ],
    brief: 'Answer first: the summary slide states the conclusion. Show change vs. plan and last period. Every decision request has a recommendation.',
  },
  {
    id: 'conference-talk', title: 'Conference talk', description: 'Talk for an audience: hook, story, big ideas, evidence, takeaway',
    aliases: ['talk', 'keynote', 'presentation', 'conference', 'meetup', 'webinar'],
    match: /\btalk|keynote|conference|meetup|webinar|summit\b/i,
    theme: 'aurora', maxBullets: 3, words: [5, 30],
    slides: [
      { layout: 'title', title: 'Talk title', intent: 'Title, speaker, event' },
      { layout: 'quote', title: '', intent: 'A hook: a striking quote or fact' },
      { layout: 'agenda', title: 'Today', intent: 'The 3 parts of the talk' },
      { layout: 'section', title: 'Part 1', intent: 'The first idea' },
      { layout: 'bullets', title: 'The big idea', intent: 'One idea in 3 short lines' },
      { layout: 'diagram', title: 'How it works', intent: 'One diagram' },
      { layout: 'chart', title: 'The evidence', intent: 'One chart, one message' },
      { layout: 'bullets', title: 'Takeaways', intent: 'What the audience should do Monday' },
      { layout: 'closing', title: 'Thank you', intent: 'Speaker contact and links' },
    ],
    brief: 'Few words per slide, big type: the speaker carries the detail (write it in notes). One message per slide.',
  },
];

export function deckTypeById(id: unknown): DeckType | undefined {
  if (typeof id !== 'string') return undefined;
  const k = id.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return DECK_TYPES.find(t => t.id === k || t.aliases.some(a => a.replace(/\s+/g, '-') === k) || t.title.toLowerCase().replace(/\s+/g, '-') === k);
}

/** The type a title obviously names (exactly one match), else undefined. */
export function pickDeckType(title: string): DeckType | undefined {
  const hits = DECK_TYPES.filter(t => t.match.test(title));
  return hits.length === 1 ? hits[0] : undefined;
}
