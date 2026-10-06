/**
 * Edits to the cached item lists, for optimistic updates.
 *
 * Why this exists: an item is shown in an infinite list (several pages in one
 * cache entry). A mutation that waits for the server before the screen changes
 * feels slow; one that changes the screen first needs a way to patch every page
 * and, if the server says no, put everything back exactly. These helpers do the
 * patching on the generated query key and return a snapshot to restore. The
 * server stays the source of truth: every mutation ends by invalidating the
 * lists, which replaces the optimistic rows with what the API really holds.
 */

import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';
import type { Item, ItemPage } from '../../api/generated';

export const PAGE_SIZE = 20;
export const PENDING_PREFIX = 'pending-';

export type ItemsData = InfiniteData<ItemPage>;
export type Snapshot = Array<[QueryKey, ItemsData | undefined]>;

export function isListKey(key: QueryKey): boolean {
  const head = key[0];
  return (
    typeof head === 'object' && head !== null && (head as { _id?: unknown })._id === 'listItems'
  );
}

const listFilter = { predicate: (query: { queryKey: QueryKey }) => isListKey(query.queryKey) };

export const isPendingItem = (item: Pick<Item, 'id'>): boolean =>
  item.id.startsWith(PENDING_PREFIX);

let counter = 0;
export function pendingId(): string {
  counter += 1;
  return `${PENDING_PREFIX}${counter}`;
}

export function snapshotLists(client: QueryClient): Snapshot {
  return client.getQueriesData<ItemsData>(listFilter);
}

export function restoreLists(client: QueryClient, snapshot: Snapshot): void {
  for (const [key, data] of snapshot) client.setQueryData(key, data);
}

export function cancelLists(client: QueryClient): Promise<void> {
  return client.cancelQueries(listFilter);
}

export function invalidateLists(client: QueryClient): Promise<void> {
  return client.invalidateQueries(listFilter);
}

function mapItems(data: ItemsData, fn: (items: Item[]) => Item[]): ItemsData {
  return { ...data, pages: data.pages.map((page) => ({ ...page, items: fn(page.items) })) };
}

export function prependItem(client: QueryClient, item: Item): void {
  client.setQueriesData<ItemsData>(listFilter, (data) => {
    if (!data || data.pages.length === 0) return data;
    const [first, ...rest] = data.pages;
    return first
      ? { ...data, pages: [{ ...first, items: [item, ...first.items] }, ...rest] }
      : data;
  });
}

export function patchItem(client: QueryClient, id: string, patch: Partial<Item>): void {
  client.setQueriesData<ItemsData>(listFilter, (data) =>
    data
      ? mapItems(data, (items) => items.map((i) => (i.id === id ? { ...i, ...patch } : i)))
      : data,
  );
}

export function removeItem(client: QueryClient, id: string): void {
  client.setQueriesData<ItemsData>(listFilter, (data) =>
    data ? mapItems(data, (items) => items.filter((i) => i.id !== id)) : data,
  );
}

/** Every loaded item, once: a page boundary can repeat a row when something was created while paging. */
export function flatten(data: ItemsData | undefined): Item[] {
  const seen = new Map<string, Item>();
  for (const page of data?.pages ?? []) for (const item of page.items) seen.set(item.id, item);
  return [...seen.values()];
}
