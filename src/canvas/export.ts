/**
 * Export a canvas as Markdown, HTML, Word (.docx) or PDF — everything as it
 * looks in the app.
 *
 * One parse (`canvas/markdown`), one visuals pass (`canvas/visuals`), four
 * writers. Pending placeholders are stripped first in every format: an export
 * is the document as it stands, not the plan for it.
 *
 * - **md** — the Markdown itself, placeholders removed, the TOC marker
 *   expanded into a linked list.
 * - **html** — a standalone file: inline CSS in the chat's reading style,
 *   charts and diagrams as inline SVG, maths as images, infographics as HTML,
 *   pictures from the project inlined as data URLs, a cover, a linked TOC and
 *   the watermark.
 * - **docx** — `canvas/docx` (real TOC field, header/footer, cover, watermark).
 * - **pdf** — the HTML printed by the installed Chrome/Edge through
 *   `playwright-core`, with the page setup, running header/footer and page
 *   numbers. **TOC page numbers use two passes**: print once, read which page
 *   each heading landed on (pdf-parse, sequentially after the TOC), print
 *   again with the numbers filled in. The numbers occupy fixed-width slots in
 *   both passes, so filling them in cannot move a heading to another page.
 *   The running header/footer are CSS margin boxes on named pages (ADR 0022),
 *   so the cover has none and the front matter is numbered i, ii; the body is
 *   numbered from 1 and "of N" is the body's page count from the first pass.
 *
 * **Design (ADR 0022).** Both the HTML and the Word writer follow one layout
 * plan (`canvas/doc-plan`) and the document's family (`shared/ui/canvas/
 * doc-blueprints`): heading levels and numbers, captions, table widths and
 * variants, cover and front matter. A .docx with contents is also printed
 * once (laid out the way Word paginates) to pre-fill its TOC page numbers.
 *
 * No browser: md and html still work (charts as SVG, diagrams/maths as
 * labelled placeholders with their source); docx works with placeholders for
 * every visual; pdf fails with a message naming the alternatives. Every
 * network request from the print page is refused.
 *
 * A document with several tabs exports whole (each tab under its own
 * top-level heading) unless one tab is named.
 *
 * **Themes and document blocks (round 3).** `settings.theme` switches on the
 * generated rules of `shared/ui/canvas/doc-themes` (fonts, accent, heading,
 * table and cover style) — the same rules the editor page uses — plus a
 * classification banner on every page and, for a letter, a letterhead on the
 * first page instead of a running header. The document blocks (signature,
 * line items, risk matrix, …) are drawn by `shared/ui/canvas/doc-blocks`,
 * the very HTML the editor shows.
 *
 * @module canvas/export
 */

import type { Nodes, Paragraph, PhrasingContent, Root, RootContent, Table } from 'mdast';
import type { CanvasDoc } from './store.js';
import { stripPending } from './sections.js';
import { tableCapacity, toDocx } from './docx.js';
import { fileBase, parseMarkdown, type ImageResolver } from './markdown.js';
import { PAGE_MM, expandFields, expandRunning, mergeSettings, resolveSettings, type DocSettings } from './doc-settings.js';
import { frontModel, planDocument, type Caption, type DocPlan, type FrontModel } from './doc-plan.js';
import { apportion } from '../../shared/ui/canvas/doc-layout.js';
import { collectHeadings, hasTocMarker, isTocMarker, plainText, type HeadingInfo } from './doc-model.js';
import {
  INFOGRAPHIC_CSS, infographicHtml, infographicKind, normalizeAlternateSyntax, parseImageAttrs, parseInfographic, type ImageAttrs,
} from './infographics.js';
import {
  collectVisuals, launchExportBrowser, renderVisuals, visualForCode, visualKey,
  type ExportBrowser, type RenderedVisual,
} from './visuals.js';
import { DOC_BLOCK_CSS, docBlockHtml, docBlockKind, parseDocBlock } from '../../shared/ui/canvas/doc-blocks.js';
import { resolveLook, styleText, themeAttrs, themeRules, type ResolvedLook } from '../../shared/ui/canvas/doc-themes.js';

export type ExportFormat = 'md' | 'html' | 'docx' | 'pdf';
export const EXPORT_FORMATS: readonly ExportFormat[] = ['md', 'html', 'docx', 'pdf'];

export const EXPORT_MEDIA: Record<ExportFormat, string> = {
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
};

export interface ExportResult {
  bytes: Buffer;
  fileName: string;
  mediaType: string;
  /** Visual blocks that could not be drawn, with why (the file shows placeholders for them). */
  warnings: string[];
  /** PDF only: whether TOC page numbers were filled in. */
  tocPageNumbers?: boolean;
}

/** The Markdown an export is made from, and the title it carries. */
export function exportSource(doc: CanvasDoc, tab?: string): { title: string; markdown: string } {
  if (tab !== undefined && tab !== '') {
    const t = doc.tabs.find(x => x.id === tab) ?? doc.tabs.find(x => x.title.toLowerCase() === String(tab).toLowerCase());
    if (!t) throw new Error(`canvas ${doc.id} has no tab "${tab}". Tabs: ${doc.tabs.map(x => `${x.id} "${x.title}"`).join(', ')}.`);
    return { title: doc.tabs.length > 1 ? `${doc.title} — ${t.title}` : doc.title, markdown: stripPending(t.content) };
  }
  if (doc.tabs.length === 1) return { title: doc.title, markdown: stripPending(doc.tabs[0]!.content) };
  return {
    title: doc.title,
    markdown: doc.tabs.map(t => `# ${t.title}\n\n${stripPending(t.content).trim()}`).join('\n\n'),
  };
}

/**
 * Does the text already open with the title as its level-1 heading (so adding
 * it would repeat)? Only the same words count: a document opening with
 * "# 1. Summary" still needs its title above it — the first live export lost
 * the title that way. A document that opens with a `cover` block has its title.
 */
function opensWithH1(tree: Root, title: string): boolean {
  const first = tree.children.find(n => n.type !== 'html' && n.type !== 'definition');
  // A cover band (round 3) is the document's title.
  if (first?.type === 'code' && docBlockKind(first.lang) === 'cover') return true;
  if (first?.type !== 'heading' || first.depth !== 1) return false;
  const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return norm(plainText(first as never)) === norm(title);
}

