/**
 * `Canvas` — write a document or a code file the person edits beside the chat.
 *
 * The content lives in the session's canvas store, versioned; the reply
 * carries only a ```canvas reference card. So the transcript stays small, the
 * document is the one place its text is, and an edit the person makes in the
 * editor is what the agent reads next — not a stale copy from three turns ago.
 *
 * `update`, `edit` and `write_section` name the version they were based on.
 * If the person (or anything else) changed the tab since, the write is
 * refused and the result carries the latest content to re-apply the change
 * to. That is enforced here rather than asked for in the prompt: a model that
 * remembers the text is exactly the model that stops re-reading it.
 *
 * ## AICO Docs: outline first, then one section at a time
 *
 * A long document written in one `create` is minutes of nothing and then a
 * wall. `outline` lays down a placeholder per section (the person sees the
 * skeleton at once), and `write_section` fills one at a time, each a small
 * version-checked write announced on the stream as `canvas-activity` so the
 * editor can show where the agent is writing. Tabs, comments (which the agent
 * answers with `reply_comment`) and `export` (md/html/docx/pdf) complete it.
 * Contract: `docs/engineering/canvas-docs-contract.md`.
 *
 * Document types (`canvas/doc-types`): `outline {template}` — or a title that
 * obviously names a type — sets the type's sections and look, and the result
 * carries that type's short writing brief. The brief is here, not in the
 * system prompt, so it costs nothing on turns that write no document.
 *
 * `edit_part` (ADR 0024) changes ONE named part — a paragraph, a table or some
 * of its cells, a chart, a diagram, a section — through the same contract and
 * validator as the editor's inline "Ask AICO": the agent's own replacement, or
 * one written by the `edit` model from an instruction, is checked (nothing
 * outside the part changes, type and shape kept unless asked, figures,
 * citations and cross-references kept) before a version-checked write. That
 * is what keeps "fix the SLA table" from becoming a whole-tab `update`.
 *
 * Sheets (`kind: "sheet"`, AICO Sheets): a workbook the agent changes by
 * cells — `set_cells`, `format_cells`, `add_sheet`, `grid_op`, `import` —
 * each version-checked like a document write, never resending the workbook
 * (`canvas/sheet-tool`). `read` and `export` (xlsx/csv) dispatch on the kind.
 *
 * @module tools/canvas
 */

import path from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { currentRunContext } from '../run-context.js';
import { getWorkspaceInfo, getWorkspaceRuntime } from '../workspace.js';
import {
  addTab, announceActivity, applyFindReplace, createCanvas, getCanvas, listCanvases, listComments,
  renameTab, replyToComment, setDocSettings, writeCanvas,
  type CanvasContext, type CanvasDoc, type CanvasTab,
} from '../canvas/store.js';
import {
  SECTION_ID, findSection, pendingBlocks, pendingLine, replaceSection, sectionAt,
} from '../canvas/sections.js';
import { EXPORT_FORMATS, exportCanvas, type ExportFormat } from '../canvas/export.js';
import { mergeSettings, resolveSettings, type DocSettings } from '../canvas/doc-settings.js';
import { DOC_TYPES, classificationOf, docTypeById, pickDocType, writingNote, type DocType } from '../canvas/doc-types.js';
import { workspaceImages } from '../canvas/markdown.js';
import { resolveInsideWorkspace } from './path.js';
import { SHEET_TOOL_HELP, createSheet, importSheet, readSheet, sheetAction, bookOf, type SheetInput } from '../canvas/sheet-tool.js';
import { SHEET_EXPORT_FORMATS, SHEET_MEDIA, exportSheet, type SheetExportFormat } from '../canvas/sheet-xlsx.js';
import { fileBase } from '../canvas/markdown.js';
import { editDocPart } from '../canvas/inline-edit.js';
import {
  applyPart, definedTerms, findPart, patchFromMarkdown, resolveTarget, validatePatch, type PartQuery,
} from '../../shared/ui/canvas/scoped-edit.js';
import { diffStats, wordDiff } from '../../shared/ui/canvas/scoped-diff.js';
import { DECK_TOOL_HELP, createDeck, readDeck, readSlides, setSlides } from '../canvas/deck-tool.js';
import { DECK_EXPORT_FORMATS, exportDeck, type DeckExportFormat } from '../canvas/deck-export.js';

export interface CanvasInput {
  action?: 'create' | 'read' | 'update' | 'edit' | 'list' | 'outline' | 'write_section' | 'add_tab' | 'rename_tab'
    | 'comments' | 'reply_comment' | 'export' | 'settings' | 'edit_part'
    | 'set_cells' | 'format_cells' | 'add_sheet' | 'grid_op' | 'import' | 'set_slides';
  id?: string;
  title?: string;
  kind?: 'document' | 'code' | 'sheet' | 'deck';
  language?: string;
  content?: string;
  version?: number;
  find?: string;
  replace?: string;
  all?: boolean;
  note?: string;
  tab?: string;
  tabs?: { title?: string }[];
  sections?: { id?: string; intent?: string; heading?: string; tab?: string }[];
  section?: string;
  commentId?: string;
  body?: string;
  resolve?: boolean;
  format?: string;
  template?: string;
  settings?: Record<string, unknown>;
  toc?: boolean;
  path?: string;
  // edit_part (ADR 0024).
  part?: PartQuery;
  instruction?: string;
  // Sheets (canvas/sheet-tool).
  sheet?: string;
  range?: string;
  cells?: SheetInput['cells'];
  values?: SheetInput['values'];
  style?: SheetInput['style'];
  layout?: SheetInput['layout'];
  operation?: SheetInput['operation'];
  // Decks (canvas/deck-tool). `slides`: set_slides/create the slides; read: ids whose full fields to show.
  slides?: unknown[];
  remove?: string[];
  order?: string[];
  theme?: string;
  aspect?: string;
  footer?: string;
}

