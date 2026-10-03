/**
 * Export a deck canvas as PowerPoint (.pptx), PDF (one slide per page) or
 * PNG (one image per slide, zipped for a download).
 *
 * One layout pass (`shared/ui/canvas/deck-layout`) feeds every format, so the
 * three files show the same slides as the editor. What needs a browser:
 *
 * - **PDF and PNG** are the slides' HTML (`deck-render`) printed and
 *   photographed by the installed Chrome/Edge (`playwright-core`, ADR 0008),
 *   every network request refused, pictures inlined as data URLs.
 * - **Mermaid diagrams** are drawn by the web build's renderer page (via
 *   `canvas/visuals`), themed with the deck's `%%{init}%%` directive; for
 *   PowerPoint they are then rasterised at 3× the size of their frame.
 * - **Charts** are SVG from ECharts in Node for PDF/PNG; in PowerPoint they
 *   are native charts and need no browser at all (only a chart kept as a raw
 *   ECharts option becomes a picture).
 *
 * Without a browser a .pptx is still written — diagrams become labelled
 * placeholders and the result says so — while PDF and PNG fail with a message
 * naming .pptx as the alternative.
 *
 * @module canvas/deck-export
 */

import { zipSync } from 'fflate';
import type { CanvasDoc } from './store.js';
import { fileBase, type ImageResolver } from './markdown.js';
import { launchExportBrowser, renderVisuals, type ExportBrowser } from './visuals.js';
import { imageSize, nativeChart, toPptx, PPTX_MEDIA, type PptxImage, type PptxPicture } from './deck-pptx.js';
import { parseDeck, type Deck, type DeckChart } from '../../shared/ui/canvas/deck-model.js';
import { layoutDeck, type ChartFrame, type DiagramFrame, type SlideLayout } from '../../shared/ui/canvas/deck-layout.js';
import { DECK_SLIDE_CSS, chartKey, deckChartOption, diagramKey, slideHtml, themedMermaid } from '../../shared/ui/canvas/deck-render.js';
import { themeOfDeck, type DeckTheme } from '../../shared/ui/canvas/deck-themes.js';

export type DeckExportFormat = 'pptx' | 'pdf' | 'png';
export const DECK_EXPORT_FORMATS: readonly DeckExportFormat[] = ['pptx', 'pdf', 'png'];
export const DECK_MEDIA: Record<DeckExportFormat, string> = { pptx: PPTX_MEDIA, pdf: 'application/pdf', png: 'application/zip' };

export interface DeckExportResult {
  bytes: Buffer;
  fileName: string;
  mediaType: string;
  warnings: string[];
  /** PNG: each slide's image, for a caller that writes them as separate files. */
  slides?: { name: string; bytes: Buffer }[];
}

export function deckOf(doc: CanvasDoc): Deck {
  return parseDeck(doc.tabs[0]!.content);
}

/** Draw a chart to SVG in Node, at its frame size (points → CSS pixels). */
export async function deckChartSvg(chart: DeckChart, theme: DeckTheme, w: number, h: number): Promise<string | undefined> {
  const echarts = await import('echarts');
  const inst = echarts.init(null as unknown as HTMLElement, undefined, { renderer: 'svg', ssr: true, width: Math.round(w * 4 / 3), height: Math.round(h * 4 / 3) });
  try {
    inst.setOption(deckChartOption(chart, theme));
    return inst.renderToSVGString();
  } catch {
    return undefined;
  } finally {
    inst.dispose();
  }
}

interface Prepared {
  deck: Deck;
  theme: DeckTheme;
  layouts: SlideLayout[];
  /** Visual key → SVG markup. */
  svgs: Map<string, string>;
  /** Image src → data URL (HTML) and bytes (PowerPoint). */
  dataUrls: Map<string, string>;
  images: Map<string, PptxImage | undefined>;
  warnings: string[];
}

