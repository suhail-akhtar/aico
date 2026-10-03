/**
 * Document design blueprints — the layout of each *family* of document
 * (proposal, technical design, report, policy, correspondence, academic paper,
 * CV, marketing, legal, manual, transactional), read by the editor page and by
 * every export (`src/canvas/docx.ts`, `src/canvas/export.ts`).
 *
 * ## Why blueprints, when there are already themes
 *
 * Themes (`doc-themes`) are colour and ornament: an accent, a heading rule, a
 * table fill. The owner's real export (a 55-page SharePoint technical
 * proposal, 2026-10-03) showed that colour was never the problem: the
 * document had no Heading 1 (its sections were Heading 2 with numbers typed
 * into the text), a cover that was a purple box in the corner of a blank page,
 * no document control, a TOC whose every entry said "1", 56 tables that all
 * looked alike with ID columns wider than prose columns, two diagrams in an
 * architecture proposal, and serif headings over a sans body for no reason.
 * Every type exported the same *layout* in a different colour.
 *
 * A blueprint is the layout a professional reader expects of a family: the
 * front matter (cover layout, document-control page, revision history,
 * approvals), page setup, a deliberate typeface pairing with Word-safe faces,
 * the heading numbering scheme (Word multilevel numbering, never typed
 * numbers), running header/footer content, table and caption conventions, and
 * the visuals the family is expected to carry (a technical design has
 * architecture, topology and sequence diagrams; a proposal a Gantt, a RACI and
 * a pricing table; a report charts). The writing brief (`src/canvas/doc-types`
 * `writingNote`) is built from the same data, so the *content* differs by
 * family too, not just the paint (ADR 0022).
 *
 * ## Why a few switches, not a stylesheet per family
 *
 * The same reason themes are switches (see `doc-themes`): every field here maps
 * one-to-one onto a Word construct and a print-CSS rule, so Word and the PDF
 * cannot drift. A family that needs something a switch cannot say gets a new
 * switch, used by both writers.
 *
 * ## Faces
 *
 * Each face names the Word font (one name — `w:rFonts` takes one) and a CSS
 * stack that starts with the same font, so on a machine with Office the PDF and
 * the .docx are set in the same type, and elsewhere the PDF falls back to a
 * metric-compatible or similar face. Only faces that ship with Windows or
 * Office are used; nothing is embedded.
 *
 * DOM-free and Node-importable (the engine imports it).
 *
 * @module shared/ui/canvas/doc-blueprints
 */

import type { ThemeId } from './doc-themes';

export type BlueprintId =
  | 'general' | 'proposal' | 'technical' | 'report' | 'policy' | 'correspondence' | 'academic' | 'cv'
  | 'marketing' | 'legal' | 'manual' | 'transactional';

/**
 * - `band` — its own page, a full-bleed colour band (top for proposals,
 *   bottom for reports) with the title, and the metadata under it.
 * - `title-block` — its own white page: kicker, title, subtitle, a metadata
 *   table, prepared-by (technical designs, manuals).
 * - `masthead` — no cover page: a title band at the top of page one, the
 *   control box under it (policies, marketing, invoices).
 * - `academic` — a centred title block (title, authors, date) on page one.
 * - `classic` — the round-1 cover page (plain documents that ask for one).
 * - `none` — the text opens the document (letters, CVs, contracts).
 */
export type CoverLayout = 'band' | 'title-block' | 'masthead' | 'academic' | 'classic' | 'none';

/** `decimal` 1 · 1.1 · 1.1.1 — `legal` 1. · 1.1 · (a) — `none`. */
export type NumberingScheme = 'decimal' | 'legal' | 'none';

export interface Face {
  /** The font Word is told to use. */
  word: string;
  /** The CSS stack, starting with the same font. */
  css: string;
  /** Headings in this face use this weight in CSS (Word: the face's own weight, or bold). */
  weight?: number;
  /** Word takes the face's own weight (a "Semibold" family) instead of switching bold on. */
  ownWeight?: boolean;
}

