import { describe, expect, it } from 'vitest';
import { openDatabase } from '@/lib/db';
import { dashboard, kpi, parseMetric, perDay, record } from '@/lib/metrics';

describe('aggregation (pure)', () => {
  it('sums per day, ascending', () => {
    const points = perDay([
      { value: 2, at: '2026-09-02 10:00:00' },
      { value: 3, at: '2026-09-01 09:00:00' },
      { value: 5, at: '2026-09-02 18:00:00' },
    ]);
    expect(points).toEqual([{ day: '2026-09-01', value: 3 }, { day: '2026-09-02', value: 7 }]);
  });
  it('computes total, last and the change from the previous day', () => {
    const k = kpi('signups', [{ day: 'a', value: 10 }, { day: 'b', value: 15 }]);
    expect(k.total).toBe(25);
    expect(k.last).toBe(15);
    expect(k.change).toBeCloseTo(0.5);
    expect(kpi('x', [{ day: 'a', value: 1 }]).change).toBeNull();
    expect(kpi('x', [{ day: 'a', value: 0 }, { day: 'b', value: 4 }]).change).toBeNull();
  });
  it('parses an ingest body', () => {
    expect(parseMetric({ name: 'signups', value: '3' })).toEqual({ value: { name: 'signups', value: 3 } });
    expect('errors' in parseMetric({ name: 'bad name!', value: 'x' })).toBe(true);
    expect('errors' in parseMetric(null)).toBe(true);
  });
});

describe('the dashboard over sqlite', () => {
  it('seeds sample data so the first open is not blank', () => {
    const db = openDatabase(':memory:');
    const view = dashboard(db, 14);
    expect(Object.keys(view.series).sort()).toEqual(['revenue', 'signups']);
    expect(view.series.signups!.length).toBe(14);
    expect(view.kpis.find(k => k.name === 'signups')!.total).toBeGreaterThan(0);
  });
  it('records and aggregates a new series without seed', () => {
    const db = openDatabase(':memory:', { seed: false });
    record(db, 'errors', 1);
    record(db, 'errors', 2);
    const view = dashboard(db, 1);
    expect(view.kpis).toEqual([{ name: 'errors', total: 3, last: 3, change: null }]);
  });
});
