/**
 * Charts, diagrams and maths drawn for document exports.
 *
 * ## One pass, one browser, cached
 *
 * An export collects every visual block first, then draws them all in one
 * headless page (the same Chrome/Edge the PDF is printed with, launched once
 * per export) and caches each result by a hash of its kind and source, so the
 * second export of a document redraws only what changed.
 *
 * - **Charts**: ECharts (a runtime dependency) renders to SVG right here in
 *   Node, with the chat's own spec parser, theme and defaults
 *   (`shared/ui/widget-specs`, `shared/ui/chart-theme`). The browser only
 *   rasterises that SVG to a 2× PNG for Word.
 * - **Diagrams and maths**: Mermaid and KaTeX need a DOM and ship only in the
 *   web build, so they are drawn by `web-dist/export-render.html`
 *   (`web/src/export-render.ts`), served to the page through a request
 *   interceptor. Every other request from that page is refused.
 *
 * ## When it cannot draw
 *
 * No browser, no built renderer page, or a block that does not parse: the
 * visual comes back with an `error`, and every writer shows a labelled
 * placeholder with the block's source — never a silent gap, never a crash of
 * the whole export.
 *
 * @module canvas/visuals
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Browser, Page } from 'playwright-core';
import type { Root } from 'mdast';
import { parseChartSpec } from '../../shared/ui/widget-specs.js';
import { chartDefaults, chartTheme } from '../../shared/ui/chart-theme.js';

export type VisualKind = 'chart' | 'diagram' | 'math' | 'math-inline';

export interface VisualJob { key: string; kind: VisualKind; source: string }

export interface RenderedVisual {
  kind: VisualKind;
  /** For HTML/PDF where available (charts, diagrams). */
  svg?: string;
  /** 2× raster for Word (and for maths everywhere). */
  png?: Buffer;
  /** CSS pixel size (the PNG is twice this). */
  width: number;
  height: number;
  error?: string;
}

const CHART_LANGS = new Set(['chart', 'echarts', 'plot']);
const DIAGRAM_LANGS: Record<string, string> = { mermaid: '', diagram: '', flowchart: 'flowchart TD', sequence: 'sequenceDiagram', gantt: 'gantt' };
const MATH_LANGS = new Set(['math', 'latex', 'tex', 'katex']);
export const CHART_SIZE = { width: 640, height: 360 };

export function visualKey(kind: VisualKind, source: string): string {
  return crypto.createHash('sha1').update(`${kind}\0${source}`).digest('hex').slice(0, 20);
}

/** Classify a fenced code block, returning the source to draw (diagram keyword supplied when the fence implies it). */
export function visualForCode(lang: string | null | undefined, value: string): { kind: VisualKind; source: string } | undefined {
  const l = (lang ?? '').toLowerCase();
  if (CHART_LANGS.has(l)) return { kind: 'chart', source: value };
  if (l in DIAGRAM_LANGS) {
    const prefix = DIAGRAM_LANGS[l]!;
    const first = value.trimStart().split(/\s/)[0] ?? '';
    return { kind: 'diagram', source: prefix && !/^(flowchart|graph|sequenceDiagram|gantt)$/i.test(first) ? `${prefix}\n${value}` : value };
  }
  if (MATH_LANGS.has(l)) return { kind: 'math', source: value };
  return undefined;
}

/** Every visual in a document, deduplicated. */
export function collectVisuals(tree: Root): VisualJob[] {
  const jobs = new Map<string, VisualJob>();
  const add = (kind: VisualKind, source: string): void => {
    const key = visualKey(kind, source);
    if (!jobs.has(key)) jobs.set(key, { key, kind, source });
  };
  const walk = (node: { type: string; lang?: string | null; value?: string; children?: unknown[] }): void => {
    if (node.type === 'code') {
      const v = visualForCode(node.lang, node.value ?? '');
      if (v) add(v.kind, v.source);
    } else if (node.type === 'math') add('math', node.value ?? '');
    else if (node.type === 'inlineMath') add('math-inline', node.value ?? '');
    for (const child of (node.children ?? []) as never[]) walk(child);
  };
  walk(tree as never);
  return [...jobs.values()];
}