function context(): CanvasContext {
  const runtime = getWorkspaceRuntime();
  const sessionId = currentRunContext()?.sessionId ?? runtime.sessionId;
  if (!sessionId) throw new Error('Canvas needs a chat session to keep the document in.');
  return { settings: runtime.settings, cwd: runtime.cwd ?? process.cwd(), sessionId };
}

function ref(doc: CanvasDoc): string {
  const card = { id: doc.id, title: doc.title, kind: doc.kind, ...(doc.language ? { language: doc.language } : {}) };
  return `\`\`\`canvas\n${JSON.stringify(card)}\n\`\`\``;
}

function tabFor(doc: CanvasDoc, tab: string | undefined): CanvasTab {
  if (tab === undefined || tab === '') return doc.tabs[0]!;
  const t = doc.tabs.find(x => x.id === tab) ?? doc.tabs.find(x => x.title.toLowerCase() === String(tab).trim().toLowerCase());
  if (!t) throw new Error(`Canvas ${doc.id} has no tab "${tab}". Tabs: ${doc.tabs.map(x => `${x.id} "${x.title}"`).join(', ')}.`);
  return t;
}

function tabLabel(doc: CanvasDoc, tab: CanvasTab): string {
  return doc.tabs.length > 1 ? ` tab ${tab.id} "${tab.title}"` : '';
}

function describe(doc: CanvasDoc, tab: CanvasTab = doc.tabs[0]!): string {
  const last = [...doc.versions].reverse().find(v => (v.tab ?? 't1') === tab.id);
  const by = last?.author === 'user' ? 'the user' : 'you (the agent)';
  const what = doc.kind === 'code' ? `code${doc.language ? `, ${doc.language}` : ''}` : 'document';
  return `Canvas ${doc.id} "${doc.title}" (${what})${tabLabel(doc, tab)} — version ${tab.version}, last edited by ${by}.`;
}

function tabsLine(doc: CanvasDoc): string {
  if (doc.tabs.length < 2) return '';
  return `\nTabs: ${doc.tabs.map(t => `${t.id} "${t.title}" (version ${t.version})`).join(', ')}. Pass tab to read or write another one.`;
}

function body(doc: CanvasDoc, tab: CanvasTab = doc.tabs[0]!): string {
  return `----- canvas content (${doc.tabs.length > 1 ? `tab ${tab.id}, ` : ''}version ${tab.version}) -----\n${tab.content}\n----- end of canvas -----`;
}

function card(doc: CanvasDoc): string {
  return 'Put this block in your reply so the user can open the canvas. It is only a reference card — '
    + 'do not paste the content into the chat, and do not describe every change line by line:\n'
    + ref(doc);
}

function stale(doc: CanvasDoc, tab: CanvasTab, base: number | undefined): Error {
  const last = [...doc.versions].reverse().find(v => (v.tab ?? 't1') === tab.id);
  const who = last?.author === 'user' ? 'The user edited it' : 'It changed';
  return new Error(
    `NOT APPLIED — canvas ${doc.id}${tabLabel(doc, tab)} is at version ${tab.version}, not ${base ?? '(no version given)'}. `
    + `${who} since your last read. Re-apply your change to this latest content and pass version: ${tab.version}.\n`
    + `${describe(doc, tab)}\n${body(doc, tab)}`,
  );
}

async function load(ctx: CanvasContext, id: string | undefined): Promise<CanvasDoc> {
  if (!id) throw new Error('`id` is required — `list` shows the canvases in this chat.');
  const doc = await getCanvas(ctx, id);
  if (!doc) {
    const known = await listCanvases(ctx);
    throw new Error(`No canvas "${id}" in this chat.${known.length
      ? ` Canvases here: ${known.map(c => `${c.id} "${c.title}"`).join(', ')}.`
      : ' There are none yet — use create or outline.'}`);
  }
  return doc;
}

function pendingNote(tab: CanvasTab): string {
  const left = pendingBlocks(tab.content);
  if (left.length === 0) return '';
  return `\nStill to write: ${left.map(p => `${p.id}${p.heading ? ` (${p.heading})` : ''}`).join(', ')}.`;
}

/** Run a write with `canvas-activity` frames either side, however it ends. */
async function withActivity<T>(ctx: CanvasContext, doc: CanvasDoc, tab: CanvasTab, where: { section?: string; heading?: string },
  fn: () => Promise<T>): Promise<T> {
  const base = {
    sessionId: ctx.sessionId, canvasId: doc.id, tabId: tab.id, by: 'agent' as const,
    ...(where.section ? { section: where.section } : {}), ...(where.heading ? { heading: where.heading } : {}),
  };
  announceActivity({ ...base, status: 'writing' });
  try {
    return await fn();
  } finally {
    announceActivity({ ...base, status: 'done' });
  }
}

function describeSettings(stored: Partial<DocSettings> | undefined): string {
  const s = resolveSettings(stored);
  return [
    `${s.pageSize} ${s.orientation}`, `${s.font}`, s.cover?.enabled ? 'cover page' : 'no cover', s.toc ? 'contents' : 'no contents',
    s.pageNumbers ? 'page numbers' : 'no page numbers', ...(s.header ? [`header "${s.header}"`] : []), ...(s.footer ? [`footer "${s.footer}"`] : []),
    ...(s.watermark ? [`watermark "${s.watermark}"`] : []),
  ].join(', ');
}

/**
 * The type a new document is for: the template it names (by id, alias, or a
 * name like "risk assessment"), else the one its title obviously names. A
 * template that names nothing is an error the model can fix; a title that
 * names nothing is simply a plain document.
 */
