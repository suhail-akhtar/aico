import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { getItemOptions } from '../../api/generated/@tanstack/react-query.gen';
import { t, tn } from '../../shared/i18n/i18n';
import { ApiError } from '../../shared/problem';
import { Button } from '../../shared/ui/Button';
import { Dialog } from '../../shared/ui/Dialog';
import { EmptyState, ErrorState, ItemsSkeleton } from '../../shared/ui/Feedback';
import { useToast } from '../../shared/ui/Toast';
import { flatten } from './cache';
import { ItemForm } from './ItemForm';
import { ItemList } from './ItemList';
import { useDeleteItem, useItems } from './queries';

/** Which dialog is open, kept in the URL so it can be linked to and Back closes it. */
export interface DialogState {
  dialog?: 'new' | 'edit' | 'delete' | undefined;
  id?: string | undefined;
}

interface Props {
  search: DialogState;
  onSearch: (next: DialogState) => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function ItemsPage({ search, onSearch }: Props) {
  const toast = useToast();
  const query = useItems();
  const remove = useDeleteItem();
  const items = useMemo(() => flatten(query.data), [query.data]);

  const needsItem = (search.dialog === 'edit' || search.dialog === 'delete') && !!search.id;
  const loaded = needsItem ? items.find((i) => i.id === search.id) : undefined;
  // A link straight to /items?dialog=edit&id=... may name an item that is not on the first page.
  const lookup = useQuery({
    ...getItemOptions({ path: { id: search.id ?? '' } }),
    enabled: needsItem && !loaded && !query.isPending,
    retry: false,
  });
  const current = loaded ?? lookup.data;
  const close = () => onSearch({});

  useEffect(() => {
    if (lookup.isError) onSearch({});
  }, [lookup.isError, onSearch]);

  // "N" opens the create dialog from anywhere on the page that is not a text box.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== 'n' || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.defaultPrevented || isTypingTarget(event.target) || search.dialog) return;
      event.preventDefault();
      onSearch({ dialog: 'new' });
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [search.dialog, onSearch]);

  function confirmDelete() {
    if (!current) return;
    const id = current.id;
    remove.mutate(
      { path: { id } },
      {
        onSuccess: () => toast.push('success', t('toast.deleted')),
        onError: (error) => {
          // 404 means it is already gone: the refetch removes it and there is nothing to apologise for.
          if (!(error instanceof ApiError && error.status === 404))
            toast.push('error', t('toast.deleteFailed'));
        },
      },
    );
    close();
  }

  const newButton = (
    <Button variant="primary" onClick={() => onSearch({ dialog: 'new' })} aria-keyshortcuts="n">
      {t('items.new')}
    </Button>
  );

  return (
    <section aria-labelledby="items-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 id="items-heading" className="text-2xl font-semibold">
            {t('items.title')}
          </h1>
          {items.length > 0 ? (
            <p aria-live="polite" className="text-sm text-muted">
              {tn('items.count', items.length)}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-1">
          {newButton}
          <span className="hidden text-xs text-muted sm:block">{t('items.newHint')}</span>
        </div>
      </div>

      <div className="mt-6">
        {query.isPending ? (
          <ItemsSkeleton />
        ) : query.isError ? (
          <ErrorState
            title={t('items.loadFailed')}
            body={
              query.error instanceof ApiError && query.error.isNetwork
                ? t('error.network')
                : undefined
            }
            onRetry={() => void query.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            title={t('items.empty.title')}
            body={t('items.empty.body')}
            action={newButton}
          />
        ) : (
          <>
            <ItemList
              items={items}
              onEdit={(item) => onSearch({ dialog: 'edit', id: item.id })}
              onDelete={(item) => onSearch({ dialog: 'delete', id: item.id })}
            />
            {query.hasNextPage ? (
              <div className="mt-4 flex justify-center">
                <Button
                  onClick={() => void query.fetchNextPage()}
                  loading={query.isFetchingNextPage}
                >
                  {query.isFetchingNextPage ? t('items.loadingMore') : t('items.loadMore')}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <Dialog open={search.dialog === 'new'} onClose={close} title={t('form.create.title')}>
        <ItemForm onDone={close} onCancel={close} />
      </Dialog>

      <Dialog
        open={search.dialog === 'edit' && !!current}
        onClose={close}
        title={t('form.edit.title')}
      >
        <ItemForm key={current?.id} item={current} onDone={close} onCancel={close} />
      </Dialog>

      <Dialog
        open={search.dialog === 'delete' && !!current}
        onClose={close}
        title={t('delete.title')}
      >
        <p className="mt-2 text-muted">{t('delete.body', { name: current?.name ?? '' })}</p>
        <div className="mt-6 flex justify-end gap-2">
          {/* The safe choice holds focus when the dialog opens. */}
          <Button onClick={close} data-autofocus>
            {t('form.cancel')}
          </Button>
          <Button variant="danger" onClick={confirmDelete}>
            {t('delete.confirm')}
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
