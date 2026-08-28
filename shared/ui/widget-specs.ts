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
