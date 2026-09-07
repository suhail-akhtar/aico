/**
 * The worked feature's data layer: record a metric, and aggregate a series
 * per day for the chart and the tiles. Pure functions take the database, so
 * tests run in memory; the aggregation is separate from the query so it can
 * be tested without SQLite at all.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface Metric { id: number; name: string; value: number; at: string }
export interface Point { day: string; value: number }

export function parseMetric(body: unknown): { value: { name: string; value: number } } | { errors: Record<string, string> } {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!/^[a-z][a-z0-9_.-]{0,60}$/i.test(name)) errors.name = 'A short identifier like "signups" or "api.latency_ms".';
  const value = Number(b.value);
  if (!Number.isFinite(value)) errors.value = 'A number.';
  return Object.keys(errors).length ? { errors } : { value: { name, value } };
}

export function record(db: DatabaseSync, name: string, value: number, at?: string): Metric {
  const { lastInsertRowid } = at
    ? db.prepare('INSERT INTO metrics (name, value, at) VALUES (?, ?, ?)').run(name, value, at)
    : db.prepare('INSERT INTO metrics (name, value) VALUES (?, ?)').run(name, value);
  return db.prepare('SELECT * FROM metrics WHERE id = ?').get(Number(lastInsertRowid)) as unknown as Metric;
}

export function seriesNames(db: DatabaseSync): string[] {
  return (db.prepare('SELECT DISTINCT name FROM metrics ORDER BY name').all() as Array<{ name: string }>).map(r => r.name);
}

export function rowsFor(db: DatabaseSync, name: string, days: number): Metric[] {
  return db.prepare("SELECT * FROM metrics WHERE name = ? AND at >= datetime('now', ?) ORDER BY at")
    .all(name, `-${days} days`) as unknown as Metric[];
}

/** Sum per calendar day, days ascending. Pure. */
export function perDay(rows: Array<Pick<Metric, 'value' | 'at'>>): Point[] {
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const day = r.at.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + r.value);
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, value]) => ({ day, value }));
}

export interface Kpi { name: string; total: number; last: number; change: number | null }

/** Total over the window, the latest day, and the change from the day before (fraction, or null). Pure. */
export function kpi(name: string, points: Point[]): Kpi {
  const total = points.reduce((s, p) => s + p.value, 0);
  const last = points.at(-1)?.value ?? 0;
  const prev = points.at(-2)?.value;
  const change = prev === undefined || prev === 0 ? null : (last - prev) / prev;
  return { name, total, last, change };
}

export function dashboard(db: DatabaseSync, days = 14): { kpis: Kpi[]; series: Record<string, Point[]> } {
  const series: Record<string, Point[]> = {};
  const kpis: Kpi[] = [];
  for (const name of seriesNames(db)) {
    const points = perDay(rowsFor(db, name, days));
    series[name] = points;
    kpis.push(kpi(name, points));
  }
  return { kpis, series };
}
