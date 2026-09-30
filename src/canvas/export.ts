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
 *   Limit: Chromium applies the running header/footer to every page, the cover
 *   included.
 *
 * No browser: md and html still work (charts as SVG, diagrams/maths as
 * labelled placeholders with their source); docx works with placeholders for
 * every visual; pdf fails with a message naming the alternatives. Every
 * network request from the print page is refused.
 *
 * A document with several tabs exports whole (each tab under its own
 * top-level heading) unless one tab is named.
 *
 * @module canvas/export
 */

import type { Nodes, Paragraph, PhrasingContent, Root, RootContent, Table } from 'mdast';
import type { CanvasDoc } from './store.js';
import { stripPending } from './sections.js';
import { toDocx } from './docx.js';
import { fileBase, parseMarkdown, type ImageResolver } from './markdown.js';
import { PAGE_MM, expandFields, resolveSettings, type DocSettings } from './doc-settings.js';
import { collectHeadings, hasTocMarker, isTocMarker, plainText, type HeadingInfo } from './doc-model.js';
import {
  INFOGRAPHIC_CSS, infographicHtml, infographicKind, normalizeAlternateSyntax, parseImageAttrs, parseInfographic, type ImageAttrs,
} from './infographics.js';
import {
  collectVisuals, launchExportBrowser, renderVisuals, visualForCode, visualKey,
  type ExportBrowser, type RenderedVisual,
} from './visuals.js';

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
 * the title that way.
 */
