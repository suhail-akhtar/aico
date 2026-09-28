/**
 * Rendered content out of the app: rich copy, standalone HTML, PDF.
 *
 * "Copy" of a reply puts two things on the clipboard: the Markdown the model
 * wrote (for editors) and HTML of what is on screen — charts as images, math
 * as rendered, tables as tables — for anything that pastes rich text (mail,
 * docs, slides). Exports use the same capture, wrapped as a self-contained
 * document with the app's styles inlined, so nothing in it depends on AICO.
 *
 * @module desktop/renderer/lib/rich
 */

import { desktop } from '@/desktop';

/** Clone a node with canvases turned into images and interactive chrome removed. */
export function snapshotNode(node: HTMLElement): HTMLElement {
  const clone = node.cloneNode(true) as HTMLElement;
  // Canvases lose their pixels when cloned; copy them over as images.
  const src = node.querySelectorAll('canvas');
  const dst = clone.querySelectorAll('canvas');
  src.forEach((c, i) => {
    const target = dst[i];
    if (!target) return;
    try {
      const img = document.createElement('img');
      img.src = c.toDataURL('image/png');
      img.width = c.clientWidth || c.width;
      img.height = c.clientHeight || c.height;
      img.style.maxWidth = '100%';
      target.replaceWith(img);
    } catch { target.remove(); }
  });
  // Iframes (HTML previews, plugin widgets) cannot travel; leave a note.
  clone.querySelectorAll('iframe').forEach(f => {
    const note = document.createElement('div');
    note.textContent = '[interactive preview]';
    note.style.cssText = 'padding:8px;border:1px dashed #999;border-radius:8px;color:#777;font-size:12px';
    f.replaceWith(note);
  });
  clone.querySelectorAll('button, [data-no-export], .no-export, input, textarea, select').forEach(el => el.remove());
  clone.querySelectorAll('[style*="visibility: hidden"]').forEach(el => el.remove());
  return clone;
}

/** Every stylesheet the page uses, as text, so an export looks like the app. */
export function collectCss(): string {
  const out: string[] = [];
  for (const sheet of [...document.styleSheets]) {
    try {
      for (const rule of [...sheet.cssRules]) out.push(rule.cssText);
    } catch { /* cross-origin sheet (web fonts) — skipped */ }
  }
  // Freeze the live theme tokens into the document.
  const root = document.documentElement;
  const vars = [...root.style].filter(p => p.startsWith('--')).map(p => `${p}:${root.style.getPropertyValue(p)}`).join(';');
  out.push(`:root{${vars}}`);
  return out.join('\n');
}

export function standaloneHtml(title: string, bodyHtml: string, opts?: { dark?: boolean }): string {
  const esc = title.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]!));
  return `<!doctype html>
<html lang="en" class="${opts?.dark ? 'dark' : ''}" data-theme="${opts?.dark ? 'dark' : 'light'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="AICO Desktop">
<title>${esc}</title>
<style>${collectCss()}</style>
<style>
  html, body { height: auto !important; overflow: visible !important; }
  body { user-select: text; margin: 0; background: var(--aico-bg); }
  .export-page { max-width: 860px; margin: 0 auto; padding: 40px 32px 64px; }
  .export-head { border-bottom: 1px solid var(--aico-border); margin-bottom: 28px; padding-bottom: 14px; }
  .export-head h1 { font-size: 24px; margin: 0 0 4px; }
  .export-head p { margin: 0; color: var(--aico-text-muted); font-size: 12px; }
  @media print { .export-page { padding: 0; } pre, table, svg, img { break-inside: avoid; } }
</style>
</head>
<body>
<div class="export-page">
<div class="export-head"><h1>${esc}</h1><p>Exported from AICO Desktop · ${new Date().toLocaleString()}</p></div>
${bodyHtml}
</div>
</body>
</html>`;
}

/** Copy a rendered block: Markdown as text, what you see as HTML. */
export async function copyRich(node: HTMLElement | null, markdown: string): Promise<void> {
  if (!node) { await desktop.clipboard.writeRich(markdown); return; }
  const html = snapshotNode(node).innerHTML;
  const wrapped = `<div style="font-family:Segoe UI,system-ui,sans-serif;line-height:1.6">${html}</div>`;
  try {
    await desktop.clipboard.writeRich(markdown, wrapped);
  } catch {
    await navigator.clipboard.writeText(markdown);
  }
}

/** A chart, diagram or table on screen as a PNG data URL. */
export async function nodeToPng(node: HTMLElement): Promise<string | null> {
  const svg = node.querySelector('svg');
  const canvas = node.querySelector('canvas');
  if (canvas) return canvas.toDataURL('image/png');
  if (!svg) return null;
  const xml = new XMLSerializer().serializeToString(svg);
  const box = svg.getBoundingClientRect();
  const img = new Image();
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('svg')); img.src = url; });
  const scale = 2;
  const c = document.createElement('canvas');
  c.width = Math.max(1, box.width * scale);
  c.height = Math.max(1, box.height * scale);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}
