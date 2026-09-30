/**
 * What every export writer needs to agree on: the headings (with the anchor
 * each one gets), where the table of contents goes, and how a heading reads
 * as plain text.
 *
 * Computed once per export so the HTML anchors, the Word bookmarks, the TOC
 * entries and the PDF page-number pass all name the same heading the same
 * way — two writers each slugging headings independently is how a TOC link
 * ends up pointing at the wrong "Overview".
 *
 * @module canvas/doc-model
 */

import type { Heading, Root } from 'mdast';

export interface HeadingInfo {
  depth: number;
  text: string;
  /** Unique anchor id (HTML) / bookmark suffix (Word). */
  id: string;
  node: Heading;
}

export const TOC_MARKER = /^\s*<!--\s*aico:toc\s*-->\s*$/i;

/** Plain text of a node, maths and code included as written. */
export function plainText(node: { type?: string; value?: unknown; alt?: unknown; children?: unknown[] }): string {
  if (typeof node.value === 'string') return node.value;
  if (node.type === 'image') return String(node.alt ?? '');
  return (node.children ?? []).map(c => plainText(c as never)).join('');
}

export function slug(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'section';
}

/** Headings in document order, each with a unique id. */
export function collectHeadings(tree: Root): HeadingInfo[] {
  const seen = new Map<string, number>();
  const out: HeadingInfo[] = [];
  const walk = (node: { type: string; children?: unknown[] }): void => {
    if (node.type === 'heading') {
      const h = node as unknown as Heading;
      const text = plainText(h as never).replace(/\s+/g, ' ').trim();
      const base = slug(text);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      out.push({ depth: h.depth, text, id: n === 1 ? base : `${base}-${n}`, node: h });
      return;
    }
    // Headings inside quotes or lists are not document structure.
    if (node.type === 'root') for (const c of (node.children ?? []) as never[]) walk(c);
  };
  walk(tree as never);
  return out;
}

/** Is this top-level node the TOC marker? */
export function isTocMarker(node: { type: string; value?: unknown }): boolean {
  return node.type === 'html' && typeof node.value === 'string' && TOC_MARKER.test(node.value);
}

export function hasTocMarker(tree: Root): boolean {
  return tree.children.some(n => isTocMarker(n as never));
}
