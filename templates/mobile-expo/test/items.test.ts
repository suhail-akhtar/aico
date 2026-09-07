import { describe, expect, it } from 'vitest';
import { addItem, parseName, removeItem, toggleItem, type Item } from '../src/lib/items';

describe('items', () => {
  it('refuses an empty or overlong name', () => {
    expect(parseName('   ')).toEqual({ error: 'Give it a name.' });
    expect('error' in parseName('x'.repeat(121))).toBe(true);
    expect(addItem([], '')).toEqual({ error: 'Give it a name.' });
  });
  it('adds newest first and keeps open before done', () => {
    let items: Item[] = [];
    items = (addItem(items, 'first', 1) as { items: Item[] }).items;
    items = (addItem(items, 'second', 2) as { items: Item[] }).items;
    expect(items.map(i => i.name)).toEqual(['second', 'first']);
    items = toggleItem(items, items[0]!.id);
    expect(items.map(i => [i.name, i.done])).toEqual([['first', false], ['second', true]]);
    items = toggleItem(items, items[1]!.id);
    expect(items[0]!.name).toBe('second');
  });
  it('removes by id', () => {
    const items = (addItem([], 'x') as { items: Item[] }).items;
    expect(removeItem(items, items[0]!.id)).toEqual([]);
    expect(removeItem(items, 'nope')).toHaveLength(1);
  });
});
