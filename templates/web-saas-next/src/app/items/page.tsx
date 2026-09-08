import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { itemsFor } from '@/lib/items';
import { ItemForm } from '@/components/ItemForm';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusPill } from '@/components/ui/StatusPill';
import { removeItem, toggleItemAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * The worked feature's screen. Server component: it reads the database directly
 * and renders; the only client code is the add form (for inline errors).
 * Actions are plain forms, so everything works with JavaScript off.
 *
 * The shape every list screen copies: a page header with the counts, the way
 * to add one, then the list — or an empty state that says what the list is for.
 */
export default async function ItemsPage() {
  const user = await requireUser();
  const items = itemsFor(db(), user.id);
  const open = items.filter(i => !i.done).length;

  return (
    <div>
      <PageHeader
        title="Items"
        context={items.length === 0 ? 'Things to do, in the order you added them.' : `${open} open · ${items.length - open} done`}
      />

      <div className="mb-6 max-w-xl">
        <ItemForm />
      </div>

      {items.length === 0 ? (
        <EmptyState
          title="Nothing here yet"
          description="Add the first item above. Tick it when it is done; delete it when it no longer matters."
        />
      ) : (
        <ul className="card divide-y divide-line p-0">
          {items.map(item => (
            <li key={item.id} className="flex items-center gap-3 px-4 py-3">
              <form action={toggleItemAction}>
                <input type="hidden" name="id" value={item.id} />
                <button
                  type="submit"
                  className={`flex h-5 w-5 items-center justify-center rounded border border-line text-xs ${item.done ? 'border-brand bg-brand text-brand-ink' : ''}`}
                  aria-label={item.done ? `Mark ${item.name} not done` : `Mark ${item.name} done`}
                >
                  {item.done ? '✓' : ''}
                </button>
              </form>
              <span className={`flex-1 ${item.done ? 'text-ink-muted line-through' : ''}`}>{item.name}</span>
              <StatusPill tone={item.done ? 'success' : 'neutral'}>{item.done ? 'Done' : 'Open'}</StatusPill>
              <form action={removeItem}>
                <input type="hidden" name="id" value={item.id} />
                <button type="submit" className="btn btn-danger btn-sm" aria-label={`Delete ${item.name}`}>Delete</button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
