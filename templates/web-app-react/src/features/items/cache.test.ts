import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { Item } from '../../api/generated';
import { listItemsInfiniteQueryKey } from '../../api/generated/@tanstack/react-query.gen';
import {
  flatten,
  type ItemsData,
  isListKey,
  isPendingItem,
  patchItem,
  pendingId,
  prependItem,
  removeItem,
  restoreLists,
  snapshotLists,
} from './cache';

const item = (id: string, name = id): Item => ({
  id,
  name,
  description: null,
  quantity: 0,
  created_at: '2026-10-06T10:00:00Z',
  updated_at: '2026-10-06T10:00:00Z',
});

function seeded() {
  const client = new QueryClient();
  const key = listItemsInfiniteQueryKey({ query: { limit: 20 } });
  const data: ItemsData = {
    pages: [
      { items: [item('a'), item('b')], next_cursor: 'c1' },
      { items: [item('c')], next_cursor: null },
    ],
    pageParams: [{}, 'c1'],
  };
  client.setQueryData(key, data);
  client.setQueryData(['session'], { id: 'u', email: 'x' });
  return { client, key };
}

describe('item list cache edits', () => {
  it('recognises list keys and nothing else', () => {
    expect(isListKey(listItemsInfiniteQueryKey())).toBe(true);
    expect(isListKey(['session'])).toBe(false);
    expect(isListKey([null])).toBe(false);
  });

  it('prepends to the first page only', () => {
    const { client, key } = seeded();
    prependItem(client, item('new'));
    expect(client.getQueryData<ItemsData>(key)?.pages.map((p) => p.items.map((i) => i.id))).toEqual(
      [['new', 'a', 'b'], ['c']],
    );
  });

  it('patches and removes an item on whichever page holds it', () => {
    const { client, key } = seeded();
    patchItem(client, 'c', { name: 'renamed' });
    expect(flatten(client.getQueryData<ItemsData>(key)).find((i) => i.id === 'c')?.name).toBe(
      'renamed',
    );
    removeItem(client, 'a');
    expect(flatten(client.getQueryData<ItemsData>(key)).map((i) => i.id)).toEqual(['b', 'c']);
  });

  it('restores a snapshot exactly, and leaves unrelated queries alone', () => {
    const { client, key } = seeded();
    const snapshot = snapshotLists(client);
    expect(snapshot).toHaveLength(1);
    removeItem(client, 'a');
    prependItem(client, item('x'));
    restoreLists(client, snapshot);
    expect(flatten(client.getQueryData<ItemsData>(key)).map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(client.getQueryData(['session'])).toEqual({ id: 'u', email: 'x' });
  });

  it('ignores edits when nothing is cached yet', () => {
    const client = new QueryClient();
    expect(() => {
      prependItem(client, item('x'));
      patchItem(client, 'x', { name: 'y' });
      removeItem(client, 'x');
    }).not.toThrow();
  });

  it('lists every item once, even if a page boundary repeats a row', () => {
    const data: ItemsData = {
      pages: [{ items: [item('a'), item('b')] }, { items: [item('b', 'newer'), item('c')] }],
      pageParams: [{}, 'x'],
    };
    expect(flatten(data).map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(flatten(data)[1]?.name).toBe('newer');
    expect(flatten(undefined)).toEqual([]);
  });

  it('marks optimistic items with unique pending ids', () => {
    const one = pendingId();
    const two = pendingId();
    expect(one).not.toBe(two);
    expect(isPendingItem({ id: one })).toBe(true);
    expect(isPendingItem({ id: '5c4b5d84-4ac0-45a1-8b8a-2b6bf0a5c2de' })).toBe(false);
  });
});
