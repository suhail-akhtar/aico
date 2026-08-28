/**
 * What a fenced block can turn into — the one list, read from both ends.
 *
 * Two very different consumers need to agree about this, and until now they
 * only agreed by coincidence. `MarkdownRenderer` decided which fences draw, by
 * matching against sets defined next to the components. `prompts.ts` told the
 * model which fences draw, in prose written months earlier. Nothing connected
 * them, so the failure mode was silent in both directions: a renderer nobody
 * was told about is dead code, and a documented block with no renderer shows up
 * as a wall of JSON in the transcript with no indication anything went wrong.
 *
 * ## Why the spec is not in the prompt
 *
 * Each kind carries a one-line `summary` and a full `spec`. Only the summaries
 * are in the system prompt. That is not tidiness — it is the whole reason this
 * file is shaped this way.
 *
 * The prompt's rendered-blocks section is prefix text on every request of every
 * session, and prefix is what prompt caching bills for. Three kinds with worked
 * examples cost about thirty lines, which is affordable. Fifteen would cost
 * several hundred, on every request, for a capability most turns never use —
 * and the cost is paid whether or not anything is ever drawn.
 *
 * So the catalog is injected and the specs are queried. A model that decides to
 * draw something asks for the contract it needs, once, on the turn it needs it.
 * The same trade the codemap makes, for the same reason.
 *
 * ## Why some specs are inline anyway
 *
 * `chart`, `table` and `mermaid` keep worked examples in the prompt. They are
 * the overwhelming majority of what gets drawn, a round trip to look up a
 * format the model already knows would be latency spent on nothing, and that
 * text is already written and already cached. Novelty is what needs looking up.
 *
 * @module shared/widgets/catalog
 */

export interface WidgetKind {
  /** Stable identity. Names the renderer and labels the widget frame. */
  id: string;
  /**
   * Fence languages that select this renderer.
   *
   * More than one because a model reaches for the obvious word rather than the
   * documented one — `plot` and `echarts` for a chart, `datatable` for a table.
   * Accepting the synonyms costs a set entry and saves a block that would
   * otherwise render as unexplained JSON.
   */
  languages: readonly string[];
  /** Download extension, without the dot. */
  extension: string;
  /**
   * Whether the shared widget frame wraps it.
   *
   * The frame carries copy, download, expand, hide and — when the block fails —
   * the offer to have it repaired. Diagrams and HTML previews predate it and
   * bring their own chrome, so framing them would double the border.
   */
  framed: boolean;
  /** One line for the prompt catalog. Says what it is *for*, not what it takes. */
  summary: string;
  /**
   * The full contract: shape, a worked example, and the conventions a model
   * cannot guess. Retrieved on demand, never injected.
   */
  spec: string;
}

/**
 * `satisfies` rather than a type annotation, and it is load-bearing.
 *
 * Annotating this `readonly WidgetKind[]` would widen every `id` to `string`,
 * and the renderer map keyed on those ids would degrade to `Record<string, …>`
 * — which accepts anything, including nothing. The compile-time guarantee that
 * every catalogued kind has a component would quietly become no guarantee at
 * all, while still looking exactly like one. `satisfies` checks the shape and
 * keeps the literals.
 */
