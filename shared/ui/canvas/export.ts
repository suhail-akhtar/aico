/**
 * Getting a document out of AICO Docs: files saved where the person chooses,
 * and images put in.
 *
 * Files come from the engine's export route (the one place that knows how to
 * make a .docx or a PDF), and are saved through the desktop's native save
 * dialog when running there — a browser-style download in Electron lands
 * silently in Downloads, which is not where anyone looks for a report. Where
 * the engine is older than the export route, Markdown and HTML are made here
 * and PDF falls back to the desktop's own print-to-PDF.
 *
 * Images are inlined as data URLs so the document stays one self-contained
 * Markdown text (the canvas store holds no attachments). They are downscaled
 * first, because a canvas has a size ceiling and a phone photo would fill it.
 *
 * @module shared/ui/canvas/export
 */

import { desktopBridge } from '../rich/common';
import type { ExportFormat } from './host';

export const EXPORT_TYPES: Record<ExportFormat, { label: string; ext: string; mime: string }> = {
  md: { label: 'Markdown', ext: 'md', mime: 'text/markdown' },
  docx: { label: 'Word document', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  pdf: { label: 'PDF', ext: 'pdf', mime: 'application/pdf' },
  html: { label: 'Web page', ext: 'html', mime: 'text/html' },
};

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Save a file: the native dialog in the desktop app, a download elsewhere.
 * Resolves to where it went (desktop), 'downloaded', or null when cancelled.
 */
export async function saveBlob(name: string, blob: Blob, format: ExportFormat): Promise<string | null> {
  const bridge = desktopBridge();
  if (bridge) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const t = EXPORT_TYPES[format];
    const where = await bridge.invoke('dialog:saveFile', {
      defaultName: name, content: base64(bytes), encoding: 'base64', filters: [{ name: t.label, extensions: [t.ext] }],
    });
    return typeof where === 'string' ? where : null;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return 'downloaded';
}

/** The desktop's print-to-PDF of a standalone HTML page (used when the engine cannot make a PDF). */
export async function desktopPdf(html: string, name: string): Promise<string | null | undefined> {
  const bridge = desktopBridge();
  if (!bridge) return undefined;
  const where = await bridge.invoke('export:pdf', { html, defaultName: name });
  return typeof where === 'string' ? where : null;
}

/** Longest data URL an inserted image may become, in characters. */
export const MAX_IMAGE_CHARS = 300_000;

/** Read an image file as a data URL, downscaled to fit the page and the canvas's size ceiling. */
export async function imageDataUrl(file: File): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('could not read the image'));
    r.readAsDataURL(file);
  });
  if (file.type === 'image/svg+xml' || file.type === 'image/gif') {
    if (raw.length > MAX_IMAGE_CHARS) throw new Error('That image is too large to put in the document (about 220 KB at most).');
    return raw;
  }
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('that file is not an image this app can read'));
    i.src = raw;
  });
  for (const [max, quality] of [[1400, 0.85], [1100, 0.8], [800, 0.75], [600, 0.7]] as const) {
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale === 1 && raw.length <= MAX_IMAGE_CHARS) return raw;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const g = c.getContext('2d');
    if (!g) break;
    g.drawImage(img, 0, 0, c.width, c.height);
    const keepAlpha = file.type === 'image/png' && c.width * c.height < 400_000;
    const out = c.toDataURL(keepAlpha ? 'image/png' : 'image/jpeg', quality);
    if (out.length <= MAX_IMAGE_CHARS) return out;
  }
  throw new Error('That image is too large to put in the document, even scaled down.');
}

/** A file picker for images, without a visible input. */
export function pickImage(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** Markdown alt text from a file name: "Q3 chart.png" → "Q3 chart". */
export function altFromName(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '').replace(/[[\]]/g, '').trim() || 'image';
}