function docTypeFor(template: string | undefined, title: string): { type?: DocType; picked: boolean } {
  if (template?.trim()) {
    const type = docTypeById(template) ?? pickDocType(template);
    if (!type) throw new Error(`Unknown template "${template}". Document types: ${DOC_TYPES.map(t => t.id).join(', ')}.`);
    return { type, picked: false };
  }
  const type = pickDocType(title);
  return type ? { type, picked: true } : { picked: false };
}

/** A type's page setup, plus the classification marking a title names ("Confidential: …"). */
function docTypeSettings(type: DocType | undefined, title: string): Partial<DocSettings> {
  const marking = classificationOf(title);
  return mergeSettings(type?.docSettings, marking && !type?.docSettings.classification ? { classification: marking, watermark: marking } : {});
}

function cleanSections(input: CanvasInput['sections']): { id: string; intent: string; heading?: string; tab?: string }[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('`sections` is required for outline: [{id: "s1", intent: "what this section will say", heading?: "Its heading"}, …].');
  }
  if (input.length > 60) throw new Error('an outline holds at most 60 sections — split the document into tabs or shorter documents.');
  const seen = new Set<string>();
  return input.map((s, i) => {
    const id = typeof s?.id === 'string' && s.id.trim() ? s.id.trim() : `s${i + 1}`;
    if (!SECTION_ID.test(id)) throw new Error(`section id "${id}" must be letters, digits, - or _ (e.g. "s${i + 1}").`);
    if (seen.has(id)) throw new Error(`section id "${id}" is used twice — each section needs its own id.`);
    seen.add(id);
    const intent = typeof s?.intent === 'string' ? s.intent.trim() : '';
    if (!intent) throw new Error(`section "${id}" needs an intent — one line on what it will cover.`);
    return {
      id, intent: intent.slice(0, 300),
      ...(typeof s.heading === 'string' && s.heading.trim() ? { heading: s.heading.trim().slice(0, 200) } : {}),
      ...(typeof s.tab === 'string' && s.tab.trim() ? { tab: s.tab.trim() } : {}),
    };
  });
}