async function prepare(doc: CanvasDoc, resolveImage: ImageResolver, opts: { charts: 'all' | 'picture-only'; getBrowser: () => Promise<ExportBrowser | { error: string }> }): Promise<Prepared> {
  const deck = deckOf(doc);
  const theme = themeOfDeck(deck);
  const layouts = layoutDeck(deck);
  const warnings: string[] = [];
  const svgs = new Map<string, string>();
  const frames = layouts.flatMap(l => l.frames);
  for (const f of frames.filter((x): x is ChartFrame => x.kind === 'chart')) {
    if (opts.charts === 'picture-only' && nativeChart(f.chart)) continue;
    const key = chartKey(f.chart, theme, f.w, f.h);
    if (svgs.has(key)) continue;
    const svg = await deckChartSvg(f.chart, theme, f.w, f.h);
    if (svg) svgs.set(key, svg); else warnings.push(`a chart on "${f.name}" could not be drawn`);
  }
  const diagrams = frames.filter((x): x is DiagramFrame => x.kind === 'diagram');
  if (diagrams.length) {
    const jobs = [...new Map(diagrams.map(d => [diagramKey(d.source, theme), d])).entries()]
      .map(([key, d]) => ({ key, kind: 'diagram' as const, source: themedMermaid(d.source, theme) }));
    const drawn = await renderVisuals(jobs, opts.getBrowser, { needPng: false });
    for (const job of jobs) {
      const v = drawn.get(job.key);
      if (v?.svg && !v.error) svgs.set(job.key, v.svg);
      else warnings.push(`diagram not drawn: ${v?.error ?? 'unknown error'}`);
    }
  }
  const dataUrls = new Map<string, string>();
  const images = new Map<string, PptxImage | undefined>();
  for (const f of frames) {
    if (f.kind !== 'image' || images.has(f.src)) continue;
    const data = await resolveImage(f.src).catch(() => undefined);
    if (!data) { images.set(f.src, undefined); warnings.push(`picture not found or not allowed: ${f.src.startsWith('data:') ? 'an embedded image' : f.src}`); continue; }
    dataUrls.set(f.src, `data:${data.mediaType};base64,${data.bytes.toString('base64')}`);
    const size = imageSize(data.bytes);
    images.set(f.src, size ? { bytes: data.bytes, ext: size.ext, width: size.width, height: size.height } : undefined);
  }
  return { deck, theme, layouts, svgs, dataUrls, images, warnings };
}

/** The whole deck as one HTML page, one slide per printed page. */
export function deckHtml(p: Pick<Prepared, 'layouts' | 'theme' | 'svgs' | 'dataUrls'>, title: string): string {
  const w = p.layouts[0]?.w ?? 960;
  const h = p.layouts[0]?.h ?? 540;
  const slides = p.layouts.map(l => `<section class="page">${slideHtml(l, p.theme, {
    visual: key => p.svgs.get(key), image: src => p.dataUrls.get(src),
  })}</section>`).join('\n');
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
@page { size: ${w}pt ${h}pt; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.page { width: ${w}pt; height: ${h}pt; overflow: hidden; break-after: page; page-break-after: always; }
.page:last-child { break-after: auto; page-break-after: auto; }
${DECK_SLIDE_CSS}
</style></head><body>${slides}</body></html>`;
}

async function containedPage(browser: ExportBrowser, scale: number, w: number, h: number) {
  const context = await browser.browser.newContext({ deviceScaleFactor: scale, viewport: { width: Math.ceil(w * 4 / 3), height: Math.ceil(h * 4 / 3) } });
  const page = await context.newPage();
  await page.route('**/*', route => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
  return { context, page };
}

/** Diagrams (and raw-ECharts charts) as 3× PNGs of their frame, for PowerPoint. */
async function rasterise(browser: ExportBrowser, p: Prepared): Promise<Map<string, PptxPicture>> {
  const out = new Map<string, PptxPicture>();
  const wanted = new Map<string, { w: number; h: number; svg: string }>();
  for (const f of p.layouts.flatMap(l => l.frames)) {
    const key = f.kind === 'diagram' ? diagramKey(f.source, p.theme) : f.kind === 'chart' && !nativeChart(f.chart) ? chartKey(f.chart, p.theme, f.w, f.h) : undefined;
    const svg = key ? p.svgs.get(key) : undefined;
    if (key && svg && !wanted.has(key)) wanted.set(key, { w: f.w, h: f.h, svg });
  }
  if (!wanted.size) return out;
  const { context, page } = await containedPage(browser, 3, 960, 540);
  try {
    const items = [...wanted.entries()];
    await page.setContent(`<!doctype html><html><head><style>body{margin:0;background:transparent}${DECK_SLIDE_CSS}.box{position:relative;margin:0 0 8pt}</style></head><body>${
      items.map(([key, v]) => `<div class="box dk-v" id="k-${key}" style="position:relative;width:${v.w}pt;height:${v.h}pt">${v.svg}</div>`).join('')}</body></html>`, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    for (const [key, v] of items) {
      const el = await page.$(`#k-${key}`);
      if (!el) continue;
      const png = await el.screenshot({ type: 'png', omitBackground: true, timeout: 15_000 });
      out.set(key, { png, width: Math.round(v.w * 3), height: Math.round(v.h * 3) });
    }
  } finally {
    await context.close().catch(() => undefined);
  }
  return out;
}