export const FACES = {
  segoe: { word: 'Segoe UI', css: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif" },
  segoeSemi: { word: 'Segoe UI Semibold', css: "'Segoe UI Semibold', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif", weight: 600, ownWeight: true },
  calibri: { word: 'Calibri', css: "Calibri, Carlito, 'Segoe UI', Arial, sans-serif" },
  cambria: { word: 'Cambria', css: "Cambria, Caladea, Georgia, 'Times New Roman', serif" },
  georgia: { word: 'Georgia', css: "Georgia, 'Times New Roman', serif" },
  arial: { word: 'Arial', css: "Arial, 'Liberation Sans', 'Helvetica Neue', sans-serif" },
  palatino: { word: 'Palatino Linotype', css: "'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif" },
  franklin: { word: 'Franklin Gothic Medium', css: "'Franklin Gothic Medium', 'Franklin Gothic', 'Arial Narrow', Arial, sans-serif", ownWeight: true },
  consolas: { word: 'Consolas', css: "Consolas, 'Cascadia Code', ui-monospace, monospace" },
} as const satisfies Record<string, Face>;

/** Running header/footer slots; text with `{title}` `{client}` `{reference}` `{version}` `{status}` `{classification}` `{date}` `{page}` `{pages}`. */
export interface RunningText { left?: string; right?: string }

export interface Blueprint {
  id: BlueprintId;
  label: string;
  /** What the family is for, one line (the picker, the ADR). */
  description: string;
  /** Document types (`src/canvas/doc-types` ids) laid out with this blueprint. */
  types: string[];
  /** The colour/ornament theme a document of this family gets when it names none. */
  theme?: ThemeId;
  cover: CoverLayout;
  /** Where the band sits on a `band` cover. */
  band?: 'top' | 'bottom';
  /** The front matter after the cover. */
  front: {
    /** `page`: a document-control page (information, revisions, approvals); `inline`: a control box under the title; `none`. */
    control: 'page' | 'inline' | 'none';
    /** Approval rows to sign, by role (empty = no approvals table). */
    approvals: string[];
    /** A distribution table, when the document says who gets it. */
    distribution: boolean;
    /** The contents on its own page (else it runs on). */
    tocPage: boolean;
  };
  /** Defaults this family implies under the document's own settings. */
  defaults: { toc?: boolean; cover?: boolean; margins?: { top: number; right: number; bottom: number; left: number }; pageNumbers?: boolean };
  /** Heading and body faces; absent = the theme's sans/serif choice (the round-3 look). */
  fonts?: { heading: Face; body: Face };
  /** Points: body, then H1–H3 and the cover/title size. */
  sizes: { body: number; h1: number; h2: number; h3: number; title: number };
  numbering: NumberingScheme;
  /** Each top-level section starts a new page. */
  h1PageBreak: boolean;
  header?: RunningText;
  footer?: RunningText;
  /** Captions: tables numbered above ("Table 3 — …"), figures below ("Figure 2 — …"). */
  captions: boolean;
  /** The kicker over the cover title (the family's name for itself). */
  kicker?: string;
  /** For the writing brief: how the content is structured in this family. */
  structure: string;
  /** For the writing brief: the visuals a reader expects, each with how to draw it. */
  visuals: string[];
}

const MM = (top: number, right: number, bottom: number, left: number): Blueprint['defaults']['margins'] => ({ top, right, bottom, left });
const PAGE_OF = 'Page {page} of {pages}';
const NUMBERED_HEADINGS = 'Top-level sections are ## headings and subsections ###; the export numbers them (1, 1.1, 1.1.1) as real Word numbering — never type numbers into a heading.';
/** The caption convention every family with captions is briefed with (`src/canvas/doc-plan` reads it back). */
export const CAPTION_RULE = 'Caption every table with a line `Table: <what it shows>` directly above it, and every diagram, chart or picture with `Figure: <what it shows>` directly below it — the export numbers them.';

export const BLUEPRINTS: readonly Blueprint[] = [
  {
    id: 'proposal', label: 'Proposal / tender', description: 'Persuasive commercial document: band cover, document control, executive summary on its own page, pricing, plan and responsibilities.',
    types: ['proposal', 'technical-proposal', 'sow', 'rfp'], theme: 'proposal', cover: 'band', band: 'top', kicker: 'Proposal',
    front: { control: 'page', approvals: ['Client sponsor', 'Solution lead', 'Account director'], distribution: true, tocPage: true },
    defaults: { toc: true, cover: true, margins: MM(22, 20, 22, 20), pageNumbers: true },
    fonts: { heading: FACES.segoeSemi, body: FACES.segoe }, sizes: { body: 10, h1: 18, h2: 13.5, h3: 11.5, title: 34 },
    numbering: 'decimal', h1PageBreak: true,
    header: { left: '{title}', right: '{client}' }, footer: { left: '{classification} · Version {version}', right: PAGE_OF }, captions: true,
    structure: `${NUMBERED_HEADINGS} Open with an Executive Summary that fits one page (the problem, the answer, the price and the ask). Commercials (pricing, assumptions, exclusions) get their own section; supporting detail goes in "## Appendix A — …" sections at the end.`,
    visuals: [
      'solution overview diagram — ```mermaid flowchart LR with a subgraph per area (users, platform, integrations)',
      'delivery plan — ```mermaid gantt with phases and milestones (or ```timeline for a short plan)',
      'responsibilities — a RACI table (activities × roles, cells R, A, C or I)',
      'pricing — ```lineitems (totals are computed)',
      'risks — ```riskmatrix',
    ],
  },
  {
    id: 'technical', label: 'Technical design', description: 'HLD/LLD, architecture and specs: title-block cover, document control, numbered sections, diagrams and inventories.',
    types: ['architecture-design', 'spec', 'technical-writeup', 'test-plan', 'user-stories', 'flow-diagram', 'postmortem'], theme: 'spec', cover: 'title-block', kicker: 'Technical design',
    front: { control: 'page', approvals: ['Author', 'Technical reviewer', 'Design authority'], distribution: false, tocPage: true },
    defaults: { toc: true, cover: true, margins: MM(20, 20, 20, 20), pageNumbers: true },
    fonts: { heading: FACES.calibri, body: FACES.calibri }, sizes: { body: 10.5, h1: 16, h2: 13, h3: 11.5, title: 30 },
    numbering: 'decimal', h1PageBreak: true,
    header: { left: '{title}', right: '{reference}' }, footer: { left: '{classification} · Version {version} · {status}', right: PAGE_OF }, captions: true,
    structure: `${NUMBERED_HEADINGS} Each design area gets: a diagram, then a table (components, servers, settings), then the decisions and why. Specifications go in key-value tables (Setting | Value); inventories in data tables with an ID column.`,
    visuals: [
      'logical architecture — ```mermaid flowchart TB with one subgraph per tier or zone',
      'physical / network topology — ```mermaid flowchart TB (a page is taller than wide) with sites, network zones, load balancers, firewalls and server groups as subgraphs',
      'the main request or authentication flow — ```mermaid sequenceDiagram',
      'keep each diagram to about a dozen nodes with short labels — split a bigger one by tier or site',
      'component or server inventory — a table with an ID column',
      'decision table — decision, options considered, choice, rationale',
    ],
  },
  {
    id: 'report', label: 'Report / analysis', description: 'Findings for decision-makers: band cover, contents, executive summary up front, charts with captions.',
    types: ['report', 'whitepaper', 'financial-report', 'business-plan', 'research-summary', 'risk-assessment', 'project-brief'], theme: 'report', cover: 'band', band: 'bottom', kicker: 'Report',
    front: { control: 'none', approvals: [], distribution: false, tocPage: true },
    defaults: { toc: true, cover: true, margins: MM(25, 22, 25, 22), pageNumbers: true },
    fonts: { heading: FACES.cambria, body: FACES.calibri }, sizes: { body: 10.5, h1: 20, h2: 14, h3: 12, title: 36 },
    numbering: 'decimal', h1PageBreak: true,
    header: { left: '{title}', right: '{client}' }, footer: { left: '{date}', right: PAGE_OF }, captions: true,
    structure: `${NUMBERED_HEADINGS} The executive summary states the conclusion and the recommendation first; every finding pairs a claim with the chart or table that proves it.`,
    visuals: [
      'headline numbers — ```stats in the executive summary',
      'one ```chart per quantitative finding (bar for comparison, line for trend), with real data only',
      'recommendations — a table (recommendation, owner, timing)',
    ],
  },
  {
    id: 'policy', label: 'Policy / procedure / SOP', description: 'Controlled document: masthead with a control box on page one, numbered clauses, warnings, revision history.',
    types: ['policy', 'sop', 'confidential'], theme: 'sop', cover: 'masthead',
    front: { control: 'inline', approvals: ['Owner', 'Approver'], distribution: false, tocPage: false },
    defaults: { toc: true, margins: MM(22, 22, 22, 22), pageNumbers: true },
    fonts: { heading: FACES.arial, body: FACES.arial }, sizes: { body: 10, h1: 14, h2: 12, h3: 10.5, title: 22 },
    numbering: 'decimal', h1PageBreak: false,
    header: { left: '{title}', right: '{reference} · Version {version}' }, footer: { left: 'Uncontrolled when printed', right: PAGE_OF }, captions: true,
    structure: `${NUMBERED_HEADINGS} Rules are short numbered statements ("must", "must not"); procedures are numbered steps, one action each, with warnings in callouts before the step they guard.`,
    visuals: [
      'roles — a RACI or responsibilities table',
      'procedures — ```steps, with ```callout warn before hazardous steps',
      'the process flow — ```mermaid flowchart TD with decisions',
    ],
  },
  {
    id: 'correspondence', label: 'Letter / memo / minutes', description: 'Correspondence: letterhead or a To/From block, no cover, no numbering, one or two pages.',
    types: ['letter', 'cover-letter', 'email', 'memo', 'meeting-minutes', 'press-release'], cover: 'none',
    front: { control: 'none', approvals: [], distribution: false, tocPage: false },
    defaults: { toc: false, pageNumbers: false },
    fonts: { heading: FACES.georgia, body: FACES.georgia }, sizes: { body: 11, h1: 14, h2: 12, h3: 11, title: 22 },
    numbering: 'none', h1PageBreak: false, captions: false,
    structure: 'Plain paragraphs; headings only where the type needs them (minutes, memos). No cover, no contents, no numbering.',
    visuals: [],
  },
  {
    id: 'academic', label: 'Academic paper', description: 'Research paper: centred title block, abstract, numbered sections, booktabs tables with captions, references.',
    types: ['research-paper'], theme: 'research', cover: 'academic',
    front: { control: 'none', approvals: [], distribution: false, tocPage: false },
    defaults: { toc: false, margins: MM(25, 25, 25, 25), pageNumbers: true },
    fonts: { heading: FACES.cambria, body: FACES.cambria }, sizes: { body: 11, h1: 13, h2: 11.5, h3: 11, title: 20 },
    numbering: 'decimal', h1PageBreak: false,
    footer: { right: '{page}' }, captions: true,
    structure: `${NUMBERED_HEADINGS} Abstract first (150–250 words), then Introduction, Methods, Results, Discussion, Conclusion, References.`,
    visuals: ['results — tables with effect sizes and uncertainty', 'a ```chart where a trend or distribution matters', 'display maths in $$ … $$'],
  },
  {
    id: 'cv', label: 'CV / résumé', description: 'Two-column CV: sidebar of contact, skills and education; experience with achievements. No cover, no numbering.',
    types: ['cv'], theme: 'cv', cover: 'none',
    front: { control: 'none', approvals: [], distribution: false, tocPage: false },
    defaults: { toc: false, pageNumbers: false },
    fonts: { heading: FACES.calibri, body: FACES.calibri }, sizes: { body: 10, h1: 20, h2: 11, h3: 10.5, title: 26 },
    numbering: 'none', h1PageBreak: false, captions: false,
    structure: 'The name as the heading, a three-line profile, then one sidebar ````columns block.',
    visuals: [],
  },
  {
    id: 'marketing', label: 'Marketing / one-pager', description: 'Brief, case study or one-pager: a colour masthead, big numbers, pull quotes, no contents.',
    types: ['marketing-brief', 'one-pager', 'pitch-outline', 'case-study'], theme: 'case-study', cover: 'masthead',
    front: { control: 'none', approvals: [], distribution: false, tocPage: false },
    defaults: { toc: false, pageNumbers: false },
    fonts: { heading: FACES.franklin, body: FACES.segoe }, sizes: { body: 10.5, h1: 16, h2: 12.5, h3: 11, title: 30 },
    numbering: 'none', h1PageBreak: false, captions: false,
    structure: 'Lead with the one message that matters; short sections, numbers before prose, a clear call to action at the end.',
    visuals: ['headline numbers — ```stats', 'the offer or options — ```comparison', 'the plan — ```timeline', 'the call to action — ```callout success'],
  },
  {
    id: 'legal', label: 'Contract / legal', description: 'Agreements: centred title, numbered clauses (1. · 1.1 · (a)), justified serif text, signature blocks.',
    types: ['nda', 'contract'], theme: 'legal', cover: 'none',
    front: { control: 'none', approvals: [], distribution: false, tocPage: false },
    defaults: { toc: false, margins: MM(25, 25, 25, 25), pageNumbers: true },
    fonts: { heading: FACES.palatino, body: FACES.palatino }, sizes: { body: 11, h1: 11.5, h2: 11, h3: 11, title: 18 },
    numbering: 'legal', h1PageBreak: false,
    footer: { left: '{title}', right: PAGE_OF }, captions: false,
    structure: 'Each clause is a ## heading (numbered 1., 2. by the export) with sub-clauses as ### (1.1); never type clause numbers. Defined terms in bold on first use.',
    visuals: ['fees — a table', 'execution — ```signature'],
  },
  {
    id: 'manual', label: 'Manual / guide', description: 'User manuals, API references and release notes: title-block cover, contents, numbered chapters, task steps.',
    types: ['user-manual', 'api-docs', 'release-notes'], theme: 'spec', cover: 'title-block', kicker: 'Guide',
    front: { control: 'none', approvals: [], distribution: false, tocPage: true },
    defaults: { toc: true, cover: true, margins: MM(22, 22, 22, 22), pageNumbers: true },
    fonts: { heading: FACES.segoeSemi, body: FACES.segoe }, sizes: { body: 10, h1: 18, h2: 13, h3: 11, title: 30 },
    numbering: 'decimal', h1PageBreak: true,
    header: { left: '{title}', right: 'Version {version}' }, footer: { right: PAGE_OF }, captions: true,
    structure: `${NUMBERED_HEADINGS} One section per task; each task is numbered steps with the expected result; reference material in tables.`,
    visuals: ['tasks — ```steps', 'screens or flows — images or ```mermaid flowchart', 'settings and errors — tables', 'warnings — ```callout warn'],
  },
  {
    id: 'transactional', label: 'Invoice / quote / BOQ', description: 'Commercial forms: a masthead with the parties and numbers, computed line items, terms. No prose.',
    types: ['invoice', 'quote', 'boq'], theme: 'invoice', cover: 'masthead',
    front: { control: 'none', approvals: [], distribution: false, tocPage: false },
    defaults: { toc: false, pageNumbers: false },
    fonts: { heading: FACES.calibri, body: FACES.calibri }, sizes: { body: 10, h1: 13, h2: 11, h3: 10, title: 26 },
    numbering: 'none', h1PageBreak: false, captions: false,
    structure: 'Parties and numbers in key-value blocks, items in ```lineitems, terms last.',
    visuals: [],
  },
  {
    id: 'general', label: 'General', description: 'Any other document: the theme\'s look, the document\'s own settings, no front matter.',
    types: [], cover: 'classic',
    front: { control: 'none', approvals: [], distribution: false, tocPage: true },
    defaults: {},
    sizes: { body: 11, h1: 18, h2: 15, h3: 13, title: 24 },
    numbering: 'none', h1PageBreak: false, captions: true,
    structure: 'Sections are ## headings and subsections ###.',
    visuals: [],
  },
];

/** The family a theme implies when a document names no type (documents made before blueprints). */
const THEME_FAMILY: Partial<Record<ThemeId, BlueprintId>> = {
  report: 'report', research: 'academic', letter: 'correspondence', memo: 'correspondence', cv: 'cv', proposal: 'proposal',
  invoice: 'transactional', sop: 'policy', legal: 'legal', spec: 'technical', 'release-notes': 'manual', minutes: 'correspondence',
  'case-study': 'marketing', 'press-release': 'correspondence', risk: 'report',
};

export function blueprintById(id: unknown): Blueprint | undefined {
  return typeof id === 'string' ? BLUEPRINTS.find(b => b.id === id.trim().toLowerCase()) : undefined;
}

/** The blueprint for a document type id. */
export function blueprintForType(typeId: unknown): Blueprint | undefined {
  if (typeof typeId !== 'string' || !typeId) return undefined;
  return BLUEPRINTS.find(b => b.types.includes(typeId));
}

/**
 * The blueprint a document is laid out with: the one it names, else its type's,
 * else the one its theme implies, else `general`.
 */
export function resolveBlueprint(s: { blueprint?: unknown; docType?: unknown; theme?: unknown }): Blueprint {
  return blueprintById(s.blueprint) ?? blueprintForType(s.docType)
    ?? (typeof s.theme === 'string' ? blueprintById(THEME_FAMILY[s.theme as ThemeId]) : undefined)
    ?? BLUEPRINTS.find(b => b.id === 'general')!;
}

/** Can a blueprint draw this cover as its own page? */
export function coverIsPage(layout: CoverLayout): boolean {
  return layout === 'band' || layout === 'title-block' || layout === 'classic';
}
