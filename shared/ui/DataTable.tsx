/**
 * Tables, with the arithmetic a reader would otherwise do by hand.
 *
 * A table of numbers in a chat is usually the *start* of a question — which is
 * biggest, what do they add up to, is anything missing. Answering that in the
 * table costs nothing and saves a round trip to the model, which is the
 * expensive way to compute a sum.
 *
 * ## Why not a table library
 *
 * Sorting and a summary row is genuinely all that is wanted here, and every
 * headless table library is larger than that and brings a styling problem with
 * it. The chart renderer takes a dependency because it buys thirty chart types;
 * this one would buy a comparator.
 *
 * ## Numeric columns are detected, not declared
 *
 * A model asked to tag its own column types gets it wrong on the column that
 * matters — the one with `1,024` or `92%` in it. Reading the values is both
 * more reliable and one less thing for the spec to carry.
 *
 * @module shared/ui/DataTable
 */

import React, { useMemo, useState } from 'react';
import {
  numericColumns, numericValue, parseTableSpec, summarise, type TableSpec,
} from './widget-specs';

function format(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function DataTable({ source }: { source: string }): React.ReactElement {
  const parsed = useMemo(() => parseTableSpec(source), [source]);
  const [sort, setSort] = useState<{ index: number; descending: boolean } | null>(null);
  const [showStats, setShowStats] = useState(false);

  // Thrown, not rendered: the widget frame owns every failure state so a bad
  // table offers the same Fix action as a bad chart.
  if (parsed.error) throw new Error(parsed.error);
  const spec = parsed.spec!;

  const numeric = useMemo(() => numericColumns(spec), [spec]);
  const rows = useMemo(() => {
    if (!sort) return spec.rows;
    const { index, descending } = sort;
    // Copied before sorting: the spec is memoised from the source and sorting
    // it in place would mutate what every other render reads.
    return [...spec.rows].sort((a, b) => {
      const left = numeric[index] ? numericValue(a[index] ?? null) : undefined;
      const right = numeric[index] ? numericValue(b[index] ?? null) : undefined;
      const result = left !== undefined && right !== undefined
        ? left - right
        : String(a[index] ?? '').localeCompare(String(b[index] ?? ''));
      return descending ? -result : result;
    });
  }, [spec, sort, numeric]);

  const hasNumbers = numeric.some(Boolean);

  return (
    <div className="space-y-1.5">
      <div className="max-h-[420px] overflow-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead className="sticky top-0 bg-aico-bg">
            <tr>
              {spec.columns.map((column, index) => (
                <th
                  key={column}
                  onClick={() => setSort(current => ({
                    index,
                    descending: current?.index === index ? !current.descending : false,
                  }))}
                  className={`cursor-pointer select-none border-b border-aico-border px-2 py-1
                              text-left font-medium text-aico-secondary hover:text-aico-primary
                              ${numeric[index] ? 'text-right' : ''}`}
                  title="Sort by this column"
                >
                  {column}
                  {sort?.index === index && (
                    <span className="ml-1 text-aico-muted">{sort.descending ? '↓' : '↑'}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className="border-b border-aico-border-subtle last:border-0">
                {row.map((cell, c) => (
                  <td key={c} className={`px-2 py-1 text-aico-secondary ${
                    numeric[c] ? 'text-right tabular-nums' : ''}`}>
                    {cell === null ? '' : String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-2 text-[11px] text-aico-muted">
        <span>{spec.rows.length} row{spec.rows.length === 1 ? '' : 's'}</span>
        {hasNumbers && (
          <button
            onClick={() => setShowStats(v => !v)}
            className="rounded px-1.5 py-0.5 transition-colors hover:bg-aico-hover hover:text-aico-primary"
          >
            {showStats ? 'hide stats' : 'stats'}
          </button>
        )}
      </div>

      {showStats && (
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="text-aico-muted">
              <th className="px-2 py-0.5 text-left font-normal">column</th>
              {['sum', 'mean', 'min', 'max', 'n'].map(h => (
                <th key={h} className="px-2 py-0.5 text-right font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {spec.columns.map((column, index) => {
              if (!numeric[index]) return null;
              const stats = summarise(spec, index);
              if (!stats) return null;
              return (
                <tr key={column} className="text-aico-secondary">
                  <td className="px-2 py-0.5">{column}</td>
                  <td className="px-2 py-0.5 text-right tabular-nums">{format(stats.sum)}</td>
                  <td className="px-2 py-0.5 text-right tabular-nums">{format(stats.mean)}</td>
                  <td className="px-2 py-0.5 text-right tabular-nums">{format(stats.min)}</td>
                  <td className="px-2 py-0.5 text-right tabular-nums">{format(stats.max)}</td>
                  <td className="px-2 py-0.5 text-right tabular-nums">{stats.count}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
