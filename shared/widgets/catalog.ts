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
    id: 'places',
    languages: ['places', 'map', 'local'],
    extension: 'json',
    framed: true,
    summary: 'local places on an interactive map with rating pins and cards (restaurants, shops, hotels, "near me") — '
      + 'use for any answer that is a list of real places with coordinates',
    spec: `Places on an OpenStreetMap map: a rating pill per place, a row of cards over
the map, and an Expand button that opens a full-window map with a list, an
"Open now" filter and zoom. JSON:

{"title":"Coffee near Soho","places":[
  {"name":"Bar Italia","lat":51.5136,"lng":-0.1318,"rating":4.5,"reviews":2310,
   "category":"Café","address":"22 Frith St, London W1D 4RF","open":true,
   "hours":"Open 24 hours","price":"££","phone":"+44 20 7437 4520",
   "url":"https://baritaliasoho.co.uk","image":"https://…/photo.jpg",
   "note":"Late-night espresso institution","source":"Google Maps"},
  {"name":"Monmouth Coffee","lat":51.5143,"lng":-0.1266,"rating":4.7,"category":"Coffee shop","open":false,"price":"£"}]}

Fields: name, lat and lng are required per place (decimal degrees). Everything
else is optional — omit what you do not know rather than guessing:
  rating    0–5 (one decimal); reviews = count
  open      true / false / null (unknown). Only set it from real opening data.
  price     as written locally ("$$", "££", "PKR 1,500–3,000")
  url       the place's own site (http/https); without it the card links to
            OpenStreetMap at the coordinates
  image     an http(s) photo URL; a placeholder icon is drawn when absent
"center":[lat,lng] and "zoom" (1–19) are optional — by default the map fits
all places. Coordinates must be real (from a search or map lookup): a place
with made-up coordinates is drawn in the wrong street. A place with no
coordinates is listed but not pinned. Aliases: \`\`\`map, \`\`\`local.`,
  },
  {
    id: 'images',
    languages: ['images', 'gallery', 'carousel'],
    extension: 'json',
    framed: true,
    summary: 'a carousel of pictures with captions and sources, opening into a lightbox — '
      + 'use for "show me pictures/photos of …" and for generated images',
    spec: `A horizontal image carousel; clicking opens a lightbox (←/→, Esc, "Open source").

{"title":"Hunza Valley","images":[
  {"url":"https://upload.wikimedia.org/…/Hunza.jpg","caption":"Karimabad at dusk",
   "source":"Wikimedia Commons","link":"https://commons.wikimedia.org/wiki/File:Hunza.jpg",
   "alt":"Terraced village below snow peaks"},
  {"url":"/api/…/generated.png","caption":"Generated concept"}]}

url      required — an http(s) URL of the image itself (not a web page), or a
         same-origin path like /api/… for images the engine serves
caption  one line under the image; source = the site's name (a chip);
         link = the page the image came from (the chip and "Open source" go there)
A bare array of URL strings also works. Images that fail to load are hidden,
not shown broken — but use real image URLs you found, never invented ones.`,
  },
  {
    id: 'products',
    languages: ['products', 'shopping'],
    extension: 'json',
    framed: true,
    summary: 'shopping results as product cards (image, price, rating, store, badge, link) plus a spec comparison table — '
      + 'use for "best X to buy", price comparisons and product recommendations',
    spec: `Product cards in a row, each linking to the store; with specs, a comparison table.

{"title":"Noise-cancelling headphones under $400","compare":true,"products":[
  {"name":"Sony WH-1000XM6","image":"https://…/xm6.jpg","price":399.99,"currency":"USD",
   "rating":4.7,"reviews":1824,"store":"Best Buy","url":"https://www.bestbuy.com/…",
   "badge":"Best overall","specs":{"Battery":"30 h","Weight":"254 g","ANC":"Adaptive"}},
  {"name":"Bose QuietComfort Ultra","price":349,"currency":"USD","rating":4.5,
   "store":"Amazon","url":"https://www.amazon.com/…","badge":"Most comfortable",
   "specs":{"Battery":"24 h","Weight":"250 g","ANC":"Adaptive"}}]}

name is required. price is a number (formatted with "currency", an ISO code
like USD, EUR, PKR) or a string as written ("From £29"). rating is 0–5.
badge is a short label ("Best value"). specs is a flat object of short values;
use the SAME keys across products — each key becomes one table row.
"compare": true shows the table; it also appears on its own when 2–5 products
have specs; "compare": false hides it. Prices and ratings change — only give
figures you looked up, and say when they were checked.`,
  },
  {
    id: 'video',
    languages: ['video', 'youtube', 'videos'],
    extension: 'json',
    framed: true,
    summary: 'YouTube videos as thumbnail cards that play inline on click — use when recommending or citing videos',
    spec: `YouTube videos: a thumbnail card each; the player loads (from
youtube-nocookie.com) only when the reader clicks. Several videos form a row.

{"title":"Learn sourdough","videos":[
  {"url":"https://www.youtube.com/watch?v=2FVfJTGpXnU","title":"Sourdough for beginners",
   "channel":"Joshua Weissman","duration":"18:42"},
  {"url":"https://youtu.be/sTAiDki7OJ4?t=95","title":"Shaping a boule","channel":"King Arthur Baking"}]}

url      required — any YouTube form works: watch?v=, youtu.be/, /shorts/, /embed/,
         /live/, or the bare 11-character id; ?t=95 or t=1m35s starts there.
         A non-YouTube http(s) link is shown as a link card, not embedded.
title, channel, duration   shown on the card — give them; a card without a
         title just says "YouTube video".
A bare URL on its own line (or several) inside the fence also works. Only cite
videos you actually found — a made-up id is a dead thumbnail.`,
  },
  {
    id: 'news',
    languages: ['news'],
    extension: 'json',
    framed: true,
    summary: 'news headlines with source, favicon, age, picture and summary — use for current events and "latest on …"',
    spec: `A list of articles: source (with its favicon), how long ago, headline,
a line of summary and a thumbnail. The first five show; the rest behind "Show more".

{"title":"Latest on the monsoon","items":[
  {"title":"Record rainfall floods Karachi streets","source":"Dawn",
   "url":"https://www.dawn.com/news/…","date":"2026-09-29T06:30:00Z",
   "image":"https://…/photo.jpg","summary":"Parts of the city received 180 mm in 12 hours."}]}

title and url are required per item (url = the article). date is ISO 8601 —
shown as "3h ago", or the date when older than a week. source is the outlet's
name (defaults to the site's domain). Only list articles you actually found,
newest first, and give their real publication dates.`,
  },
  {
    id: 'draft',
    languages: ['draft', 'writing', 'email', 'post'],
    extension: 'json',
    framed: true,
    summary: 'a piece of writing to use elsewhere — email, social post, message, report, script — with copy, edit, '
      + 'open-in-mail and download; use whenever you write something the reader will send or paste',
    spec: `A draft with its own actions: Copy (formatted and plain), Edit in place,
"Open in mail app" for emails (mailto: with subject and body), download .md/.txt.

{"kind":"email","to":"hr@acme.com","cc":"lead@acme.com",
 "subject":"Leave request: 14–18 October",
 "body":"Hi Sara,\\n\\nI'd like to request annual leave from **14 to 18 October**.\\n\\n- Handover notes are in the team drive\\n- Ali will cover on-call\\n\\nThanks,\\nSuhail"}

kind     email | post | message | report | script | document (the badge)
body     required — Markdown, as a JSON string (newlines as \\n)
email    to, cc (strings; comma-separate several), subject
others   title (a heading), platform ("LinkedIn", "X", "WhatsApp") — X, Threads,
         Bluesky and LinkedIn also show a character count against their limit
Write the finished text in the body — no "[Your name]" placeholders when you
know the value. Plain Markdown inside the fence (optionally led by "To:" and
"Subject:" lines) is also accepted. Aliases: \`\`\`writing, \`\`\`email, \`\`\`post.`,
  },
  {
    id: 'weather',
    languages: ['weather'],
    extension: 'json',
    framed: true,
    summary: 'a weather card — current conditions, the next 24 hours and a 7-day forecast with icons and a °C/°F toggle',
    spec: `A weather card from forecast data (the Weather tool returns exactly this; if you
have it, pass its block through unchanged). Icons come from WMO weather codes.

{"location":"Lahore, Pakistan","lat":31.55,"lng":74.34,"timezone":"Asia/Karachi","units":"metric",
 "current":{"time":"2026-09-29T14:00","temp":33,"feels":36,"humidity":48,"wind":11,"code":1,"isDay":true},
 "hourly":[{"time":"2026-09-29T14:00","temp":33,"code":1,"precip":0},
           {"time":"2026-09-29T15:00","temp":34,"code":2,"precip":10}],
 "daily":[{"date":"2026-09-29","min":24,"max":35,"code":1,"precip":5,"sunrise":"2026-09-29T06:02","sunset":"2026-09-29T17:58"},
          {"date":"2026-09-30","min":25,"max":34,"code":61,"precip":60}],
 "source":"Open-Meteo"}

units    "metric" (°C, km/h) or "imperial" (°F, mph) — what the numbers ARE in;
         the reader can switch the display
code     WMO code: 0 clear, 1 mainly clear, 2 partly cloudy, 3 overcast, 45/48 fog,
         51–57 drizzle, 61–67 rain, 71–77 snow, 80–82 showers, 85/86 snow showers,
         95–99 thunderstorm
precip   chance of precipitation, in %
times    local wall time as "YYYY-MM-DDTHH:MM" (no offset); hourly starts at the
         current hour; up to 7 daily entries are shown
Needs "location" and either "current" (with "temp") or "daily". Never invent a
forecast: use the Weather tool, or say you could not get one.`,
  },
  {
    id: 'currency',
    languages: ['currency', 'fx', 'convert'],
    extension: 'json',
    framed: true,
    summary: 'an interactive currency converter over given exchange rates — both amounts editable, swap, other currencies listed',
    spec: `A converter: both amounts are editable and drive each other, a swap
button flips the pair, and any other currency in "rates" is one click away.

{"base":"USD","amount":250,"rates":{"PKR":278.4,"EUR":0.92,"GBP":0.78,"AED":3.6725},
 "date":"2026-09-29","source":"European Central Bank"}

base     the ISO code the rates are quoted against
rates    units of each currency per ONE base unit; the first is the default target
amount   the starting amount in the base currency (default 1)
date, source   always give them — rates move, and the reader must see how fresh
         these are. Use rates you looked up, never remembered ones.
One-pair shorthand: {"base":"USD","to":"PKR","rate":278.4,"amount":100}.
For physical units (km to miles, °C to °F, kg to lb) use \`\`\`calc — it converts
units exactly. Aliases: \`\`\`fx, \`\`\`convert.`,
  },
  {
    id: 'files',
    languages: ['files', 'downloads'],
    extension: 'json',
    framed: true,
    summary: 'cards for files you created or changed (reports, spreadsheets, decks, exports) — with Open and Show in folder in the desktop app',
    spec: `Cards for files: an icon by type (pdf, xlsx, docx, pptx, csv, md, image,
code, zip…), name, size and path. In the desktop app each card has Open (the
default app) and Show in folder; elsewhere the path can be copied.

{"title":"Your report","files":[
  {"path":"E:/work/q3/Q3-report.pdf","size":482133},
  {"path":"E:/work/q3/q3-figures.xlsx","name":"Q3 figures.xlsx","size":91200}]}

path     required — the ABSOLUTE path of a file that exists (relative paths do not
         open from the desktop app)
name     shown instead of the file name from the path; size is bytes;
         kind overrides the type detected from the extension
List only files you actually wrote in this conversation. Alias: \`\`\`downloads.`,
  },
  {
    id: 'sports',
    languages: ['sports', 'scores', 'scoreboard'],
    extension: 'json',
    framed: true,
    summary: 'a live scoreboard — game cards with crests, scores and a LIVE/FINAL/start-time state, and/or a league table '
      + '(the SportsScores tool returns it)',
    spec: `A scoreboard: one card per game (both sides with crest, score, winner in
bold; a pulsing LIVE pill with the clock, FINAL, or the start in the reader's
local time), a sideways row when there are many, and an optional league table.
Use the SportsScores tool for live data and paste its block as it is; never
invent or "remember" scores — if the tool could not get them, say so.

{"title":"Premier League","league":"Premier League","sport":"soccer","date":"2026-09-20",
 "games":[
  {"id":"401879272","status":"final","start":"2026-09-20T13:00:00Z","venue":"Etihad Stadium",
   "home":{"name":"Manchester City","short":"MNC","logo":"https://a.espncdn.com/i/teamlogos/soccer/500/382.png","score":"5","winner":true},
   "away":{"name":"Sunderland","short":"SUN","score":"3"}},
  {"status":"live","clock":"67'","home":{"name":"Fulham","score":"1"},"away":{"name":"Manchester United","score":"1"}},
  {"status":"scheduled","start":"2026-10-10T11:30:00Z","home":{"name":"Arsenal"},"away":{"name":"Leeds United"},"note":"Matchday 8"}],
 "standings":{"columns":["GP","W","D","L","GD","Pts"],"groups":[{"name":"Premier League","rows":[
  {"team":"Manchester City","logo":"https://…/382.png","values":[5,5,0,0,"+8",15]},
  {"team":"Arsenal","values":[5,4,0,1,"+4",12]}]}]},
 "source":"ESPN","updatedAt":"2026-09-29T09:40:19Z"}

status   scheduled | live | final | postponed
clock    what the clock says while live ("67'", "Q3 4:12", "Top 7th"); for a
         final, only when it adds something ("AET", "Final/OT")
start    ISO 8601 with a zone (UTC "Z") — shown in the reader's own time
home, away   name required; short, logo (https), score (string or number),
         record ("12-4", or the overs in cricket), winner (true on the final's winner)
sport    soccer and cricket list the home side first; basketball, football,
         baseball and hockey list the away side first
standings   columns are the header labels; each row's values follow them in order;
         rows are listed in table order (position = row number)
Needs "games" or "standings". Always give source and updatedAt — scores move.
Aliases: \`\`\`scores, \`\`\`scoreboard.`,
  },
  {
    id: 'canvas',
    languages: ['canvas'],
    extension: 'json',
    // The card is its own chrome; the frame's copy/download would act on a
    // three-field reference, not on the document.
    framed: false,
    summary: 'a card that opens a Canvas (the Canvas tool returns it) — for anything the user will iterate on — '
      + 'essays, emails, reports, specs, a code file — create a Canvas instead of pasting long text into the chat',
    spec: `A reference card for a canvas: a document or code file the user edits
directly beside the chat. The Canvas tool creates it and returns this block —
paste it as it is. It carries no content; the card reads the live document.

{"id":"cv-3f9a01bc2e","title":"Launch announcement","kind":"document"}

id      required — from Canvas create/list; never invent one
kind    document (Markdown) or code; language for code ("python")
Write the text with the Canvas tool (create, then edit/update), never inside
this block and never pasted again into the reply. The user may edit the canvas
between turns, so read it before changing it.`,
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
