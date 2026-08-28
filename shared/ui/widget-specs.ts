/**
 * Reading the specifications a model writes for rendered widgets.
 *
 * Separate from the components that draw them, because parsing is the part
 * that has to be *right* and the part worth testing, and testing it through a
 * React tree would mean a DOM and a charting library to assert that a trailing
 * comma is a trailing comma.
 *
 * ## Every failure names the actual mistake
 *
 * These blocks are written by a model that cannot see the renderer, so it
 * guesses shapes. The sibling AIOps console documented exactly what that costs:
 * an operator asked for a network diagram and got `widget failed: s.map is not
 * a function`, because the orchestrator had emitted a perfectly reasonable
 * array-of-objects where the widget read arrays. Nothing had told it otherwise.
 *
 * So an error here says which key was wrong and what it should have been,
 * because that message is what the agent gets handed when the reader asks for
 * a repair. "Invalid table spec" would send it round the same loop.
 *
 * @module shared/ui/widget-specs
 */

export interface TableSpec {
  columns: string[];
  rows: Array<Array<string | number | null>>;
  title?: string;
}

export interface ColumnSummary {
  sum: number;
  mean: number;
  min: number;
  max: number;
  count: number;
}

/**
 * Read a chart block as an ECharts option object.
 *
 * The `series` check earns its place: a spec without one parses as valid JSON
 * and renders an empty grid, which looks like a broken renderer rather than an
 * incomplete specification.
 */
export function parseChartSpec(
  source: string,
): { option?: Record<string, unknown>; error?: string } {
  const text = source.trim();
  if (!text) return { error: 'the chart block is empty' };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'a chart spec must be a JSON object of ECharts options' };
    }
    const option = parsed as Record<string, unknown>;
    if (!option.series && !option.dataset) {
      return { error: 'no `series` in the chart spec — there is nothing to draw' };
    }
    return { option };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `the chart spec is not valid JSON — ${message}` };
  }
}

/**
 * Read a viz block, and locate the mistake when there is one.
 *
 * The two structural checks are here rather than left to Vega because Vega
 * accepts both mistakes and renders an empty white box. A figure that silently
 * shows nothing is the worst outcome available: there is no error to report, no
 * Fix button to press, and nothing for the reader to conclude except that the
 * feature is broken. Better to fail loudly with the reason.
 */
export function parseVizSpec(
  source: string,
): { spec?: Record<string, unknown>; error?: string } {
  const text = source.trim();
  if (!text) return { error: 'the viz block is empty' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `the viz spec is not valid JSON — ${message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'a viz spec must be a JSON object of Vega-Lite options' };
  }

  const spec = parsed as Record<string, unknown>;
  // Any one of these means something will be drawn. Composition operators count
  // because a concat or facet carries its marks in the views underneath.
  const DRAWS = ['mark', 'layer', 'hconcat', 'vconcat', 'concat', 'facet', 'repeat', 'spec'];
  if (!DRAWS.some(key => key in spec)) {
    return { error: 'no `mark` and no composition operator in the viz spec — there is nothing to draw' };
  }
  if (!('data' in spec)) {
    return { error: 'no `data` in the viz spec — use {"values": [...]} with the rows inline' };
  }
  return { spec };
}

/** One tile in a dashboard's headline row. */
export interface DashboardStat {
  label: string;
  value: string | number;
  /** Change against the previous period, already formatted — "+17.8%". */
  delta?: string;
  /** Which way is being reported. Colour only follows this, never the sign. */
  direction?: 'up' | 'down' | 'flat';
  /** History behind the number, drawn as a sparkline. */
  series?: number[];
}

/** One panel in a dashboard grid. */
export interface DashboardPanel {
  title?: string;
  /** Which renderer draws it. Dashboards do not nest. */
  kind: 'chart' | 'viz' | 'table';
  /** The spec that renderer takes, exactly as the standalone block would. */
  spec: unknown;
  /** 1 for a half-width panel, 2 for a full-width one. */
  span?: 1 | 2;
  /** One line under the panel saying what it shows. */
  note?: string;
}

export interface DashboardSpec {
  title?: string;
  subtitle?: string;
  stats?: DashboardStat[];
  panels: DashboardPanel[];
}

/** Panel kinds a dashboard may contain. Deliberately excludes `dashboard`. */
const PANEL_KINDS = new Set(['chart', 'viz', 'table']);

/**
 * Read a dashboard block, and locate the mistake when there is one.
 *
 * Stricter than the other parsers because a dashboard is a composite: one bad
 * panel out of nine should say *which* panel and why, not fail the whole board
 * with a message about the outermost object. A reader looking at eight charts
 * and one gap needs to know which gap.
 */
export function parseDashboardSpec(
  source: string,
): { spec?: DashboardSpec; error?: string } {
  const text = source.trim();
  if (!text) return { error: 'the dashboard block is empty' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `the dashboard spec is not valid JSON — ${message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'a dashboard spec must be a JSON object with `panels`' };
  }

  const spec = parsed as Record<string, unknown>;
  const panels = spec.panels;
  if (!Array.isArray(panels) || panels.length === 0) {
    return { error: 'no `panels` in the dashboard spec — there is nothing to lay out' };
  }

  for (let i = 0; i < panels.length; i++) {
    const panel = panels[i] as Record<string, unknown> | null;
    const where = `panel ${i + 1}${panel?.title ? ` ("${String(panel.title)}")` : ''}`;
    if (!panel || typeof panel !== 'object' || Array.isArray(panel)) {
      return { error: `${where} is not an object` };
    }
    if (typeof panel.kind !== 'string' || !PANEL_KINDS.has(panel.kind)) {
      // Naming the panel kinds beats "invalid kind": the most likely mistake is
      // reaching for a fence language rather than a panel kind, and the fix is
      // then obvious rather than a guess.
      return {
        error: `${where} has kind "${String(panel.kind)}" — must be chart, viz or table. `
          + 'Dashboards do not nest.',
      };
    }
    if (panel.spec === undefined || panel.spec === null) {
      return { error: `${where} has no \`spec\`, so there is nothing to draw in it` };
    }
  }

  if (spec.stats !== undefined && !Array.isArray(spec.stats)) {
    return { error: '`stats` must be an array of tiles' };
  }

  return { spec: spec as unknown as DashboardSpec };
}

