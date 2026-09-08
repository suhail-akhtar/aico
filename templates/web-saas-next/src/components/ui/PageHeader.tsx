/**
 * Every working screen starts with this: the title, one line of context
 * (counts, totals, what the list holds), and the primary action on the right.
 * A screen with nothing to do has no button, not a disabled one.
 */
export function PageHeader({ title, context, action }: { title: string; context?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {context && <p className="mt-1 text-sm text-ink-muted">{context}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
