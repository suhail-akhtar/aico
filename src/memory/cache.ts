import type { MemoryEntry } from './types.js';

const DEFAULT_TTL_MS = 60_000; // 60 seconds
let _ttlMs = DEFAULT_TTL_MS;

export function setMemoryCacheTtl(ttlSeconds: number): void {
  _ttlMs = ttlSeconds * 1000;
}

interface CacheEntry {
  data: MemoryEntry;
  timestamp: number;
}

const _cache = new Map<string, CacheEntry>();
let _hits = 0;
let _misses = 0;

export function getCached(filePath: string): MemoryEntry | undefined {
  const entry = _cache.get(filePath);
  if (!entry) {
    _misses++;
    return undefined;
  }
  if (Date.now() - entry.timestamp > _ttlMs) {
    _cache.delete(filePath);
    _misses++;
    return undefined;
  }
  _hits++;
  return entry.data;
}

export function setCached(filePath: string, data: MemoryEntry): void {
  _cache.set(filePath, { data, timestamp: Date.now() });
}

export function invalidate(filePath: string): void {
  _cache.delete(filePath);
}

export function invalidateAll(): void {
  _cache.clear();
}

export function getCacheStats() {
  let oldestAge = 0;
  const now = Date.now();
  for (const entry of _cache.values()) {
    const age = now - entry.timestamp;
    if (age > oldestAge) oldestAge = age;
  }
  return {
    hits: _hits,
    misses: _misses,
    entries: _cache.size,
    oldestEntryAge: oldestAge,
  };
}

export function resetCacheStats(): void {
  _hits = 0;
  _misses = 0;
}
