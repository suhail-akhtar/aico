/**
 * The document-type catalogue for AICO Docs — data, not prose.
 *
 * Each type says what a professional reader expects of that kind of document:
 * its sections and their intents, the theme and page setup it is exported
 * with, which visual blocks carry its information and where (an architecture
 * design has a component and a sequence diagram and a decision table; an
 * invoice has computed line items; a CV has a sidebar layout), and how long it
 * should be. `outline {template}` lays the sections down, `GET
 * /api/canvas/templates` lists the types for the editor's picker, and
 * `writingNote` turns one type into the short brief the agent reads when it
 * starts writing.
 *
 * ## Why the guidance lives here and not in the system prompt
 *
 * The prompt is sent on every turn; this note is returned only by `outline`,
 * the moment a document is being written. And it is a few lines per type, not
 * a checklist: a checklist-style design skill once tripled the length of
 * design documents for no gain (`docs/engineering/agent-capability-audit.md`),
 * so the note leads with the length range and says visuals are for
 * information, not decoration. What was kept was measured with
 * `scripts/doc-quality-eval.mjs`.
 *
 * ## Why types are picked from the title only when it is obvious
 *
 * `pickDocType` returns a type only when exactly one type's pattern matches
 * the title. A wrong guess would give a résumé an invoice's look, which is
 * worse than the plain default; two matches mean the title is ambiguous and
 * the agent (which saw the whole request) should name the template.
 *
 * Each type belongs to a layout family (`shared/ui/canvas/doc-blueprints`,
 * ADR 0022) — cover, front matter, numbering, captions — and the brief carries
 * that family's structure and expected visuals, so a technical design is
 * *written* with its architecture and topology diagrams, not just painted.
 *
 * Theme ids and block names come from the UI side's round-3 contract
 * (`docs/engineering/canvas-docs-contract.md`, `shared/ui/canvas/doc-themes`,
 * `shared/ui/canvas/doc-blocks`); the tests check every name here exists there.
 *
 * @module canvas/doc-types
 */

import type { ThemeId } from '../../shared/ui/canvas/doc-themes.js';
import { DOC_BLOCK_KINDS, type DocBlockKind } from '../../shared/ui/canvas/doc-blocks.js';
import type { DocSettings } from './doc-settings.js';
import { blueprintForType, CAPTION_RULE } from '../../shared/ui/canvas/doc-blueprints.js';

const BUILTIN_VISUALS = ['table', 'mermaid', 'chart', 'math', 'stats', 'timeline', 'steps', 'comparison', 'callout'] as const;

/** A block the type uses: a Markdown table, a chat-style visual, a round-2 infographic or a round-3 document block. */
export type VisualBlock = typeof BUILTIN_VISUALS[number] | DocBlockKind;

/** Every block name a type may use — the renderer's own list, so a renamed block fails the catalogue test. */
export const VISUAL_BLOCKS: readonly VisualBlock[] = [...BUILTIN_VISUALS, ...DOC_BLOCK_KINDS];

export interface DocTypeSection {
  id: string;
  heading: string;
  intent: string;
  /** Blocks that carry this section's information, in order of preference. */
  visuals?: VisualBlock[];
}

export interface DocType {
  id: string;
  title: string;
  description: string;
  /** Other names that resolve to this type (`templateById`). */
  aliases: string[];
  /** Matched against a title for `pickDocType`. */
  match: RegExp;
  sections: DocTypeSection[];
  /** Export setup; `theme` supplies most of the look (and implies defaults). */
  docSettings: Partial<DocSettings>;
  /** Words in the whole document (blocks' JSON not counted). */
  words: [number, number];
  /** One type-specific line for the writing brief. */
  note?: string;
}

/**
 * One line of syntax per block, sent only for the blocks a type uses. "fence,
 * JSON body" is spelled out because the first measured run copied a compact
 * ```keyvalue {…} onto the fence line itself, where no renderer reads it.
 */
export const BLOCK_SYNTAX: Record<VisualBlock, string> = {
  table: 'a Markdown table',
  mermaid: '```mermaid — valid Mermaid (flowchart LR, sequenceDiagram, erDiagram, stateDiagram-v2, gantt); quote labels that contain spaces or punctuation',
  chart: '```chart — ECharts option JSON; real data only',
  math: '$$ … $$ for display maths',
  stats: '```stats fence, JSON body {"items":[{"value","label","delta"}]} — 2–6 headline numbers',
  timeline: '```timeline fence, JSON body {"items":[{"date","title","text"}]}',
  steps: '```steps fence, JSON body {"items":[{"title","text"}]}',
  comparison: '```comparison fence, JSON body {"columns":[{"title","items":[…],"highlight","footer"}]} — 2–4 options',
  callout: '```callout info|warn|success — Markdown body, optional first line **Title**',
  signature: '```signature fence, JSON body {"parties":[{"label","name","title","date"}]}',
  keyvalue: '```keyvalue fence, JSON body {"title","items":[{"key","value"}]} — labelled details (numbers, dates, parties)',
  lineitems: '```lineitems fence, JSON body {"currency":"GBP","taxRate":20,"taxLabel":"VAT","items":[{"item","qty","unit","rate"}]} — subtotal, tax and total are computed: never type them',
  riskmatrix: '```riskmatrix fence, JSON body {"risks":[{"id":"R1","title","likelihood":1-5,"impact":1-5,"owner","mitigation"}]}',
  actions: '```actions fence, JSON body {"items":[{"action","owner","due","status":"open|in progress|done|blocked"}]}',
  columns: '````columns sidebar (four backticks) — Markdown columns separated by a line +++; the first is the narrow sidebar',
  cover: '```cover fence, JSON body {"kicker","title","subtitle","meta":[…]} — a title band',
  meta: '```meta fence, JSON body {"author","date","version","status"} — one line under the title',
  references: '```references fence, JSON body {"items":[{"text","url"}]} — numbered sources',
};