export interface DeckExportInput {
  format: DeckExportFormat;
  resolveImage: ImageResolver;
  timeoutMs?: number;
  date?: Date;
}

export async function exportDeck(doc: CanvasDoc, input: DeckExportInput): Promise<DeckExportResult> {
  if (!DECK_EXPORT_FORMATS.includes(input.format)) throw new Error(`a deck exports as ${DECK_EXPORT_FORMATS.join(', ')}`);
  let browser: ExportBrowser | { error: string } | undefined;
  const getBrowser = async (): Promise<ExportBrowser | { error: string }> => (browser ??= await launchExportBrowser(input.timeoutMs));
  const base = fileBase(doc.title);
  try {
    if (input.format !== 'pptx') {
      const b = await getBrowser();
      if ('error' in b) {
        throw new Error(`${input.format.toUpperCase()} export of a deck needs Google Chrome or Microsoft Edge installed, and ${b.error}. Export as pptx instead.`);
      }
    }
    const p = await prepare(doc, input.resolveImage, { charts: input.format === 'pptx' ? 'picture-only' : 'all', getBrowser });
    if (input.format === 'pptx') {
      const needsPictures = p.layouts.some(l => l.frames.some(f => f.kind === 'diagram' || (f.kind === 'chart' && !nativeChart(f.chart))));
      let pictures = new Map<string, PptxPicture>();
      if (needsPictures) {
        const b = await getBrowser();
        if (!('error' in b)) pictures = await rasterise(b, p);
      }
      const out = toPptx({ title: doc.title, deck: p.deck, layouts: p.layouts, images: p.images, pictures, ...(input.date ? { date: input.date } : {}) });
      return { bytes: Buffer.from(out.bytes), fileName: `${base}.pptx`, mediaType: DECK_MEDIA.pptx, warnings: [...new Set([...p.warnings, ...out.warnings])] };
    }
    const b = browser as ExportBrowser;
    const html = deckHtml(p, doc.title);
    const w = p.layouts[0]?.w ?? 960;
    const h = p.layouts[0]?.h ?? 540;
    const timeout = input.timeoutMs ?? 60_000;
    if (input.format === 'pdf') {
      const { context, page } = await containedPage(b, 1, w, h);
      try {
        await page.setContent(html, { waitUntil: 'load', timeout });
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
        return { bytes: Buffer.from(pdf), fileName: `${base}.pdf`, mediaType: DECK_MEDIA.pdf, warnings: p.warnings };
      } finally {
        await context.close().catch(() => undefined);
      }
    }
    // PNG: 1920×1080 (16:9) per slide — 960 pt is 1280 CSS px, at 1.5×.
    const { context, page } = await containedPage(b, 1.5, w, h);
    try {
      await page.setContent(html.replace('.page {', '.page { margin: 0 0 0 0;'), { waitUntil: 'load', timeout });
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const slides: { name: string; bytes: Buffer }[] = [];
      const els = await page.$$('.page');
      for (let i = 0; i < els.length; i++) {
        const png = await els[i]!.screenshot({ type: 'png', timeout: 20_000 });
        slides.push({ name: `${base}-slide-${String(i + 1).padStart(2, '0')}.png`, bytes: png });
      }
      const zip = zipSync(Object.fromEntries(slides.map(s => [s.name, new Uint8Array(s.bytes)])), { level: 0 });
      return { bytes: Buffer.from(zip), fileName: `${base}-slides.zip`, mediaType: DECK_MEDIA.png, warnings: p.warnings, slides };
    } finally {
      await context.close().catch(() => undefined);
    }
  } finally {
    const opened = browser as ExportBrowser | { error: string } | undefined;
    if (opened && !('error' in opened)) await opened.close();
  }
}
