/**
 * Mermaid diagrams and charts.
 *
 * Covers flowcharts, sequence and state diagrams, ER diagrams, Gantt charts,
 * pie charts and xy plots from one grammar, which is why there is no separate
 * charting library. Loaded on demand — mermaid is around half a megabyte, and a
 * session with no diagrams should not pay for it.
 *
 * Three things here exist because of how badly it behaves without them:
 *
 * **Rendered SVG is cached by source.** React remounts components for all sorts
 * of reasons, and a remount used to mean re-running mermaid: the diagram
 * vanished and redrew on every re-render of the transcript, which is the
 * flicker you see while a later message streams. The cache makes a remount free
 * and the diagram visually stable.
 *
 * **The source/diagram toggle is remembered per diagram.** Component state is
 * lost on remount, so a diagram flipped to Source would silently flip back. The
 * choice is keyed by source text and outlives the component.
 *
 * **The rendered SVG scrolls in both directions.** A wide flowchart or a tall
 * sequence diagram is genuinely bigger than the column, and clipping it is
 * worse than letting it scroll.
 *
 * @module shared/ui/Diagram
 */

import React, { useEffect, useRef, useState } from 'react';

/** One module-level promise, so N diagrams cost one download. */
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;

function loadMermaid(): Promise<typeof import('mermaid').default> {
  mermaidPromise ??= import('mermaid').then(module => {
    const mermaid = module.default;
    const dark = document.documentElement.dataset.theme === 'dark';
    // Mermaid derives a chart palette from `primaryColor` unless told
    // otherwise, and our primary is a near-white surface tint — which produced
    // pie charts whose slices were all the same shade of nothing. An explicit
    // sequence is the only way to get a readable chart.
    const palette = dark
      ? ['#679efe', '#4ed17e', '#f7ad31', '#f25a5a', '#a78bfa', '#56b6d8', '#f472b6', '#94a3b8']
      : ['#4176e6', '#1a9c53', '#b8791a', '#d13333', '#7c5cd6', '#2b7fa8', '#c2409c', '#64748b'];
    const pieColors = Object.fromEntries(palette.map((c, i) => [`pie${i + 1}`, c]));
    mermaid.initialize({
      startOnLoad: false,
      // Strict removes script tags and click bindings from the output. Diagram
      // source reaches us the same way prose does, so it gets the same distrust.
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: {
        ...pieColors,
        // Pie labels sit on the slices, so they take the on-accent colour
        // rather than the body text colour.
        pieSectionTextColor: '#ffffff',
        pieStrokeWidth: '0px',
        pieOuterStrokeWidth: '0px',
        pieTitleTextSize: '16px',
        pieSectionTextSize: '13px',
        fontFamily: 'var(--aico-font)',
        fontSize: '14px',
        background: 'transparent',
        ...(dark
          ? {
            primaryColor: '#232733', primaryTextColor: '#e8eaed', primaryBorderColor: '#679efe',
            lineColor: '#6f7480', secondaryColor: '#1c1f26', tertiaryColor: '#16181d',
            textColor: '#e8eaed', mainBkg: '#232733', nodeBorder: '#679efe',
          }
          : {
            primaryColor: '#eaf0fd', primaryTextColor: '#0f1115', primaryBorderColor: '#4176e6',
            lineColor: '#8a8f98', secondaryColor: '#f4f5f7', tertiaryColor: '#f9fafb',
            textColor: '#0f1115', mainBkg: '#eaf0fd', nodeBorder: '#4176e6',
          }),
      },
      flowchart: { curve: 'basis', htmlLabels: false },
    });
    return mermaid;
  });
  return mermaidPromise;
}

/**
 * Rendered SVG, keyed by source.
 *
 * Module-level rather than component state on purpose: it must survive the
 * remounts that caused the flicker in the first place.
 */
