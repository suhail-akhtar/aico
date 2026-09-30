/**
 * Document setup for exports — page, margins, header/footer, cover, watermark,
 * font, table of contents — and the templates that pick sensible values.
 *
 * ## Why stored with the canvas
 *
 * A letter is always exported as a letter. Settings chosen once in the export
 * dialog (or by the agent from a template) belong to the document, so the next
 * export — from any client, or by the agent — produces the same file. An export
 * call may still override them for one file without saving.
 *
 * ## Why sanitised here, not trusted
 *
 * Settings arrive from HTTP bodies and model tool calls. Every field is
 * whitelisted and clamped (margins 5–60 mm, text 200 characters), so a bad
 * value becomes the default rather than a broken .docx or a 0-margin PDF.
 *
 * @module canvas/doc-settings
 */

export type PageSize = 'A4' | 'Letter';

export interface CoverPage {
  enabled: boolean;
  title?: string;
  subtitle?: string;
  author?: string;
  date?: string;
  /** A data URL or a path inside the project. */
  logo?: string;
}

export interface Margins { top: number; right: number; bottom: number; left: number }

export interface DocSettings {
  pageSize: PageSize;
  orientation: 'portrait' | 'landscape';
  /** Millimetres. */
  margins: Margins;
  font: 'sans' | 'serif';
  header?: string;
  footer?: string;
  pageNumbers: boolean;
  toc: boolean;
  watermark?: string;
  cover?: CoverPage;
}

export const MARGIN_PRESETS: Record<'normal' | 'narrow' | 'wide', Margins> = {
  normal: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 },
  narrow: { top: 12.7, right: 12.7, bottom: 12.7, left: 12.7 },
  wide: { top: 25.4, right: 50.8, bottom: 25.4, left: 50.8 },
};

export const DEFAULT_SETTINGS: DocSettings = {
  pageSize: 'A4', orientation: 'portrait', margins: MARGIN_PRESETS.normal, font: 'sans', pageNumbers: true, toc: false,
};

/** Page size in millimetres, portrait. */
export const PAGE_MM: Record<PageSize, { w: number; h: number }> = { A4: { w: 210, h: 297 }, Letter: { w: 215.9, h: 279.4 } };

function text(value: unknown, max = 200): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.replace(/[\u0000-\u001F]/g, ' ').trim();
  return t ? t.slice(0, max) : undefined;
}

function mm(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.min(60, Math.max(5, n)) : fallback;
}

/** Clean a partial settings object. Unknown keys are dropped; bad values are ignored. `null` means "clear". */
export function cleanSettings(raw: unknown): Partial<Record<keyof DocSettings, unknown>> {
  const out: Partial<Record<keyof DocSettings, unknown>> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(r, k);
  if (has('pageSize')) {
    const v = String(r.pageSize ?? '').toLowerCase();
    if (v === 'a4') out.pageSize = 'A4'; else if (v === 'letter') out.pageSize = 'Letter'; else if (r.pageSize === null) out.pageSize = null;
  }
  if (has('orientation')) {
    if (r.orientation === 'portrait' || r.orientation === 'landscape') out.orientation = r.orientation;
    else if (r.orientation === null) out.orientation = null;
  }
  if (has('margins')) {
    const m = r.margins;
    if (typeof m === 'string' && m in MARGIN_PRESETS) out.margins = MARGIN_PRESETS[m as keyof typeof MARGIN_PRESETS];
    else if (m && typeof m === 'object') {
      const o = m as Record<string, unknown>;
      const d = MARGIN_PRESETS.normal;
      out.margins = { top: mm(o.top, d.top), right: mm(o.right, d.right), bottom: mm(o.bottom, d.bottom), left: mm(o.left, d.left) };
    } else if (m === null) out.margins = null;
  }
  if (has('font')) {
    if (r.font === 'sans' || r.font === 'serif') out.font = r.font; else if (r.font === null) out.font = null;
  }
  for (const k of ['header', 'footer', 'watermark'] as const) {
    if (has(k)) out[k] = r[k] === null ? null : text(r[k], k === 'watermark' ? 40 : 200) ?? null;
  }
  for (const k of ['pageNumbers', 'toc'] as const) {
    if (has(k)) { if (typeof r[k] === 'boolean') out[k] = r[k]; else if (r[k] === null) out[k] = null; }
  }
  if (has('cover')) {
    const c = r.cover;
    if (c === null || c === false) out.cover = null;
    else if (c === true) out.cover = { enabled: true };
    else if (c && typeof c === 'object') {
      const o = c as Record<string, unknown>;
      const logo = typeof o.logo === 'string' && o.logo.length <= 8_000_000 ? o.logo.trim() : undefined;
      out.cover = {
        enabled: o.enabled !== false,
        ...(text(o.title) ? { title: text(o.title) } : {}),
        ...(text(o.subtitle) ? { subtitle: text(o.subtitle) } : {}),
        ...(text(o.author) ? { author: text(o.author) } : {}),
        ...(text(o.date, 60) ? { date: text(o.date, 60) } : {}),
        ...(logo ? { logo } : {}),
      };
    }
  }
  return out;
}

