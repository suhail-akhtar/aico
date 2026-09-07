/**
 * The worked feature's logic, pure: no React, no native, so vitest runs it in
 * Node. The screen calls these and renders what comes back.
 */
export interface Item { id: string; name: string; done: boolean; createdAt: number }

let counter = 0;
/** Unique enough for a session; replace with a persisted id when storage arrives. */
export function nextId(now = Date.now()): string {
  counter += 1;
  return `${now.toString(36)}-${counter}`;
}

export function parseName(raw: string): { value: string } | { error: string } {
  const name = raw.trim();
  if (!name) return { error: 'Give it a name.' };
  if (name.length > 120) return { error: 'Keep it under 120 characters.' };
  return { value: name };
}

/** Open items first, newest first within each group. */
export function addItem(items: Item[], raw: string, now = Date.now()): { items: Item[] } | { error: string } {
  const parsed = parseName(raw);
  if ('error' in parsed) return parsed;
  const item: Item = { id: nextId(now), name: parsed.value, done: false, createdAt: now };
  return { items: sort([item, ...items]) };
}

export function toggleItem(items: Item[], id: string): Item[] {
  return sort(items.map(i => (i.id === id ? { ...i, done: !i.done } : i)));
}

export function removeItem(items: Item[], id: string): Item[] {
  return items.filter(i => i.id !== id);
}

export function sort(items: Item[]): Item[] {
  return [...items].sort((a, b) => Number(a.done) - Number(b.done) || b.createdAt - a.createdAt);
}
