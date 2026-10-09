/**
 * The Artifacts panel's pure half: what a file is (and so how it previews),
 * what to call it, which rows are the same file twice, and how the list is
 * grouped and filtered. No React and no store, so the unit suite runs it in
 * Node (`desktop/scripts/test-unit.mjs`).
 *
 * Why it exists: the first panel showed the engine's list as it came. A chat
 * that verified an app twenty times listed "load-1440.png" five times with
 * nothing to tell them apart, "the-chart-still-draws-all-50-days-1440.png" as
 * a truncated filename, and every file as "image" or "file" with no way to
 * look at one. The names are the agent's captions with a viewport width and
 * dashes added (`tools/verify-app` writes `<caption>-<width>.png`), so they
 * read back as sentences; identical copies (same name, same size) fold into
 * one row with a count; and the type comes from the extension, because that
 * is what decides the viewer.
 *
 * Deliberately not here: hashing file contents (the list has no bytes, and
 * name + size is what a person would call "the same file"), and any guess at
 * which chat step made a file — the engine does not record it, so the panel
 * shows the topic it does know rather than inventing one.
 *
 * @module desktop/renderer/chat/artifacts-core
 */

import type { ArtifactItem } from '@web/api';
import { dayBucket } from '../lib/util';

/** How an artifact is shown in the viewer. `canvas` opens the canvas editor beside the chat. */
export type PreviewKind =
  | 'canvas' | 'image' | 'svg' | 'html' | 'markdown' | 'csv' | 'xlsx' | 'docx'
  | 'pdf' | 'code' | 'text' | 'video' | 'audio' | 'board' | 'none';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico']);
const VIDEO = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
const AUDIO = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'opus']);
const TEXT = new Set(['txt', 'log', 'text', 'out', 'err', 'conf', 'cfg', 'properties']);

/** Extension → the highlighter's language token (shared/ui/languages). Unlisted code shows unhighlighted. */
const CODE: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'jsx', json: 'json', jsonc: 'json', json5: 'json', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  kt: 'kotlin', kts: 'kotlin', cs: 'csharp', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', css: 'css', scss: 'scss',
  sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', psm1: 'powershell', yaml: 'yaml', yml: 'yaml',
  toml: 'toml', ini: 'ini', php: 'php', swift: 'swift', graphql: 'graphql', gql: 'graphql', diff: 'diff', patch: 'diff',
  dockerfile: 'docker', xml: '', vue: '', svelte: '', lua: '', r: '', dart: '', scala: '', ex: '', exs: '', env: 'ini',
};

/** Media types for the bytes a viewer turns into a blob: the engine serves unknown types as octet-stream. */
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  avif: 'image/avif', ico: 'image/x-icon', svg: 'image/svg+xml', pdf: 'application/pdf',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/opus',
};

export function extOf(item: Pick<ArtifactItem, 'ext' | 'title'>): string {
  if (item.ext) return item.ext.toLowerCase();
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(item.title);
  return m ? m[1]!.toLowerCase() : '';
}

/** Which viewer an artifact gets. */
export function previewKind(item: Pick<ArtifactItem, 'source' | 'ext' | 'title'> & { kind?: ArtifactItem['kind'] }): PreviewKind {
  if (item.source === 'canvas') return 'canvas';
  // A design board is its board.json (ADR 0037); the engine marks it, the extension alone would say "code".
  if (item.kind === 'board') return 'board';
  const ext = extOf(item);
  if (IMAGE.has(ext)) return 'image';
  if (ext === 'svg') return 'svg';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'docx') return 'docx';
  if (ext === 'pdf') return 'pdf';
  if (VIDEO.has(ext)) return 'video';
  if (AUDIO.has(ext)) return 'audio';
  if (ext in CODE) return 'code';
  if (TEXT.has(ext)) return 'text';
  return 'none';
}

export function languageFor(ext: string): string {
  return CODE[ext.toLowerCase()] ?? '';
}

export function mimeFor(ext: string): string {
  return MIME[ext.toLowerCase()] ?? 'application/octet-stream';
}

/** Viewer kinds that read the file as text (and so have a size limit). */
export function isTextual(kind: PreviewKind): boolean {
  return kind === 'html' || kind === 'markdown' || kind === 'csv' || kind === 'code' || kind === 'text' || kind === 'svg';
}

/** Largest text file the viewer reads into the page; bigger ones offer Open / Save instead. */
export const MAX_TEXT_PREVIEW = 3 * 1024 * 1024;