/** Merge a cleaned patch over stored settings (`null` removes the key). */
export function mergeSettings(base: Partial<DocSettings> | undefined, patch: unknown): Partial<DocSettings> {
  const next: Record<string, unknown> = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(cleanSettings(patch))) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next as Partial<DocSettings>;
}

/** Stored (partial) settings with every default filled in. */
export function resolveSettings(stored: Partial<DocSettings> | undefined, override?: unknown): DocSettings {
  const merged = override === undefined ? (stored ?? {}) : mergeSettings(stored, override);
  return { ...DEFAULT_SETTINGS, ...merged } as DocSettings;
}

/** Expand `{title}`, `{date}`, `{page}`, `{pages}` in header/footer text. */
export function expandFields(template: string, values: { title: string; date: string; page?: string; pages?: string }): string {
  return template
    .replace(/\{title\}/gi, values.title)
    .replace(/\{date\}/gi, values.date)
    .replace(/\{page\}/gi, values.page ?? '{page}')
    .replace(/\{pages\}/gi, values.pages ?? '{pages}');
}

// ── Templates ────────────────────────────────────────────────────────

export interface TemplateSection { id: string; heading: string; intent: string }
export interface DocTemplate {
  id: string;
  title: string;
  description: string;
  sections: TemplateSection[];
  docSettings: Partial<DocSettings>;
}

const s = (id: string, heading: string, intent: string): TemplateSection => ({ id, heading, intent });

/**
 * Starting points, not straitjackets: the agent may pass its own sections and
 * still take the template's page setup. Intents say what a good section of
 * that kind contains, which is most of what a template is for.
 */
