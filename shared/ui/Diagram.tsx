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
 * **The rendered SVG zooms and pans.** A wide flowchart or a tall sequence
 * diagram is genuinely bigger than the column. Scaling it to fit makes a
 * twenty-node architecture unreadable, and letting it overflow puts half of it
 * off the side — neither is something the diagram's author can fix, so the
 * reader gets the controls instead. See {@link module:shared/ui/ZoomPan}.
 *
 * ## Inside the widget frame, not beside it
 *
 * This drew its own bordered figure with its own source toggle, which meant a
 * diagram was the one drawable block with different chrome, a different place
 * to find copy and download, and — because it rendered its own red error box —
 * no Fix button when it failed to parse. It now throws like every other
 * renderer and lets the frame own all of that. Only the controls belonging to
 * the *view* rather than the block stay here, over the diagram where a reader
 * reaching for zoom is already looking.
 *
 * @module shared/ui/Diagram
 */

import React, { useEffect, useRef, useState } from 'react';
import { IconButton } from './icons';
import { ZoomPan } from './ZoomPan';

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
    return <p className="p-2 text-[11px] text-aico-muted">Diagram arriving…</p>;
  }

  if (error) {
    // Thrown rather than drawn, so the widget frame owns the failure and offers
    // to have it repaired — the same path a chart takes. This used to render
    // its own red box, which meant a diagram that would not parse was the one
    // broken widget with no Fix button.
    throw new Error(error.split(String.fromCharCode(10))[0]);
  }

  return (
    <ZoomPan
      className="max-h-[30rem]"
      actions={
        <IconButton
          icon="code"
          label={showSource ? 'Back to the diagram' : 'Show the source'}
          onClick={toggleSource}
          active={showSource}
        />
      }
    >
      {showSource ? (
        <pre className="max-h-[28rem] overflow-auto p-2 font-mono text-[13px]
                        leading-[22px] text-aico-primary">
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
          className="p-2 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
        />
      ) : (
        <div className="p-6 text-center text-[13px] text-aico-muted">Drawing…</div>
      )}
    </ZoomPan>
  );
});
