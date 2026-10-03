/**
 * Scoped ("inline") AI edits on a presentation — the engine half. ADR 0024
 * (deck section).
 *
 * The part, its context, the validator and the patch application live in
 * `shared/ui/canvas/deck-scoped-edit` (the deck editor re-applies an accepted
 * patch with the same code). This module adds what only the engine does: it
 * runs the document editor's model call (`editPart` — same `edit` role, same
 * prompt shape, same retry-once-with-reasons) with the deck validator in place
 * of the document one, so a proposal that breaks the slide's layout is sent
 * back to the model with the layout engine's own words ("the title is too
 * long for two lines…") before anyone sees it. It never writes; the route
 * returns a proposal, and the Canvas tool's `edit_part` writes a validated
 * one, version-checked, as one version noted "AICO edit: …".
 *
 * Why not `set_slides` for the agent's targeted change: `set_slides` takes
 * whatever fields it is sent; nothing holds "make the title punchier" to the
 * title, or a shortened table to its columns. `edit_part` on a deck is held
 * to the part, the layout and the facts the way the editor's edits are.
 *
 * @module canvas/deck-inline-edit
 */

import type { AicoSettings } from '../settings.js';
import type { ProviderAPI } from '../providers/types.js';
import { parseDeck, serializeDeck, type Deck, type Slide } from '../../shared/ui/canvas/deck-model.js';
import { layoutSlide, problemLines } from '../../shared/ui/canvas/deck-layout.js';
import {
  ELEMENT_IDS, applyDeckPatch, buildDeckEditContext, resolveDeckTarget, validateDeckPatch, withSlide,
  type DeckPart, type DeckTarget, type DeckVerdict,
} from '../../shared/ui/canvas/deck-scoped-edit.js';
import { patchFromMarkdown, type PartPatch, type PartQuery } from '../../shared/ui/canvas/scoped-edit.js';
import { diffStats, wordDiff } from '../../shared/ui/canvas/scoped-diff.js';
import { editPart, type EditTurn, type PartEditResult } from './inline-edit.js';
import { writeCanvas, type CanvasContext, type CanvasDoc } from './store.js';

export interface DeckEditResult extends PartEditResult {
  part?: DeckPart;
  /** The slide after the edit (when ok). */
  slide?: Slide;
}

/** A part of a deck, edited: resolve the target, build the context, ask, validate against the layout. Never writes. */
export async function editDeckPart(o: {
  doc: Pick<CanvasDoc, 'title' | 'tabs'>;
  target: DeckTarget;
  instruction: string;
  history?: EditTurn[];
  retryError?: string;
  settings: AicoSettings;
  mainModel: string;
  provider?: ProviderAPI;
  signal?: AbortSignal;
  model?: string;
}): Promise<DeckEditResult> {
  let deck: Deck;
  try { deck = parseDeck(o.doc.tabs[0]!.content); } catch (err) {
    return { ok: false, error: `the deck does not parse: ${err instanceof Error ? err.message : String(err)}`, warnings: [], errors: [], attempts: 0, model: '', costUsd: 0 };
  }
  const r = resolveDeckTarget(deck, o.target);
  if (!r.ok) return { ok: false, error: r.error, warnings: [], errors: [], attempts: 0, model: '', costUsd: 0 };
  const part = r.part;
  const context = buildDeckEditContext(deck, part, { title: o.doc.title });
  const result = await editPart({
    part, context, instruction: o.instruction, settings: o.settings, mainModel: o.mainModel,
    ...(o.history ? { history: o.history } : {}), ...(o.retryError ? { retryError: o.retryError } : {}),
    ...(o.provider ? { provider: o.provider } : {}), ...(o.signal ? { signal: o.signal } : {}), ...(o.model ? { model: o.model } : {}),
    validate: (patch, all) => validateDeckPatch(deck, part, patch, all),
  });
  if (!result.ok || !result.patch) return { ...result, part };
  const built = applyDeckPatch(deck, part, result.patch);
  return { ...result, part, ...(built.ok ? { slide: built.slide } : {}) };
}

/**
 * The agent's own replacement for a deck part, read as the part's patch: text
 * for a text element, JSON for the structured ones (a Markdown table or a
 * fenced block is accepted where it is unambiguous).
 */
export function deckPatchFromContent(part: DeckPart, content: string): PartPatch {
  const text = content.replace(/^\s*\n/, '').replace(/\s+$/, '');
  const json = (): unknown => {
    const body = /^```\w*\n([\s\S]*?)\n```$/.exec(text)?.[1] ?? text;
    try { return JSON.parse(body); } catch { return undefined; }
  };
  switch (part.kind) {
    case 'text': return { kind: 'text', text };
    case 'json': {
      const j = json();
      return j === undefined ? { kind: 'blocks', markdown: text } : { kind: 'json', json: j };
    }
    case 'table': case 'cells': {
      const j = json() as { header?: unknown; rows?: unknown } | undefined;
      if (j && Array.isArray(j.header) && Array.isArray(j.rows)) {
        return { kind: 'table', header: j.header.map(String), rows: (j.rows as unknown[]).map(r => (Array.isArray(r) ? r.map(c => (c === null || c === undefined ? '' : String(c))) : [])) };
      }
      return patchFromMarkdown({ ...part, kind: 'table' }, text);
    }
    default: return patchFromMarkdown(part, text);
  }
}

