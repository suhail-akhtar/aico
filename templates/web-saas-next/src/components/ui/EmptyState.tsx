/**
 * An empty list says what it is for and offers the first action. "No results"
 * on its own tells a new user nothing about what they are looking at.
 */
export function EmptyState({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="card flex flex-col items-center py-12 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 max-w-sm text-sm text-ink-muted">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