const svgCache = new Map<string, string>();
/** Which diagrams the reader has flipped to source. Same reasoning. */
const sourceShown = new Set<string>();
/** Ids must be unique per render or mermaid reuses a stale definition. */
let diagramCounter = 0;

export interface DiagramProps {
  source: string;
  /** Suppress rendering until the block stops changing. */
  streaming?: boolean;
}

export const Diagram = React.memo(function Diagram({
  source, streaming = false,
}: DiagramProps): React.ReactElement {
  const [svg, setSvg] = useState(() => svgCache.get(source) ?? '');
  const [error, setError] = useState('');
  const [showSource, setShowSource] = useState(() => sourceShown.has(source));
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // A half-written diagram is a syntax error by definition, so rendering
    // mid-stream produces a flashing error box that resolves itself.
    if (streaming) return;

    const cached = svgCache.get(source);
    if (cached) { setSvg(cached); setError(''); return; }

    let cancelled = false;
    const id = `aico-diagram-${++diagramCounter}`;

    void loadMermaid()
      .then(mermaid => mermaid.render(id, source))
      .then(({ svg: rendered }) => {
        svgCache.set(source, rendered);
        if (!cancelled) { setSvg(rendered); setError(''); }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        // Mermaid leaves its failed attempt in the document on error.
        document.getElementById(id)?.remove();
      });

    return () => { cancelled = true; };
  }, [source, streaming]);

  const toggleSource = (): void => {
    setShowSource(current => {
      const next = !current;
      if (next) sourceShown.add(source);
      else sourceShown.delete(source);
      return next;
    });
  };

  if (streaming) {
    return (
      <figure className="my-4 rounded-xl border border-aico-border-subtle bg-aico-code p-4">
        <figcaption className="mb-2 text-[13px] text-aico-muted aico-thinking">
          Diagram — drawing when complete…
        </figcaption>
        <pre className="overflow-x-auto font-mono text-[13px] leading-[22px] text-aico-muted">
          {source}
        </pre>
      </figure>
    );
  }

  if (error) {
    // The source is shown rather than hidden: a diagram that will not parse is
    // still information, and the mistake is usually obvious from looking at it.
    return (
      <figure className="my-4 overflow-hidden rounded-xl border border-aico-danger/30">
        <figcaption className="bg-aico-danger/8 px-4 py-2 text-[13px] text-aico-danger">
          This diagram could not be drawn: {error.split('\n')[0]}
        </figcaption>
        <pre className="overflow-x-auto bg-aico-code p-4 font-mono text-[13px] leading-[22px] text-aico-secondary">
          <code>{source}</code>
        </pre>
      </figure>
    );
  }

  return (
    <figure className="group/diagram my-4 overflow-hidden rounded-xl border border-aico-border-subtle bg-aico-code">
      <figcaption className="flex items-center gap-2 px-4 py-2 text-[12px] text-aico-muted">
        <span>diagram</span>
        <div className="flex-1" />
        <button
          onClick={toggleSource}
          className="rounded px-2 py-0.5 text-[12px] text-aico-muted opacity-0 transition-opacity
                     hover:text-aico-primary focus:opacity-100 group-hover/diagram:opacity-100"
        >
          {showSource ? 'Diagram' : 'Source'}
        </button>
      </figcaption>

      {showSource ? (
        <pre className="max-h-[28rem] overflow-auto px-4 pb-4 font-mono text-[13px] leading-[22px] text-aico-primary">
          <code>{source}</code>
        </pre>
      ) : svg ? (
        <div
          ref={container}
          // Mermaid's own output, produced under securityLevel 'strict', which
          // strips scripts and event bindings. Parsing the SVG back out to
          // build React elements would remove the structure that makes it a
          // diagram in the first place.
          dangerouslySetInnerHTML={{ __html: svg }}
          className="max-h-[32rem] overflow-auto px-4 pb-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-none"
        />
      ) : (
        <div className="px-4 pb-6 text-center text-[13px] text-aico-muted">Drawing…</div>
      )}
    </figure>
  );
});