const s = (id: string, heading: string, intent: string, ...visuals: VisualBlock[]): DocTypeSection =>
  ({ id, heading, intent, ...(visuals.length ? { visuals } : {}) });

// Every type stores its own id, so an export finds the type's layout family (ADR 0022) even after the theme is changed.
const T = (t: Omit<DocType, 'aliases'> & { aliases?: string[] }): DocType => ({ aliases: [], ...t, docSettings: { docType: t.id, ...t.docSettings } });

const CONFIDENTIAL = 'CONFIDENTIAL';

export const DOC_TYPES: readonly DocType[] = [
  // ── Reports and analysis ──
  T({
    id: 'report', title: 'Report', description: 'Formal report: cover, contents, findings and recommendations.', aliases: ['business-report', 'status-report'],
    match: /\breport\b/i, words: [800, 2500],
    sections: [
      s('s1', 'Executive Summary', 'The conclusion first: what was found and what should happen, in one screen', 'stats'),
      s('s2', 'Background', 'Why this report exists, scope and the question it answers'),
      s('s3', 'Method', 'Sources, data and approach, with their limits'),
      s('s4', 'Findings', 'The evidence, organised by theme, with charts or tables where they help', 'chart', 'table'),
      s('s5', 'Recommendations', 'Numbered actions with owner and timing', 'table'),
      s('s6', 'Appendix', 'Supporting detail too long for the body'),
    ],
    docSettings: { theme: 'report', cover: { enabled: true }, toc: true, pageNumbers: true, footer: '{title}' },
  }),
  T({
    id: 'whitepaper', title: 'Whitepaper', description: 'Authoritative long-form argument for a solution, backed by evidence.',
    match: /white\s?paper/i, words: [1500, 4000],
    sections: [
      s('s1', 'Abstract', 'The problem, the argument and the conclusion in one paragraph'),
      s('s2', 'The Problem', 'The problem and its cost, with evidence', 'stats', 'chart'),
      s('s3', 'Current Approaches', 'How it is handled today and why that falls short', 'comparison'),
      s('s4', 'The Approach', 'The proposed approach and how it works', 'mermaid', 'steps'),
      s('s5', 'Evidence', 'Results, cases or data that support it', 'chart', 'table'),
      s('s6', 'Conclusion', 'What the reader should take away and do'),
      s('s7', 'References', 'Numbered sources', 'references'),
    ],
    docSettings: { theme: 'report', cover: { enabled: true }, toc: true, pageNumbers: true },
  }),
  T({
    id: 'research-paper', title: 'Research paper', description: 'Academic paper: abstract, methods, results, discussion, references.',
    aliases: ['paper', 'academic-paper'], match: /research paper|academic paper|\bjournal article\b/i, words: [2000, 6000],
    sections: [
      s('s1', 'Abstract', 'Question, method, main result and conclusion in 150–250 words'),
      s('s2', 'Introduction', 'Background, prior work and the question'),
      s('s3', 'Methods', 'Data, participants, procedure and analysis, reproducibly', 'table'),
      s('s4', 'Results', 'Findings with effect sizes and uncertainty', 'table', 'chart'),
      s('s5', 'Discussion', 'Interpretation, limitations and implications'),
      s('s6', 'Conclusion', 'The answer to the question'),
      s('s7', 'References', 'Numbered citations', 'references'),
    ],
    docSettings: { theme: 'research', toc: false, pageNumbers: true },
    note: 'Cite only sources the user gave or you verified; numbers in text match the tables.',
  }),
  T({
    id: 'research-summary', title: 'Research summary', description: 'Question, method, key findings, implications, sources.',
    aliases: ['research', 'literature-review', 'evidence-review'], match: /research summary|literature review|evidence review|research brief/i,
    words: [500, 1500],
    sections: [
      s('s1', 'Summary', 'The question and the answer in brief', 'callout'),
      s('s2', 'Method', 'How the evidence was gathered: the studies and their designs'),
      s('s3', 'Key Findings', 'The findings, strongest evidence first, compared side by side', 'table', 'chart'),
      s('s4', 'Implications', 'What follows for the reader'),
      s('s5', 'Limitations', 'What this evidence cannot tell us'),
      s('s6', 'Sources', 'Numbered references', 'references'),
    ],
    docSettings: { theme: 'research', toc: false, pageNumbers: true },
    note: 'Put every study in one comparison table (study, design, sample, result); do not describe a study\'s design beyond what the source says.',
  }),
  T({
    id: 'technical-writeup', title: 'Technical write-up', description: 'Engineering write-up of a problem, investigation and result.',
    aliases: ['tech-writeup', 'engineering-writeup', 'technical-report'], match: /technical write-?up|engineering write-?up|technical report|deep dive/i,
    words: [800, 2500],
    sections: [
      s('s1', 'Summary', 'What happened and the result, in a paragraph'),
      s('s2', 'Context', 'The system and the problem'),
      s('s3', 'Investigation', 'What was tried, measured and learned', 'table', 'chart'),
      s('s4', 'Solution', 'What was built or changed and how it works', 'mermaid'),
      s('s5', 'Results', 'Before/after measurements', 'stats', 'table'),
      s('s6', 'Next Steps', 'Follow-ups with owners', 'actions'),
    ],
    docSettings: { theme: 'spec', toc: false, pageNumbers: true },
  }),
  T({
    id: 'financial-report', title: 'Financial report', description: 'Period results: headline figures, P&L, variance, outlook.',
    aliases: ['finance-report', 'quarterly-report', 'annual-report'], match: /financial (report|statement|results)|quarterly results|annual report|\bP&L\b/i,
    words: [600, 2000],
    sections: [
      s('s1', 'Highlights', 'The period in headline numbers and one paragraph', 'stats'),
      s('s2', 'Income Statement', 'Revenue, costs and profit against the prior period and budget', 'table'),
      s('s3', 'Trends', 'The movements that matter', 'chart'),
      s('s4', 'Variance Analysis', 'The largest variances and their causes', 'table'),
      s('s5', 'Cash and Balance Sheet', 'Cash position, working capital, key balances', 'table'),
      s('s6', 'Outlook', 'Expectations and risks for the next period'),
    ],
    docSettings: { theme: 'report', cover: { enabled: true }, toc: true, pageNumbers: true },
    note: 'Use only the user\'s figures; state the period and currency once; totals must add up.',
  }),
  T({
    id: 'case-study', title: 'Case study', description: 'Customer story: challenge, solution, measured results.',
    aliases: ['customer-story', 'success-story'], match: /case study|customer story|success story/i, words: [500, 1200],
    sections: [
      s('s1', 'At a Glance', 'Customer, industry and the headline results', 'stats', 'keyvalue'),
      s('s2', 'The Challenge', 'What the customer faced and what it cost'),
      s('s3', 'The Solution', 'What was implemented and how', 'steps'),
      s('s4', 'The Results', 'Measured outcomes', 'stats', 'chart'),
      s('s5', 'What\'s Next', 'Where the customer goes from here; a quote if the user gave one', 'callout'),
    ],
    docSettings: { theme: 'case-study', pageNumbers: false },
  }),
  T({
    id: 'risk-assessment', title: 'Risk assessment', description: 'Risks scored by likelihood and impact, with owners and mitigations.',
    aliases: ['risk-register', 'risk-analysis'], match: /risk (assessment|register|analysis)/i, words: [500, 1800],
    sections: [
      s('s1', 'Scope', 'What is being assessed, when and by whom', 'keyvalue'),
      s('s2', 'Method', 'How likelihood and impact are scored (1–5) and rated'),
      s('s3', 'Risk Matrix', 'Every risk placed on the likelihood × impact matrix, with its register', 'riskmatrix'),
      s('s4', 'Key Risks', 'The high and critical risks in detail: cause, effect, mitigation'),
      s('s5', 'Actions', 'Mitigation actions with owner and due date', 'actions'),
    ],
    docSettings: { theme: 'risk', toc: false, pageNumbers: true },
  }),
  T({
    id: 'postmortem', title: 'Incident postmortem', description: 'Blameless incident review: impact, timeline, root cause, actions.',
    aliases: ['incident-report', 'post-mortem', 'incident-review'], match: /post-?mortem|incident (report|review)|outage report|\bRCA\b/i,
    words: [600, 1800],
    sections: [
      s('s1', 'Summary', 'What happened, impact and duration', 'stats'),
      s('s2', 'Timeline', 'Detection to resolution, timestamped', 'timeline'),
      s('s3', 'Root Cause', 'The cause chain, blameless', 'mermaid'),
      s('s4', 'What Went Well and Badly', 'Response strengths and gaps', 'comparison'),
      s('s5', 'Action Items', 'Preventive actions with owner and due date', 'actions'),
    ],
    docSettings: { theme: 'spec', pageNumbers: true },
  }),

  // ── Correspondence ──
  T({
    id: 'letter', title: 'Letter', description: 'Formal letter on a letterhead: address, salutation, body, sign-off.', aliases: ['formal-letter', 'business-letter'],
    match: /\bletter\b/i, words: [150, 600],
    sections: [
      s('s1', 'Addresses', 'Sender and recipient address blocks and the date'),
      s('s2', 'Letter', 'Salutation, the body in short paragraphs, and the closing with name and title', 'signature'),
    ],
    docSettings: { theme: 'letter', toc: false, pageNumbers: false, header: '{title}' },
    note: 'No headings inside the letter body; one page if possible.',
  }),
  T({
    id: 'cover-letter', title: 'Cover letter', description: 'Job application letter matched to the role.', aliases: ['application-letter'],
    match: /cover letter|application letter/i, words: [250, 450],
    sections: [
      s('s1', 'Header', 'Applicant contact details, date and the employer\'s name and address'),
      s('s2', 'Letter', 'Salutation; why this role; two or three achievements that match it, with numbers; close and sign-off'),
    ],
    docSettings: { theme: 'letter', toc: false, pageNumbers: false },
    note: 'Use only the applicant\'s real achievements; no headings in the body; one page.',
  }),
  T({
    id: 'email', title: 'Email', description: 'A clear email: subject, greeting, point first, ask, sign-off.', aliases: ['mail', 'e-mail'],
    match: /\be-?mail\b/i, words: [60, 350],
    sections: [s('s1', 'Email', 'Subject line, greeting, the point in the first sentence, details, the ask with a date, sign-off')],
    docSettings: { theme: 'memo', toc: false, pageNumbers: false },
    note: 'Write it as an email, not a report: a **Subject:** line then plain paragraphs; no headings or visuals unless a small table is the point.',
  }),
  T({
    id: 'memo', title: 'Memo', description: 'Internal memo: to/from/date header, purpose, detail, action.', aliases: ['memorandum'],
    match: /\bmemo(randum)?\b/i, words: [200, 700],
    sections: [
      s('s1', 'Memo', 'To / From / Date / Subject', 'keyvalue'),
      s('s2', 'Purpose', 'Why the reader is getting this, in two sentences'),
      s('s3', 'Details', 'The facts and reasoning'),
      s('s4', 'Action Required', 'What the reader must do, by when', 'actions'),
    ],
    docSettings: { theme: 'memo', toc: false, pageNumbers: false },
  }),
  T({
    id: 'meeting-minutes', title: 'Meeting minutes', description: 'Attendees, agenda, decisions and actions.', aliases: ['minutes', 'meeting-notes'],
    match: /minutes|meeting notes/i, words: [250, 1000],
    sections: [
      s('s1', 'Details', 'Date, time, place, chair, attendees and apologies', 'keyvalue'),
      s('s2', 'Agenda', 'The items discussed, in order'),
      s('s3', 'Discussion', 'A short summary per agenda item'),
      s('s4', 'Decisions', 'Each decision in one line'),
      s('s5', 'Action Items', 'Action, owner, due date and status', 'actions'),
    ],
    docSettings: { theme: 'minutes', toc: false, pageNumbers: true, header: '{title}' },
  }),
  T({
    id: 'press-release', title: 'Press release', description: 'News announcement: headline, dateline, quote, boilerplate.', aliases: ['press', 'news-release'],
    match: /press release|news release|media release/i, words: [300, 700],
    sections: [
      s('s1', 'Headline', 'Headline and a one-sentence subhead'),
      s('s2', 'Announcement', 'Dateline (CITY, Date —) and the news in the first paragraph: who, what, when, where, why'),
      s('s3', 'Details', 'Supporting facts and a quote attributed to a named person the user gave', 'callout'),
      s('s4', 'About', 'Company boilerplate and media contact', 'keyvalue'),
    ],
    docSettings: { theme: 'press-release', toc: false, pageNumbers: false },
    note: 'Quotes only from people the user named; end with ### (the press-release end mark).',
  }),

  // ── Legal and procedural ──
  T({
    id: 'policy', title: 'Policy', description: 'Policy with purpose, scope, roles, rules and review.', aliases: ['policy-document'],
    match: /\bpolicy\b/i, words: [600, 2000],
    sections: [
      s('s1', 'Purpose', 'Why this policy exists'),
      s('s2', 'Scope', 'Who and what it applies to'),
      s('s3', 'Definitions', 'Terms a reader must understand', 'keyvalue'),
      s('s4', 'Roles and Responsibilities', 'Who does what', 'table'),
      s('s5', 'Policy', 'The rules, numbered'),
      s('s6', 'Compliance and Review', 'How it is enforced, reviewed and versioned', 'keyvalue'),
    ],
    docSettings: { theme: 'sop', toc: true, pageNumbers: true, header: '{title}', footer: 'Controlled document — {date}' },
  }),
  T({
    id: 'sop', title: 'SOP / Procedure', description: 'Standard operating procedure: numbered steps, roles, warnings.',
    aliases: ['standard-operating-procedure', 'procedure', 'work-instruction', 'runbook'],
    match: /\bSOP\b|standard operating procedure|\bprocedure\b|runbook|work instruction/i, words: [500, 1800],
    sections: [
      s('s1', 'Document Control', 'Owner, version, effective date, review date', 'keyvalue'),
      s('s2', 'Purpose and Scope', 'What the procedure achieves and where it applies'),
      s('s3', 'Roles', 'Who performs and who approves', 'table'),
      s('s4', 'Procedure', 'Numbered steps, one action each; safety warnings where they apply', 'steps', 'callout'),
      s('s5', 'Records and Review', 'What is recorded, where, and the review cadence'),
    ],
    docSettings: { theme: 'sop', toc: true, pageNumbers: true, header: '{title}' },
  }),
  T({
    id: 'nda', title: 'NDA', description: 'Non-disclosure agreement with numbered clauses and signatures.',
    aliases: ['non-disclosure-agreement', 'confidentiality-agreement'], match: /\bNDA\b|non-?disclosure( agreement)?|confidentiality agreement/i, words: [800, 2500],
    sections: [
      s('s1', 'Parties', 'The parties, their addresses and the effective date', 'keyvalue'),
      s('s2', '1. Definitions', 'Confidential Information and other defined terms'),
      s('s3', '2. Obligations', 'Use and disclosure restrictions, standard of care'),
      s('s4', '3. Exclusions', 'What is not confidential'),
      s('s5', '4. Term and Return', 'Duration, survival, return or destruction'),
      s('s6', '5. General', 'Remedies, governing law, entire agreement'),
      s('s7', 'Signatures', 'Signature lines for each party', 'signature'),
    ],
    docSettings: { theme: 'legal', toc: false, pageNumbers: true, footer: 'Page {page} of {pages}' },
    note: 'Numbered clauses (1, 1.1); mark it a draft for legal review; leave unknown names as [To confirm: …].',
  }),
  T({
    id: 'contract', title: 'Contract / Agreement', description: 'Agreement with parties, numbered clauses, schedules and signatures.',
    aliases: ['agreement', 'service-agreement', 'msa'], match: /\bcontract\b|\bagreement\b/i, words: [1000, 4000],
    sections: [
      s('s1', 'Parties and Background', 'The parties, effective date and recitals', 'keyvalue'),
      s('s2', '1. Definitions', 'Defined terms'),
      s('s3', '2. Services and Obligations', 'What each party must do'),
      s('s4', '3. Fees and Payment', 'Amounts, invoicing and payment terms', 'table'),
      s('s5', '4. Term and Termination', 'Duration and how it ends'),
      s('s6', '5. Liability and General', 'Liability caps, IP, governing law'),
      s('s7', 'Signatures', 'Signature lines for each party', 'signature'),
    ],
    docSettings: { theme: 'legal', toc: true, pageNumbers: true, footer: 'Page {page} of {pages}' },
    note: 'Numbered clauses (1, 1.1); mark it a draft for legal review.',
  }),
  T({
    id: 'confidential', title: 'Confidential document', description: 'Any sensitive document: classification banner and watermark on every page.',
    aliases: ['secret', 'restricted', 'classified'], match: /\b(confidential|secret|restricted|classified)\b/i, words: [400, 2000],
    sections: [
      s('s1', 'Handling', 'Classification, distribution list and handling instructions', 'keyvalue'),
      s('s2', 'Summary', 'The point of the document'),
      s('s3', 'Details', 'The body'),
      s('s4', 'Actions', 'What recipients must do', 'actions'),
    ],
    docSettings: { theme: 'confidential', classification: CONFIDENTIAL, watermark: CONFIDENTIAL, pageNumbers: true },
  }),

  // ── Product and engineering ──
  T({
    id: 'spec', title: 'Spec / PRD', description: 'Product requirements: problem, users, requirements, acceptance criteria.',
    aliases: ['prd', 'spec-prd', 'product-requirements', 'requirements'], match: /\bPRD\b|product requirements|\bspec(ification)?\b|requirements doc/i,
    words: [800, 2500],
    sections: [
      s('s1', 'Overview', 'What is being built and the problem it solves', 'meta'),
      s('s2', 'Goals and Non-Goals', 'What success is, and what is explicitly out', 'stats'),
      s('s3', 'Users and Use Cases', 'Who uses it and the key scenarios'),
      s('s4', 'Requirements', 'Functional and non-functional requirements, numbered, with priority', 'table'),
      s('s5', 'Design', 'Architecture or UX approach', 'mermaid'),
      s('s6', 'Acceptance Criteria', 'Testable criteria, as a checklist'),
      s('s7', 'Open Questions', 'Unresolved decisions with an owner', 'actions'),
    ],
    docSettings: { theme: 'spec', toc: true, pageNumbers: true, footer: '{title} — {date}' },
  }),
  T({
    id: 'user-stories', title: 'User stories / Epics', description: 'Epics broken into user stories with acceptance criteria and priority.',
    aliases: ['epics', 'backlog', 'stories'], match: /user stor(y|ies)|\bepics?\b|product backlog/i, words: [400, 1800],
    sections: [
      s('s1', 'Context', 'The product goal and personas'),
      s('s2', 'Epics', 'Each epic with its outcome', 'table'),
      s('s3', 'User Stories', 'As a … I want … so that …, grouped by epic, each with Given/When/Then acceptance criteria'),
      s('s4', 'Prioritisation', 'Priority and estimate per story', 'table'),
      s('s5', 'Dependencies and Risks', 'What blocks what', 'mermaid'),
    ],
    docSettings: { theme: 'spec', toc: false, pageNumbers: true },
  }),
  T({
    id: 'api-docs', title: 'API documentation', description: 'Endpoints, authentication, parameters, examples and errors.',
    aliases: ['api', 'api-documentation', 'api-reference'], match: /\bAPI (doc|documentation|reference|guide)/i, words: [600, 3000],
    sections: [
      s('s1', 'Overview', 'What the API does, base URL and versioning', 'keyvalue'),
      s('s2', 'Authentication', 'How to authenticate, with an example request'),
      s('s3', 'Endpoints', 'Each endpoint: method, path, parameters table, request and response examples in code blocks', 'table'),
      s('s4', 'Errors', 'Error codes and meanings', 'table'),
      s('s5', 'Rate Limits and Changelog', 'Limits and version history'),
    ],
    docSettings: { theme: 'spec', toc: true, pageNumbers: true },
    note: 'Examples in fenced code blocks with a language (```http, ```json); document only endpoints the user or the code defines.',
  }),
  T({
    id: 'release-notes', title: 'Release notes', description: 'What changed in a version: highlights, added, fixed, changed.',
    aliases: ['changelog', 'release'], match: /release notes|change ?log|what'?s new/i, words: [150, 900],
    sections: [
      s('s1', 'Highlights', 'Version, date and the two or three changes that matter most', 'meta', 'stats'),
      s('s2', 'Added', 'New features, one line each'),
      s('s3', 'Changed', 'Behaviour changes'),
      s('s4', 'Fixed', 'Bugs fixed'),
      s('s5', 'Upgrade Notes', 'Breaking changes and migration steps', 'callout'),
    ],
    docSettings: { theme: 'release-notes', toc: false, pageNumbers: false },
  }),
  T({
    id: 'user-manual', title: 'User manual', description: 'How to install and use a product, task by task.',
    aliases: ['manual', 'user-guide', 'handbook', 'how-to'], match: /user (manual|guide)|\bmanual\b|handbook|how-to guide/i, words: [1000, 4000],
    sections: [
      s('s1', 'Introduction', 'What the product does and who this manual is for'),
      s('s2', 'Getting Started', 'Requirements and installation', 'steps'),
      s('s3', 'Tasks', 'One subsection per task, as numbered steps', 'steps', 'callout'),
      s('s4', 'Reference', 'Settings and options', 'table'),
      s('s5', 'Troubleshooting', 'Problem, cause, fix', 'table'),
    ],
    docSettings: { theme: 'spec', toc: true, pageNumbers: true },
  }),
  T({
    id: 'architecture-design', title: 'Architecture design', description: 'System design: context, components, flows, data, decisions, risks.',
    aliases: ['architecture', 'system-design', 'design-doc', 'technical-design', 'sad'],
    match: /architecture|system design|design doc|technical design/i, words: [1000, 2500],
    sections: [
      s('s1', 'Context and Goals', 'The problem, constraints and measurable targets', 'keyvalue'),
      s('s2', 'Architecture Overview', 'Components and how they connect', 'mermaid', 'table'),
      s('s3', 'Key Flows', 'The main request path step by step', 'mermaid'),
      s('s4', 'Data', 'Stores, schemas and data ownership', 'mermaid', 'table'),
      s('s5', 'Decisions', 'Key decisions with alternatives and rationale', 'table'),
      s('s6', 'Quality Attributes and Risks', 'How targets are met (scale, latency, availability); risks with mitigations', 'table'),
      s('s7', 'Rollout', 'Milestones to launch', 'timeline'),
    ],
    docSettings: { theme: 'spec', toc: true, pageNumbers: true },
    note: 'One component diagram (flowchart) and one sequence diagram for the main flow; a decision table (decision, options, choice, why); no code listings unless asked.',
  }),
  T({
    id: 'flow-diagram', title: 'Flow diagram', description: 'A process or system flow drawn as a diagram, with a short explanation.',
    aliases: ['flowchart', 'process-map', 'process-flow', 'workflow'], match: /flow ?(chart|diagram)|process (map|flow)|\bworkflow\b/i, words: [100, 600],
    sections: [
      s('s1', 'Flow', 'The flow as one diagram', 'mermaid'),
      s('s2', 'Steps', 'Each step and decision explained briefly', 'table'),
    ],
    docSettings: { theme: 'spec', pageNumbers: false },
    note: 'The diagram is the document: keep the prose to what the diagram cannot say.',
  }),
  T({
    id: 'test-plan', title: 'Test plan', description: 'Scope, approach, environments, test cases and exit criteria.', aliases: ['qa-plan', 'test-strategy'],
    match: /test (plan|strategy)|\bQA plan/i, words: [500, 1800],
    sections: [
      s('s1', 'Scope', 'What is tested and what is not'),
      s('s2', 'Approach', 'Levels and types of testing'),
      s('s3', 'Test Cases', 'ID, scenario, steps, expected result', 'table'),
      s('s4', 'Environments and Data', 'Where and with what'),
      s('s5', 'Entry and Exit Criteria', 'When testing starts and when it is done'),
    ],
    docSettings: { theme: 'spec', toc: false, pageNumbers: true },
  }),

  // ── Commercial ──
  T({
    id: 'proposal', title: 'Proposal', description: 'Persuasive proposal with scope, plan, pricing and next steps.', aliases: ['business-proposal'],
    match: /\bproposal\b/i, words: [800, 2500],
    sections: [
      s('s1', 'Summary', 'The problem, the proposed solution and the ask in a paragraph'),
      s('s2', 'The Problem', 'What the reader faces today and what it costs them'),
      s('s3', 'Proposed Solution', 'What will be delivered and why this approach', 'comparison'),
      s('s4', 'Plan and Timeline', 'Phases, milestones and dates', 'timeline'),
      s('s5', 'Investment', 'Price, what it includes, assumptions', 'lineitems'),
      s('s6', 'Why Us', 'Evidence of ability: experience, references, team'),
      s('s7', 'Next Steps', 'What the reader should do to proceed, with a date'),
    ],
    docSettings: { theme: 'proposal', cover: { enabled: true }, toc: false, pageNumbers: true },
  }),
  T({
    id: 'technical-proposal', title: 'Technical proposal', description: 'Proposed technical solution with architecture, plan, cost and risks.',
    aliases: ['solution-proposal'], match: /technical proposal|solution proposal/i, words: [1200, 4000],
    sections: [
      s('s1', 'Executive Summary', 'The problem, the solution, the price and the ask — one page'),
      s('s2', 'Requirements', 'What the solution must do: functional and non-functional, each with an ID', 'table'),
      s('s3', 'Proposed Architecture', 'The logical architecture diagram, then the components and why each is there', 'mermaid', 'table'),
      s('s4', 'Infrastructure and Topology', 'The physical/network topology diagram (sites, zones, load balancing), then the server inventory', 'mermaid', 'table'),
      s('s5', 'Options Considered', 'Alternatives and why this one', 'comparison'),
      s('s6', 'Delivery Plan', 'Phases and milestones as a Gantt chart, then who does what (RACI)', 'mermaid', 'table'),
      s('s7', 'Cost', 'Cost breakdown', 'lineitems'),
      s('s8', 'Risks', 'Risks with mitigations', 'riskmatrix'),
    ],
    docSettings: { theme: 'proposal', cover: { enabled: true }, toc: true, pageNumbers: true },
  }),
  T({
    id: 'sow', title: 'Statement of work', description: 'Scope, deliverables, schedule, fees, acceptance and signatures.', aliases: ['statement-of-work'],
    match: /\bSOW\b|statement of work/i, words: [800, 2500],
    sections: [
      s('s1', 'Overview', 'Parties, project and reference agreement', 'keyvalue'),
      s('s2', 'Scope', 'In scope and out of scope'),
      s('s3', 'Deliverables', 'Each deliverable with acceptance criteria', 'table'),
      s('s4', 'Schedule', 'Milestones and dates', 'timeline'),
      s('s5', 'Fees', 'Fees and payment schedule', 'lineitems'),
      s('s6', 'Assumptions and Change Control', 'Assumptions, dependencies and how changes are agreed'),
      s('s7', 'Signatures', 'Signature lines', 'signature'),
    ],
    docSettings: { theme: 'proposal', toc: true, pageNumbers: true },
  }),
  T({
    id: 'rfp', title: 'RFP', description: 'Request for proposal: requirements, evaluation criteria, timeline, submission.',
    aliases: ['request-for-proposal', 'rfq', 'tender'], match: /\bRFP\b|\bRFQ\b|request for (proposal|quotation)|\btender\b/i, words: [800, 2500],
    sections: [
      s('s1', 'Introduction', 'The issuer, the project and key dates', 'keyvalue'),
      s('s2', 'Background', 'Current situation and objectives'),
      s('s3', 'Requirements', 'Mandatory and desirable requirements, numbered', 'table'),
      s('s4', 'Evaluation Criteria', 'Criteria and weights', 'table'),
      s('s5', 'Timeline', 'Questions, submission, decision dates', 'timeline'),
      s('s6', 'Submission Instructions', 'Format, contact, terms'),
    ],
    docSettings: { theme: 'proposal', toc: true, pageNumbers: true },
  }),
  T({
    id: 'invoice', title: 'Invoice', description: 'Invoice: parties, number and dates, computed line items, payment terms.', aliases: ['bill', 'tax-invoice'],
    match: /\binvoice\b/i, words: [40, 300],
    sections: [
      s('s1', 'Invoice Details', 'Seller (with tax number) and buyer, invoice number, issue date, due date', 'keyvalue', 'columns'),
      s('s2', 'Items', 'Every item with quantity, unit and rate', 'lineitems'),
      s('s3', 'Payment', 'Terms, method and reference; leave bank details the user did not give as [To confirm: …]'),
    ],
    docSettings: { theme: 'invoice', toc: false, pageNumbers: false },
    note: 'No prose beyond the payment terms. Due date = issue date + terms.',
  }),
  T({
    id: 'quote', title: 'Quote / Estimate', description: 'Priced quotation with validity and terms.', aliases: ['quotation', 'estimate'],
    match: /\bquot(e|ation)\b|\bestimate\b/i, words: [60, 500],
    sections: [
      s('s1', 'Quote Details', 'Supplier, customer, quote number, date, validity', 'keyvalue'),
      s('s2', 'Items', 'Priced items', 'lineitems'),
      s('s3', 'Terms', 'Assumptions, exclusions, how to accept'),
    ],
    docSettings: { theme: 'invoice', toc: false, pageNumbers: false },
  }),
  T({
    id: 'boq', title: 'Bill of quantities', description: 'Itemised quantities and rates by trade or section.', aliases: ['bill-of-quantities'],
    match: /\bBOQ\b|bill of quantities/i, words: [80, 800],
    sections: [
      s('s1', 'Project', 'Project, location, client, date and basis of measurement', 'keyvalue'),
      s('s2', 'Quantities', 'Items grouped by section (a section row per trade) with unit, quantity and rate', 'lineitems'),
      s('s3', 'Notes', 'Assumptions, exclusions and provisional sums'),
    ],
    docSettings: { theme: 'invoice', toc: false, pageNumbers: true, orientation: 'landscape' },
  }),

  // ── Marketing and strategy ──
  T({
    id: 'marketing-brief', title: 'Marketing brief', description: 'Campaign brief: objective, audience, message, channels, budget.',
    aliases: ['creative-brief', 'campaign-brief'], match: /marketing brief|creative brief|campaign brief/i, words: [400, 1200],
    sections: [
      s('s1', 'Objective', 'The business goal and the campaign KPI', 'stats'),
      s('s2', 'Audience', 'Who, and what they believe today'),
      s('s3', 'Message', 'The single-minded proposition and proof points', 'callout'),
      s('s4', 'Channels and Timeline', 'Where and when', 'timeline'),
      s('s5', 'Budget and Measurement', 'Spend and how success is measured', 'table'),
    ],
    docSettings: { theme: 'proposal', pageNumbers: true },
  }),
  T({
    id: 'pitch-outline', title: 'Pitch outline', description: 'Investor or sales pitch, slide by slide.', aliases: ['pitch', 'pitch-deck-outline'],
    match: /\bpitch\b/i, words: [300, 1000],
    sections: [
      s('s1', 'Problem', 'The pain, with a number'),
      s('s2', 'Solution', 'What it is and why it wins', 'comparison'),
      s('s3', 'Market and Traction', 'Size and progress so far', 'stats', 'chart'),
      s('s4', 'Business Model', 'How it makes money'),
      s('s5', 'Team', 'Who and why them'),
      s('s6', 'The Ask', 'Amount and use of funds', 'chart'),
    ],
    docSettings: { theme: 'proposal', pageNumbers: false },
  }),
  T({
    id: 'business-plan', title: 'Business plan', description: 'Company, market, model, operations, financials and funding.', aliases: [],
    match: /business plan/i, words: [1500, 4000],
    sections: [
      s('s1', 'Executive Summary', 'The business, the opportunity and the ask', 'stats'),
      s('s2', 'Market', 'Size, segments and competition', 'chart', 'comparison'),
      s('s3', 'Product and Model', 'What is sold, to whom, at what price'),
      s('s4', 'Go-to-Market', 'Channels and plan', 'timeline'),
      s('s5', 'Operations and Team', 'How it runs and who runs it'),
      s('s6', 'Financials', 'Forecast and key assumptions', 'table', 'chart'),
      s('s7', 'Risks', 'Main risks with mitigations', 'riskmatrix'),
    ],
    docSettings: { theme: 'report', cover: { enabled: true }, toc: true, pageNumbers: true },
  }),
  T({
    id: 'project-brief', title: 'Project brief', description: 'One-document brief: goals, scope, plan, risks.', aliases: ['brief', 'project-charter'],
    match: /project (brief|charter)/i, words: [400, 1200],
    sections: [
      s('s1', 'Background', 'Context and why the project matters now'),
      s('s2', 'Goals', 'Outcomes with measurable success criteria', 'stats'),
      s('s3', 'Scope', 'In scope, out of scope, key assumptions', 'comparison'),
      s('s4', 'Timeline', 'Milestones and dates', 'timeline'),
      s('s5', 'Risks and Next Steps', 'Main risks with mitigations; the immediate actions', 'table'),
    ],
    docSettings: { theme: 'proposal', toc: false, pageNumbers: true },
  }),
  T({
    id: 'one-pager', title: 'One-pager', description: 'A single page: headline, key points, numbers, call to action.', aliases: ['onepager', 'fact-sheet'],
    match: /one-?pager|fact ?sheet/i, words: [150, 450],
    sections: [
      s('s1', 'Headline', 'The one sentence that matters, then a short paragraph'),
      s('s2', 'Key Points', 'Three to five points', 'stats'),
      s('s3', 'Call to Action', 'What the reader should do next', 'callout'),
    ],
    docSettings: { theme: 'proposal', toc: false, pageNumbers: false, margins: { top: 12.7, right: 12.7, bottom: 12.7, left: 12.7 } },
  }),

  // ── People ──
  T({
    id: 'cv', title: 'CV / Résumé', description: 'Two-column CV: contact and skills sidebar, experience with achievements.', aliases: ['resume', 'résumé', 'curriculum-vitae'],
    match: /\bCV\b|r[ée]sum[ée]|curriculum vitae/i, words: [250, 800],
    sections: [
      s('s1', 'Profile', 'Name, title, contact; a three-line profile; then the two-column body: sidebar (skills, education, certifications) | experience — reverse chronological, achievements with numbers', 'columns'),
    ],
    docSettings: { theme: 'cv', toc: false, pageNumbers: false },
    note: 'Write the whole CV in this one section: the name as the heading, a profile, then one ````columns sidebar block (sidebar: contact, skills, education, certifications +++ main: experience). Achievements only as the user stated them.',
  }),
];

