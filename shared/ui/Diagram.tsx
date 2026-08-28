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

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconButton } from './icons';
import { ZoomPan } from './ZoomPan';
import { useWidgetExpanded } from './Widget';
import { diagramCss, diagramTheme } from './diagram-theme';

/** One module-level promise, so N diagrams cost one download. */
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;

function loadMermaid(): Promise<typeof import('mermaid').default> {
  mermaidPromise ??= import('mermaid').then(module => {
    const mermaid = module.default;
    const dark = document.documentElement.dataset.theme === 'dark';
    mermaid.initialize({
      startOnLoad: false,
      // Strict removes script tags and click bindings from the output. Diagram
      // source reaches us the same way prose does, so it gets the same distrust.
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: diagramTheme(dark),
      // The few things themeVariables cannot express — corner radius, stroke
      // weights, and stopping a group being drawn as a hard dashed box.
      themeCSS: diagramCss(dark),
      flowchart: { curve: 'basis', htmlLabels: false, nodeSpacing: 44, rankSpacing: 54 },
      sequence: { actorMargin: 56, mirrorActors: false },
      gantt: { barHeight: 22, barGap: 6, topPadding: 46 },
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
  const expanded = useWidgetExpanded();

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

  /**
   * Make the drawing fit the box it was given.
   *
   * The viewport cannot scroll — it is `overflow-hidden` so that dragging pans
   * rather than scrolls — so a diagram taller than the frame is not clipped
   * gracefully, it simply is not there. That is what an eight-service
   * architecture looked like: a correct diagram, entirely below the fold, in a
   * frame showing the empty top of its own group box.
   *
   * Mermaid writes `width="100%"` and an inline `max-width` in pixels, which
   * together mean "as wide as you like, as tall as that makes me". Asking for
   * both axes and letting `preserveAspectRatio` letterbox turns that into "as
   * big as fits", which is what a reader wants before they reach for zoom.
   */
  useLayoutEffect(() => {
    const drawing = container.current?.querySelector(':scope > svg');
    if (!drawing) return;
    drawing.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    drawing.setAttribute('height', '100%');
    (drawing as SVGElement).style.maxWidth = 'none';
  }, [svg, expanded, showSource]);

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
      className="h-[28rem]"
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
          // `!max-w-none` is doing real work. Mermaid writes an inline
          // `style="max-width: NNNpx"` on the svg it produces, which wins over
          // any class and pins the diagram to its natural width — so expanding
          // to full screen left it the same size in the corner of a blank
          // page. Overriding that is the only way to let it grow.
          // `!max-w-none` when expanded is doing real work: mermaid writes an
          // inline `style="max-width: NNNpx"` on the svg, which beats any class
          // and pins the diagram to its natural width — so filling the window
          // left it the same size in the corner of a blank page.
          //
          // Rewriting the viewBox to crop mermaid's generous margins was tried
          // and reverted. `getBBox` has to run after paint, the icon pack
          // resolves asynchronously, and the measurement therefore lands before
          // the services exist — cropping the diagram down to its empty group
          // box. Margin is a smaller problem than a blank frame.
          // `[&>svg]`, not `[&_svg]`. The descendant form matches every svg
          // inside the diagram — including the nested one mermaid uses for each
          // architecture icon — so sizing rules meant for the drawing were
          // applied to every glyph in it and the services rendered as nothing.
          // The child combinator reaches the diagram and stops.
          // `[&>svg]`, not `[&_svg]`. The descendant form matches every svg
          // inside the diagram — including the nested one mermaid uses for each
          // architecture icon — so sizing meant for the drawing was applied to
          // every glyph in it.
          className="h-full w-full p-2 [&>svg]:!max-w-none [&>svg]:h-full [&>svg]:w-full"
        />
      ) : (
        <div className="p-6 text-center text-[13px] text-aico-muted">Drawing…</div>
      )}
    </ZoomPan>
  );
});