/** A `part` query from the Canvas tool, as a deck target. */
export function deckTargetOf(deck: Deck, q: PartQuery): { ok: true; target: DeckTarget } | { ok: false; error: string } {
  const raw = q.slide;
  const slide = typeof raw === 'number' || /^\d+$/.test(String(raw ?? '')) ? deck.slides[Number(raw) - 1] : deck.slides.find(s => s.id === String(raw ?? '').trim());
  if (!slide) return { ok: false, error: `part.slide is required — a slide id or its 1-based number. Slides: ${deck.slides.map((s, i) => `${i + 1}=${s.id}`).join(', ')}` };
  const elementId = q.element?.trim() || 'slide';
  const target: DeckTarget = { slideId: slide.id, elementId };
  if ((q.rows || q.columns) && slide.table) {
    const t = slide.table;
    const cols = (q.columns ?? []).map(c => (typeof c === 'number' ? c - 1 : t.header.findIndex(h => h.trim().toLowerCase() === String(c).trim().toLowerCase())));
    if (cols.some(c => c < 0 || c >= t.header.length)) return { ok: false, error: `columns must be among: ${t.header.map(h => `"${h}"`).join(', ')}` };
    const r = q.rows ?? [1, t.rows.length];
    target.elementId = 'table';
    target.cells = {
      r0: Math.max(0, r[0] - 1), r1: Math.min(t.rows.length - 1, r[1] - 1),
      c0: cols.length ? Math.min(...cols) : 0, c1: cols.length ? Math.max(...cols) : t.header.length - 1,
    };
  }
  return { ok: true, target };
}

/**
 * Canvas `edit_part` on a deck: one slide or element changed, held to the
 * part, the layout and the facts; written version-checked as one version.
 * Throws "NOT APPLIED — …" with the reason when it cannot be.
 */
export async function deckEditPartTool(ctx: CanvasContext, doc: CanvasDoc, input: {
  version?: number; instruction?: string; part?: PartQuery; content?: string; note?: string;
}, opts: { mainModel: string; stale: (doc: CanvasDoc) => Error }): Promise<string> {
  const tab = doc.tabs[0]!;
  if (typeof input.version !== 'number' || input.version !== tab.version) throw opts.stale(doc);
  const instruction = (input.instruction ?? '').trim();
  if (!instruction) throw new Error('`instruction` is required for edit_part: what to change, in words ("make the title punchier", "turn the bullets into big numbers") — it also decides what the checks allow.');
  if (!input.part || typeof input.part !== 'object') throw new Error(`\`part\` is required for edit_part on a deck: {slide: "s3" or 3, element?: one of ${ELEMENT_IDS} (default the whole slide; items 1-based), rows?, columns?}.`);
  const deck = parseDeck(tab.content);
  const t = deckTargetOf(deck, input.part);
  if (!t.ok) throw new Error(`NOT APPLIED — ${t.error}`);
  const r = resolveDeckTarget(deck, t.target);
  if (!r.ok) throw new Error(`NOT APPLIED — ${r.error}`);
  const part = r.part;
  let verdict: DeckVerdict;
  let how: string;
  if (typeof input.content === 'string') {
    verdict = validateDeckPatch(deck, part, deckPatchFromContent(part, input.content), [instruction]);
    if (!verdict.ok) {
      throw new Error(`NOT APPLIED — your replacement for the ${part.label.toLowerCase()} on slide ${part.index + 1} failed the checks:\n${verdict.errors.map(e => `- ${e}`).join('\n')}\n`
        + `Current ${part.what}:\n${part.editable}\nSend content again with only what the instruction asks changed, and make it fit.`);
    }
    how = 'your replacement';
  } else {
    const result = await editDeckPart({ doc, target: t.target, instruction, settings: ctx.settings ?? {}, mainModel: opts.mainModel });
    if (!result.ok || !result.patch) {
      throw new Error(`NOT APPLIED — ${result.error ?? 'no edit'}${result.errors.length > 1 ? `\n${result.errors.map(e => `- ${e}`).join('\n')}` : ''}`);
    }
    verdict = validateDeckPatch(deck, part, result.patch, [instruction]);
    how = `the inline editor (${result.model}${result.attempts > 1 ? ', second attempt' : ''})`;
  }
  if (verdict.unchanged || !verdict.slide) return `The ${part.label.toLowerCase()} on slide ${part.index + 1} already reads that way — nothing changed (still version ${tab.version}).`;
  const next = withSlide(deck, part.index, verdict.slide);
  const written = await writeCanvas(ctx, doc.id, {
    content: serializeDeck(next), baseVersion: tab.version, author: 'agent', tab: tab.id,
    note: input.note?.trim() || `AICO edit: ${instruction.slice(0, 120)}`,
  });
  if (!written.ok) throw opts.stale(written.canvas);
  const now = written.canvas.tabs[0]!.version;
  const d = diffStats(wordDiff(part.before, verdict.after));
  const left = layoutSlide(next, part.index).problems;
  return `Edited the ${part.label.toLowerCase()} on slide ${part.index + 1} (${part.slideId}) of deck ${doc.id} with ${how} — now version ${now} (pass version: ${now} next). `
    + `${d.removed} word(s) out, ${d.added} in; every other slide and element is unchanged.`
    + `${left.length ? `\nLayout check for that slide:\n${problemLines(left).join('\n')}` : ' The slide fits its layout.'}`
    + `${verdict.warnings.length ? `\nCheck: ${verdict.warnings.join('; ')}.` : ''}`;
}
