import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import { z } from 'zod';
import { appName } from '../../app/context';
import { type DialogState, ItemsPage } from '../../features/items/ItemsPage';
import { t } from '../../shared/i18n/i18n';

const searchSchema = z.object({
  dialog: z.enum(['new', 'edit', 'delete']).optional(),
  id: z.uuid().optional(),
});

export const Route = createFileRoute('/_authed/items')({
  validateSearch: searchSchema,
  head: () => ({ meta: [{ title: `${t('items.title')} · ${appName}` }] }),
  component: Items,
});

function Items() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  // Opening a dialog is a history entry (Back closes it); closing replaces it.
  const onSearch = useCallback(
    (next: DialogState) => {
      void navigate({ search: next, replace: !next.dialog });
    },
    [navigate],
  );
  return <ItemsPage search={search} onSearch={onSearch} />;
}
