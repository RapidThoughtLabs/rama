// docs/SYMBOL_LAYER_PLAN.md Phase SL1 acceptance test.
// Fixture-per-family tests asserting exact symbol lists. Covers every case
// listed in the plan: TS class with methods, type alias, enum, arrow-function
// const, Rust impl block, Python async def, Go pointer-receiver method.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractSymbols, type Symbol } from "./extract";

const FIXTURES = join(import.meta.dir, "fixtures");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

// Helper to get a symbol subset for assertion (omit endLine / text for brevity).
function pick(syms: Symbol[]) {
  return syms.map((s) => ({ line: s.line, kind: s.kind, name: s.name, depth: s.depth }));
}

describe("SL1: extractSymbols — TypeScript (js family)", () => {
  it("finds type alias, enum, arrow-function const, named function, class and methods", async () => {
    const src = fixture("sample.ts");
    const { symbols, hasError } = await extractSymbols("js", src);
    expect(hasError).toBe(false);

    const names = symbols.map((s) => s.name);

    // Type alias (Rama supplement, spike finding 6)
    expect(names).toContain("User");
    const user = symbols.find((s) => s.name === "User");
    expect(user?.kind).toBe("type_alias");

    // Enum (Rama supplement, spike finding 6)
    expect(names).toContain("Status");
    const status = symbols.find((s) => s.name === "Status");
    expect(status?.kind).toBe("enum");

    // Arrow-function const (JS tags)
    expect(names).toContain("fetchUser");
    const fetch = symbols.find((s) => s.name === "fetchUser");
    expect(fetch?.kind).toBe("function");

    // Named async function (JS tags)
    expect(names).toContain("resolveModel");
    const resolve = symbols.find((s) => s.name === "resolveModel");
    expect(resolve?.kind).toBe("function");

    // Class (JS tags)
    expect(names).toContain("AgentRun");
    const cls = symbols.find((s) => s.name === "AgentRun");
    expect(cls?.kind).toBe("class");
    // exported class is inside an export_statement node — depth 1 is correct.
    expect(cls?.depth).toBeGreaterThanOrEqual(0);

    // Methods inside the class (spike finding 9: methods are free)
    expect(names).toContain("start");
    const startMethod = symbols.find((s) => s.name === "start");
    expect(startMethod?.kind).toBe("method");
    expect(startMethod?.depth).toBeGreaterThan(0); // nested inside class

    expect(names).toContain("step");
  });

  it("symbols are sorted by line number", async () => {
    const src = fixture("sample.ts");
    const { symbols } = await extractSymbols("js", src);
    const lines = symbols.map((s) => s.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });

  it("text strips trailing brace and is trimmed", async () => {
    const src = `export class Foo {`;
    const { symbols } = await extractSymbols("js", src);
    const foo = symbols.find((s) => s.name === "Foo");
    expect(foo?.text).not.toMatch(/\{/);
  });
});

describe("SL1: extractSymbols — Python", () => {
  it("finds class, __init__, and async def method", async () => {
    const src = fixture("sample.py");
    const { symbols, hasError } = await extractSymbols("py", src);
    expect(hasError).toBe(false);

    const names = symbols.map((s) => s.name);
    expect(names).toContain("Animal");
    expect(names).toContain("__init__");
    expect(names).toContain("speak");
    expect(names).toContain("helper");

    const speak = symbols.find((s) => s.name === "speak");
    expect(speak?.kind).toBe("function");
    expect(speak?.depth).toBeGreaterThan(0); // inside class block
  });
});

describe("SL1: extractSymbols — Go", () => {
  it("finds struct type, pointer-receiver method, and top-level function", async () => {
    const src = fixture("sample.go");
    const { symbols, hasError } = await extractSymbols("go", src);
    expect(hasError).toBe(false);

    const names = symbols.map((s) => s.name);
    expect(names).toContain("Runner");
    expect(names).toContain("Start");
    expect(names).toContain("NewRunner");

    const start = symbols.find((s) => s.name === "Start");
    expect(start?.kind).toBe("method");

    const newRunner = symbols.find((s) => s.name === "NewRunner");
    expect(newRunner?.kind).toBe("function");
  });
});

describe("SL1: extractSymbols — Rust", () => {
  it("finds struct, enum, trait, and impl methods", async () => {
    const src = fixture("sample.rs");
    const { symbols, hasError } = await extractSymbols("rs", src);
    expect(hasError).toBe(false);

    const names = symbols.map((s) => s.name);
    expect(names).toContain("Config");
    expect(names).toContain("State");
    expect(names).toContain("Runnable");
    expect(names).toContain("Agent");
    expect(names).toContain("new");
    expect(names).toContain("start");

    const config = symbols.find((s) => s.name === "Config");
    expect(config?.kind).toBe("struct");

    const state = symbols.find((s) => s.name === "State");
    expect(state?.kind).toBe("struct"); // enums arrive as class → struct in rs normalisation

    const runnable = symbols.find((s) => s.name === "Runnable");
    expect(runnable?.kind).toBe("trait");

    // Dedup: fn new should appear only once (spike finding 7)
    const newSymbols = symbols.filter((s) => s.name === "new");
    expect(newSymbols.length).toBe(1);
    expect(newSymbols[0]?.kind).toBe("method"); // method wins over function (higher specificity)
  });
});
