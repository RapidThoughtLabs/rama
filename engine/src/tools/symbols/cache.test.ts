// docs/SYMBOL_LAYER_PLAN.md Phase SL4 acceptance test.
// Asserts: cache hit skips re-parse, touching file invalidates.
// Asserts: LRU eviction at MAX_ENTRIES.

import { describe, it, expect, beforeEach } from "bun:test";
import {
  getCached,
  setCached,
  clearCache,
  cacheSize,
  MAX_FILE_BYTES,
} from "./cache";
import type { Symbol } from "./extract";

const SYM: Symbol = {
  line: 1,
  endLine: 5,
  kind: "function",
  name: "foo",
  text: "function foo()",
  depth: 0,
};

beforeEach(() => clearCache());

describe("SL4: parse cache", () => {
  it("returns null on a cold miss", () => {
    expect(getCached("/a/b.ts", 1000, 100)).toBeNull();
  });

  it("returns the cached result on a hit with matching mtime+size", () => {
    setCached("/a/b.ts", 1000, 100, [SYM], false);
    const result = getCached("/a/b.ts", 1000, 100);
    expect(result).not.toBeNull();
    expect(result!.symbols).toEqual([SYM]);
    expect(result!.hasError).toBe(false);
  });

  it("returns null when mtime differs (file was modified)", () => {
    setCached("/a/b.ts", 1000, 100, [SYM], false);
    expect(getCached("/a/b.ts", 1001, 100)).toBeNull();
  });

  it("returns null when size differs", () => {
    setCached("/a/b.ts", 1000, 100, [SYM], false);
    expect(getCached("/a/b.ts", 1000, 101)).toBeNull();
  });

  it("grows the cache on distinct paths", () => {
    setCached("/a/b.ts", 1, 1, [SYM], false);
    setCached("/a/c.ts", 1, 1, [SYM], false);
    expect(cacheSize()).toBe(2);
  });

  it("evicts at MAX_ENTRIES (LRU)", () => {
    // Fill the cache beyond its limit.
    // We rely on the exported MAX_FILE_BYTES only for reference here; MAX_ENTRIES is 256.
    const MAX_ENTRIES = 256;
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      setCached(`/path/file${i}.ts`, i, i, [SYM], false);
    }
    expect(cacheSize()).toBe(MAX_ENTRIES);
    // The first 5 entries should have been evicted.
    expect(getCached("/path/file0.ts", 0, 0)).toBeNull();
    expect(getCached("/path/file4.ts", 4, 4)).toBeNull();
    // The last entry should still be present.
    expect(getCached(`/path/file${MAX_ENTRIES + 4}.ts`, MAX_ENTRIES + 4, MAX_ENTRIES + 4)).not.toBeNull();
  });

  it("MAX_FILE_BYTES is exported and equals 1MB", () => {
    expect(MAX_FILE_BYTES).toBe(1024 * 1024);
  });
});