// ── Cache ───────────────────────────────────────────────────────────

const CACHE_MAX = 300;
const cache = new Map<string, RenderedVisual>();
function remember(key: string, value: RenderedVisual): void {
  if (value.error) return; // failures are retried next time (a browser may be installed by then)
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}
export function clearVisualCache(): void { cache.clear(); }

// ── Charts in Node ──────────────────────────────────────────────────

let themeRegistered = false;

export async function chartSvg(source: string): Promise<{ svg: string; width: number; height: number } | { error: string }> {
  const parsed = parseChartSpec(source);
  if (parsed.error || !parsed.option) return { error: parsed.error ?? 'invalid chart' };
  const echarts = await import('echarts');
  if (!themeRegistered) { echarts.registerTheme('aico-light', chartTheme(false)); themeRegistered = true; }
  const { width, height } = CHART_SIZE;
  const chart = echarts.init(null as unknown as HTMLElement, 'aico-light', { renderer: 'svg', ssr: true, width, height });
  try {
    chart.setOption({ ...chartDefaults(parsed.option), ...parsed.option, animation: false });
    return { svg: chart.renderToSVGString(), width, height };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    chart.dispose();
  }
}

// ── The browser ─────────────────────────────────────────────────────

/** A browser for one export; `page()` opens a fresh 2× page. Closed by the caller. */
export interface ExportBrowser {
  browser: Browser;
  close(): Promise<void>;
}