export async function canvasTool(input: CanvasInput): Promise<string> {
  const ctx = context();
  const action = input.action ?? (input.id ? 'read' : 'list');

  switch (action) {
    case 'list': {
      const all = await listCanvases(ctx);
      if (all.length === 0) return 'No canvases in this chat yet.';
      return ['Canvases in this chat (newest first):', ...all.map(c =>
        `- ${c.id} "${c.title}" — ${c.kind}${c.language ? ` (${c.language})` : ''}, version ${c.version}${c.tabs > 1 ? `, ${c.tabs} tabs` : ''}, `
        + `last edited by ${c.author === 'user' ? 'the user' : 'the agent'}, ${c.chars.toLocaleString()} characters`)].join('\n');
    }

    case 'read': {
      const doc = await load(ctx, input.id);
      if (doc.kind === 'sheet') return readSheet(doc, input);
      if (doc.kind === 'deck') {
        const ids = (input.slides ?? []).filter((s): s is string => typeof s === 'string');
        return ids.length ? readSlides(doc, ids) : readDeck(doc);
      }
      const tab = tabFor(doc, input.tab);
      const open = doc.comments.filter(c => !c.resolved).length;
      return `${describe(doc, tab)}\nPass version: ${tab.version}${doc.tabs.length > 1 ? ` (and tab: "${tab.id}")` : ''} when you update, edit or write_section.`
        + `${tabsLine(doc)}${pendingNote(tab)}${open ? `\n${open} open comment${open === 1 ? '' : 's'} — see action comments.` : ''}\n${body(doc, tab)}`;
    }

    case 'create': {
      if (input.kind === 'sheet') return createSheet(ctx, input);
      if (input.kind === 'deck') return createDeck(ctx, input);
      if (typeof input.content !== 'string') throw new Error('`content` is required to create a canvas (Markdown for a document, source for code). For a long document use outline instead.');
      if (!input.title?.trim()) throw new Error('`title` is required to create a canvas.');
      // A document whose title names its type gets that type's look, as an outline would.
      const kind = input.kind ?? 'document';
      const type = kind === 'document' ? pickDocType(input.title) : undefined;
      const docSettings = kind === 'document' ? docTypeSettings(type, input.title) : {};
      const doc = await createCanvas(ctx, {
        title: input.title, kind, content: input.content, author: 'agent',
        ...(input.language ? { language: input.language } : {}),
        ...(Object.keys(docSettings).length ? { docSettings } : {}),
      });
      return `Created canvas ${doc.id} "${doc.title}" (${doc.kind}), version 1.${type ? ` Styled as ${type.title}.` : ''} The user can now edit it directly.\n${card(doc)}`;
    }

    case 'outline': {
      if (!input.title?.trim()) throw new Error('`title` is required for outline.');
      if (input.kind && input.kind !== 'document') throw new Error('outline makes documents; for code use create with kind "code".');
      const { type: template, picked } = docTypeFor(input.template, input.title);
      const ownSections = Boolean(input.sections?.length);
      const sections = cleanSections(ownSections ? input.sections : template?.sections);
      const docSettings = mergeSettings(docTypeSettings(template, input.title), input.settings ?? {});
      const tabTitles = (Array.isArray(input.tabs) ? input.tabs : [])
        .map((t, i) => (typeof t?.title === 'string' && t.title.trim() ? t.title.trim() : `Tab ${i + 1}`));
      if (tabTitles.length === 0) tabTitles.push('Tab 1');
      const tabIndex = (name: string | undefined): number => {
        if (!name) return 0;
        const byId = /^t(\d+)$/.exec(name);
        if (byId && Number(byId[1]) >= 1 && Number(byId[1]) <= tabTitles.length) return Number(byId[1]) - 1;
        const i = tabTitles.findIndex(t => t.toLowerCase() === name.toLowerCase());
        if (i < 0) throw new Error(`section tab "${name}" is not one of the outline's tabs: ${tabTitles.map((t, j) => `t${j + 1} "${t}"`).join(', ')}.`);
        return i;
      };
      const contents = tabTitles.map(() => [] as string[]);
      for (const s of sections) contents[tabIndex(s.tab)]!.push(pendingLine(s));
      // A contents list the reader can see in the app too, where the settings ask for one.
      if (docSettings.toc) contents[0]!.unshift('<!-- aico:toc -->');
      const text = contents.map(lines => (lines.length ? `${lines.join('\n\n')}\n` : ''));
      const doc = await createCanvas(ctx, {
        title: input.title, kind: 'document', content: text[0]!, author: 'agent', note: 'Outline',
        firstTabTitle: tabTitles[0],
        tabs: tabTitles.slice(1).map((title, i) => ({ title, content: text[i + 1] })),
        ...(Object.keys(docSettings).length ? { docSettings } : {}),
      });
      const order = sections.map(s => `${s.id}${s.heading ? ` "${s.heading}"` : ''}${doc.tabs.length > 1 ? ` (tab ${`t${tabIndex(s.tab) + 1}`})` : ''}`);
      return `Outlined canvas ${doc.id} "${doc.title}" with ${sections.length} pending section${sections.length === 1 ? '' : 's'}: ${order.join(', ')}. `
        + `Every tab is at version 1.${template
          ? ` ${picked ? `Picked document type "${template.id}" from the title (pass template to choose another); it` : `Template "${template.id}"`} set up the export (${describeSettings(doc.docSettings)}).`
          : ''}\n`
        + 'Next: tell the user in ONE short line what you are writing (e.g. "Drafting the brief now — 5 sections."), do any research you need, '
        + 'then call write_section once per section, in order, with the section id, its Markdown (starting with its heading), and the '
        + 'version each result gives you. Do not paste the document into the chat.\n'
        + `${writingNote(template, ownSections)}\n`
        + card(doc);
    }

    case 'write_section':
    case 'update':
    case 'edit': {
      const doc = await load(ctx, input.id);
      if (doc.kind === 'sheet') throw new Error(`Canvas ${doc.id} is a sheet — change it with set_cells {id, version, cells:{"B2":…}} (formulas as "=…"), format_cells or grid_op, not ${action}.`);
      if (doc.kind === 'deck') throw new Error(`Canvas ${doc.id} is a deck — change it with set_slides {id, version, slides:[{id:"s3", title, bullets…}]}, not ${action}.`);
      const tab = tabFor(doc, input.tab);
      if (typeof input.version !== 'number' || input.version !== tab.version) throw stale(doc, tab, input.version);
      let content: string;
      let where: { section?: string; heading?: string } = {};
      let alias: { id: string; heading: string } | undefined;
      if (action === 'write_section') {
        if (typeof input.content !== 'string' || !input.content.trim()) {
          throw new Error('`content` is required for write_section: the section\'s Markdown, starting with its heading.');
        }
        const found = findSection(tab.content, input.section ?? '', tab.sectionIds ?? {});
        if (!found.ok) throw new Error(`NOT APPLIED — ${found.error}`);
        const replaced = replaceSection(tab.content, found.section, input.content);
        content = replaced.content;
        const sectionName = found.section.type === 'pending' ? found.section.id! : (input.section ?? '').trim();
        where = { section: sectionName, ...(found.section.heading ? { heading: found.section.heading } : {}) };
        if (found.section.type === 'pending' && replaced.heading) alias = { id: found.section.id!, heading: replaced.heading };
        else if (found.section.type === 'heading' && replaced.heading && replaced.heading !== found.section.heading) {
          // Renamed by the rewrite: keep any id that pointed at the old heading pointing at the new one.
          const id = Object.entries(tab.sectionIds ?? {}).find(([, h]) => h === found.section.heading)?.[0];
          if (id) alias = { id, heading: replaced.heading };
        }
      } else if (action === 'update') {
        if (typeof input.content !== 'string') throw new Error('`content` is required for update (the whole new text). For a targeted change use edit with find/replace, or write_section for one section.');
        content = input.content;
      } else {
        const r = applyFindReplace(tab.content, input.find ?? '', input.replace ?? '', input.all === true);
        if (!r.ok) throw new Error(`NOT APPLIED — ${r.error}`);
        content = r.content;
        const at = sectionAt(tab.content, tab.content.indexOf(input.find ?? ''));
        if (at && input.all !== true) {
          where = at.type === 'pending' ? { section: at.id!, ...(at.heading ? { heading: at.heading } : {}) } : { section: at.heading!, heading: at.heading! };
        }
      }
      const written = await withActivity(ctx, doc, tab, where, () => writeCanvas(ctx, doc.id, {
        content, baseVersion: tab.version, author: 'agent', tab: tab.id,
        ...(input.note ? { note: input.note } : action === 'write_section' ? { note: `Wrote ${where.heading ?? where.section}` } : {}),
        ...(input.title?.trim() && action !== 'write_section' ? { title: input.title } : {}),
        ...(alias ? { sectionAlias: alias } : {}),
      }));
      if (!written.ok) throw stale(written.canvas, tabFor(written.canvas, tab.id), input.version);
      const nowTab = tabFor(written.canvas, tab.id);
      if (!written.changed) return `Canvas ${doc.id}${tabLabel(doc, tab)} already has that content — still version ${tab.version}.`;
      if (action === 'write_section') {
        const left = pendingBlocks(nowTab.content);
        return `Wrote ${where.heading ? `"${where.heading}"` : where.section} in canvas ${doc.id}${tabLabel(written.canvas, nowTab)} — now version ${nowTab.version} `
          + `(pass version: ${nowTab.version} next).${left.length
            ? ` Next pending: ${left.map(p => p.id).join(', ')}.`
            : ' No pending sections left in this tab.'}${left.length ? '' : `\n${card(written.canvas)}`}`;
      }
      return `Canvas ${doc.id} "${written.canvas.title}"${tabLabel(written.canvas, nowTab)} is now version ${nowTab.version}.${pendingNote(nowTab)}\n${card(written.canvas)}`;
    }

    case 'edit_part': {
      const doc = await load(ctx, input.id);
      if (doc.kind !== 'document') throw new Error(`edit_part changes one part of a document; canvas ${doc.id} is a ${doc.kind}.`);
      const tab = tabFor(doc, input.tab);
      if (typeof input.version !== 'number' || input.version !== tab.version) throw stale(doc, tab, input.version);
      const instruction = (input.instruction ?? '').trim();
      if (!instruction) throw new Error('`instruction` is required for edit_part: what to change, in words ("add an Owner column", "fix the grammar") — it also decides what the checks allow.');
      if (!input.part || typeof input.part !== 'object') throw new Error('`part` is required for edit_part: {kind?: "table"|"paragraph"|"chart"|"diagram"|"section"|…, section?: "<heading>", quote?: "<text in it>", nth?, rows?, columns?}.');
      const found = findPart(tab.content, input.part);
      if (!found.ok) throw new Error(`NOT APPLIED — ${found.error}`);
      let after: string;
      let label: string;
      let span: { start: number; end: number };
      let before: string;
      let warnings: string[];
      let how: string;
      if (typeof input.content === 'string') {
        // The agent's own replacement for the whole part (cells are the editor's convenience; the agent sends the table).
        const { cells: _cells, ...whole } = found.target;
        const r = resolveTarget(tab.content, whole);
        if (!r.ok) throw new Error(`NOT APPLIED — ${r.error}`);
        const v = validatePatch(r.part, patchFromMarkdown(r.part, input.content), [instruction], { glossary: definedTerms(tab.content) });
        if (!v.ok) {
          throw new Error(`NOT APPLIED — your replacement for the ${r.part.label.toLowerCase()} failed the checks:\n${v.errors.map(e => `- ${e}`).join('\n')}\n`
            + `Current text of the part:\n${r.part.before}\nSend content again with only what the instruction asks changed.`);
        }
        ({ after, warnings } = v);
        ({ label, span, before } = r.part);
        how = 'your replacement';
      } else {
        const rc = currentRunContext();
        const result = await editDocPart({
          doc, tab, target: found.target, instruction,
          settings: ctx.settings ?? {}, mainModel: rc?.model ?? ctx.settings?.model ?? '',
        });
        if (!result.ok || !result.after || !result.part) {
          throw new Error(`NOT APPLIED — ${result.error ?? 'no edit'}${result.errors.length > 1 ? `\n${result.errors.map(e => `- ${e}`).join('\n')}` : ''}`);
        }
        after = result.after;
        warnings = result.warnings;
        ({ label, span, before } = result.part);
        how = `the inline editor (${result.model}${result.attempts > 1 ? ', second attempt' : ''})`;
      }
      if (after === before) return `The ${label.toLowerCase()} in canvas ${doc.id} already reads that way — nothing changed (still version ${tab.version}).`;
      const applied = applyPart(tab.content, { span, before }, after);
      if (!applied.ok) throw new Error(`NOT APPLIED — ${applied.error}`);
      const written = await withActivity(ctx, doc, tab, {}, () => writeCanvas(ctx, doc.id, {
        content: applied.text, baseVersion: tab.version, author: 'agent', tab: tab.id,
        note: input.note?.trim() || `AICO edit: ${instruction.slice(0, 120)}`,
      }));
      if (!written.ok) throw stale(written.canvas, tabFor(written.canvas, tab.id), input.version);
      const nowTab = tabFor(written.canvas, tab.id);
      const d = diffStats(wordDiff(before, after));
      return `Edited the ${label.toLowerCase()} in canvas ${doc.id}${tabLabel(written.canvas, nowTab)} with ${how} — now version ${nowTab.version} (pass version: ${nowTab.version} next). `
        + `${d.removed} word(s) out, ${d.added} in; every other block is unchanged.${warnings.length ? `\nCheck: ${warnings.join('; ')}.` : ''}`;
    }

    case 'add_tab': {
      const doc = await load(ctx, input.id);
      if (doc.kind === 'sheet') return sheetAction(ctx, doc, 'add_sheet', input);
      const { canvas, tab } = await addTab(ctx, doc.id, {
        ...(input.title ? { title: input.title } : {}), content: input.content ?? '', author: 'agent',
      });
      return `Added tab ${tab.id} "${tab.title}" to canvas ${canvas.id} (version 1). Write to it with tab: "${tab.id}".`;
    }

    case 'rename_tab': {
      const doc = await load(ctx, input.id);
      if (!input.title?.trim()) throw new Error('`title` is required for rename_tab (the new name), with `tab` naming which tab.');
      const tab = tabFor(doc, input.tab);
      const next = await renameTab(ctx, doc.id, tab.id, input.title);
      return `Tab ${tab.id} of canvas ${doc.id} is now "${tabFor(next, tab.id).title}".`;
    }

    case 'comments': {
      const doc = await load(ctx, input.id);
      const open = await listComments(ctx, doc.id, { open: true });
      if (open.length === 0) return `Canvas ${doc.id} has no open comments.`;
      return [`Open comments on canvas ${doc.id} (answer with reply_comment; edit the text if they ask for a change):`,
        ...open.map((c) => {
          const tab = doc.tabs.find(t => t.id === c.tabId);
          const thread = c.replies.map(r => `\n    ↳ ${r.author === 'agent' ? 'you' : 'user'}: ${r.body}`).join('');
          return `- ${c.id}${doc.tabs.length > 1 && tab ? ` [tab ${tab.id} "${tab.title}"]` : ''}${c.orphaned ? ' [the quoted text is no longer in the document]' : ''} `
            + `on "${c.anchor.quote.length > 200 ? `${c.anchor.quote.slice(0, 200)}…` : c.anchor.quote}" — ${c.author === 'agent' ? 'you' : 'user'}: ${c.body}${thread}`;
        })].join('\n');
    }

    case 'reply_comment': {
      const doc = await load(ctx, input.id);
      if (!input.commentId) throw new Error('`commentId` is required — action comments lists them.');
      if (typeof input.body !== 'string' || !input.body.trim()) throw new Error('`body` is required: your reply.');
      const { comment } = await replyToComment(ctx, doc.id, input.commentId, { body: input.body, author: 'agent', resolve: input.resolve === true });
      return `Replied to comment ${comment.id} on canvas ${doc.id}${comment.resolved ? ' and resolved it' : ''}.`;
    }

    case 'set_cells':
    case 'format_cells':
    case 'add_sheet':
    case 'grid_op': {
      const doc = await load(ctx, input.id);
      if (doc.kind !== 'sheet') throw new Error(`Canvas ${doc.id} is a ${doc.kind}, not a sheet — ${action} is for sheets (create one with kind "sheet").`);
      return sheetAction(ctx, doc, action, input);
    }

    case 'set_slides': {
      const doc = await load(ctx, input.id);
      if (doc.kind !== 'deck') throw new Error(`Canvas ${doc.id} is a ${doc.kind}, not a deck — set_slides is for decks (create one with kind "deck").`);
      return withActivity(ctx, doc, doc.tabs[0]!, {}, () => setSlides(ctx, doc, input));
    }

    case 'import': {
      if (!input.path?.trim()) throw new Error('`path` is required for import: a .xlsx or .csv file in the project or workspace.');
      return importSheet(ctx, resolveInsideWorkspace(input.path.trim(), 'path'), input.title);
    }

    case 'export': {
      const doc = await load(ctx, input.id);
      if (doc.kind === 'deck') {
        const df = String(input.format ?? 'pptx').toLowerCase().replace(/^\./, '') as DeckExportFormat;
        if (!DECK_EXPORT_FORMATS.includes(df)) throw new Error(`A deck exports as ${DECK_EXPORT_FORMATS.join(', ')}.`);
        const result = await exportDeck(doc, { format: df, resolveImage: workspaceImages(ctx.cwd) });
        const info = getWorkspaceInfo({ settings: ctx.settings, cwd: ctx.cwd, sessionId: ctx.sessionId });
        const dir = input.path?.trim() ? resolveInsideWorkspace(input.path.trim(), 'path') : (info.artifactsDir ?? path.join(ctx.cwd, 'exports'));
        const warned = result.warnings.length ? `\nNot drawn or not found: ${result.warnings.join('; ')}.` : '';
        if (df === 'png' && result.slides) {
          const folder = path.extname(dir) ? path.dirname(dir) : input.path?.trim() ? dir : path.join(dir, result.fileName.replace(/\.zip$/, ''));
          await mkdir(folder, { recursive: true });
          for (const s of result.slides) await writeFile(path.join(folder, s.name), s.bytes);
          return `Exported deck ${doc.id} "${doc.title}" as ${result.slides.length} PNG slide images (1920 px wide) in ${folder}${warned}\nTell the user the folder.`;
        }
        const target = path.extname(dir) ? dir : path.join(dir, result.fileName);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, result.bytes);
        return `Exported deck ${doc.id} "${doc.title}" as ${df} (${result.bytes.length.toLocaleString()} bytes): ${target}${warned}\n`
          + `${df === 'pptx' ? 'Text, tables and charts are native and editable in PowerPoint; speaker notes are in the notes pane. ' : ''}Tell the user the path; the deck editor can also download it.`;
      }
      if (doc.kind === 'sheet') {
        const sf = String(input.format ?? 'xlsx').toLowerCase().replace(/^\./, '') as SheetExportFormat;
        if (!SHEET_EXPORT_FORMATS.includes(sf)) throw new Error(`A sheet exports as ${SHEET_EXPORT_FORMATS.join(' or ')}.`);
        const bytes = exportSheet(bookOf(doc), sf, { title: doc.title, ...(input.sheet ? { sheet: input.sheet } : {}) });
        const fileName = `${fileBase(doc.title)}.${sf}`;
        let out: string;
        if (input.path?.trim()) {
          out = resolveInsideWorkspace(input.path.trim(), 'path');
          if (!path.extname(out)) out = path.join(out, fileName);
        } else {
          const info = getWorkspaceInfo({ settings: ctx.settings, cwd: ctx.cwd, sessionId: ctx.sessionId });
          out = path.join(info.artifactsDir ?? path.join(ctx.cwd, 'exports'), fileName);
        }
        await mkdir(path.dirname(out), { recursive: true });
        await writeFile(out, bytes);
        return `Exported sheet ${doc.id} "${doc.title}" as ${sf} (${bytes.length.toLocaleString()} bytes, ${SHEET_MEDIA[sf].split(';')[0]}): ${out}\n`
          + `${sf === 'xlsx' ? 'Formulas are real Excel formulas with their computed values cached. ' : ''}Tell the user the path; the sheet editor can also download it.`;
      }
      const format = String(input.format ?? '').toLowerCase().replace(/^\./, '') as ExportFormat;
      if (!EXPORT_FORMATS.includes(format)) throw new Error(`\`format\` must be one of ${EXPORT_FORMATS.join(', ')}.`);
      const result = await exportCanvas(doc, {
        format, ...(input.tab ? { tab: input.tab } : {}), resolveImage: workspaceImages(ctx.cwd),
        ...(input.settings ? { settings: input.settings } : {}), ...(typeof input.toc === 'boolean' ? { toc: input.toc } : {}),
      });
      let target: string;
      if (input.path?.trim()) {
        target = resolveInsideWorkspace(input.path.trim(), 'path');
        if (!path.extname(target)) target = path.join(target, result.fileName);
      } else {
        const info = getWorkspaceInfo({ settings: ctx.settings, cwd: ctx.cwd, sessionId: ctx.sessionId });
        target = path.join(info.artifactsDir ?? path.join(ctx.cwd, 'exports'), result.fileName);
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, result.bytes);
      const warned = result.warnings.length
        ? `\nNot drawn (shown as a placeholder with its source): ${[...new Set(result.warnings)].join('; ')}. Fix the block if it is wrong.` : '';
      return `Exported canvas ${doc.id} "${doc.title}" as ${format} (${result.bytes.length.toLocaleString()} bytes): ${target}${warned}\n`
        + 'Tell the user the path; the canvas editor can also download it directly.';
    }

    case 'settings': {
      const doc = await load(ctx, input.id);
      if (!input.settings || typeof input.settings !== 'object') {
        return `Canvas ${doc.id} export settings: ${describeSettings(doc.docSettings)}. Pass settings: {…} to change them.`;
      }
      const next = await setDocSettings(ctx, doc.id, input.settings);
      return `Canvas ${doc.id} export settings: ${describeSettings(next.docSettings)}.`;
    }

    default:
      throw new Error(`Unknown action "${String(action)}". Use create, outline, read, write_section, update, edit, edit_part, list, add_tab, rename_tab, comments, reply_comment, settings or export — and for sheets set_cells, format_cells, add_sheet, grid_op, import; for decks set_slides.`);
  }
}

