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

import { DIAGRAM_TYPES, diagramIndex } from './diagram-types.js';
import { KIT_CATALOG } from '../kit/catalog.js';
import { OPTION_CONTRACTS } from '../kit/contracts.js';

/** The kit's widgets by category, one short line each, for the widgets spec. */
function kitIndex(): string {
  const byCat = new Map<string, string[]>();
  for (const w of KIT_CATALOG) {
    const sig = OPTION_CONTRACTS[w.id]?.signature ?? '';
    const short = sig.length > 110 ? sig.slice(0, 107) + '…' : sig;
    const line = `  ${w.id} — ${w.description}` + (short ? `\n      ${short}` : '');
    byCat.set(w.category, [...(byCat.get(w.category) ?? []), line]);
  }
  return [...byCat.entries()].map(([c, lines]) => `${c}:\n${lines.join('\n')}`).join('\n');
}

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
    id: 'dashboard',
    languages: ['dashboard', 'board'],
    extension: 'json',
    framed: true,
    summary: 'several figures as one board — KPI tiles with sparklines plus a responsive '
      + 'grid of chart/viz/table panels; use this when asked for a dashboard',
    spec: `One board, in one block. Needs \`panels\`.

{"title":"Q3 performance","subtitle":"USD millions",
 "stats":[{"label":"Revenue","value":"$9,850M","delta":"+17.8%","direction":"up",
           "series":[4820,5940,7120,8360,9850]}],
 "panels":[
  {"title":"Growth","span":2,"kind":"chart","spec":{"xAxis":{"type":"category",
    "data":["FY24","FY25"]},"yAxis":{"type":"value"},
    "series":[{"type":"bar","data":[8360,9850]}]}},
  {"title":"Peers","kind":"table","spec":{"columns":["Company","Margin %"],
    "rows":[["Aurora",22.4],["Vertex",24.0]]}}]}

stats   optional headline tiles. \`value\` is already formatted — the tile does
        no arithmetic. \`direction\` is up/down/flat and is what colours the
        delta, NOT the sign: falling debt is good news and rising churn is not,
        and only you know which way a given number reads. \`series\` draws a
        sparkline.
panels  \`kind\` is chart, viz or table, and \`spec\` is exactly what that block
        takes on its own. \`span\`: 2 for full width, otherwise half. \`note\` is
        one line underneath.

Dashboards do not nest — a panel cannot be a dashboard. Use \`span\` for
emphasis instead.

Reach for this whenever the ask is a dashboard, an overview or "all of it in
one view". Do not build an HTML file for that: this draws in the chat, and a
page on disk is something the reader has to go and open.`,
  },
  {
    id: 'math',
    languages: ['math', 'latex', 'tex', 'katex'],
    extension: 'tex',
    framed: true,
    summary: 'LaTeX set as mathematics — also available inline in ordinary prose as '
      + '$x^2$ and as a display formula between $$ … $$; covers chemistry via \\ce{}',
    spec: `LaTeX, rendered by KaTeX.

Three places it works, and the block is only one of them:

  $E = mc^2$              inline, in the middle of a sentence
  $$\\int_0^1 x^2 dx$$      display, its own centred line
  \`\`\`math                 a block, with copy, download and expand

**Write mathematics as mathematics.** Backticks around \`2x = 10\` produce code
formatting for something that is not code, and drawing a fraction or a balance
scale out of ASCII art produces something no reader can follow. If it is a
formula, set it as one — this renders in the chat.

Chemistry through mhchem:

  $\\ce{2H2 + O2 -> 2H2O}$          equations, arrows, states, charges
  $\\ce{SO4^2-}$                    charges and subscripts
  $\\pu{123 kJ//mol}$               physical units

Available beyond standard KaTeX: \\deriv{y}{x}, \\pderiv{f}{x}, \\abs{x},
\\norm{v}.

Use the block for anything worth its own line — a derivation, a system of
equations, a matrix. Use inline for a symbol or a short expression inside a
sentence, because a formula on its own line breaks the reading otherwise.

  \`\`\`math
  \\begin{aligned}
    3x - 2 &= 10 \\\\
    3x &= 12 \\\\
    x &= 4
  \\end{aligned}
  \`\`\`

\`aligned\` with \`&=\` is how a worked solution lines up on the equals sign,
which is what makes each step readable as a step.`,
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
    framed: true,
    summary: `a Mermaid diagram — ${DIAGRAM_TYPES.length} types covering architecture (C4, `
      + 'block, cloud), behaviour (flowchart, sequence, state), structure (class, ER) '
      + 'and planning (gantt, timeline, kanban, mindmap, quadrant, requirements)',
    spec: `Mermaid source, exactly as Mermaid takes it. The first keyword picks
the diagram; everything after it is that diagram's own syntax.

flowchart TD
  A[Client] --> B[API]
  B --> C[(Database)]

Call \`WidgetSpec\` again with the type name — "c4container", "architecture",
"gantt" — for a worked example of that one specifically. These all render in
this build; the list is generated from the same samples a check renders on
every run, so nothing here is aspirational:

${diagramIndex()}

Pick by what the diagram has to say, not by what it is called. A request for
"the architecture" is usually C4Context or C4Container; "how does a request
flow" is sequenceDiagram or C4Dynamic; "what runs where" is C4Deployment or
architecture-beta; "the plan" is gantt or timeline.

Node text containing brackets, quotes or parentheses must be quoted. That is
the single most common reason a diagram fails to parse.`,
  },
  {
    id: 'widgets',
    languages: ['widgets', 'aico-widgets', 'aetnic-widgets', 'kit'],
    extension: 'json',
    framed: true,
    summary: `a dashboard grid of rich widgets — ${KIT_CATALOG.length} kinds: stat/KPI tiles, gauges, `
      + 'time series, bar/pie/scatter/radar/sankey/boxplot/funnel, heatmaps, calendars, treemaps, gantt, '
      + 'pipelines, scorecards, SLOs, network and service maps, doc panels and action buttons',
    spec: `{"title":"Release health","widgets":[
  {"widget":"stat","title":"Build time","span":{"w":4,"h":1},"options":{"label":"p50","value":142,"unit":"s","previous":171,"lowIsGood":true}},
  {"widget":"radial","title":"Coverage","span":{"w":4,"h":2},"options":{"value":81,"min":0,"max":100,"unit":"%","warn":70,"crit":50}},
  {"widget":"barchart","title":"Bugs by area","span":{"w":4,"h":2},"options":{"items":[["API",12],["UI",7],["DB",3]]}}
]}

A 12-column grid. Each widget: "widget" (an id below), "title", "span" {"w":1-12,"h":1-8}
(h is rows of ~100px), "options" (that widget's own shape), optional "note" and
"section" (a heading above it). Put related numbers side by side: w 3-4 for tiles,
w 6-12 for charts. The data is what you write — use real values, never invented ones.

Before writing a widget you have not used in this conversation, call WidgetSpec
with "widgets.<id>" (e.g. "widgets.gantt") for its exact options and an example.
Widget options differ from ECharts options: do not mix them.

Widgets by purpose:
${kitIndex()}`,
  },
  {
    id: 'plot',
    languages: ['plot2d', 'function', 'functions', 'fplot', 'graph'],
    extension: 'json',
    framed: true,
    summary: 'mathematical functions plotted exactly — y=f(x), derivatives, parametric and polar curves, points, and the computed area of an integral',
    spec: `{"title":"sin and its derivative","x":[-6.2832,6.2832],"y":[-1.5,1.5],
 "functions":[{"fn":"sin(x)","label":"sin x"},{"fn":"x^2/10","dashed":true}],
 "derivatives":false,"integral":[0,3.1416],
 "points":[[1.5708,1,"max"]],
 "parametric":[{"x":"cos(t)","y":"sin(t)","t":[0,6.2832],"label":"unit circle"}],
 "polar":[{"r":"1+cos(theta)","label":"cardioid"}]}

Or just lines:  y = x^3 - 3x   /   f(x) = exp(-x^2)   /   x: -3..3

Functions are evaluated here, so write the function, not points. Syntax is
mathjs: ^ power, * explicit multiply, sqrt, exp, log (natural), log10, abs,
sin/cos/tan (radians), pi, e. "derivatives": true adds each derivative (computed
symbolically). "integral": [a, b] shades the area under the first function and
reports its value (computed with Simpson's rule). Discontinuities (tan, 1/x) are
broken, not joined, when "y" is given.`,
  },
  {
    id: 'geometry',
    languages: ['geometry', 'geo', 'construction', 'figure'],
    extension: 'json',
    framed: true,
    summary: 'a geometric figure drawn to scale — points, segments, lines, vectors, circles, polygons and marked angles, with lengths, angles and areas computed',
    spec: `{"title":"Right triangle","points":{"A":[0,0],"B":[4,0],"C":[0,3]},
 "polygons":[["A","B","C"]],
 "segments":[["A","B","4"],["B","C","5"]],
 "angles":[["B","A","C"],["A","B","C"]],
 "circles":[{"center":"A","through":"B"}],
 "vectors":[["A","C","v"]],
 "lines":[], "rays":[], "labels":[{"at":"C","text":"apex"}],
 "grid":true, "axes":false, "measure":true}

Coordinates are real units with y up. Everything refers to points by name.
segments take an optional label; angles are [arm, vertex, arm] (a right angle
draws a square marker). Lengths, angles, polygon areas/perimeters and circle
measures are computed from the coordinates and listed under the figure — so put
the true coordinates in, and the numbers will be right.`,
  },
  {
    id: 'calc',
    languages: ['calc', 'calculation', 'physics', 'units', 'mathjs'],
    extension: 'txt',
    framed: true,
    summary: 'a worked calculation that is really computed — step by step, typeset, with units, unit conversion and physical constants',
    spec: `# Kinetic energy of a thrown ball
mass = 0.145 kg
v0 = 40 m/s
KE = 1/2 * mass * v0^2        # joules
KE to J
height = KE / (mass * g0)      # if all of it became height
height to m
f(x) = 3x^2 + 2
f(4)

One statement per line, evaluated in order; names carry forward. Units attach
to numbers (5 kg, 9.81 m/s^2, 3 km/h, 20 degC) and flow through the arithmetic;
"expr to unit" converts. Comments start with # (a line of its own is a heading).
Constants: g0 (standard gravity), c0 (speed of light), G, planck, hbar, kB,
NA, qe, me, mp, eps0, mu0, R_gas, sigma_sb — or mathjs names like speedOfLight.

NEVER name a variable after a unit: m, s, g, h, J, N, K, A, V, W, Pa, L, t, in,
ft are units, and "3 m/s" after "m = 2" silently uses your m. Use mass, t1, len.
Every result shown is computed here — write the formula, not the answer.`,
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
