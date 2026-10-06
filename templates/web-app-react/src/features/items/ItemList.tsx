import type { Item } from '../../api/generated';
import { formatDateTime, formatNumber, t } from '../../shared/i18n/i18n';
import { Button } from '../../shared/ui/Button';
import { isPendingItem } from './cache';

interface Props {
  items: Item[];
  onEdit: (item: Item) => void;
  onDelete: (item: Item) => void;
}

/**
 * One list for every width: stacked on a phone, a row with the actions on the
 * right from `sm` up. A real list (not a table whose cells are restyled) keeps
 * its semantics in every layout; an item still being saved is marked busy and
 * cannot be edited or deleted until the server has it.
 */
export function ItemList({ items, onEdit, onDelete }: Props) {
  return (
    <ul
      aria-label={t('items.list.label')}
      className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface"
    >
      {items.map((item) => {
        const pending = isPendingItem(item);
        return (
          <li
            key={item.id}
            aria-busy={pending || undefined}
            className={`flex flex-col gap-3 p-4 sm:flex-row sm:items-center ${pending ? 'opacity-60' : ''}`}
          >
            <div className="min-w-0 flex-1">
              <p className="break-words font-semibold">{item.name}</p>
              {item.description ? (
                <p className="mt-0.5 line-clamp-2 break-words text-sm text-muted">
                  {item.description}
                </p>
              ) : null}
              <p className="mt-1 text-xs text-muted">
                {t('items.quantity', { quantity: formatNumber(item.quantity) })}
                {' · '}
                {pending
                  ? t('items.pending')
                  : t('items.updated', { when: formatDateTime(item.updated_at) })}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                disabled={pending}
                onClick={() => onEdit(item)}
                aria-label={t('items.edit', { name: item.name })}
              >
                {t('items.editAction')}
              </Button>
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => onDelete(item)}
                aria-label={t('items.delete', { name: item.name })}
              >
                {t('items.deleteAction')}
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
