import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { itemsFor } from '@/lib/items';
import { ItemForm } from '@/components/ItemForm';
import { removeItem, toggleItemAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * The worked feature's screen. Server component: it reads the database directly
 * and renders; the only client code is the add form (for inline errors).
 * Actions are plain forms, so everything works with JavaScript off.
 */
export default async function ItemsPage() {
  const user = await requireUser();
  const items = itemsFor(db(), user.id);
  const open = items.filter(i => !i.done).length;

  return (
    <div className="space-y-6">
      <div className="flex items-end gap-4">
        <div>
          <h1 className="text-2xl font-bold">Items</h1>
          <p className="text-ink-muted text-sm">
            {items.length === 0 ? 'Nothing yet.' : `${open} open · ${items.length - open} done`}
          </p>
        </div>
      </div>

      <ItemForm />

      {items.length === 0 ? (
        <div className="card text-center text-ink-muted">No items yet. Add the first one above.</div>
      ) : (
        <ul className="card divide-y divide-line p-0">
          {items.map(item => (
            <li key={item.id} className="flex items-center gap-3 px-4 py-3">
              <form action={toggleItemAction}>
                <input type="hidden" name="id" value={item.id} />
                <button
                  type="submit"
                  className={`h-5 w-5 rounded border border-line flex items-center justify-center text-xs ${item.done ? 'bg-brand text-brand-ink border-brand' : ''}`}
                  aria-label={item.done ? `Mark ${item.name} not done` : `Mark ${item.name} done`}
                >
                  {item.done ? '✓' : ''}
                </button>
              </form>
              <span className={`flex-1 ${item.done ? 'line-through text-ink-muted' : ''}`}>{item.name}</span>
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