export const TEMPLATES: DocTemplate[] = [
  {
    id: 'report', title: 'Report', description: 'Formal report: cover, contents, findings and recommendations.',
    sections: [
      s('s1', 'Executive Summary', 'The conclusion first: what was found and what should happen, in one screen'),
      s('s2', 'Background', 'Why this report exists, scope and the question it answers'),
      s('s3', 'Method', 'Sources, data and approach, with their limits'),
      s('s4', 'Findings', 'The evidence, organised by theme, with charts or tables where they help'),
      s('s5', 'Recommendations', 'Numbered actions with owner and timing'),
      s('s6', 'Appendix', 'Supporting detail too long for the body'),
    ],
    docSettings: { cover: { enabled: true }, toc: true, pageNumbers: true, footer: '{title}' },
  },
  {
    id: 'proposal', title: 'Proposal', description: 'Persuasive proposal with scope, plan, pricing and next steps.',
    sections: [
      s('s1', 'Summary', 'The problem, the proposed solution and the ask in a paragraph'),
      s('s2', 'The Problem', 'What the reader faces today and what it costs them'),
      s('s3', 'Proposed Solution', 'What will be delivered and why this approach'),
      s('s4', 'Plan and Timeline', 'Phases, milestones and dates'),
      s('s5', 'Investment', 'Price or budget, what it includes, assumptions'),
      s('s6', 'Why Us', 'Evidence of ability: experience, references, team'),
      s('s7', 'Next Steps', 'What the reader should do to proceed, with a date'),
    ],
    docSettings: { cover: { enabled: true }, toc: false, pageNumbers: true },
  },
  {
    id: 'project-brief', title: 'Project brief', description: 'One-document brief: goals, scope, plan, risks.',
    sections: [
      s('s1', 'Background', 'Context and why the project matters now'),
      s('s2', 'Goals', 'Outcomes with measurable success criteria'),
      s('s3', 'Scope', 'In scope, out of scope, key assumptions'),
      s('s4', 'Timeline', 'Milestones and dates'),
      s('s5', 'Risks and Next Steps', 'Main risks with mitigations; the immediate actions'),
    ],
    docSettings: { toc: false, pageNumbers: true },
  },
  {
    id: 'memo', title: 'Memo', description: 'Internal memo: to/from/date header, purpose, detail, action.',
    sections: [
      s('s1', 'Memo', 'To / From / Date / Subject lines as a short list'),
      s('s2', 'Purpose', 'Why the reader is getting this, in two sentences'),
      s('s3', 'Details', 'The facts and reasoning'),
      s('s4', 'Action Required', 'What the reader must do, by when'),
    ],
    docSettings: { toc: false, pageNumbers: false },
  },
  {
    id: 'letter', title: 'Letter', description: 'Formal letter on a letterhead: address, salutation, body, sign-off.',
    sections: [
      s('s1', 'Addresses', 'Sender and recipient address blocks and the date'),
      s('s2', 'Letter', 'Salutation, the body in short paragraphs, and the closing with name and title'),
    ],
    docSettings: { toc: false, pageNumbers: false, cover: { enabled: false }, header: '{title}', font: 'serif', margins: MARGIN_PRESETS.wide },
  },
  {
    id: 'meeting-minutes', title: 'Meeting minutes', description: 'Attendees, agenda, decisions and actions.',
    sections: [
      s('s1', 'Details', 'Date, time, place, chair, attendees and apologies'),
      s('s2', 'Agenda', 'The items discussed, in order'),
      s('s3', 'Discussion', 'A short summary per agenda item'),
      s('s4', 'Decisions', 'Each decision in one line'),
      s('s5', 'Action Items', 'A table of action, owner and due date'),
    ],
    docSettings: { toc: false, pageNumbers: true, header: '{title}' },
  },
  {
    id: 'spec', title: 'Spec / PRD', description: 'Product requirements: problem, users, requirements, acceptance criteria.',
    sections: [
      s('s1', 'Overview', 'What is being built and the problem it solves'),
      s('s2', 'Goals and Non-Goals', 'What success is, and what is explicitly out'),
      s('s3', 'Users and Use Cases', 'Who uses it and the key scenarios'),
      s('s4', 'Requirements', 'Functional and non-functional requirements, numbered'),
      s('s5', 'Design', 'Architecture or UX approach, with a diagram where useful'),
      s('s6', 'Acceptance Criteria', 'Testable criteria, as a checklist'),
      s('s7', 'Open Questions', 'Unresolved decisions with an owner'),
    ],
    docSettings: { toc: true, pageNumbers: true, footer: '{title} — {date}' },
  },
  {
    id: 'policy', title: 'Policy / SOP', description: 'Policy or standard operating procedure with roles and steps.',
    sections: [
      s('s1', 'Purpose', 'Why this policy or procedure exists'),
      s('s2', 'Scope', 'Who and what it applies to'),
      s('s3', 'Definitions', 'Terms a reader must understand'),
      s('s4', 'Roles and Responsibilities', 'Who does what'),
      s('s5', 'Procedure', 'Numbered steps, one action each'),
      s('s6', 'Compliance and Review', 'How it is enforced, reviewed and versioned'),
    ],
    docSettings: { toc: true, pageNumbers: true, header: '{title}', footer: 'Controlled document — {date}' },
  },
  {
    id: 'one-pager', title: 'One-pager', description: 'A single page: headline, key points, numbers, call to action.',
    sections: [
      s('s1', 'Headline', 'The one sentence that matters, then a short paragraph'),
      s('s2', 'Key Points', 'Three to five points; a stats block if there are numbers'),
      s('s3', 'Call to Action', 'What the reader should do next'),
    ],
    docSettings: { toc: false, pageNumbers: false, margins: MARGIN_PRESETS.narrow },
  },
  {
    id: 'research-summary', title: 'Research summary', description: 'Question, method, key findings, implications, sources.',
    sections: [
      s('s1', 'Summary', 'The question and the answer in brief'),
      s('s2', 'Background', 'Why the question matters and prior work'),
      s('s3', 'Method', 'How the evidence was gathered'),
      s('s4', 'Key Findings', 'The findings with evidence strength'),
      s('s5', 'Implications', 'What follows for the reader'),
      s('s6', 'Sources', 'Numbered references with links'),
    ],
    docSettings: { toc: true, pageNumbers: true },
  },
];

export function templateById(id: unknown): DocTemplate | undefined {
  const key = String(id ?? '').toLowerCase().trim().replace(/[\s_/]+/g, '-');
  const alias: Record<string, string> = {
    prd: 'spec', 'spec-prd': 'spec', sop: 'policy', 'policy-sop': 'policy', brief: 'project-brief', minutes: 'meeting-minutes',
    research: 'research-summary', onepager: 'one-pager',
  };
  return TEMPLATES.find(t => t.id === (alias[key] ?? key));
}
