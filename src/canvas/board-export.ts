/**
 * Design board export: a screen as PNG, the whole board as one PDF (a page
 * per screen, each page the screen's own size) or as a zip of its folder
 * (ADR 0037).
 *
 * ## The same headless browser as every other export
 *
 * PNG and PDF are pictures of the real screens, taken by the installed
 * Chrome/Edge through `playwright-core` (`launchExportBrowser`, ADR 0008) —
 * not re-drawn — so what is exported is what the board shows. The page is
 * served from an origin that exists only inside this browser
 * (`http://aico-board.invalid/`), mapped onto the board folder with the same
 * containment rule as the artifacts route; relative stylesheets, scripts,
 * fonts and pictures load as they would from disk. Every other request is
 * refused except a script, stylesheet or font from the three CDNs a preview
 * may use (ADR 0020), so an export draws what the preview draws and nothing
 * more. Motion is frozen (reduced motion, zero-length animations) so an
 * entrance animation is captured at its end, not halfway.
 *
 * ## The PDF is pictures on purpose
 *
 * Printing each screen with print CSS would reflow it to paper and break the
 * design being reviewed. The PDF is the screenshots, one per page, each page
 * sized to its screen (CSS named pages), in board order — a deck of the
 * mockup to send round. Selectable text is the trade-off, and stated.
 *
 * ## Zip
 *
 * The board folder as it is (`fflate`, already a dependency), so the screens
 * open in any browser from disk and keep linking to each other. Hidden files
 * and anything over the size cap are left out.
 *
 * @module canvas/board-export
 */

import fs from 'fs';
import path from 'path';
import { zipSync } from 'fflate';
import type { BrowserContext, Page } from 'playwright-core';
import { launchExportBrowser, type ExportBrowser } from './visuals.js';
import { BOARD_CDNS, orderedFrames, slugify, type Board, type BoardFrame } from '../../shared/ui/board/board-model.js';

export type BoardExportFormat = 'png' | 'pdf' | 'zip';
export const BOARD_EXPORT_FORMATS: readonly BoardExportFormat[] = ['png', 'pdf', 'zip'];

const ORIGIN = 'http://aico-board.invalid';
const ZIP_MAX_BYTES = 60 * 1024 * 1024;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.json': 'application/json', '.ico': 'image/x-icon',
};

export interface BoardShot { frame: BoardFrame; png: Buffer }

export interface BoardExportResult {
  bytes: Buffer;
  fileName: string;
  mediaType: string;
  /** PNG: one picture per screen exported. */
  shots?: BoardShot[];
  warnings: string[];
}

/** Every file of the board folder (relative, forward slashes), hidden files and temp files skipped. */
export function boardFiles(dir: string, rel = '', depth = 0, out: string[] = []): string[] {
  if (depth > 4 || out.length > 500) return out;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.endsWith('.tmp')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) boardFiles(dir, r, depth + 1, out);
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/** Serve the board folder at ORIGIN; the three CDNs for scripts, styles and fonts; refuse the rest. */
async function servePage(page: Page, dir: string): Promise<void> {
  const root = fs.realpathSync(dir);
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    if (url.startsWith(`${ORIGIN}/`)) {
      let rel: string;
      try { rel = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, ''); } catch { return route.abort(); }
      const file = path.resolve(root, rel);
      if (file.startsWith(root + path.sep) && fs.existsSync(file)) {
        const real = fs.realpathSync(file);
        if (real.startsWith(root + path.sep) && fs.statSync(real).isFile()) {
          return route.fulfill({ status: 200, body: fs.readFileSync(real), contentType: MIME[path.extname(real).toLowerCase()] ?? 'application/octet-stream' });
        }
      }
      return route.fulfill({ status: 404, body: 'not found' });
    }
    const host = (() => { try { return new URL(url).host.toLowerCase(); } catch { return ''; } })();
    if (url.startsWith('https://') && (BOARD_CDNS as readonly string[]).includes(host) && ['script', 'stylesheet', 'font'].includes(req.resourceType())) return route.continue();
    return route.abort();
  });
}

const FREEZE = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important}';