export async function launchExportBrowser(timeoutMs = 60_000): Promise<ExportBrowser | { error: string }> {
  const { findBrowser } = await import('../tools/verify-app.js');
  const executablePath = findBrowser();
  if (!executablePath) return { error: 'no Chrome or Edge is installed' };
  try {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ executablePath, headless: true, timeout: timeoutMs });
    return { browser, close: () => browser.close().catch(() => undefined) };
  } catch (err) {
    return { error: `the browser did not start: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Where the built renderer page is, if the web client has been built. */
export function rendererRoot(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(dir, 'web-dist');
    if (fs.existsSync(path.join(candidate, 'export-render.html'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const ORIGIN = 'http://aico-export.invalid';
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
};

/** Serve `root` at {@link ORIGIN}, refuse everything else. */
async function containPage(page: Page, root: string | undefined): Promise<void> {
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('data:')) return route.continue();
    if (root && url.startsWith(`${ORIGIN}/`)) {
      const rel = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '');
      const file = path.resolve(root, rel);
      if (file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return route.fulfill({ status: 200, body: fs.readFileSync(file), contentType: MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
      }
    }
    return route.abort();
  });
}

/**
 * Draw every job. `browser` may be an error (no browser): charts still get
 * their SVG, everything that needs rasterising or a DOM reports why not.
 */
export async function renderVisuals(jobs: VisualJob[], getBrowser: () => Promise<ExportBrowser | { error: string } | undefined>,
  opts: { needPng: boolean }): Promise<Map<string, RenderedVisual>> {
  const out = new Map<string, RenderedVisual>();
  const todo: VisualJob[] = [];
  for (const job of jobs) {
    const hit = cache.get(job.key);
    if (hit && (!opts.needPng || hit.png || hit.error)) out.set(job.key, hit); else todo.push(job);
  }
  if (!todo.length) return out;

  // Charts: SVG in Node.
  const charts = new Map<string, { svg: string; width: number; height: number }>();
  for (const job of todo.filter(j => j.kind === 'chart')) {
    const r = await chartSvg(job.source);
    if ('error' in r) out.set(job.key, { kind: 'chart', width: 0, height: 0, error: `chart: ${r.error}` });
    else charts.set(job.key, r);
  }
  const needsDom = todo.filter(j => j.kind !== 'chart');
  // Launched only now, when something is actually left to draw: a cached export never starts a browser.
  const browser = needsDom.length || (opts.needPng && charts.size) ? await getBrowser() : undefined;
  const noBrowser = !browser || 'error' in browser ? (browser && 'error' in browser ? browser.error : 'no browser') : undefined;

  if (noBrowser) {
    for (const [key, c] of charts) out.set(key, { kind: 'chart', svg: c.svg, width: c.width, height: c.height, ...(opts.needPng ? { error: `chart image needs a browser (${noBrowser})` } : {}) });
    for (const job of needsDom) out.set(job.key, { kind: job.kind, width: 0, height: 0, error: `${job.kind === 'diagram' ? 'diagram' : 'maths'} rendering needs a browser (${noBrowser})` });
    for (const [key, v] of out) remember(key, v);
    return out;
  }

  const root = rendererRoot();
  const context = await (browser as ExportBrowser).browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1400, height: 1400 } });
  try {
    const page = await context.newPage();
    await containPage(page, root);
    let rendered: { id: string; ok: boolean; svg?: string; error?: string }[] = [];
    if (root && needsDom.length) {
      await page.goto(`${ORIGIN}/export-render.html`, { waitUntil: 'load', timeout: 30_000 });
      await page.waitForFunction(() => (window as unknown as { aicoRenderReady?: boolean }).aicoRenderReady === true, undefined, { timeout: 30_000 });
      rendered = await page.evaluate(
        (list) => (window as unknown as { aicoRender: (l: unknown) => Promise<{ id: string; ok: boolean; svg?: string; error?: string }[]> }).aicoRender(list),
        needsDom.map(j => ({ id: j.key, kind: j.kind, source: j.source })),
      );
    } else {
      await page.setContent('<!doctype html><html><body style="margin:0;background:#fff"><div id="root" style="padding:8px"></div></body></html>');
      for (const job of needsDom) {
        out.set(job.key, { kind: job.kind, width: 0, height: 0, error: 'the renderer page is not built (run npm run build:web)' });
      }
    }
    // Charts join the same page as plain SVG, to be photographed.
    await page.evaluate((list) => {
      const root = document.getElementById('root')!;
      for (const c of list) {
        const box = document.createElement('div');
        box.id = `v-${c.id}`;
        box.className = 'v v-chart';
        box.style.cssText = `width:${c.width}px;height:${c.height}px;background:#fff;display:block;margin:0 0 12px`;
        box.innerHTML = c.svg;
        root.appendChild(box);
      }
    }, [...charts].map(([id, c]) => ({ id, ...c })));

    const done = new Map(rendered.map(r => [r.id, r]));
    const shoot = async (key: string): Promise<{ png: Buffer; width: number; height: number } | undefined> => {
      const el = await page.$(`#v-${key}`);
      if (!el) return undefined;
      const box = await el.boundingBox();
      if (!box || box.width < 1 || box.height < 1) return undefined;
      const png = await el.screenshot({ type: 'png', omitBackground: false, timeout: 15_000 });
      return { png, width: Math.round(box.width), height: Math.round(box.height) };
    };
    for (const [key, c] of charts) {
      const shot = opts.needPng ? await shoot(key) : undefined;
      out.set(key, { kind: 'chart', svg: c.svg, width: c.width, height: c.height, ...(shot ? { png: shot.png } : {}) });
    }
    for (const job of needsDom) {
      if (out.has(job.key)) continue;
      const r = done.get(job.key);
      if (!r?.ok) { out.set(job.key, { kind: job.kind, width: 0, height: 0, error: `${job.kind === 'diagram' ? 'diagram' : 'maths'}: ${r?.error ?? 'not rendered'}` }); continue; }
      const shot = await shoot(job.key);
      if (!shot) { out.set(job.key, { kind: job.kind, width: 0, height: 0, error: 'rendered to nothing' }); continue; }
      out.set(job.key, { kind: job.kind, ...(r.svg ? { svg: r.svg } : {}), png: shot.png, width: shot.width, height: shot.height });
    }
  } finally {
    await context.close().catch(() => undefined);
  }
  for (const [key, v] of out) remember(key, v);
  return out;
}