/** Read a table block, and locate the mistake when there is one. */
export function parseTableSpec(source: string): { spec?: TableSpec; error?: string } {
  const text = source.trim();
  if (!text) return { error: 'the table block is empty' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      error: `the table spec is not valid JSON — ${
        error instanceof Error ? error.message : String(error)}`,
    };
  }
  const candidate = parsed as Partial<TableSpec> | null;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { error: 'a table spec must be a JSON object with `columns` and `rows`' };
  }
  if (!Array.isArray(candidate.columns) || !candidate.columns.every(c => typeof c === 'string')) {
    return { error: '`columns` must be an array of strings' };
  }
  if (!Array.isArray(candidate.rows) || !candidate.rows.every(Array.isArray)) {
    return {
      error: '`rows` must be an array of arrays, one per row, in column order — '
        + 'not an array of objects',
    };
  }
  const width = candidate.columns.length;
  const ragged = candidate.rows.findIndex(row => row.length !== width);
  if (ragged !== -1) {
    return {
      error: `row ${ragged + 1} has ${candidate.rows[ragged]!.length} cells but there are `
        + `${width} columns`,
    };
  }
  return { spec: candidate as TableSpec };
}

/**
 * A cell's numeric value, or undefined if it is not a number.
 *
 * Thousands separators, a currency symbol and a trailing percent are all still
 * numbers to a reader. A column of "1,024" that summed to nothing would look
 * like a broken table rather than a strict one.
 */
export function numericValue(cell: string | number | null | undefined): number | undefined {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : undefined;
  if (typeof cell !== 'string') return undefined;
  const cleaned = cell.trim().replace(/[,\s]/g, '').replace(/^[$£€]/, '').replace(/%$/, '');
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return undefined;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Which columns carry enough numbers to be worth arithmetic.
 *
 * A clear majority rather than all of them: one "n/a" in a column of hundreds
 * should not cost the whole column its right-alignment and its stats.
 */
export function numericColumns(spec: TableSpec): boolean[] {
  return spec.columns.map((_, index) => {
    const cells = spec.rows.map(row => row[index]).filter(c => c !== null && c !== '');
    if (cells.length === 0) return false;
    const numbers = cells.filter(c => numericValue(c) !== undefined);
    return numbers.length / cells.length >= 0.8;
  });
}

/** Sum, mean, min, max and count for one column, or nothing if it has no numbers. */
export function summarise(spec: TableSpec, index: number): ColumnSummary | undefined {
  const values = spec.rows
    .map(row => numericValue(row[index]))
    .filter((v): v is number => v !== undefined);
  if (values.length === 0) return undefined;
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    sum,
    mean: sum / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    count: values.length,
  };
}