// ── HTML ────────────────────────────────────────────────────────────

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Links that are safe to keep clickable in an exported file. */
function safeHref(url: string): string | undefined {
  const u = url.trim();
  if (/^(https?:|mailto:|#)/i.test(u)) return u;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return u; // relative
  return undefined;
}

interface HtmlCtx {
  images: Map<string, string | null>;
  visuals: Map<string, RenderedVisual>;
  headingIds: Map<unknown, HeadingInfo>;
  tocHtml: string;
  /** The layout plan (`canvas/doc-plan`) — the same one the Word writer follows. */
  plan: DocPlan;
  /** The title has been drawn (cover, masthead or title line). */
  titleShown: boolean;
}

function captionHtml(c: Caption, tag = 'p'): string {
  return `<${tag} class="caption caption-${c.kind}"><b>${c.kind === 'table' ? 'Table' : 'Figure'} ${c.n}</b> — ${esc(c.text)}</${tag}>`;
}

function dataPng(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`;
}

function imgStyle(attrs: ImageAttrs | undefined): string {
  return attrs?.width ? ` style="width:${esc(attrs.width)}"` : '';
}

function imageHtml(n: { url: string; alt?: string | null }, ctx: HtmlCtx, attrs?: ImageAttrs): string {
  const src = ctx.images.get(n.url);
  if (src === undefined && /^https?:/i.test(n.url)) return `<img src="${esc(n.url)}" alt="${esc(n.alt ?? '')}"${imgStyle(attrs)}>`;
  return src ? `<img src="${esc(src)}" alt="${esc(n.alt ?? '')}"${imgStyle(attrs)}>` : `<em>[${esc(n.alt || 'image')}]</em>`;
}

function inlineHtml(nodes: PhrasingContent[], ctx: HtmlCtx): string {
  return nodes.map((n, i) => {
    switch (n.type) {
      case 'text': {
        const prev = nodes[i - 1];
        const v = prev?.type === 'image' ? (parseImageAttrs(n.value)?.rest ?? n.value) : n.value;
        return esc(v);
      }
      case 'strong': return `<strong>${inlineHtml(n.children, ctx)}</strong>`;
      case 'emphasis': return `<em>${inlineHtml(n.children, ctx)}</em>`;
      case 'delete': return `<del>${inlineHtml(n.children, ctx)}</del>`;
      case 'inlineCode': return `<code>${esc(n.value)}</code>`;
      case 'break': return '<br>';
      case 'link': {
        const href = safeHref(n.url ?? '');
        const inner = inlineHtml(n.children, ctx);
        return href ? `<a href="${esc(href)}">${inner}</a>` : inner;
      }
      case 'image': {
        const next = nodes[i + 1];
        return imageHtml(n, ctx, next?.type === 'text' ? parseImageAttrs(next.value)?.attrs : undefined);
      }
      case 'inlineMath': {
        const v = ctx.visuals.get(visualKey('math-inline', n.value));
        return v?.png && !v.error
          ? `<img class="math-inline" src="${dataPng(v.png)}" style="width:${v.width}px;height:${v.height}px" alt="${esc(n.value)}">`
          : `<code>${esc(n.value)}</code>`;
      }
      case 'html': return /^<!--/.test(n.value) ? '' : esc(n.value);
      case 'footnoteReference': return `<sup>[${esc(n.identifier)}]</sup>`;
      default:
        if ('children' in n) return inlineHtml((n as { children: PhrasingContent[] }).children, ctx);
        if ('value' in n) return esc(String((n as { value: unknown }).value));
        return '';
    }
  }).join('');
}

function tableHtml(n: Table, ctx: HtmlCtx): string {
  const align = n.align ?? [];
  const tp = ctx.plan.tables.get(n);
  const last = n.children.length - 1;
  const rows = n.children.map((row, ri) => {
    const tag = ri === 0 ? 'th' : 'td';
    const cells = row.children.map((cell, ci) => {
      const want = align[ci] ?? (ri > 0 && tp?.numeric[ci] ? 'right' : null);
      const a = want ? ` style="text-align:${want}"` : '';
      return `<${tag}${a}>${inlineHtml(cell.children, ctx)}</${tag}>`;
    }).join('');
    return `<tr${tp?.total && ri === last && ri > 0 ? ' class="total"' : ''}>${cells}</tr>`;
  });
  const [head, ...body] = rows;
  // Content-based column widths (`doc-layout`), the same shares the Word table gets.
  const cols = tp ? `<colgroup>${apportion(tp.widths, 1000).map(w => `<col style="width:${(w / 10).toFixed(1)}%">`).join('')}</colgroup>` : '';
  const cls = tp ? ` class="fit tv-${tp.variant}"` : '';
  const cap = ctx.plan.captions.get(n);
  // The caption is the table's own <caption>: Chrome keeps it with the table across a page break, a paragraph it does not.
  const table = `<table${cls}>${cap ? captionHtml(cap, 'caption') : ''}${cols}<thead>${head ?? ''}</thead><tbody>${body.join('')}</tbody></table>`;
  // A short table is kept whole on a page; a long one breaks between rows, its header repeated.
  return cap || tp ? `<div class="tblock${n.children.length <= 12 ? ' short' : ''}">${table}</div>` : table;
}

function figureHtml(n: Paragraph, ctx: HtmlCtx): string | undefined {
  const kids = n.children.filter(c => !(c.type === 'text' && !c.value.trim()));
  const img = kids[0];
  if (!img || img.type !== 'image') return undefined;
  let attrs: ImageAttrs = {};
  if (kids.length === 2 && kids[1]!.type === 'text') {
    const parsed = parseImageAttrs(kids[1]!.value.trim());
    if (!parsed || parsed.rest.trim()) return undefined;
    attrs = parsed.attrs;
  } else if (kids.length !== 1) return undefined;
  const cap = ctx.plan.captions.get(n);
  return `<figure class="align-${attrs.align ?? 'center'}">${imageHtml(img, ctx, attrs)}`
    + `${cap ? captionHtml(cap, 'figcaption') : img.title ? `<figcaption>${esc(img.title)}</figcaption>` : ''}</figure>`;
}

function visualHtml(kind: 'chart' | 'diagram' | 'math', source: string, ctx: HtmlCtx, node?: unknown): string {
  const v = ctx.visuals.get(visualKey(kind, source));
  const c = node ? ctx.plan.captions.get(node) : undefined;
  const cap = c ? captionHtml(c, 'figcaption') : '';
  if (v && !v.error) {
    // At its drawn size (as in Word, 1 px = 0.75 pt), never stretched to the page width.
    if (v.svg && kind !== 'math') return `<figure class="visual visual-${kind}"${v.width ? ` style="--vw: ${v.width}px"` : ''}>${v.svg}${cap}</figure>`;
    if (v.png) return `<figure class="visual visual-${kind}"><img src="${dataPng(v.png)}" style="width:${v.width}px;max-width:100%" alt="${esc(c?.text ?? kind)}">${cap}</figure>`;
  }
  if (v?.svg && kind === 'chart') return `<figure class="visual visual-chart">${v.svg}${cap}</figure>`;
  const label = kind === 'chart' ? 'Chart' : kind === 'diagram' ? 'Diagram' : 'Formula';
  return `<div class="visual-missing"><div>${label} not rendered${v?.error ? ` — ${esc(v.error)}` : ''}. Source:</div><pre><code>${esc(source)}</code></pre></div>`;
}

function markdownToHtmlFragment(source: string, ctx: HtmlCtx): string {
  return parseMarkdown(source).children.map(n => blockHtml(n, ctx)).join('\n');
}

function blockHtml(n: RootContent | Nodes, ctx: HtmlCtx): string {
  switch (n.type) {
    case 'heading': {
      const info = ctx.headingIds.get(n);
      const p = ctx.plan.byNode.get(n);
      if (p?.isTitle) {
        if (ctx.titleShown) return '';
        ctx.titleShown = true;
        return `<h1${info ? ` id="${esc(info.id)}"` : ''} class="doc-title">${inlineHtml(n.children, ctx)}</h1>`;
      }
      // The tag stays the Markdown's (the theme rules key on it); the class carries the logical level.
      const inner = p && info && p.text !== info.text ? esc(p.text) : inlineHtml(n.children, ctx);
      const label = p?.label ? `<span class="hnum">${esc(p.label)}${p.appendix ? ' —' : ''}</span> ` : '';
      const cls = p ? ` class="lv${p.level}${p.appendix ? ' appendix' : ''}"` : '';
      return `<h${n.depth}${info ? ` id="${esc(info.id)}"` : ''}${cls}>${label}${inner}</h${n.depth}>`;
    }
    case 'paragraph':
      if (ctx.plan.consumed.has(n)) return ''; // printed as a caption
      return figureHtml(n, ctx) ?? `<p>${inlineHtml(n.children, ctx)}</p>`;
    case 'thematicBreak': return '<hr>';
    case 'blockquote': return `<blockquote>${n.children.map(c => blockHtml(c, ctx)).join('\n')}</blockquote>`;
    case 'math': return visualHtml('math', n.value, ctx);
    case 'code': {
      const visual = visualForCode(n.lang, n.value);
      if (visual && visual.kind !== 'math-inline') return visualHtml(visual.kind, visual.source, ctx, n);
      const ig = infographicKind(n.lang);
      if (ig) {
        const parsed = parseInfographic(ig, n.value, n.meta);
        if (parsed.ok) return infographicHtml(parsed.value, md => markdownToHtmlFragment(md, ctx));
        return `<div class="visual-missing"><div>${esc(parsed.error)}. Source:</div><pre><code>${esc(n.value)}</code></pre></div>`;
      }
      const db = docBlockKind(n.lang);
      if (db) {
        const parsed = parseDocBlock(db, n.value, `${n.lang ?? ''} ${n.meta ?? ''}`);
        if (parsed.ok) return `<div class="db-block">${docBlockHtml(parsed.value, md => markdownToHtmlFragment(md, ctx))}</div>`;
        return `<div class="visual-missing"><div>${esc(parsed.error)}. Source:</div><pre><code>${esc(n.value)}</code></pre></div>`;
      }
      return `<pre><code${n.lang ? ` class="language-${esc(n.lang)}"` : ''}>${esc(n.value)}</code></pre>`;
    }
    case 'list': {
      const tag = n.ordered ? 'ol' : 'ul';
      const start = n.ordered && n.start && n.start !== 1 ? ` start="${n.start}"` : '';
      const task = n.children.some(i => typeof i.checked === 'boolean');
      const items = n.children.map((item) => {
        const box = typeof item.checked === 'boolean'
          ? `<input type="checkbox" disabled${item.checked ? ' checked' : ''}> ` : '';
        // A tight list's paragraphs render without <p>, as the chat does.
        const inner = item.children.map((c, i) => {
          const html = n.spread === false && c.type === 'paragraph' ? inlineHtml(c.children, ctx) : blockHtml(c, ctx);
          return i === 0 ? box + html : html;
        }).join('\n');
        return `<li${typeof item.checked === 'boolean' ? ' class="task"' : ''}>${inner || box}</li>`;
      }).join('\n');
      return `<${tag}${start}${task ? ' class="tasks"' : ''}>\n${items}\n</${tag}>`;
    }
    case 'table': return tableHtml(n, ctx);
    case 'html':
      if (isTocMarker(n)) return ctx.plan.tocAtMarker ? ctx.tocHtml : '';
      return /^<!--/.test(n.value.trim()) ? '' : `<p>${esc(n.value)}</p>`;
    case 'definition': return '';
    case 'footnoteDefinition':
      return `<div class="footnote"><sup>[${esc(n.identifier)}]</sup> ${n.children.map(c => blockHtml(c, ctx)).join('')}</div>`;
    default:
      if ('children' in n) return (n.children as RootContent[]).map(c => blockHtml(c, ctx)).join('\n');
      return '';
  }
}

async function loadImages(tree: Root, resolve: ImageResolver, extra: string[] = []): Promise<Map<string, string | null>> {
  const images = new Map<string, string | null>();
  const one = async (url: string): Promise<void> => {
    if (images.has(url) || /^https?:/i.test(url)) return; // remote: left as a link; never fetched here
    const data = await resolve(url).catch(() => undefined);
    images.set(url, data ? `data:${data.mediaType};base64,${data.bytes.toString('base64')}` : null);
  };
  const walk = async (node: { type: string; url?: string; children?: unknown[] }): Promise<void> => {
    if (node.type === 'image' && node.url) await one(node.url);
    for (const child of (node.children ?? []) as never[]) await walk(child);
  };
  for (const e of extra) await one(e);
  await walk(tree as never);
  return images;
}

const CSS = `
  body { margin: 0; background: #fff; color: #1a1a1a; font: 16px/1.65 var(--font); }
  :root { --font: -apple-system, "Segoe UI", system-ui, sans-serif; }
  body.serif { --font: Georgia, "Times New Roman", serif; }
  main { max-width: 760px; margin: 0 auto; padding: 48px 28px 72px; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.6em 0 0.5em; break-after: avoid; }
  h1 { font-size: 2em; } main > h1:first-child, .cover + h1 { margin-top: 0; } h2 { font-size: 1.5em; } h3 { font-size: 1.2em; }
  p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
  a { color: #2563eb; }
  blockquote { border-left: 3px solid #d4d4d8; padding-left: 14px; color: #52525b; }
  code { font: 0.9em ui-monospace, "Cascadia Code", Consolas, monospace; background: #f4f4f5; padding: 1px 5px; border-radius: 4px; }
  pre { background: #f4f4f5; padding: 12px 14px; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: auto; max-width: 100%; }
  th, td { border: 1px solid #e4e4e7; padding: 6px 10px; text-align: left; vertical-align: top; }
  thead th { background: #f4f4f5; font-weight: 700; }
  tr { break-inside: avoid; }
  ul.tasks { list-style: none; padding-left: 1.2em; } li.task input { margin: 0 6px 0 -1.2em; }
  img, svg { max-width: 100%; height: auto; }
  img.math-inline { vertical-align: middle; }
  figure { margin: 0 0 1.2em; break-inside: avoid; }
  figure.align-center { text-align: center; } figure.align-right { text-align: right; } figure.align-left { text-align: left; }
  figcaption { font-size: 0.88em; color: #52525b; font-style: italic; margin-top: 6px; }
  figure.visual { text-align: center; } figure.visual svg { max-width: 100%; height: auto; }
  .visual-missing { border: 1px dashed #a1a1aa; border-radius: 8px; padding: 10px 12px; margin: 0 0 1em; color: #52525b; font-size: 0.9em; }
  .visual-missing pre { margin: 6px 0 0; }
  hr { border: 0; border-top: 1px solid #e4e4e7; margin: 2em 0; }
  nav.toc { margin: 0 0 2em; }
  nav.toc .toc-title { font-size: 1.4em; font-weight: 700; margin-bottom: 0.6em; }
  nav.toc ol { list-style: none; padding: 0; margin: 0; }
  nav.toc li { display: flex; align-items: baseline; gap: 6px; margin: 3px 0; position: relative; }
  nav.toc li a { color: inherit; text-decoration: none; }
  nav.toc li .dots { flex: 1; border-bottom: 1px dotted #a1a1aa; transform: translateY(-4px); }
  nav.toc li .pg { display: inline-block; min-width: 2.2em; text-align: right; font-variant-numeric: tabular-nums; }
  nav.toc .l1 { font-weight: 600; } nav.toc .l2 { padding-left: 1.2em; } nav.toc .l3 { padding-left: 2.4em; }
  .toc-end { position: absolute; color: #fff; font-size: 1px; }
  .cover { min-height: 70vh; display: flex; flex-direction: column; justify-content: center; margin-bottom: 3em; }
  .cover .logo { max-height: 80px; max-width: 200px; margin-bottom: 36px; }
  .cover h1.cover-title { font-size: 2.6em; margin: 0 0 12px; }
  .cover .subtitle { font-size: 1.35em; color: #52525b; margin-bottom: 18px; }
  .cover .rule { border-top: 3px solid #2563eb; width: 120px; margin: 12px 0 18px; }
  .cover .meta { color: #52525b; }
  .watermark { position: fixed; top: 42%; left: 0; right: 0; text-align: center; transform: rotate(-35deg); font-weight: 700;
    color: rgba(160, 160, 160, 0.18); white-space: nowrap; pointer-events: none; z-index: 0; letter-spacing: 3px; }
  ${INFOGRAPHIC_CSS}
  .db-block { margin: 0 0 1.2em; }
  ${DOC_BLOCK_CSS}
  :root { --dt-ink: #1a1a1a; --dt-muted: #52525b; --dt-rule: #e4e4e7; --dt-accent: #2563eb; --dt-accent-ui: var(--dt-accent);
    --dt-accent-fill: var(--dt-accent); --dt-tint: color-mix(in srgb, var(--dt-accent) 7%, #fff); }
  body[data-dt] { --dt-accent-ui: var(--dt-accent); --dt-accent-fill: var(--dt-accent); --dt-tint: color-mix(in srgb, var(--dt-accent) 7%, #fff); }
  ${themeRules('body')}
  body[data-dt] h1 { font-size: 2.1em; }
  .classification { text-align: center; font: 700 11px/1.4 -apple-system, "Segoe UI", sans-serif; letter-spacing: 0.14em; color: #b91c1c;
    border: 1px solid #fca5a5; background: #fef2f2; padding: 3px 8px; margin: 0 0 1.5em; }
  .classification.bottom { margin: 2em 0 0; }
  .letterhead { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; padding-bottom: 12px; margin-bottom: 2em;
    border-bottom: 2px solid var(--dt-accent-ui); }
  .letterhead .lh-name { font-family: var(--dt-head, inherit); font-size: 1.6em; font-weight: 700; color: var(--dt-accent-ui); letter-spacing: 0.01em; }
  .letterhead .lh-date { color: var(--dt-muted); font-size: 0.9em; }
  .cover.cover-band { justify-content: flex-end; padding: 48px 40px; background: var(--dt-accent-fill); color: #fff; border-radius: 4px; }
  .cover.cover-band .subtitle, .cover.cover-band .meta { color: rgba(255,255,255,0.85); }
  .cover.cover-band .rule { border-top-color: rgba(255,255,255,0.7); }
  .cover.cover-band h1.cover-title { color: #fff; border: 0; }
  .cover.cover-minimal { justify-content: flex-start; padding-top: 18vh; }
  .cover.cover-minimal h1.cover-title { border: 0; }
  .cover .rule { border-top-color: var(--dt-accent-ui); }
`;


/** The design layer (ADR 0022): captions, fitted tables and their variants, covers, front matter, masthead, numbered headings. */
const DESIGN_CSS = `
  .hnum { color: var(--dt-accent-ui, #2563eb); font-variant-numeric: tabular-nums; margin-right: 0.2em; }
  .caption { font-size: 0.86em; color: #3f3f46; margin: 0.35em 0 1em; break-after: avoid; }
  figcaption.caption { text-align: center; margin-top: 6px; }
  .tblock { margin: 0 0 1.15em; } .tblock table { margin: 0; }
  table > caption.caption { caption-side: top; text-align: left; margin: 0 0 0.4em; }
  table.fit { width: 100%; table-layout: fixed; } table.fit th, table.fit td { overflow-wrap: break-word; }
  /* The Word table's padding (120 twips a side), so the computed widths fit the same words on a line. */
  body.bp table.fit th, body.bp table.fit td { padding: 4px 8px; }
  figure.visual svg { width: 100%; max-width: min(100%, var(--vw, 100%)); height: auto; }
  table.tv-keyvalue td:first-child { background: var(--dt-tint, #f4f4f5); font-weight: 600; }
  table.tv-matrix td:not(:first-child), table.tv-matrix th:not(:first-child) { text-align: center; }
  table.tv-matrix td:first-child { font-weight: 600; }
  tr.total td { font-weight: 700; border-top: 1.5px solid #1a1a1a; }
  p, li { orphans: 3; widows: 3; }
  h1.doc-title { margin-top: 0; }
  .cover-page { display: flex; flex-direction: column; margin: 0 0 3em; min-height: 80vh; box-sizing: border-box; }
  .cv-kicker { font-family: var(--dt-head, inherit); font-weight: 700; font-size: 0.8em; letter-spacing: 0.16em; text-transform: uppercase; }
  .cv-title { font-family: var(--dt-head, inherit); font-weight: var(--dt-head-weight, 700); line-height: 1.08; margin: 0.25em 0 0.3em; border: 0 !important; padding: 0 !important; }
  .cv-sub { font-size: 1.3em; line-height: 1.3; }
  .cover-band .cv-band { background: var(--dt-accent-fill, #2563eb); color: #fff; display: flex; flex-direction: column; justify-content: flex-end; padding: 48px 40px; }
  .cover-band.at-top .cv-band { flex: 0 0 58%; } .cover-band.at-top .cv-rest { flex: 1; padding: 36px 40px; }
  .cover-band.at-bottom .cv-upper { flex: 0 0 62%; display: flex; flex-direction: column; justify-content: flex-end; padding: 48px 40px 32px; }
  .cover-band.at-bottom .cv-band { flex: 1; justify-content: flex-start; padding-top: 34px; }
  .cv-band .cv-kicker { color: rgba(255,255,255,0.72); } .cv-band .cv-sub { color: rgba(255,255,255,0.88); } .cv-band .cv-title { color: #fff; }
  .cv-upper .cv-kicker, .cover-title-block .cv-kicker { color: var(--dt-accent-ui, #2563eb); } .cv-upper .cv-sub, .cover-title-block .cv-sub { color: #52525b; }
  .cv-rule { width: 30mm; border-top: 4px solid var(--dt-accent-ui, #2563eb); margin-top: 16px; }
  .cv-logo { max-height: 70px; max-width: 200px; margin-bottom: 28px; align-self: flex-start; }
  table.cv-meta { border-collapse: collapse; width: 100%; table-layout: auto; font-size: 0.95em; }
  /* !important: the theme's banded-table rules would otherwise stripe the cover's metadata. */
  table.cv-meta td { border: 0; border-bottom: 1px solid #e4e4e7; padding: 7px 14px 7px 0 !important; vertical-align: top; background: none !important; }
  table.cv-meta td.k { font-size: 0.7em; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: #71717a; width: 34%; padding-top: 9px; }
  .cv-band table.cv-meta td { border-bottom-color: rgba(255,255,255,0.25); color: #fff; } .cv-band table.cv-meta td.k { color: rgba(255,255,255,0.72); }
  .cover-title-block .cv-bar { border-top: 9px solid var(--dt-accent-ui, #2563eb); padding-top: 10px; }
  .cover-title-block .cv-mid { margin-top: auto; margin-bottom: auto; } .cover-title-block table.cv-meta { margin-top: auto; }
  .masthead { background: var(--dt-accent-fill, #2563eb); color: #fff; padding: 20px 26px 22px; margin: 0 0 20px; }
  .masthead .cv-kicker { color: rgba(255,255,255,0.72); } .masthead .cv-title { color: #fff; margin: 0.15em 0 0; } .masthead .cv-sub { color: rgba(255,255,255,0.88); font-size: 1.1em; }
  table.ctl-box { width: 100%; table-layout: fixed; border-collapse: collapse; margin: 0 0 1.6em; font-size: 0.9em; }
  table.ctl-box td { border: 0; border-bottom: 1px solid #e4e4e7; padding: 6px 10px; } table.ctl-box td:not(.k) { background: none !important; }
  table.ctl-box td.k { background: var(--dt-tint, #f4f4f5); font-size: 0.72em; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #52525b; }
  .paper-title { text-align: center; border-bottom: 1px solid #a1a1aa; padding-bottom: 14px; margin: 0 0 26px; }
  .paper-title .cv-title { font-size: 1.9em; } .paper-title .pt-sub { font-style: italic; color: #3f3f46; } .paper-title .pt-meta { color: #52525b; font-size: 0.92em; }
  .front-title { margin-top: 0; }
  .front-label { font-weight: 700; font-size: 0.74em; letter-spacing: 0.1em; text-transform: uppercase; color: var(--dt-accent-ui, #2563eb); margin: 1.7em 0 0.5em; break-after: avoid; }
  table.front-grid { width: 100%; table-layout: fixed; } table.front-grid.sign td { height: 12mm; }
  .doc-history { margin-top: 2.4em; }
  nav.toc .tn { display: inline-block; min-width: 2.4em; color: var(--dt-accent-ui, #2563eb); font-variant-numeric: tabular-nums; }
  nav.toc .l2 .tn { min-width: 3em; } nav.toc .l3 .tn { min-width: 3.6em; }
  .body-start { position: absolute; color: #fff; font-size: 1px; }
`;

/** Point sizes and faces of the family, for the export page (screen and print). */
function blueprintCss(look: ResolvedLook, tablePt: number): string {
  const z = look.blueprint.sizes;
  return `
  body.bp { font-size: ${z.body}pt; line-height: 1.45; }
  body.bp .lv1 { font-size: ${z.h1}pt; } body.bp .lv2 { font-size: ${z.h2}pt; } body.bp .lv3 { font-size: ${z.h3}pt; } body.bp .lv4 { font-size: ${z.body + 1}pt; }
  body.bp h1.doc-title, body.bp .cv-title { font-size: ${z.title}pt; } body.bp .masthead .cv-title { font-size: ${Math.round(z.title * 0.8)}pt; }
  body.bp table { font-size: ${tablePt}pt; } body.bp nav.toc { font-size: ${z.body}pt; }`;
}

/** A CSS string literal. */
function cssStr(t: string): string {
  return `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;
}

/** Running text as a margin-box `content` value: `{page}` → the page counter, `{pages}` → the body's page count. */
function cssContent(t: string, pages: string): string {
  if (!t) return 'none';
  return t.split(/(\{page\}|\{pages\})/i).filter(Boolean)
    .map(p => (/^\{page\}$/i.test(p) ? 'counter(page)' : /^\{pages\}$/i.test(p) ? pages : cssStr(p))).join(' ');
}

interface Running { headLeft: string; headRight: string; footLeft: string; footRight: string }

/** The running header/footer slots, filled the way the Word writer fills them (`docx.ts`). */
export function runningText(s: DocSettings, look: ResolvedLook, values: Parameters<typeof expandFields>[1]): Running {
  const bp = look.blueprint;
  const letterhead = look.theme?.header === 'letterhead';
  const pageSlot = /\{page\}/i.test(s.footer ?? '') ? '' : s.pageNumbers ? (bp.footer?.right ?? 'Page {page} of {pages}') : '';
  return {
    headLeft: letterhead ? '' : s.header ? expandFields(s.header, values) : expandRunning(bp.header?.left, values),
    headRight: letterhead ? '' : expandRunning(bp.header?.right, values),
    footLeft: s.footer ? expandFields(s.footer, values) : expandRunning(bp.footer?.left, values),
    footRight: expandRunning(pageSlot, values),
  };
}

/**
 * Print rules: the page, its running header/footer as CSS margin boxes (so the
 * cover can have none), named pages for the cover (counters reset) and the
 * front matter (roman numbers), and the body's own page count — `bodyPages`
 * from the first pass, since `counter(pages)` counts the cover too.
 */
function printCss(s: DocSettings, look: ResolvedLook, plan: DocPlan, run: Running, bodyPages?: number): string {
  const page = PAGE_MM[s.pageSize] ?? PAGE_MM.A4;
  const [w, h] = s.orientation === 'landscape' ? [page.h, page.w] : [page.w, page.h];
  const m = s.margins;
  const pages = bodyPages ? cssStr(String(bodyPages)) : 'counter(pages)';
  const font = `7.5pt/1.25 ${look.fonts.body.css}`;
  const ruled = look.theme?.header === 'rule' || Boolean(look.blueprint.header);
  const box = (content: string, align: string, edge: 'top' | 'bottom', rule: boolean): string =>
    `content: ${content === 'none' && rule ? '""' : content}; font: ${font}; color: #71717a; text-align: ${align}; vertical-align: ${edge === 'top' ? 'bottom' : 'top'};`
    + ` padding-${edge === 'top' ? 'bottom' : 'top'}: 3mm;${rule ? ` border-${edge === 'top' ? 'bottom' : 'top'}: 0.5pt solid #d4d4d8;` : ''}`;
  const cls = look.classification ? cssStr(look.classification) : '';
  const headRule = ruled && Boolean(run.headLeft || run.headRight);
  const footRule = ruled && Boolean(run.footLeft || run.footRight);
  const center = (edge: 'top' | 'bottom', rule: boolean): string => (cls
    ? `content: ${cls}; font: 700 7pt/1.2 ${look.fonts.body.css}; letter-spacing: 0.14em; color: #b91c1c; text-align: center; vertical-align: ${edge === 'top' ? 'bottom' : 'top'}; padding-${edge === 'top' ? 'bottom' : 'top'}: 3mm;${rule ? ` border-${edge === 'top' ? 'bottom' : 'top'}: 0.5pt solid #d4d4d8;` : ''}`
    : rule ? `content: ""; border-${edge === 'top' ? 'bottom' : 'top'}: 0.5pt solid #d4d4d8;` : 'content: none;');
  const none = '@top-left { content: none; } @top-right { content: none; } @bottom-left { content: none; } @bottom-right { content: none; }'
    + (cls ? '' : ' @top-center { content: none; } @bottom-center { content: none; }');
  const usable = h - m.top - m.bottom;
  return `@page { size: ${w}mm ${h}mm; margin: ${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm;
    @top-left { ${box(cssContent(run.headLeft, pages), 'left', 'top', headRule)} }
    @top-center { ${run.headLeft || run.headRight ? (headRule ? 'content: ""; border-bottom: 0.5pt solid #d4d4d8;' : 'content: none;') : center('top', headRule)} }
    @top-right { ${box(cssContent(run.headRight, pages), 'right', 'top', headRule)} }
    @bottom-left { ${box(cssContent(run.footLeft, pages), 'left', 'bottom', footRule)} }
    @bottom-center { ${center('bottom', footRule)} }
    @bottom-right { ${box(cssContent(run.footRight, pages), 'right', 'bottom', footRule)} } }
  @page cover { counter-reset: page 0 fpage 0; ${none} }
  @page cover-bleed { margin: 0; counter-reset: page 0 fpage 0; ${none} }
  @page front { counter-increment: page 0 fpage 1; @bottom-left { content: none; }
    @bottom-right { ${box(s.pageNumbers ? 'counter(fpage, lower-roman)' : 'none', 'right', 'bottom', footRule)} } }
  @media print {
    html, body { margin: 0; } main { padding: 0; max-width: none; }
    /* A picture taller than the page is clipped by the printer; scale it to fit instead. */
    figure.visual svg, figure.visual img, figure img { max-height: ${Math.round(usable - 20)}mm; width: auto; }
    .cover { min-height: 0; height: ${usable - 8}mm; margin: 0; break-after: page; box-sizing: border-box; page: cover; }
    .cover-page { page: cover; height: ${usable}mm; min-height: 0; margin: 0; overflow: hidden; }
    .cover-page.bleed { page: cover-bleed; height: ${h}mm; width: ${w}mm; }
    .cover-page.cover-band .cv-band, .cover-page.cover-band .cv-rest, .cover-page.cover-band .cv-upper { padding-left: 20mm; padding-right: 20mm; }
    .front-page { page: front; break-after: page; }
    .doc-body { page: body; }
    ${plan.h1PageBreak ? '.doc-body .lv1, .doc-body .h1-break { break-before: page; }' : ''}
    .classification { display: none; }
    nav.toc { break-after: ${look.blueprint.front.tocPage || look.blueprint.id === 'general' ? 'page' : 'auto'}; }
    pre, img, svg, figure, .tblock.short, .tblock.short > table { break-inside: avoid; }
    tr { break-inside: avoid; } thead { display: table-header-group; }
    /* A heading stays with what follows (keepHeadingsWithNext); before a long block it reserves room under itself. */
    /* Monolithic, so Chrome moves the group whole (it ignored break-inside: avoid between a heading and a table). */
    .keep { display: inline-block; width: 100%; vertical-align: top; }
    [data-kn] { break-inside: avoid; } [data-kn]::after { content: ""; display: block; height: 32mm; margin-bottom: -32mm; } }`;
}

export interface HtmlBuild {
  title: string;
  markdown: string;
  settings: DocSettings;
  /** What the document stores (a cover it asked for is drawn even for a short document). */
  stored?: Partial<DocSettings>;
  resolveImage: ImageResolver;
  visuals: Map<string, RenderedVisual>;
  date?: Date;
  print?: boolean;
  /** Heading id → body page number, for the PDF's second pass. */
  pageNumbers?: Map<string, number>;
  /** Pages in the body, from the first pass ("Page 3 of 40" counts the body, as Word's SECTIONPAGES does). */
  bodyPages?: number;
  /** Lay out as Word paginates (for the .docx TOC's page estimates), not as the PDF keeps headings with tables. */
  wordLike?: boolean;
}

function tocHtml(plan: DocPlan, pages: Map<string, number> | undefined, print: boolean): string {
  const entries = plan.headings.filter(h => !h.isTitle && h.level <= 3);
  if (!entries.length) return '';
  return `<nav class="toc"><div class="toc-title">Contents</div><ol>${entries.map((h, i) => {
    const pg = print ? `<span class="dots"></span><span class="pg">${pages?.get(h.info.id) ?? ''}</span>` : '';
    const end = i === entries.length - 1 && print && !pages ? '<span class="toc-end">aico-toc-end</span>' : '';
    const num = h.label ? `<span class="tn">${esc(h.label)}</span>` : '';
    return `<li class="l${h.appendix ? 1 : h.level}">${num}<a href="#${esc(h.info.id)}">${esc(h.text)}</a>${pg}${end}</li>`;
  }).join('')}</ol></nav>`;
}

function metaRows(pairs: [string, string][]): string {
  return pairs.length ? `<table class="cv-meta">${pairs.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>` : '';
}

function coverPairs(f: FrontModel): [string, string][] {
  const v = f.values;
  return ([
    ['Prepared for', v.client], ['Prepared by', v.preparedBy], ['Date', f.date],
    ['Version', [v.version, v.status].filter(Boolean).join(' · ')], ['Reference', v.reference], ['Classification', v.classification],
  ] as [string, string][]).filter(([, x]) => x.trim());
}

function gridHtml(head: string[], rows: string[][], shares: number[], sign = false): string {
  return `<table class="fit front-grid${sign ? ' sign' : ''}"><colgroup>${shares.map(x => `<col style="width:${(x * 100).toFixed(1)}%">`).join('')}</colgroup>`
    + `<thead><tr>${head.map(x => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(x => `<td>${esc(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

/** The family's cover page, as the Word writer draws it (`docx.ts` bandCover / titleBlockCover). */
function coverPageHtml(look: ResolvedLook, f: FrontModel, logo: string | undefined | null): string {
  const bp = look.blueprint;
  const lg = logo ? `<img class="cv-logo" src="${esc(logo)}" alt="Logo">` : '';
  const head = `<div class="cv-kicker">${esc(f.kicker)}</div><h1 class="cv-title">${esc(f.title)}</h1>${f.subtitle ? `<div class="cv-sub">${esc(f.subtitle)}</div>` : ''}`;
  if (bp.cover === 'band' && bp.band === 'bottom') {
    return `<section class="cover-page cover-band at-bottom bleed"><div class="cv-upper">${lg}${head}<div class="cv-rule"></div></div>`
      + `<div class="cv-band">${metaRows(coverPairs(f))}</div></section>`;
  }
  if (bp.cover === 'band') {
    return `<section class="cover-page cover-band at-top bleed"><div class="cv-band">${lg}${head}</div><div class="cv-rest">${metaRows(coverPairs(f))}</div></section>`;
  }
  return `<section class="cover-page cover-title-block"><div class="cv-bar"><div class="cv-kicker">${esc(f.kicker)}</div></div>`
    + `<div class="cv-mid">${lg}<h1 class="cv-title">${esc(f.title)}</h1>${f.subtitle ? `<div class="cv-sub">${esc(f.subtitle)}</div>` : ''}</div>${metaRows(coverPairs(f))}</section>`;
}

function controlPageHtml(look: ResolvedLook, f: FrontModel): string {
  return `<section class="front-page doc-control"><h2 class="front-title">Document control</h2>`
    + `<div class="front-label">Document information</div>${metaRows([['Title', f.title], ...f.info])}`
    + `<div class="front-label">Revision history</div>${gridHtml(['Version', 'Date', 'Author', 'Description'], f.revisions, [0.12, 0.2, 0.22, 0.46])}`
    + (f.approvals.length ? `<div class="front-label">Approvals</div>${gridHtml(['Name', 'Role', 'Signature', 'Date'], f.approvals, [0.27, 0.27, 0.28, 0.18], true)}` : '')
    + (f.distribution.length && look.blueprint.front.distribution ? `<div class="front-label">Distribution</div>${gridHtml(['Name', 'Organisation', 'Role'], f.distribution, [0.34, 0.33, 0.33])}` : '')
    + '</section>';
}

function controlBoxHtml(f: FrontModel): string {
  const v = f.values;
  const pairs = ([
    ['Reference', v.reference], ['Version', v.version], ['Status', v.status], ['Owner', f.info.find(([k]) => k === 'Owner')?.[1] ?? v.preparedBy],
    ['Effective', f.date], ['Classification', v.classification],
  ] as [string, string][]).filter(([, x]) => x.trim());
  const rows: string[] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const cell = (p?: [string, string]): string => (p ? `<td class="k">${esc(p[0])}</td><td>${esc(p[1])}</td>` : '<td class="k"></td><td></td>');
    rows.push(`<tr>${cell(pairs[i])}${cell(pairs[i + 1])}</tr>`);
  }
  return `<table class="ctl-box"><colgroup><col style="width:15%"><col style="width:35%"><col style="width:15%"><col style="width:35%"></colgroup>${rows.join('')}</table>`;
}

/** Too long to keep on one page with its heading: a long table, list or code block (it breaks across pages instead). */
function isLong(n: RootContent): boolean {
  if (n.type === 'table') return n.children.length > 12;
  if (n.type === 'list') return n.children.length > 10;
  if (n.type === 'code') return !visualForCode(n.lang, n.value) && n.value.split('\n').length > 25;
  // A group is moved whole and cannot itself break, so it must stay well under a page.
  if (n.type === 'paragraph' || n.type === 'blockquote') return plainText(n as never).length > 1200;
  return false;
}

/**
 * The body, with each heading kept on the page of what follows it. Chrome does
 * not honour `break-after: avoid` before a table or a figure, and the usual
 * trick (a heading reserving space under itself) defeats a short table's own
 * `break-inside: avoid`. So a run of headings and the block after them go in
 * one unbreakable group; before a long block, the heading reserves room instead.
 */
function keepHeadingsWithNext(nodes: RootContent[], ctx: HtmlCtx): string {
  const out: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i]!.type !== 'heading') { const h = blockHtml(nodes[i]!, ctx); if (h) out.push(h); continue; }
    const group: string[] = [];
    while (i < nodes.length && nodes[i]!.type === 'heading') group.push(blockHtml(nodes[i++]!, ctx));
    // Skip what renders as nothing (a consumed caption, a comment) to find the block the headings introduce.
    let next = '';
    while (i < nodes.length && nodes[i]!.type !== 'heading' && !(next = blockHtml(nodes[i]!, ctx))) i++;
    if (!next) { out.push(...group); i--; continue; }
    if (isLong(nodes[i]!)) out.push(...group.map((g, k) => (k === group.length - 1 ? g.replace(/^<h(\d)/, '<h$1 data-kn') : g)), next);
    // A group is an inline block, where break-before does not apply: a section's page break goes in front of it.
    else out.push(`${/class="lv1\b/.test(group[0] ?? '') ? '<div class="h1-break"></div>' : ''}<div class="keep">${group.join('\n')}\n${next}</div>`);
  }
  return out.filter(Boolean).join('\n');
}

/** Build the standalone HTML (also the PDF's source). */
export async function buildHtml(input: HtmlBuild): Promise<string> {
  const s = input.settings;
  const tree = parseMarkdown(input.markdown);
  const headings = collectHeadings(tree);
  const look = resolveLook(s);
  const bp = look.blueprint;
  const plain = bp.id === 'general' && !look.theme;
  const tablePt = Math.max(8.5, bp.sizes.body - 1);
  // Planned on this parse: the plan's maps are keyed by this tree's nodes.
  const plan = planDocument(tree, { title: input.title, settings: s, headings, ...(input.stored ? { stored: input.stored } : {}), capacity: htmlCapacity(s, tablePt) });
  const date = (input.date ?? new Date()).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const f = frontModel(plan, s, input.title, date);
  const cover = plan.coverPage && Boolean(s.cover?.enabled);
  const images = await loadImages(tree, input.resolveImage, s.cover?.enabled && s.cover?.logo ? [s.cover.logo] : []);
  const toc = tocHtml(plan, input.pageNumbers, Boolean(input.print));
  const ctx: HtmlCtx = { images, visuals: input.visuals, headingIds: new Map(headings.map(h => [h.node, h])), tocHtml: toc, plan, titleShown: false };
  const { attrs, vars } = themeAttrs(look);
  // Numbers are written into the headings (`.hnum`), so the editor's counters are off here.
  delete attrs['data-dt-numbered'];
  const letterhead = look.theme?.header === 'letterhead';
  let front = '';
  let top = '';
  if (letterhead && s.header) {
    top += `<header class="letterhead"><div class="lh-name">${esc(expandFields(s.header, { title: input.title, date }).replace(/\{page\}|\{pages\}/gi, ''))}</div>`
      + `<div class="lh-date">${esc(date)}</div></header>\n`;
  }
  const logo = s.cover?.logo ? images.get(s.cover.logo) : undefined;
  if (cover) {
    ctx.titleShown = true;
    if (bp.cover === 'band' || bp.cover === 'title-block') front += coverPageHtml(look, f, logo);
    else {
      const c = s.cover!;
      front += `<section class="cover${look.theme ? ` cover-${look.theme.cover}` : ''}">${logo ? `<img class="logo" src="${esc(logo)}" alt="Logo">` : ''}`
        + `<h1 class="cover-title">${esc(c.title ?? input.title)}</h1>${c.subtitle ? `<div class="subtitle">${esc(c.subtitle)}</div>` : ''}`
        + `<div class="rule"></div>${c.author ? `<div class="meta">${esc(c.author)}</div>` : ''}<div class="meta">${esc(c.date ?? date)}</div></section>\n`;
    }
    if (plan.control === 'page') front += controlPageHtml(look, f);
    if (plan.tocFront) front += `<section class="front-page">${toc}</section>`;
  } else {
    const masthead = (bp.cover === 'masthead' || bp.cover === 'academic') && !plan.ownCover;
    if (bp.cover === 'masthead' && masthead) {
      top += `<header class="masthead">${f.kicker ? `<div class="cv-kicker">${esc(f.kicker)}</div>` : ''}<h1 class="cv-title">${esc(f.title)}</h1>`
        + `${f.subtitle ? `<div class="cv-sub">${esc(f.subtitle)}</div>` : ''}</header>\n`;
      ctx.titleShown = true;
    } else if (bp.cover === 'academic' && masthead) {
      const author = s.cover?.author ?? f.values.preparedBy;
      top += `<header class="paper-title"><h1 class="cv-title">${esc(f.title)}</h1>${f.subtitle ? `<div class="pt-sub">${esc(f.subtitle)}</div>` : ''}`
        + `${author ? `<div class="pt-meta">${esc(author)}</div>` : ''}<div class="pt-meta">${esc(f.date)}</div></header>\n`;
      ctx.titleShown = true;
    } else if ((bp.cover === 'band' || bp.cover === 'title-block') && !plan.ownCover) {
      const meta = coverPairs(f).filter(([k]) => k !== 'Classification');
      top += `<h1 class="doc-title">${esc(input.title)}</h1>${meta.length ? `<p class="running">${meta.map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ')}</p>` : ''}\n`;
      ctx.titleShown = true;
    } else if (!plan.ownCover && !opensWithH1(tree, input.title) && input.title) {
      top += `<h1 class="doc-title">${esc(input.title)}</h1>\n`;
      ctx.titleShown = true;
    }
    if (plan.control === 'inline') top += controlBoxHtml(f);
    if (plan.tocFront) top += toc;
  }
  // Laid out for Word's page numbers, headings flow as Word flows them (keep-with-next only): no monolithic groups.
  const body = input.wordLike ? tree.children.map(n => blockHtml(n, ctx)).filter(Boolean).join('\n') : keepHeadingsWithNext(tree.children, ctx);
  const history = plan.control === 'inline'
    ? `<section class="doc-history"><h2 class="front-title">Document history</h2>${gridHtml(['Version', 'Date', 'Author', 'Description'], f.revisions, [0.12, 0.2, 0.22, 0.46])}`
      + (f.approvals.length ? `<div class="front-label">Approvals</div>${gridHtml(['Name', 'Role', 'Signature', 'Date'], f.approvals, [0.27, 0.27, 0.28, 0.18], true)}` : '') + '</section>'
    : '';
  // Outside print, the running header/footer has nowhere to go; show them once, top and bottom.
  const values = { title: input.title, date, ...f.values };
  const run = runningText(s, look, values);
  const strip = (t: string): string => t.replace(/\s*(Page\s*)?\{page\}(\s*of\s*\{pages\})?/gi, '').replace(/\{pages\}/gi, '').trim();
  const screenHeader = !input.print && (run.headLeft || run.headRight) ? `<div class="running">${esc([run.headLeft, run.headRight].map(strip).filter(Boolean).join(' · '))}</div>` : '';
  const screenFooter = !input.print && strip(run.footLeft) ? `<div class="running">${esc(strip(run.footLeft))}</div>` : '';
  const banner = (where: string): string => (look.classification ? `<div class="classification ${where}">${esc(look.classification)}</div>` : '');
  // Sized to the text so a long mark still fits the page diagonally.
  const watermark = s.watermark
    ? `<div class="watermark" style="font-size:${Math.max(28, Math.min(96, Math.round(760 / s.watermark.length)))}px">${esc(s.watermark)}</div>` : '';
  const bodyAttrs = [` class="${[s.font === 'serif' ? 'serif' : '', plain ? '' : 'bp'].filter(Boolean).join(' ')}"`,
    ...Object.entries(attrs).map(([k, v]) => ` ${k}="${esc(v)}"`),
    look.theme || s.accent || !plain ? ` style="${esc(styleText(vars))}"` : ''].join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.title)}</title>
<style>${CSS}${DESIGN_CSS}${plain ? '' : blueprintCss(look, tablePt)}
  :root { --font: ${look.fonts.body.css}; }
  .running { color: #71717a; font-size: 0.85em; margin: 0 0 1.5em; }
  ${input.print ? printCss(s, look, plan, run, input.bodyPages) : ''}</style>
</head>
<body${bodyAttrs}>
${watermark}
<main>
${banner('top')}${front}<div class="doc-body"><span class="body-start">aico-body-start</span>
${screenHeader}${top}${body}${history}
${screenFooter}</div>${banner('bottom')}
</main>
</body>
</html>
`;
}

/** Characters of table text across the page's text width (the HTML table gets the Word table's shares). */
function htmlCapacity(s: DocSettings, pt: number): number {
  const page = PAGE_MM[s.pageSize] ?? PAGE_MM.A4;
  const w = (s.orientation === 'landscape' ? page.h : page.w) - s.margins.left - s.margins.right;
  return tableCapacity(Math.round(w * 1440 / 25.4), pt);
}

/** Back-compat: the plain HTML export with default settings and no visuals pass. */
export async function toHtml(title: string, markdown: string, resolve: ImageResolver): Promise<string> {
  return buildHtml({ title, markdown, settings: resolveSettings(undefined), resolveImage: resolve, visuals: new Map() });
}

// ── PDF ─────────────────────────────────────────────────────────────

async function printPdf(browser: ExportBrowser, html: string, timeout: number): Promise<Buffer> {
  const page = await browser.browser.newPage();
  try {
    await page.route('**/*', route => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
    await page.setContent(html, { waitUntil: 'load', timeout });
    // The running header/footer are CSS margin boxes (`printCss`): the cover gets none, the front matter roman numbers.
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false, outline: true, tagged: true });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Which page each heading starts on, read from a printed PDF. */
export async function headingPages(pdf: Buffer, headings: HeadingInfo[]): Promise<Map<string, number>> {
  return (await pdfLayout(pdf, headings.map(h => ({ id: h.id, text: h.text, depth: h.depth })), false)).pages;
}

/**
 * Where things landed in a printed PDF: each heading's page counted from the
 * body's first page (the `aico-body-start` marker — cover and front matter are
 * not counted, as in Word, whose body is its own section numbered from 1),
 * and how many pages the body has. Headings are searched in order, after the
 * page that ends the TOC (whose entries repeat every heading's text).
 */
export async function pdfLayout(pdf: Buffer, headings: { id: string; text: string; depth: number }[], fromBody = true):
  Promise<{ pages: Map<string, number>; bodyPages: number; bodyStart: number }> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(pdf) });
  const out = new Map<string, number>();
  try {
    const result = await parser.getText();
    const norm = (t: string): string => t.replace(/\s+/g, ' ').toLowerCase();
    const pages = result.pages.map(p => ({ num: p.num, text: norm(p.text) }));
    const tocEnd = pages.findIndex(p => p.text.includes('aico-toc-end'));
    const marker = pages.findIndex(p => p.text.includes('aico-body-start'));
    const bodyStart = fromBody && marker >= 0 ? marker : 0;
    let from = Math.max(bodyStart, tocEnd >= 0 ? tocEnd : 0);
    const count = (text: string, want: string): number => text.split(want).length - 1;
    for (const h of headings.filter(x => x.depth <= 3)) {
      const want = norm(h.text);
      for (let i = from; i < pages.length; i++) {
        // The page the TOC ends on lists every heading once already (and the marker's place in the text
        // stream is not reliable): a heading starts there only if its text is there twice.
        if (count(pages[i]!.text, want) >= (i === tocEnd ? 2 : 1)) { out.set(h.id, pages[i]!.num - (fromBody ? pages[bodyStart]!.num - 1 : 0)); from = i; break; }
      }
    }
    return { pages: out, bodyPages: pages.length - bodyStart, bodyStart };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/** Print the document, read where its headings landed, print again with the TOC page numbers and the body's page count filled in. */
async function printTwice(b: ExportBrowser, base: HtmlBuild, plan: DocPlan, timeout: number):
  Promise<{ pdf: Buffer; pages?: Map<string, number>; bodyPages?: number }> {
  const first = await printPdf(b, await buildHtml({ ...base, print: true }), timeout);
  const wantsSecond = plan.tocFront || plan.tocAtMarker || plan.coverPage;
  if (!wantsSecond) return { pdf: first };
  // Searched with its number ("3 Procedure"), as the heading prints: the bare word also turns up in running heads and titles.
  const searchable = plan.headings.filter(h => !h.isTitle)
    .map(h => ({ id: h.info.id, text: h.label ? `${h.label}${h.appendix ? ' —' : ''} ${h.text}` : h.text, depth: Math.min(3, h.level) }));
  const layout = await pdfLayout(first, searchable).catch(() => undefined);
  if (!layout) return { pdf: first };
  const second = await printPdf(b, await buildHtml({ ...base, print: true, pageNumbers: layout.pages, bodyPages: layout.bodyPages }), timeout);
  return { pdf: second, pages: layout.pages, bodyPages: layout.bodyPages };
}

// ── Orchestration ───────────────────────────────────────────────────

export interface ExportInput {
  format: ExportFormat;
  tab?: string;
  resolveImage: ImageResolver;
  /** Settings for this file only, merged over the stored ones (not saved). */
  settings?: unknown;
  /** Shorthand for settings.toc. */
  toc?: boolean;
  date?: Date;
  timeoutMs?: number;
}

function markdownToc(headings: HeadingInfo[]): string {
  return ['**Contents**', '', ...headings.filter(h => h.depth <= 3).map(h => `${'  '.repeat(h.depth - 1)}- [${h.text}](#${h.id})`)].join('\n');
}

/** Produce the bytes of an export. */
export async function exportCanvas(doc: CanvasDoc, input: ExportInput): Promise<ExportResult> {
  if (!EXPORT_FORMATS.includes(input.format)) {
    throw new Error(`format must be one of ${EXPORT_FORMATS.join(', ')}`);
  }
  const override = { ...(input.settings && typeof input.settings === 'object' ? input.settings as object : {}), ...(input.toc !== undefined ? { toc: input.toc } : {}) };
  const settings = resolveSettings(doc.docSettings, Object.keys(override).length ? override : undefined);
  const stored = Object.keys(override).length ? mergeSettings(doc.docSettings, override) : (doc.docSettings ?? {});
  const source = exportSource(doc, input.tab);
  const title = source.title;
  const markdown = input.format === 'md' ? source.markdown : normalizeAlternateSyntax(source.markdown);
  const fileName = `${fileBase(title)}.${input.format}`;
  const mediaType = EXPORT_MEDIA[input.format];
  const date = input.date ?? new Date();
  const tree = parseMarkdown(markdown);
  const headings = collectHeadings(tree);

  if (input.format === 'md') {
    let text = markdown;
    if (hasTocMarker(tree)) text = text.replace(/^\s*<!--\s*aico:toc\s*-->\s*$/im, markdownToc(headings));
    else if (settings.toc) text = `${markdownToc(headings)}\n\n${text}`;
    const withTitle = opensWithH1(tree, title) || !title ? text : `# ${title}\n\n${text}`;
    return { bytes: Buffer.from(withTitle.replace(/\s*$/, '\n'), 'utf8'), fileName, mediaType, warnings: [] };
  }

  const look = resolveLook(settings);
  const tablePt = Math.max(8.5, look.blueprint.sizes.body - 1);
  const plan = planDocument(tree, { title, settings, stored, headings, capacity: htmlCapacity(settings, tablePt) });
  const jobs = collectVisuals(tree);
  let browser: ExportBrowser | { error: string } | undefined;
  const getBrowser = async (): Promise<ExportBrowser | { error: string }> => (browser ??= await launchExportBrowser(input.timeoutMs));
  if (input.format === 'pdf') await getBrowser();
  if (input.format === 'pdf' && browser && 'error' in browser) {
    throw new Error(`PDF export needs Google Chrome or Microsoft Edge installed, and ${browser.error}. `
      + 'Export as docx or html instead (html can be printed to PDF from any browser).');
  }
  try {
    const visuals = await renderVisuals(jobs, getBrowser, { needPng: input.format === 'docx' });
    const warnings = [...visuals.values()].filter(v => v.error).map(v => v.error!);
    const timeout = input.timeoutMs ?? 60_000;
    const base = { title, markdown, settings, stored, resolveImage: input.resolveImage, visuals, date };
    switch (input.format) {
      case 'html': {
        const html = await buildHtml(base);
        return { bytes: Buffer.from(html, 'utf8'), fileName, mediaType, warnings };
      }
      case 'docx': {
        // The TOC's page numbers: print the same layout once and read where each heading landed.
        let pageNumbers: Map<string, number> | undefined;
        if (plan.tocFront || plan.tocAtMarker) {
          const b = await getBrowser();
          if (!('error' in b)) {
            const printed = await printTwice(b, { ...base, wordLike: true }, plan, timeout).catch(() => undefined);
            pageNumbers = printed?.pages;
          }
        }
        const bytes = await toDocx({
          title, tree, showTitle: !opensWithH1(tree, title), resolveImage: input.resolveImage, date, settings, stored, visuals, headings, plan,
          ...(pageNumbers ? { pageNumbers } : {}),
        });
        return { bytes: Buffer.from(bytes), fileName, mediaType, warnings };
      }
      case 'pdf': {
        const printed = await printTwice(browser as ExportBrowser, base, plan, timeout);
        const wantsToc = plan.tocFront || plan.tocAtMarker;
        return {
          bytes: printed.pdf, fileName, mediaType, warnings,
          ...(wantsToc ? { tocPageNumbers: Boolean(printed.pages && printed.pages.size > 0) } : {}),
        };
      }
    }
  } finally {
    const opened = browser as ExportBrowser | { error: string } | undefined;
    if (opened && !('error' in opened)) await opened.close();
  }
  throw new Error('unreachable');
}
