/** `user-model` is `~/.aico/USER.md`: lines about the user, written by adoption, capped small. */
export type MemoryType = 'user' | 'user-model' | 'parent' | 'rules' | 'project' | 'local';

export interface MemoryEntry {
  type: MemoryType;
  path: string;
  content: string;
  loadedAt: number;
}

export interface MemoryReadOptions {
  types?: MemoryType[];
  /** Maximum chars per type section (default: 50_000) */
  maxSizePerType?: number;
  forceRefresh?: boolean;
}

export interface MemoryCacheStats {
  hits: number;
  misses: number;
  entries: number;
  /** Age of the oldest cache entry in ms */
  oldestEntryAge: number;
}

export interface MemoryReadResult {
  sections: MemoryEntry[];
  formatted: string;
  cacheStats: MemoryCacheStats;
}
