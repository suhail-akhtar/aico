import { db } from '@/lib/db';
import { dashboard } from '@/lib/metrics';
import { Chart } from '@/components/Chart';

export const dynamic = 'force-dynamic';

/**
 * The worked feature's screen. Server component: it aggregates on the server
 * and hands the chart plain data; the only client code is the chart itself.
 * Lead with the answer — the tiles say what happened — then the trend.
 */
export default function Home() {
  const { kpis, series } = dashboard(db(), 14);
  const names = Object.keys(series);

  return (
    <div className="space-y-6">
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-kpis>
        {kpis.map(k => (
          <div key={k.name} className="card">
            <div className="kpi-label">{k.name}</div>
            <div className="kpi-value">{format(k.last)}</div>
            <div className="mt-1 text-xs text-ink-muted">
              {k.change === null ? 'no prior day' : (
                <span className={k.change >= 0 ? 'text-good' : 'text-bad'}>
                  {k.change >= 0 ? '▲' : '▼'} {Math.abs(Math.round(k.change * 100))}% vs previous day
                </span>
              )}
              {' · '}14-day total {format(k.total)}
            </div>
          </div>
        ))}
        {kpis.length === 0 && (
          <div className="card text-ink-muted sm:col-span-2 lg:col-span-4">
            No metrics yet. POST one to <code>/api/metrics</code> and this page fills in.
          </div>
        )}
      </section>

      {names.length > 0 && (
        <section className="card">
          <h2 className="mb-3 text-sm font-semibold text-ink-muted">Last 14 days</h2>
          <Chart series={series} />
        </section>
      )}
    </div>
  );
}

function format(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
