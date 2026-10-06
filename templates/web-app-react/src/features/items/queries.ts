/**
 * Server state for items: the list, and create / update / delete with optimistic updates.
 *
 * Each mutation follows the same four steps (TanStack Query's documented
 * pattern): cancel in-flight list fetches so they cannot overwrite the
 * optimistic state, snapshot, patch the cache, and on error restore the
 * snapshot. `onSettled` always invalidates, so the screen converges on what the
 * server holds whatever happened. The generated `*Mutation` / `*InfiniteOptions`
 * factories carry the request shapes; nothing here builds a URL.
 */

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createItemMutation,
  deleteItemMutation,
  listItemsInfiniteOptions,
  replaceItemMutation,
} from '../../api/generated/@tanstack/react-query.gen';
import {
  cancelLists,
  invalidateLists,
  PAGE_SIZE,
  patchItem,
  pendingId,
  prependItem,
  removeItem,
  restoreLists,
  snapshotLists,
} from './cache';

export function useItems() {
  return useInfiniteQuery({
    ...listItemsInfiniteOptions({ query: { limit: PAGE_SIZE } }),
    initialPageParam: {},
    getNextPageParam: (last) => last.next_cursor || undefined,
  });
}

export function useCreateItem() {
  const client = useQueryClient();
  return useMutation({
    ...createItemMutation(),
    onMutate: async ({ body }) => {
      await cancelLists(client);
      const snapshot = snapshotLists(client);
      const now = new Date().toISOString();
      prependItem(client, {
        id: pendingId(),
        name: body.name,
        description: body.description ?? null,
        quantity: body.quantity ?? 0,
        created_at: now,
        updated_at: now,
      });
      return { snapshot };
    },
    onError: (_error, _vars, context) => {
      if (context) restoreLists(client, context.snapshot);
    },
    onSettled: () => invalidateLists(client),
  });
}

export function useUpdateItem() {
  const client = useQueryClient();
  return useMutation({
    ...replaceItemMutation(),
    onMutate: async ({ path, body }) => {
      await cancelLists(client);
      const snapshot = snapshotLists(client);
      patchItem(client, path.id, {
        name: body.name,
        description: body.description ?? null,
        quantity: body.quantity ?? 0,
        updated_at: new Date().toISOString(),
      });
      return { snapshot };
    },
    onError: (_error, _vars, context) => {
      if (context) restoreLists(client, context.snapshot);
    },
    onSettled: () => invalidateLists(client),
  });
}

export function useDeleteItem() {
  const client = useQueryClient();
  return useMutation({
    ...deleteItemMutation(),
    onMutate: async ({ path }) => {
      await cancelLists(client);
      const snapshot = snapshotLists(client);
      removeItem(client, path.id);
      return { snapshot };
    },
    onError: (_error, _vars, context) => {
      if (context) restoreLists(client, context.snapshot);
    },
    onSettled: () => invalidateLists(client),
  });
}
