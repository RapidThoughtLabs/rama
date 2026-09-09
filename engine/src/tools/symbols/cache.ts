// docs/SYMBOL_LAYER_PLAN.md Phase SL4 — parse cache for the outline tool.
//
// Caches Symbol[] keyed by (path + mtimeMs + size) — the FileStamp shape from types.ts.
// LRU eviction at MAX_ENTRIES prevents unbounded growth on large monorepo walks.
// Files over MAX_FILE_BYTES are skipped with an explicit note so we don't spend
// 200+ ms on generated bundles.

import type { Symbol } from "./extract";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_ENTRIES = 256;
/** Skip files over 1 MB — they are almost always generated bundles. */
export const MAX_FILE_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// LRU cache backed by a Map (Map preserves insertion order; we delete-on-hit
// and re-insert at tail to maintain LRU semantics with O(1) operations).
// ---------------------------------------------------------------------------

interface CacheEntry {
  mtimeMs: number;
  size: number;
  symbols: Symbol[];
  hasError: boolean;
}

const store = new Map<string, CacheEntry>();

/** Return the cached result for `path` if it matches the current `mtimeMs` and `size`. */
export function getCached(
  path: string,
  mtimeMs: number,
  size: number
): { symbols: Symbol[]; hasError: boolean } | null {
  const entry = store.get(path);
  if (!entry || entry.mtimeMs !== mtimeMs || entry.size !== size) return null;

  // LRU: move to tail on hit.
  store.delete(path);
  store.set(path, entry);
  return { symbols: entry.symbols, hasError: entry.hasError };
}

/** Store a result in the cache, evicting the LRU entry if necessary. */
export function setCached(
  path: string,
  mtimeMs: number,
  size: number,
  symbols: Symbol[],
  hasError: boolean
): void {
  if (store.has(path)) store.delete(path); // re-insert at tail
  if (store.size >= MAX_ENTRIES) {
    // Evict the oldest entry (Map iteration is insertion-ordered).
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(path, { mtimeMs, size, symbols, hasError });
}

/** Exported for tests: return the current cache size. */
export function cacheSize(): number {
  return store.size;
}

/** Exported for tests: clear the cache. */
export function clearCache(): void {
  store.clear();
}