export const canvasDefinition = {
  name: 'Canvas',
  description:
    'A document or code file that you write and the user edits directly, side by side with the chat (AICO Docs). '
    + 'Use it for anything the user will iterate on — essays, emails, reports, briefs, specs, a code file — instead of '
    + 'pasting long text into the chat. NEVER paste a canvas\'s content into the chat.\n'
    + 'Long documents (more than a few paragraphs): 1) outline {title, sections:[{id, intent, heading}]} — the user sees the '
    + 'skeleton at once; 2) send the user ONE short progress line (what you are writing); 3) research if needed; 4) write_section '
    + 'once per section, in order. Short notes: create. Any recognisable kind of document, even a short one (invoice, CV, letter, '
    + 'email, minutes, report, PRD, architecture design, NDA, SOW, risk assessment…): outline {template: "<type>"} — it supplies the '
    + 'sections, the look and a writing brief with the blocks that type uses.\n'
    + 'Rich blocks render in the app and in every export: ```chart (ECharts JSON), ```mermaid, $$maths$$, tables, '
    + '```stats {"items":[{"value","label","delta"}]}, ```timeline {"items":[{"date","title","text"}]}, ```steps {"items":[{"title","text"}]}, '
    + '```comparison {"columns":[{"title","items":[…],"highlight"}]}, ```callout info|warn|success (Markdown body), '
    + '<!-- aico:toc --> for a table of contents, and images as ![alt](src "caption"){width=60% align=center}.\n'
    + 'Actions:\n'
    + '- outline {title, sections:[{id:"s1", intent, heading?, tab?}], tabs?:[{title}]} — a document of pending placeholders.\n'
    + '- write_section {id, section, content, version, tab?} — replace exactly one section: `section` is a pending id ("s2") '
    + 'or an exact heading; `content` is its Markdown starting with its heading. Other sections are untouched.\n'
    + '- create {title, kind: "document"|"code", language?, content} — Markdown for a document, source code for code.\n'
    + '- read {id, tab?} — the latest content, its version, pending sections and open-comment count. The user edits canvases '
    + 'directly, so ALWAYS read before changing one they may have touched.\n'
    + '- edit {id, version, find, replace, all?, tab?} — replace one exact passage (like Edit): `find` must occur exactly once '
    + 'unless all: true. Prefer this for small changes.\n'
    + '- edit_part {id, version, instruction, part:{kind?, section?, quote?, nth?, rows?, columns?}, content?, tab?} — change ONE part '
    + '(paragraph, table or its rows/columns, chart, diagram, callout, image caption, or kind "section" with section) and nothing else. '
    + 'Send content (your Markdown for the whole part), or omit it and AICO\'s editor writes it from the instruction. Checked: '
    + 'type, shape, figures, links and references are kept unless the instruction asks. Prefer it to update for a targeted change.\n'
    + '- update {id, version, content, tab?} — replace a whole tab (rewrites, big restructures).\n'
    + '- add_tab {id, title, content?} · rename_tab {id, tab, title} · list.\n'
    + '- comments {id} — open comments the user left on passages; answer each with reply_comment {id, commentId, body, resolve?} '
    + 'and make the change they ask for with edit/write_section (resolve: true once it is done).\n'
    + '- export {id, format: "md"|"docx"|"pdf"|"html", tab?, path?, toc?, settings?} — writes the file and returns its path.\n'
    + '- settings {id, settings?} — read or change the export setup: {pageSize: A4|Letter, orientation, margins: normal|narrow|wide, '
    + 'font: sans|serif, header, footer ({title} {date} {page} {pages}), pageNumbers, toc, watermark, cover: {enabled, title, subtitle, author, date, logo}, '
    + 'control: {client, reference, version, status, preparedBy} (cover, document-control page and running header)}.\n'
    + '`version` is the tab\'s version your last read/write returned (each tab has its own; the first tab is the default). '
    + 'If it changed since, the write is refused and the result carries the latest content — re-apply your change to it. '
    + 'After create/outline, put the ```canvas block from the result in your reply: it is only a reference card that opens '
    + 'the canvas. A message like "Edit canvas <id> — …" means: read that canvas, then edit it.\n'
    + SHEET_TOOL_HELP + '\n'
    + DECK_TOOL_HELP,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'read', 'update', 'edit', 'list', 'outline', 'write_section', 'add_tab', 'rename_tab', 'comments', 'reply_comment', 'export', 'settings',
          'edit_part', 'set_cells', 'format_cells', 'add_sheet', 'grid_op', 'import', 'set_slides'],
      },
      id: { type: 'string', description: 'The canvas id (from create/outline or list).' },
      title: { type: 'string', description: 'create/outline: the title. update/edit: optionally rename. add_tab/rename_tab: the tab name.' },
      kind: { type: 'string', enum: ['document', 'code', 'sheet', 'deck'], description: 'create: document (Markdown), code, sheet (a spreadsheet) or deck (a presentation).' },
      language: { type: 'string', description: 'create, kind code: the language, e.g. "typescript", "python".' },
      content: { type: 'string', description: 'create/update: the full text. write_section: the section\'s Markdown incl. its heading. add_tab: optional initial text.' },
      version: { type: 'number', description: 'update/edit/write_section: the tab version you last read or wrote.' },
      find: { type: 'string', description: 'edit: the exact passage to replace.' },
      replace: { type: 'string', description: 'edit: what replaces it.' },
      all: { type: 'boolean', description: 'edit: replace every occurrence of find.' },
      note: { type: 'string', description: 'update/edit/write_section: a few words on what changed, shown in the version history.' },
      tab: { type: 'string', description: 'The tab id ("t2") or title; default the first tab.' },
      tabs: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } } }, description: 'outline: tabs to create (default one).' },
      sections: {
        type: 'array',
        description: 'outline: the sections, in order.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Short id, e.g. "s1".' },
            intent: { type: 'string', description: 'One line: what this section will cover.' },
            heading: { type: 'string', description: 'The planned heading.' },
            tab: { type: 'string', description: 'Which outline tab (title or "t2"); default the first.' },
          },
          required: ['id', 'intent'],
        },
      },
      section: { type: 'string', description: 'write_section: a pending id ("s2") or the exact heading text.' },
      commentId: { type: 'string', description: 'reply_comment: the comment id (from comments).' },
      body: { type: 'string', description: 'reply_comment: your reply.' },
      resolve: { type: 'boolean', description: 'reply_comment: also mark the comment resolved.' },
      format: { type: 'string', enum: ['md', 'docx', 'pdf', 'html', 'xlsx', 'csv', 'pptx', 'png'], description: 'export: the file format (sheets: xlsx or csv; decks: pptx, pdf or png).' },
      path: { type: 'string', description: 'export: where to write (inside the project or workspace); default the session\'s artifacts folder.' },
      // No enum: forty-odd ids would ride on every request; a name resolves ("risk assessment"), an unknown one lists them.
      template: { type: 'string', description: 'outline: the document type, by id or name (e.g. "invoice", "architecture design").' },
      settings: { type: 'object', description: 'settings/outline: export setup to store; export: for this file only.' },
      toc: { type: 'boolean', description: 'export: include a table of contents.' },
      instruction: { type: 'string', description: 'edit_part: what to change, in words.' },
      part: {
        type: 'object',
        description: 'edit_part: which part — narrowed until exactly one block matches.',
        properties: {
          kind: { type: 'string', description: 'paragraph, heading, list, quote, table, chart, diagram, callout, image, code, or section (with section: the heading and all under it).' },
          section: { type: 'string', description: 'A heading: the part is in that section.' },
          quote: { type: 'string', description: 'Text the block contains.' },
          nth: { type: 'number', description: '1-based, when several still match.' },
          rows: { type: 'array', items: { type: 'number' }, description: 'Tables: [from, to] body rows, 1-based.' },
          columns: { type: 'array', items: {}, description: 'Tables: column names or 1-based numbers.' },
        },
      },
      sheet: { type: 'string', description: 'Sheets: which sheet (name); default the first.' },
      range: { type: 'string', description: 'Sheets: a cell or range, e.g. "A2" (where values start) or "D2:D20".' },
      cells: { type: 'object', description: 'set_cells/create: {"B2": 10, "D2": "=B2*C2"}.' },
      values: { type: 'array', items: { type: 'array', items: {} }, description: 'set_cells/create: rows of cells starting at range.' },
      style: { type: 'object', description: 'format_cells: {num, dp, cur, bold, fill, align} for range.' },
      layout: { type: 'object', description: 'format_cells: {widths, freeze, filter, conditional, chart}.' },
      operation: { type: 'object', description: 'grid_op: {type, at, count, column, desc, header}.' },
      slides: {
        type: 'array', items: {},
        description: 'Decks — create/set_slides: slides [{id?, layout, title, bullets, …, notes}]; read: slide ids whose full fields to return.',
      },
      remove: { type: 'array', items: { type: 'string' }, description: 'set_slides: slide ids to delete.' },
      order: { type: 'array', items: { type: 'string' }, description: 'set_slides: every slide id in the new order.' },
      theme: { type: 'string', description: 'Decks — create/set_slides: the theme id.' },
      aspect: { type: 'string', enum: ['16:9', '4:3'], description: 'Decks — create/set_slides: slide shape (default 16:9).' },
      footer: { type: 'string', description: 'Decks — create/set_slides: footer text on content slides.' },
    },
    required: ['action'],
  },
};