/**
 * Widths a browser screenshot is taken at. Only these are stripped from the
 * end of a name — "report-2026" keeps its year; "load-1440" loses the width.
 */
const VIEWPORT_WIDTHS = new Set([320, 360, 375, 390, 393, 412, 414, 428, 430, 768, 800, 820, 834, 1024, 1180, 1280, 1366, 1440, 1536, 1600, 1680, 1920, 2560, 3840]);

export interface HumanName {
  /** "The chart still draws all 50 days". */
  name: string;
  /** Lower-case extension, no dot. */
  ext: string;
  /** What was taken off the name and is still worth saying: "1440 px wide", a timestamp. */
  detail?: string;
}

/** A file name as a person would say it: no extension, no width suffix, no dashes, sentence case. */
export function humaniseName(file: string): HumanName {
  const m = /^(.+)\.([A-Za-z0-9]{1,8})$/.exec(file);
  const ext = m ? m[2]!.toLowerCase() : '';
  let base = m ? m[1]! : file;
  let detail: string | undefined;
  const width = /^(.+?)[-_ ]+(\d{3,4})(?:w|px)?$/i.exec(base);
  if (width && VIEWPORT_WIDTHS.has(Number(width[2]))) { base = width[1]!; detail = `${width[2]} px wide`; }
  // shot-2026-10-03T12-30-05-123Z, report_2026-10-03_1230: keep the moment as detail.
  const stamp = /^(.*?)[-_ ]*(\d{4})-(\d{2})-(\d{2})(?:[T_ -](\d{2})[-:]?(\d{2})(?:[-:]?(\d{2}))?(?:[-.]\d+)?Z?)?$/.exec(base);
  if (stamp && (stamp[1] || stamp[5])) {
    base = stamp[1] ?? '';
    detail = `${stamp[2]}-${stamp[3]}-${stamp[4]}${stamp[5] ? ` ${stamp[5]}:${stamp[6]}` : ''}`;
  }
  if (/^(shot|screenshot|screen[-_ ]?shot)$/i.test(base.trim()) || (!base.trim() && stamp)) base = 'Screenshot';
  let words = base.replace(/[-_\s]+/g, ' ').trim();
  if (!words) words = file;
  // Sentence case only for names written all in lower case: "Q3 BOQ" and "README" are left as their author wrote them.
  if (words === words.toLowerCase()) words = words.charAt(0).toUpperCase() + words.slice(1);
  return { name: words, ext, ...(detail ? { detail } : {}) };
}

export interface ArtifactEntry {
  item: ArtifactItem;
  /** Display name: the canvas title, or the humanised file name. */
  name: string;
  ext: string;
  detail?: string;
  kind: PreviewKind;
  /** Older identical copies folded into this row (same name, same size), newest first. */
  copies: ArtifactItem[];
  /** When several different files share a name: this one's place among them, oldest = 1. */
  variant?: { index: number; of: number };
}

/**
 * One row per distinct file, newest first. Two files are the same when their
 * names and sizes match — the agent re-saving an unchanged screenshot. Same
 * name and a different size is a different file: it keeps its own row and is
 * numbered among its namesakes so the rows can be told apart.
 */
export function buildEntries(items: ArtifactItem[]): ArtifactEntry[] {
  const sorted = [...items].sort((a, b) => b.updatedAt - a.updatedAt);
  const byKey = new Map<string, ArtifactEntry>();
  const out: ArtifactEntry[] = [];
  for (const item of sorted) {
    const canvas = item.source === 'canvas' || item.kind === 'board';
    const key = canvas ? item.key : `${item.title.toLowerCase()}|${item.bytes ?? '?'}`;
    const same = byKey.get(key);
    if (same) { same.copies.push(item); continue; }
    // An export is called what its canvas is called ("BOQ", not "Boq" from boq.xlsx); the file name stays the second line.
    const h = canvas ? { name: item.title, ext: '' } as HumanName
      : item.kind === 'export' && item.topic ? { ...humaniseName(item.title), name: item.topic } : humaniseName(item.title);
    const entry: ArtifactEntry = { item, name: h.name, ext: h.ext || extOf(item), kind: previewKind(item), copies: [], ...(h.detail ? { detail: h.detail } : {}) };
    byKey.set(key, entry);
    out.push(entry);
  }
  const namesakes = new Map<string, ArtifactEntry[]>();
  for (const e of out) {
    const k = `${e.name.toLowerCase()}|${e.ext}`;
    namesakes.set(k, [...(namesakes.get(k) ?? []), e]);
  }
  for (const group of namesakes.values()) {
    if (group.length < 2) continue;
    group.forEach((e, i) => { e.variant = { index: group.length - i, of: group.length }; });
  }
  return out;
}