const norm = (v: unknown): string => String(v ?? '').toLowerCase().trim().replace(/[\s_/]+/g, '-');

/** A type by id or alias (case, spaces and slashes ignored). */
export function docTypeById(id: unknown): DocType | undefined {
  const key = norm(id);
  if (!key) return undefined;
  return DOC_TYPES.find(t => t.id === key) ?? DOC_TYPES.find(t => t.aliases.includes(key));
}

/**
 * The type a title obviously names, or undefined. Obvious = one type matches,
 * or one match contains every other ("Cover letter" contains "letter",
 * "Technical proposal" contains "proposal"). "Confidential" is a marking
 * rather than a type (see `classificationOf`), so it is picked only when
 * nothing else matches.
 */
export function pickDocType(title: unknown): DocType | undefined {
  const text = String(title ?? '');
  if (!text.trim()) return undefined;
  const hits = DOC_TYPES.filter(t => t.id !== 'confidential').flatMap((t) => {
    const m = t.match.exec(text);
    return m ? [{ t, from: m.index, to: m.index + m[0].length }] : [];
  });
  if (hits.length === 0) return DOC_TYPES.find(t => t.id === 'confidential')!.match.test(text) ? docTypeById('confidential') : undefined;
  const covering = hits.filter(h => hits.every(o => h.from <= o.from && o.to <= h.to));
  return covering.length === 1 ? covering[0]!.t : undefined;
}

