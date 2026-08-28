/**
 * Statistical graphics, from a Vega-Lite spec the model writes.
 *
 * ## Why a second chart engine
 *
 * Not because ECharts is lacking — it draws more chart *types* than this does.
 * The difference is who does the arithmetic.
 *
 * ECharts renders what it is given and nothing more. A histogram means the
 * author emits the bins; a trend line means the author emits the fitted points;
 * a box plot means the author emits five computed numbers per box. When the
 * author is a language model that is both expensive and unreliable: the data
 * goes into the transcript twice, once raw and once summarised, and the summary
 * is arithmetic done by a token predictor. Kernel density by hand in JSON is a
 * bug with a chart around it.
 *
 * Vega-Lite computes. `bin`, `aggregate`, `density`, `regression`, `loess`,
 * `quantile`, `window`, `joinaggregate`, `pivot` and `fold` are transforms, and
 * faceting is an encoding channel, so the model emits raw rows plus a statement
 * of what it wants shown and the library does the statistics. Fewer tokens and
 * — the part that matters — no invented numbers.
 *
 * ## Why not Observable Plot, which is smaller and nicer
 *
 * Because its input is JavaScript. `MarkdownRenderer` deliberately does not
 * parse model-authored HTML into live DOM, on a page that is same-origin with a
 * server that runs shell commands; accepting model-authored *code* for the same
 * page would give back everything that decision protects. Vega-Lite's input is
 * JSON — declarative data, evaluated by a library, with no path to the host.
 * That constraint picked this library, not the feature list.
 *
 * ## Loaded on demand
 *
 * Vega and its compiler are a large download, fetched the first time one of
 * these appears and never in a session without one. The same arrangement
 * `Chart` has with ECharts and `Diagram` has with mermaid.
 *
 * @module shared/ui/Viz
 */

import React, { useEffect, useRef, useState } from 'react';
import { parseVizSpec } from './widget-specs';
import { vegaTheme } from './vega-theme';

/** One module-level promise, so N figures cost one download. */
let embedPromise: Promise<typeof import('vega-embed')> | null = null;

function loadVegaEmbed(): Promise<typeof import('vega-embed')> {
  embedPromise ??= import('vega-embed');
  return embedPromise;
}

export interface VizProps {
  source: string;
  /** Suppressed while the block is still arriving, so half a spec is not drawn. */
  streaming?: boolean;
}

export function Viz({ source, streaming }: VizProps): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    // A fenced block arrives a character at a time. Parsing mid-stream reports
    // an error for every incomplete prefix, so the failure state flickers
    // through the whole message before settling on success.
    if (streaming) return;

    const parsed = parseVizSpec(source);
    if (parsed.error) { setError(parsed.error); return; }
    setError(undefined);

    let disposed = false;
    let view: { finalize: () => void } | undefined;

    void loadVegaEmbed().then(async ({ default: embed }) => {
      if (disposed || !host.current) return;
      const dark = document.documentElement.dataset.theme === 'dark';
      const result = await embed(host.current, parsed.spec as never, {
        // Our own frame already carries copy, download, expand and hide. The
        // embed menu would be a second set of the same controls in a different
        // idiom, three pixels away from the first.
        actions: false,
        // Defaults, overridable. A spec naming its own config still wins, for
        // the same reason it does in Chart.
        config: { ...vegaTheme(dark), ...(parsed.spec!.config as object ?? {}) },
        // SVG rather than canvas: these sit in a scrolling transcript that gets
        // zoomed and printed, and canvas goes blurry at both.
        renderer: 'svg',
        // Fill the column. A figure that ignores the width it was given is the
        // most common reason one looks wrong next to prose.
        width: host.current.clientWidth - 8,
        // Vega-Lite emits its own console warnings for recoverable issues; they
        // are noise in a transcript nobody is debugging.
        logLevel: 0,
      });
      if (disposed) { result.view.finalize(); return; }
      view = result.view;
    }).catch((err: unknown) => {
      if (!disposed) setError(err instanceof Error ? err.message : String(err));
    });

    return () => {
      disposed = true;
      // Vega registers listeners and timers outside React. Without finalize a
      // scrolled-away figure keeps them, and a long transcript accumulates one
      // set per figure it has ever drawn.
      view?.finalize();
    };
  }, [source, streaming]);

  if (streaming) {
    return <p className="p-2 text-[11px] text-aico-muted">Figure arriving…</p>;
  }
  if (error) {
    // Thrown rather than rendered, so the widget frame owns every failure and
    // the Fix action is offered here exactly as it is for a crash mid-render.
    throw new Error(error);
  }
  return <div ref={host} className="w-full overflow-x-auto" />;
}