export type Grouping = 'type' | 'time' | 'topic';

const TYPE_ORDER: Array<{ name: string; test: (e: ArtifactEntry) => boolean }> = [
  { name: 'Design boards', test: e => e.kind === 'board' },
  { name: 'Documents', test: e => (e.kind === 'canvas' && e.item.kind === 'document') || ['markdown', 'docx', 'pdf', 'text'].includes(e.kind) },
  { name: 'Sheets', test: e => (e.kind === 'canvas' && e.item.kind === 'sheet') || e.kind === 'csv' || e.kind === 'xlsx' },
  { name: 'Presentations', test: e => (e.kind === 'canvas' && e.item.kind === 'deck') || e.ext === 'pptx' },
  { name: 'Web pages', test: e => e.kind === 'html' },
  { name: 'Code', test: e => (e.kind === 'canvas' && e.item.kind === 'code') || e.kind === 'code' },
  { name: 'Images', test: e => e.kind === 'image' || e.kind === 'svg' },
  { name: 'Audio & video', test: e => e.kind === 'video' || e.kind === 'audio' },
];

export interface EntryGroup { name: string; entries: ArtifactEntry[] }

/** Sections for the list: by type (fixed order), by day (newest first), or by topic (canvases lead their exports). */
export function groupEntries(entries: ArtifactEntry[], grouping: Grouping, now = Date.now()): EntryGroup[] {
  if (grouping === 'type') {
    const left = new Set(entries);
    const groups = TYPE_ORDER.map(g => {
      const xs = entries.filter(e => left.has(e) && g.test(e));
      xs.forEach(e => left.delete(e));
      return { name: g.name, entries: xs };
    });
    groups.push({ name: 'Other files', entries: entries.filter(e => left.has(e)) });
    return groups.filter(g => g.entries.length);
  }
  const by = new Map<string, ArtifactEntry[]>();
  for (const e of entries) {
    const k = grouping === 'time' ? dayBucket(e.item.updatedAt, now) : e.item.topic;
    by.set(k, [...(by.get(k) ?? []), e]);
  }
  const groups = [...by.entries()].map(([name, xs]) => ({ name, entries: xs }));
  if (grouping === 'topic') for (const g of groups) g.entries.sort((a, b) => Number(b.kind === 'canvas') - Number(a.kind === 'canvas'));
  return groups;
}

/** Every word of the query must appear in the name, the file name, the type or the topic. */
export function matchesQuery(e: ArtifactEntry, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${e.name} ${e.item.title} ${e.ext} ${e.kind} ${e.item.kind} ${e.item.topic}`.toLowerCase();
  return words.every(w => hay.includes(w));
}

/** Short label for the type tile and the meta line: "PNG", "Sheet", "Web page". */
export function typeLabel(e: Pick<ArtifactEntry, 'kind' | 'ext' | 'item'>): string {
  if (e.kind === 'canvas') return e.item.kind === 'sheet' ? 'Sheet' : e.item.kind === 'deck' ? 'Presentation' : e.item.kind === 'code' ? 'Code' : 'Document';
  if (e.kind === 'board') return 'Design board';
  return e.ext ? e.ext.toUpperCase() : 'File';
}

/**
 * CSV / TSV into rows: quoted fields, doubled quotes, newlines inside quotes,
 * CRLF. The delimiter is the one the header line uses most (tab, comma or
 * semicolon). Stops after `maxRows` rows and says so.
 */
export function parseDelimited(text: string, maxRows = 2000): { rows: string[][]; truncated: boolean } {
  const src = text.replace(/^﻿/, '');
  const nl = src.search(/\r?\n/);
  const head = nl < 0 ? src : src.slice(0, nl);
  const counts = (['\t', ',', ';'] as const).map(d => [d, head.split(d).length - 1] as const);
  const delim = counts.reduce((best, c) => (c[1] > best[1] ? c : best), [',', 0] as readonly [string, number])[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') { quoted = true; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
      if (rows.length >= maxRows) return { rows, truncated: i < src.length - 1 };
      continue;
    }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return { rows, truncated: false };
}
