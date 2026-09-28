/**
 * Which component draws which kind.
 *
 * The other half of {@link module:shared/widgets/catalog}: that file says what
 * exists and what it takes, this one says what renders it. Split because the
 * two halves have different audiences — the catalog is read by the server to
 * build the prompt and answer spec lookups, and cannot import React; this is
 * read only by the browser.
 *
 * ## The drift is a type error, not a bug report
 *
 * `Record<WidgetId, …>` is the load-bearing part. Adding a kind to the catalog
 * and forgetting to write its renderer stops the build here, rather than
 * shipping a documented block that renders as a wall of JSON. That failure is
 * invisible in exactly the way that matters: the model does as it was told, the
 * reader sees raw text, and nothing anywhere reports an error.
 *
 * ## Why the components are not themselves lazy
 *
 * Every renderer here is small; what is large is the library each one pulls in,
 * and each already fetches its own on first use — echarts in `Chart`, mermaid
 * in `Diagram`. So the expensive thing is already deferred, and wrapping the
 * cheap wrappers in `React.lazy` would buy a few kilobytes at the price of a
 * Suspense boundary around every fenced block. The existing idiom is better.
 *
 * @module shared/ui/widget-registry
 */

import React from 'react';
import { WIDGET_CATALOG } from '../widgets/catalog';
import type { CatalogEntry, WidgetKind } from '../widgets/catalog';
import { Chart } from './Chart';
import { DataTable } from './DataTable';
import { Diagram } from './Diagram';
import { HtmlPreview } from './HtmlPreview';
import { Viz } from './Viz';
import { Dashboard } from './Dashboard';
import { MathBlock } from './MathBlock';

/*
  The widget kit and the maths renderers are loaded on first use: together
  they bring a charting engine, a schema library and an expression engine, and
  a conversation that never draws a dashboard or a function plot should not pay
  for them.
*/
const Cluster = React.lazy(() => import('../kit/Cluster').then(m => ({ default: m.Cluster })));
const Plot = React.lazy(() => import('../kit/math/Plot').then(m => ({ default: m.Plot })));
const Geometry = React.lazy(() => import('../kit/math/Geometry').then(m => ({ default: m.Geometry })));
const Calc = React.lazy(() => import('../kit/math/Calc').then(m => ({ default: m.Calc })));

function Lazy({ children }: { children: React.ReactNode }): React.ReactElement {
  return <React.Suspense fallback={<p className="p-2 text-[11px] text-aico-muted">Loading…</p>}>{children}</React.Suspense>;
}

export type { CatalogEntry, WidgetKind };
export { widgetForLanguage, widgetById, WIDGET_CATALOG } from '../widgets/catalog';

/** Every id in the catalog. A renderer is required for each. */
export type WidgetId = CatalogEntry['id'];

export interface WidgetRenderProps {
  /** The block's source, after any correction has been substituted in. */
  source: string;
  /**
   * True while the block is still arriving.
   *
   * A fenced block streams a character at a time, so a renderer that parses
   * eagerly reports an error for every incomplete prefix and the failure state
   * flickers through the whole message before settling on success.
   */
  streaming?: boolean;
  /**
   * The fence language actually written.
   *
   * Kinds that accept synonyms mostly ignore this; `html` uses it to tell an
   * SVG from a document.
   */
  language: string;
}

/**
 * The renderers, by kind id.
 *
 * Typed as a total map over the catalog so the compiler enforces coverage —
 * see the module note. Each entry adapts its component to one prop shape, which
 * is what lets the dispatch below be a lookup rather than a chain of `if`s.
 */
const RENDERERS: Record<WidgetId, React.ComponentType<WidgetRenderProps>> = {
  chart: ({ source, streaming }) => <Chart source={source} streaming={streaming ?? false} />,
  viz: ({ source, streaming }) => <Viz source={source} streaming={streaming ?? false} />,
  dashboard: ({ source, streaming }) => <Dashboard source={source} streaming={streaming ?? false} />,
  math: ({ source, streaming }) => <MathBlock source={source} streaming={streaming ?? false} />,
  table: ({ source, streaming }) => <DataTable source={source} streaming={streaming} />,
  diagram: ({ source, streaming }) => <Diagram source={source} streaming={streaming ?? false} />,
  html: ({ source, language }) => <HtmlPreview html={source} language={language} />,
  widgets: ({ source, streaming }) => <Lazy><Cluster source={source} streaming={streaming} /></Lazy>,
  plot: ({ source, streaming }) => <Lazy><Plot source={source} streaming={streaming} /></Lazy>,
  geometry: ({ source, streaming }) => <Lazy><Geometry source={source} streaming={streaming} /></Lazy>,
  calc: ({ source, streaming }) => <Lazy><Calc source={source} streaming={streaming} /></Lazy>,
};

/** The component for a kind, or undefined if the fence is ordinary code. */
export function rendererFor(kind: CatalogEntry): React.ComponentType<WidgetRenderProps> | undefined {
  return RENDERERS[kind.id];
}
