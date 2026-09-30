/**
 * The page the engine loads (headless) to draw diagrams and maths for exports.
 *
 * ## Why a page in the web build
 *
 * Mermaid and KaTeX need a DOM and fonts, and they are only shipped to users
 * inside the web client's build (`web-dist/`) — the engine's own dependencies
 * do not include them. So the web build carries this second, tiny entry
 * (`export-render.html`), and `src/canvas/visuals.ts` opens it in the same
 * headless Chrome/Edge that prints PDFs, serving `web-dist/` through a
 * request interceptor (no server, no network). Everything is drawn in one page
 * load per export.
 *
 * The mermaid configuration and the KaTeX macros are the chat's own
 * (`shared/ui/Diagram.tsx`, `shared/ui/MathBlock.tsx`), in their light theme,
 * so a diagram in a .docx looks like the one in the conversation.
 *
 * Charts are not drawn here: the engine renders ECharts to SVG itself (it is a
 * runtime dependency), and only uses the browser to rasterise that SVG.
 *
 * @module web/export-render
 */

import mermaid from 'mermaid';
import katex from 'katex';
import 'katex/dist/contrib/mhchem.mjs';
import 'katex/dist/katex.min.css';
import { diagramCss, diagramTheme } from '../../shared/ui/diagram-theme';

interface Job { id: string; kind: 'diagram' | 'math' | 'math-inline'; source: string }
interface Done { id: string; ok: boolean; svg?: string; error?: string }

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'base',
  themeVariables: diagramTheme(false),
  themeCSS: diagramCss(false),
  flowchart: { curve: 'basis', htmlLabels: false, nodeSpacing: 44, rankSpacing: 54 },
  sequence: { actorMargin: 56, mirrorActors: false },
  gantt: { barHeight: 22, barGap: 6, topPadding: 46 },
});

// Kept identical to MathBlock's list.
const MACROS = {
  '\\deriv': '\\frac{d#1}{d#2}',
  '\\pderiv': '\\frac{\\partial#1}{\\partial#2}',
  '\\abs': '\\left|#1\\right|',
  '\\norm': '\\left\\|#1\\right\\|',
};

async function renderAll(jobs: Job[]): Promise<Done[]> {
  const out: Done[] = [];
  const root = document.getElementById('root')!;
  for (const job of jobs) {
    const box = document.createElement('div');
    box.id = `v-${job.id}`;
    box.className = `v v-${job.kind}`;
    root.appendChild(box);
    try {
      if (job.kind === 'diagram') {
        const { svg } = await mermaid.render(`m${job.id}`, job.source);
        box.innerHTML = svg;
        out.push({ id: job.id, ok: true, svg });
      } else {
        box.innerHTML = katex.renderToString(job.source.trim(), {
          displayMode: job.kind === 'math', throwOnError: true, strict: false, trust: false, macros: { ...MACROS },
        });
        out.push({ id: job.id, ok: true });
      }
    } catch (err) {
      box.remove();
      out.push({ id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  await document.fonts.ready;
  return out;
}

(window as unknown as { aicoRender: typeof renderAll }).aicoRender = renderAll;
(window as unknown as { aicoRenderReady: boolean }).aicoRenderReady = true;