/** Photograph one screen at its own size. */
async function shoot(b: ExportBrowser, dir: string, frame: BoardFrame, timeout: number): Promise<Buffer> {
  const scale = frame.width <= 600 ? 2 : 1;
  let context: BrowserContext | undefined;
  try {
    context = await b.browser.newContext({ viewport: { width: frame.width, height: frame.height }, deviceScaleFactor: scale, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await servePage(page, dir);
    await page.goto(`${ORIGIN}/${frame.file.split('/').map(encodeURIComponent).join('/')}`, { waitUntil: 'load', timeout });
    await page.addStyleTag({ content: FREEZE }).catch(() => undefined);
    await page.evaluate(() => document.fonts.ready.then(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))));
    return await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: frame.width, height: frame.height }, timeout: 20_000 });
  } finally {
    await context?.close().catch(() => undefined);
  }
}

function pdfHtml(title: string, shots: BoardShot[]): string {
  const pages = shots.map((s, i) => `@page p${i} { size: ${s.frame.width}px ${s.frame.height}px; margin: 0 }`).join('\n');
  const body = shots.map((s, i) => `<section style="page:p${i};width:${s.frame.width}px;height:${s.frame.height}px"><img alt="" src="data:image/png;base64,${s.png.toString('base64')}"></section>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title><style>${pages}
html,body{margin:0;padding:0}section{break-after:page;overflow:hidden}section:last-child{break-after:auto}img{display:block;width:100%;height:100%}</style></head><body>${body}</body></html>`;
}

export interface BoardExportInput {
  format: BoardExportFormat;
  /** PNG: one screen by id; omitted = every screen. */
  frame?: string;
  timeoutMs?: number;
}

/** Export a board whose folder is `dir`. Throws a message a person (or model) can act on. */
export async function exportBoard(dir: string, board: Board, input: BoardExportInput): Promise<BoardExportResult> {
  const base = slugify(board.title, 60) || 'board';
  if (!BOARD_EXPORT_FORMATS.includes(input.format)) throw new Error(`a board exports as ${BOARD_EXPORT_FORMATS.join(', ')}`);
  if (input.format === 'zip') {
    const files: Record<string, Uint8Array> = {};
    let total = 0;
    const warnings: string[] = [];
    for (const rel of boardFiles(dir)) {
      const bytes = fs.readFileSync(path.join(dir, rel));
      if (total + bytes.length > ZIP_MAX_BYTES) { warnings.push(`${rel} left out (the zip is capped at ${ZIP_MAX_BYTES / 1024 / 1024} MB)`); continue; }
      total += bytes.length;
      files[`${base}/${rel}`] = new Uint8Array(bytes);
    }
    return { bytes: Buffer.from(zipSync(files, { level: 6 })), fileName: `${base}.zip`, mediaType: 'application/zip', warnings };
  }
  const all = orderedFrames(board);
  const frames = input.frame ? all.filter(f => f.id === input.frame) : all;
  if (input.frame && !frames.length) throw new Error(`no screen "${input.frame}" on this board (screens: ${all.map(f => f.id).join(', ') || 'none'})`);
  if (!frames.length) throw new Error('the board has no screens yet');
  const b = await launchExportBrowser(input.timeoutMs);
  if ('error' in b) throw new Error(`${input.format.toUpperCase()} export of a board needs Google Chrome or Microsoft Edge installed, and ${b.error}. Download the board as a zip instead.`);
  const timeout = input.timeoutMs ?? 60_000;
  try {
    const shots: BoardShot[] = [];
    const warnings: string[] = [];
    for (const frame of frames) {
      try { shots.push({ frame, png: await shoot(b, dir, frame, timeout) }); } catch (err) { warnings.push(`${frame.title}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`); }
    }
    if (!shots.length) throw new Error(`no screen could be drawn: ${warnings.join('; ')}`);
    if (input.format === 'png') {
      const one = shots.length === 1 && input.frame;
      if (one) return { bytes: shots[0]!.png, fileName: `${base}-${shots[0]!.frame.id}.png`, mediaType: 'image/png', shots, warnings };
      const zip = zipSync(Object.fromEntries(shots.map((s, i) => [`${String(i + 1).padStart(2, '0')}-${s.frame.id}.png`, new Uint8Array(s.png)])), { level: 0 });
      return { bytes: Buffer.from(zip), fileName: `${base}-screens.zip`, mediaType: 'application/zip', shots, warnings };
    }
    let context: BrowserContext | undefined;
    try {
      context = await b.browser.newContext();
      const page = await context.newPage();
      await page.route('**/*', route => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
      await page.setContent(pdfHtml(board.title, shots), { waitUntil: 'load', timeout });
      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
      return { bytes: Buffer.from(pdf), fileName: `${base}.pdf`, mediaType: 'application/pdf', warnings };
    } finally {
      await context?.close().catch(() => undefined);
    }
  } finally {
    await b.close();
  }
}