export const WIDGET_CATALOG = [
  {
    id: 'chart',
    languages: ['chart', 'echarts', 'plot'],
    extension: 'json',
    framed: true,
    summary: 'an Apache ECharts option object — bar, line, pie, scatter, treemap, '
      + 'sankey, funnel, gauge, radar, heatmap, boxplot, candlestick, sunburst, graph',
    spec: `An Apache ECharts option object, as JSON. Must have \`series\`.

{"xAxis":{"type":"category","data":["Mon","Tue"]},"yAxis":{"type":"value"},
 "series":[{"type":"bar","data":[12,19]}]}

Every value must be computed. ECharts draws what you give it and nothing else,
so a histogram means you emit the bins and a trend line means you emit the
fitted points. When the shape of the answer is statistical rather than already
known, \`viz\` is the cheaper block — it computes from raw rows.

Colours, gridlines, fonts and spacing are already set. An explicit \`color\` or
\`itemStyle\` overrides a palette checked for colourblind separation against
these surfaces, so restyle only when the data genuinely needs it.`,
  },
  {
    id: 'viz',
    languages: ['viz', 'vega', 'vegalite', 'vega-lite'],
    extension: 'json',
    framed: true,
    summary: 'a Vega-Lite spec — statistical graphics that compute from raw rows: '
      + 'histograms, regression, density, box plots, faceted small multiples, cross-filtering',
    spec: `A Vega-Lite v6 specification, as JSON. Needs \`data\` and a \`mark\`.

{"data":{"values":[{"a":1,"b":22},{"a":2,"b":31}]},
 "mark":"point","encoding":{"x":{"field":"a","type":"quantitative"},
 "y":{"field":"b","type":"quantitative"}}}

Reach for this instead of \`chart\` whenever the answer is statistical, because
the library computes it and you do not. Give it the raw rows and say what you
want shown:

  binning      "x":{"field":"v","bin":true,"type":"quantitative"}
               with "y":{"aggregate":"count"} — a histogram from raw values
  aggregate    "y":{"aggregate":"mean","field":"v","type":"quantitative"}
  regression   "transform":[{"regression":"y","on":"x"}] — also "loess"
  density      "transform":[{"density":"v","bandwidth":0.3}]
  quantile     "transform":[{"quantile":"v","probs":[0.25,0.5,0.75]}]
  window       "transform":[{"window":[{"op":"mean","field":"v","as":"ma"}],
               "frame":[-6,0]}] — moving averages, running totals, ranks
  box plot     "mark":{"type":"boxplot"} — from the raw values, not five numbers
  error bars   "mark":"errorbar" with "extent":"ci"
  facets       "facet":{"field":"g","columns":3} wrapping a "spec" — small
               multiples, which beat one crowded chart almost every time
  pivot/fold   reshape wide to long and back without restating the data

Interaction is declarative too. A \`params\` entry with \`"select":"point"\` plus
an \`"opacity"\` or \`"filter"\` condition gives click-to-drill and cross-filtering
between concatenated views, with no code:

  "params":[{"name":"pick","select":{"type":"point","encodings":["x"]}}],
  "encoding":{"opacity":{"condition":{"param":"pick","value":1},"value":0.25}}

Do not pre-compute what a transform can do. Emitting bins, fitted points or box
statistics costs tokens twice over and puts arithmetic you did by hand into a
figure that could have derived it exactly.

Colours, gridlines, fonts and spacing come from the same validated palette
\`chart\` uses. An explicit \`config\` or \`color\` value overrides a scale that was
checked for colourblind separation against these surfaces.`,
  },
  {
    id: 'table',
    languages: ['table', 'datatable'],
    extension: 'json',
    framed: true,
    summary: 'a sortable table with automatic column summaries',
    spec: `{"columns":["Region","Spend"],"rows":[["EU",1200],["US",980]]}

Rows are arrays in column order, NOT objects. Numeric columns get sorting and a
sum/mean/min/max row without you computing them.`,
  },
  {
    id: 'diagram',
    languages: ['mermaid', 'diagram', 'flowchart', 'sequence', 'gantt'],
    extension: 'mmd',
    framed: false,
    summary: 'a Mermaid diagram — flowchart, sequence, ER, state, class, gantt; '
      + 'use for architecture, network topology and component diagrams',
    spec: `Mermaid source, exactly as Mermaid takes it.

graph TD
  A[Client] --> B[API]
  B --> C[(Database)]

Supports flowchart, sequenceDiagram, erDiagram, stateDiagram-v2, classDiagram,
gantt, journey and C4. Node text containing brackets, quotes or parentheses
must be quoted, which is the single most common reason one fails to parse.`,
  },
  {
    id: 'html',
    languages: ['html', 'htm', 'svg', 'preview'],
    extension: 'html',
    framed: false,
    summary: 'a rendered HTML or SVG preview, sandboxed with scripts off',
    spec: `Ordinary HTML or SVG, rendered in a sandboxed frame with a source toggle.

Scripts are disabled unless the reader turns them on, and the frame cannot
reach the page around it. Do not rely on JavaScript running: anything that only
works when scripted will look broken to a reader who never enables it.`,
  },
] as const satisfies readonly WidgetKind[];

/** One catalogued kind, with its id and languages kept as literals. */
export type CatalogEntry = (typeof WIDGET_CATALOG)[number];

/** Which kind, if any, a fence language selects. */
export function widgetForLanguage(language: string): CatalogEntry | undefined {
  const wanted = language.toLowerCase();
  return WIDGET_CATALOG.find(kind => (kind.languages as readonly string[]).includes(wanted));
}

/** A kind by id, for the spec lookup. */
export function widgetById(id: string): CatalogEntry | undefined {
  return WIDGET_CATALOG.find(kind => kind.id === id);
}

/**
 * The catalog as it appears in the prompt: one line each, canonical fence
 * first. Generated rather than written out, so a kind cannot be added to the
 * renderer and forgotten in the prompt.
 */
export function catalogLines(): string {
  return WIDGET_CATALOG
    .map(kind => `\`\`\`${kind.languages[0]} — ${kind.summary}`)
    .join('\n');
}