/** A classification marking named in a title ("Confidential: board memo" → CONFIDENTIAL). */
export function classificationOf(title: unknown): string | undefined {
  const m = /\b(top secret|secret|confidential|restricted|internal only)\b/i.exec(String(title ?? ''));
  return m ? m[1]!.toUpperCase() : undefined;
}

/** What the picker and `GET canvas/templates` show. */
export function docTypeSummary(t: DocType): {
  id: string; title: string; description: string; aliases: string[]; sections: DocTypeSection[]; docSettings: Partial<DocSettings>;
  words: [number, number]; visuals: VisualBlock[];
} {
  return {
    id: t.id, title: t.title, description: t.description, aliases: t.aliases, sections: t.sections, docSettings: t.docSettings,
    words: t.words, visuals: [...new Set(t.sections.flatMap(x => x.visuals ?? []))],
  };
}

/**
 * The brief the agent reads when it starts a document of this type: length
 * first, then where each visual goes and its syntax, then the rules that keep
 * a document honest. With `ownSections` (the agent wrote its own outline) the
 * type's section ids mean nothing, so the visuals are listed for the type as a
 * whole rather than per section.
 */
export function writingNote(t: DocType | undefined, ownSections = false): string {
  const lines: string[] = [];
  if (t) {
    lines.push(`Writing brief (${t.title}): ${t.words[0]}–${t.words[1]} words in total.`);
    const all = [...new Set(t.sections.flatMap(x => x.visuals ?? []))];
    if (ownSections) {
      if (all.length) lines.push(`Visuals that suit it: ${all.join(', ')}.`);
    } else {
      const plan = t.sections.filter(x => x.visuals?.length).map(x => `${x.id} ${x.heading} → ${x.visuals!.join(' or ')}`);
      if (plan.length) lines.push(`Visuals: ${plan.join('; ')}.`);
    }
    const used = all.filter(v => v !== 'table');
    if (used.length) lines.push(...used.map(v => `- ${BLOCK_SYNTAX[v]}`));
    // The family's layout drives the content too: its structure, the visuals its reader expects, captions.
    const bp = blueprintForType(t.id);
    if (bp) {
      lines.push(`Layout (${bp.label}): ${bp.structure}`);
      if (bp.visuals.length) lines.push(`A reader of this kind of document expects: ${bp.visuals.join('; ')}.`);
      if (bp.captions) lines.push(CAPTION_RULE);
    }
    if (t.note) lines.push(t.note);
  } else {
    lines.push('Writing brief: keep to the length the request needs.');
  }
  lines.push('Use a visual only where it carries information (never decoration); a table or diagram beats long prose. '
    + 'Only facts from the user or your sources — never invent numbers, names or citations; mark a missing detail [To confirm: …]. '
    + 'Keep formats consistent (dates, currency, numbering).');
  return lines.join('\n');
}