function opensWithH1(tree: Root, title: string): boolean {
  const first = tree.children.find(n => n.type !== 'html' && n.type !== 'definition');
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
  const rows = n.children.map((row, ri) => {
    const tag = ri === 0 ? 'th' : 'td';
    const cells = row.children.map((cell, ci) => {
      const a = align[ci] ? ` style="text-align:${align[ci]}"` : '';
      return `<${tag}${a}>${inlineHtml(cell.children, ctx)}</${tag}>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  });
  const [head, ...body] = rows;
  return `<table><thead>${head ?? ''}</thead><tbody>${body.join('')}</tbody></table>`;
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
  return `<figure class="align-${attrs.align ?? 'center'}">${imageHtml(img, ctx, attrs)}`
    + `${img.title ? `<figcaption>${esc(img.title)}</figcaption>` : ''}</figure>`;
}

function visualHtml(kind: 'chart' | 'diagram' | 'math', source: string, ctx: HtmlCtx): string {
  const v = ctx.visuals.get(visualKey(kind, source));
  if (v && !v.error) {
    if (v.svg && kind !== 'math') return `<figure class="visual visual-${kind}">${v.svg}</figure>`;
    if (v.png) return `<figure class="visual visual-${kind}"><img src="${dataPng(v.png)}" style="width:${v.width}px;max-width:100%" alt="${kind}"></figure>`;
  }
  if (v?.svg && kind === 'chart') return `<figure class="visual visual-chart">${v.svg}</figure>`;
  const label = kind === 'chart' ? 'Chart' : kind === 'diagram' ? 'Diagram' : 'Formula';
  return `<div class="visual-missing"><div>${label} not rendered${v?.error ? ` — ${esc(v.error)}` : ''}. Source:</div><pre><code>${esc(source)}</code></pre></div>`;
}

function markdownToHtmlFragment(source: string, ctx: HtmlCtx): string {
  return parseMarkdown(source).children.map(n => blockHtml(n, ctx)).join('\n');
}

function blockHtml(n: RootContent | Nodes, ctx: HtmlCtx): string {
  switch (n.type) {
    case 'heading': {
      const inner = inlineHtml(n.children, ctx);
      const info = ctx.headingIds.get(n);
      return `<h${n.depth}${info ? ` id="${esc(info.id)}"` : ''}>${inner}</h${n.depth}>`;
    }
    case 'paragraph': return figureHtml(n, ctx) ?? `<p>${inlineHtml(n.children, ctx)}</p>`;
    case 'thematicBreak': return '<hr>';
    case 'blockquote': return `<blockquote>${n.children.map(c => blockHtml(c, ctx)).join('\n')}</blockquote>`;
    case 'math': return visualHtml('math', n.value, ctx);
    case 'code': {
      const visual = visualForCode(n.lang, n.value);
      if (visual && visual.kind !== 'math-inline') return visualHtml(visual.kind, visual.source, ctx);
      const ig = infographicKind(n.lang);
      if (ig) {
        const parsed = parseInfographic(ig, n.value, n.meta);
        if (parsed.ok) return infographicHtml(parsed.value, md => markdownToHtmlFragment(md, ctx));
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
      if (isTocMarker(n)) return ctx.tocHtml;
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
`;

function printCss(s: DocSettings): string {
  const page = PAGE_MM[s.pageSize] ?? PAGE_MM.A4;
  const [w, h] = s.orientation === 'landscape' ? [page.h, page.w] : [page.w, page.h];
  return `@page { size: ${w}mm ${h}mm; margin: ${s.margins.top}mm ${s.margins.right}mm ${s.margins.bottom}mm ${s.margins.left}mm; }
  @media print { main { padding: 0; max-width: none; }
    /* A picture taller than the page is clipped by the printer; scale it to fit instead (the live check's flowchart was). */
    figure.visual svg, figure.visual img, figure img { max-height: ${Math.round(h - s.margins.top - s.margins.bottom - 20)}mm; width: auto; } .cover { min-height: 0; height: ${h - s.margins.top - s.margins.bottom - 8}mm; margin: 0; break-after: page; }
    nav.toc { break-after: page; } pre, table, img, svg, figure { break-inside: avoid; } }`;
}

export interface HtmlBuild {
  title: string;
  markdown: string;
  settings: DocSettings;
  resolveImage: ImageResolver;
  visuals: Map<string, RenderedVisual>;
  date?: Date;
  print?: boolean;
  /** Heading id → page number, for the PDF's second pass. */
  pageNumbers?: Map<string, number>;
}

function tocHtml(headings: HeadingInfo[], pages: Map<string, number> | undefined, print: boolean): string {
  const entries = headings.filter(h => h.depth <= 3);
  if (!entries.length) return '';
  return `<nav class="toc"><div class="toc-title">Contents</div><ol>${entries.map((h, i) => {
    const pg = print ? `<span class="dots"></span><span class="pg">${pages?.get(h.id) ?? (pages ? '' : '')}</span>` : '';
    const end = i === entries.length - 1 && print && !pages ? '<span class="toc-end">aico-toc-end</span>' : '';
    return `<li class="l${h.depth}"><a href="#${esc(h.id)}">${esc(h.text)}</a>${pg}${end}</li>`;
  }).join('')}</ol></nav>`;
}

/** Build the standalone HTML (also the PDF's source). */
export async function buildHtml(input: HtmlBuild): Promise<string> {
  const s = input.settings;
  const tree = parseMarkdown(input.markdown);
  const headings = collectHeadings(tree);
  const cover = Boolean(s.cover?.enabled);
  const images = await loadImages(tree, input.resolveImage, cover && s.cover?.logo ? [s.cover.logo] : []);
  const toc = tocHtml(headings, input.pageNumbers, Boolean(input.print));
  const ctx: HtmlCtx = { images, visuals: input.visuals, headingIds: new Map(headings.map(h => [h.node, h])), tocHtml: toc };
  const body = tree.children.map(n => blockHtml(n, ctx)).filter(Boolean).join('\n');
  const date = (input.date ?? new Date()).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  let top = '';
  if (cover) {
    const c = s.cover!;
    const logo = c.logo ? images.get(c.logo) : undefined;
    top = `<section class="cover">${logo ? `<img class="logo" src="${esc(logo)}" alt="Logo">` : ''}`
      + `<h1 class="cover-title">${esc(c.title ?? input.title)}</h1>${c.subtitle ? `<div class="subtitle">${esc(c.subtitle)}</div>` : ''}`
      + `<div class="rule"></div>${c.author ? `<div class="meta">${esc(c.author)}</div>` : ''}<div class="meta">${esc(c.date ?? date)}</div></section>\n`;
  } else if (!opensWithH1(tree, input.title) && input.title) {
    top = `<h1>${esc(input.title)}</h1>\n`;
  }
  if (s.toc && !hasTocMarker(tree)) top += toc;
  // Outside print, the running header/footer has nowhere to go; show them once, top and bottom.
  const values = { title: input.title, date };
  const screenHeader = !input.print && s.header ? `<div class="running">${esc(expandFields(s.header, values).replace(/\{page\}|\{pages\}/gi, ''))}</div>` : '';
  const screenFooter = !input.print && s.footer ? `<div class="running">${esc(expandFields(s.footer, values).replace(/\{page\}|\{pages\}/gi, ''))}</div>` : '';
  // Sized to the text so a long mark still fits the page diagonally.
  const watermark = s.watermark
    ? `<div class="watermark" style="font-size:${Math.max(28, Math.min(96, Math.round(760 / s.watermark.length)))}px">${esc(s.watermark)}</div>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.title)}</title>
<style>${CSS}
  .running { color: #71717a; font-size: 0.85em; margin: 0 0 1.5em; }
  ${input.print ? printCss(s) : ''}</style>
</head>
<body${s.font === 'serif' ? ' class="serif"' : ''}>
${watermark}
<main>
${screenHeader}${top}${body}
${screenFooter}
</main>
</body>
</html>
`;
}

/** Back-compat: the plain HTML export with default settings and no visuals pass. */
export async function toHtml(title: string, markdown: string, resolve: ImageResolver): Promise<string> {
  return buildHtml({ title, markdown, settings: resolveSettings(undefined), resolveImage: resolve, visuals: new Map() });
}

// ── PDF ─────────────────────────────────────────────────────────────

function hfTemplate(text: string | undefined, values: { title: string; date: string }, pageNumbers: boolean, isFooter: boolean): string {
  const expand = (t: string): string => esc(expandFields(t, values))
    .replace(/\{page\}/gi, '<span class="pageNumber"></span>').replace(/\{pages\}/gi, '<span class="totalPages"></span>');
  const left = text ? expand(text) : '';
  const right = isFooter && pageNumbers && !/\{page\}/i.test(text ?? '')
    ? 'Page <span class="pageNumber"></span> of <span class="totalPages"></span>' : '';
  return `<div style="font: 8.5px -apple-system, 'Segoe UI', sans-serif; color: #71717a; width: 100%; padding: 0 14mm; display: flex; justify-content: space-between;">`
    + `<span>${left}</span><span>${right}</span></div>`;
}

async function printPdf(browser: ExportBrowser, html: string, s: DocSettings, values: { title: string; date: string }, timeout: number): Promise<Buffer> {
  const page = await browser.browser.newPage();
  try {
    await page.route('**/*', route => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
    await page.setContent(html, { waitUntil: 'load', timeout });
    const header = Boolean(s.header);
    const footer = Boolean(s.footer) || s.pageNumbers;
    const pdf = await page.pdf({
      preferCSSPageSize: true, printBackground: true,
      displayHeaderFooter: header || footer,
      headerTemplate: header ? hfTemplate(s.header, values, false, false) : '<span></span>',
      footerTemplate: footer ? hfTemplate(s.footer, values, s.pageNumbers, true) : '<span></span>',
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Which page each heading starts on, read from a printed PDF. */
export async function headingPages(pdf: Buffer, headings: HeadingInfo[]): Promise<Map<string, number>> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(pdf) });
  const out = new Map<string, number>();
  try {
    const result = await parser.getText();
    const norm = (t: string): string => t.replace(/\s+/g, ' ').toLowerCase();
    const pages = result.pages.map(p => ({ num: p.num, text: norm(p.text) }));
    // Everything up to the page carrying the end-of-TOC marker lists every heading; search after it.
    const tocEnd = pages.findIndex(p => p.text.includes('aico-toc-end'));
    let from = tocEnd >= 0 ? tocEnd + 1 : 0;
    for (const h of headings.filter(x => x.depth <= 3)) {
      const want = norm(h.text);
      for (let i = from; i < pages.length; i++) {
        if (pages[i]!.text.includes(want)) { out.set(h.id, pages[i]!.num); from = i; break; }
      }
    }
  } finally {
    await parser.destroy().catch(() => undefined);
  }
  return out;
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
  const source = exportSource(doc, input.tab);
  const title = source.title;
  const markdown = input.format === 'md' ? source.markdown : normalizeAlternateSyntax(source.markdown);
  const fileName = `${fileBase(title)}.${input.format}`;
  const mediaType = EXPORT_MEDIA[input.format];
  const date = input.date ?? new Date();
  const dateText = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const tree = parseMarkdown(markdown);
  const headings = collectHeadings(tree);

  if (input.format === 'md') {
    let text = markdown;
    if (hasTocMarker(tree)) text = text.replace(/^\s*<!--\s*aico:toc\s*-->\s*$/im, markdownToc(headings));
    else if (settings.toc) text = `${markdownToc(headings)}\n\n${text}`;
    const withTitle = opensWithH1(tree, title) || !title ? text : `# ${title}\n\n${text}`;
    return { bytes: Buffer.from(withTitle.replace(/\s*$/, '\n'), 'utf8'), fileName, mediaType, warnings: [] };
  }

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
    switch (input.format) {
      case 'html': {
        const html = await buildHtml({ title, markdown, settings, resolveImage: input.resolveImage, visuals, date });
        return { bytes: Buffer.from(html, 'utf8'), fileName, mediaType, warnings };
      }
      case 'docx': {
        const tocAtStart = settings.toc && !hasTocMarker(tree);
        const bytes = await toDocx({
          title, tree, showTitle: !opensWithH1(tree, title), resolveImage: input.resolveImage, date, settings, visuals, headings, tocAtStart,
        });
        return { bytes: Buffer.from(bytes), fileName, mediaType, warnings };
      }
      case 'pdf': {
        const b = browser as ExportBrowser;
        const timeout = input.timeoutMs ?? 60_000;
        const values = { title, date: dateText };
        const wantsToc = settings.toc || hasTocMarker(tree);
        const html1 = await buildHtml({ title, markdown, settings, resolveImage: input.resolveImage, visuals, date, print: true });
        const first = await printPdf(b, html1, settings, values, timeout);
        if (!wantsToc) return { bytes: first, fileName, mediaType, warnings };
        // Second pass: fill in the page each heading landed on.
        const pages = await headingPages(first, headings).catch(() => new Map<string, number>());
        if (pages.size === 0) return { bytes: first, fileName, mediaType, warnings, tocPageNumbers: false };
        const html2 = await buildHtml({ title, markdown, settings, resolveImage: input.resolveImage, visuals, date, print: true, pageNumbers: pages });
        return { bytes: await printPdf(b, html2, settings, values, timeout), fileName, mediaType, warnings, tocPageNumbers: true };
      }
    }
  } finally {
    const opened = browser as ExportBrowser | { error: string } | undefined;
    if (opened && !('error' in opened)) await opened.close();
  }
  throw new Error('unreachable');
}
