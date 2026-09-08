/**
 * One figure with its name and, optionally, what it is made of. A dashboard is
 * three to five of these in a row, then a table — not a wall of them.
 */
export function StatCard({ label, value, detail }: { label: string; value: React.ReactNode; detail?: React.ReactNode }) {
  return (
    <div className="card">
      <div className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</div>
      <div className="mt-2 text-3xl font-semibold tabular-nums tracking-tight">{value}</div>
      {detail && <div className="mt-1 text-sm text-ink-muted">{detail}</div>}
    </div>
  );
}
