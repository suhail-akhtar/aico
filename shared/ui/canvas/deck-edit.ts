/**
 * The deck editor's text forms — how a slide's structured fields become the
 * plain text a person edits in the inspector, and back.
 *
 * A form per field type (a grid for tables, a row editor for KPIs…) is a lot
 * of UI for little gain; one line per item with `|` between the parts is
 * what people already type into chat and spreadsheets, survives copy and
 * paste from Excel (tabs are read too), and is what the agent's own loose
 * input accepts. Parsing goes through the model's normalisers, so a field
 * typed here is held to exactly the rules an agent's write is.
 *
 * Kept pure (no React, no DOM) so it is unit-tested in Node.
 *
 * @module shared/ui/canvas/deck-edit
 */

import {
  parseDeck, plainOf, toBullets, toChart, type Bullet, type DeckChart, type DeckChartType, type DeckKpi, type DeckMilestone, type DeckTable,
} from './deck-model';

export function bulletsToText(b: Bullet[] | undefined): string {
  return (b ?? []).map(x => `${x.level ? '  ' : ''}${x.text}`).join('\n');
}

export function textToBullets(t: string): Bullet[] | null {
  return toBullets(t) ?? null;
}

function cells(line: string): string[] {
  return (line.includes('\t') ? line.split('\t') : line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|')).map(c => c.trim());
}

export function tableToText(t: DeckTable | undefined): string {
  if (!t) return '';
  return [t.header, ...t.rows].map(r => r.join(' | ')).join('\n');
}

export function textToTable(t: string): DeckTable | null {
  const lines = t.split('\n').filter(l => l.trim() && !/^\s*\|?\s*:?-{2,}/.test(l));
  if (!lines.length) return null;
  const header = cells(lines[0]!);
  return { header, rows: lines.slice(1).map(l => { const c = cells(l); return header.map((_, i) => c[i] ?? ''); }) };
}

/** A chart's data as "Category | Series 1 | Series 2" lines. */
export function chartToText(c: DeckChart | undefined): string {
  if (!c || c.echarts) return '';
  return [[' ', ...c.series.map(s => s.name)].join(' | ').trimStart(), ...c.categories.map((cat, i) => [cat, ...c.series.map(s => String(s.values[i] ?? ''))].join(' | '))].join('\n');
}

export function textToChart(t: string, type: DeckChartType, unit?: string): DeckChart | null {
  const lines = t.split('\n').filter(l => l.trim());
  if (lines.length < 2) return null;
  const rows = lines.slice(1).map(cells);
  let head = cells(lines[0]!);
  // "| Revenue | Cost" (a blank first cell) reads like a Markdown row once its leading pipe is dropped; the data rows say which it was.
  if (rows.length && rows[0]!.length === head.length + 1) head = ['', ...head];
  const names = head.slice(1).map((n, i) => n || `Series ${i + 1}`);
  const chart = toChart({
    type, categories: rows.map(r => r[0] ?? ''),
    series: names.map((name, j) => ({ name, values: rows.map(r => r[j + 1] ?? '0') })),
    ...(unit?.trim() ? { unit: unit.trim() } : {}),
  });
  return chart ?? null;
}

export function kpisToText(k: DeckKpi[] | undefined): string {
  return (k ?? []).map(x => [x.value, x.label, x.delta ?? ''].join(' | ').replace(/ \| $/, '')).join('\n');
}

export function textToKpis(t: string): DeckKpi[] | null {
  const out = t.split('\n').filter(l => l.trim()).map((l) => {
    const [value = '', label = '', delta = ''] = cells(l);
    const trend = /^\s*[-−▼↓]/.test(delta) ? 'down' : /^\s*[+▲↑]/.test(delta) ? 'up' : undefined;
    return { value, label, ...(delta ? { delta } : {}), ...(trend ? { trend } : {}) } as DeckKpi;
  });
  return out.length ? out : null;
}

export function timelineToText(m: DeckMilestone[] | undefined): string {
  return (m ?? []).map(x => [x.date, x.title, x.text ?? ''].join(' | ').replace(/ \| $/, '')).join('\n');
}

export function textToTimeline(t: string): DeckMilestone[] | null {
  const out = t.split('\n').filter(l => l.trim()).map((l) => {
    const [date = '', title = '', text = ''] = cells(l);
    return { date, title, ...(text ? { text } : {}) };
  });
  return out.length ? out : null;
}

/** Where a dragged thumbnail lands: the index to move to, given the index it was dropped on and which half. */
export function dropIndex(from: number, over: number, after: boolean): number {
  let to = over + (after ? 1 : 0);
  if (from < to) to -= 1;
  return to;
}

/** A card's preview of a deck: "12 slides · Title · Problem · …". */
export function deckPreview(content: string, max = 3): string[] {
  try {
    const d = parseDeck(content);
    const titles = d.slides.map(s => plainOf(s.title ?? '')).filter(Boolean).slice(0, max);
    return [`${d.slides.length} slide${d.slides.length === 1 ? '' : 's'}`, ...titles];
  } catch {
    return [];
  }
}
