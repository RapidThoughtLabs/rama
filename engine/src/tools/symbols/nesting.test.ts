// docs/SYMBOL_LAYER_PLAN.md Phase SL3 acceptance test.
// Golden-file test: class with methods renders indented under the class,
// standalone function renders at depth 0. Depth is capped at 2.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractSymbols } from "./extract";

const FIXTURES = join(import.meta.dir, "fixtures");

function renderSymbols(symbols: { line: number; text: string; depth: number }[]): string {
  return symbols
    .map((s) => {
      const depthCapped = Math.min(s.depth, 2);
      const extraIndent = "  ".repeat(depthCapped);
      return `  ${extraIndent}${String(s.line).padStart(4)}  ${s.text}`;
    })
    .join("\n");
}

describe("SL3: nesting render", () => {
  it("methods indent under their class, standalone at top level", async () => {
    const src = readFileSync(join(FIXTURES, "nesting.ts"), "utf8");
    const { symbols } = await extractSymbols("js", src);

    // Greeter class should be at depth <= 1 (possibly wrapped in export_statement)
    const greeter = symbols.find((s) => s.name === "Greeter");
    expect(greeter).toBeTruthy();

    // Methods should be at greater depth than the class
    const greet = symbols.find((s) => s.name === "greet");
    const farewell = symbols.find((s) => s.name === "farewell");
    expect(greet).toBeTruthy();
    expect(farewell).toBeTruthy();
    expect(greet!.depth).toBeGreaterThan(greeter!.depth);
    expect(farewell!.depth).toBeGreaterThan(greeter!.depth);

    // standalone function should not be deeper than class
    const standalone = symbols.find((s) => s.name === "standalone");
    expect(standalone).toBeTruthy();
    expect(standalone!.depth).toBeLessThanOrEqual(greeter!.depth);
  });

  it("renderSymbols indents methods with 2 spaces per depth, capped at 2", async () => {
    const src = readFileSync(join(FIXTURES, "nesting.ts"), "utf8");
    const { symbols } = await extractSymbols("js", src);

    const rendered = renderSymbols(symbols);
    const lines = rendered.split("\n");

    // Find the Greeter line and a method line
    const greeterLine = lines.find((l) => l.includes("Greeter"));
    const greetLine = lines.find((l) => l.includes("greet"));
    expect(greeterLine).toBeTruthy();
    expect(greetLine).toBeTruthy();

    // Greeter should have less leading whitespace than greet
    const leadingSpaces = (line: string) => line.length - line.trimStart().length;
    expect(leadingSpaces(greetLine!)).toBeGreaterThan(leadingSpaces(greeterLine!));
  });

  it("depth is capped at 2 in the rendered output", async () => {
    // Synthesise a deeply nested symbol (depth 5) and verify it renders as depth 2.
    const rendered = renderSymbols([{ line: 1, text: "deep", depth: 5 }]);
    // Format: "  " (base) + "    " (depth 2 × 2 spaces) + padStart(4) "   1" + "  deep"
    //       = "        " (6 spaces) + "   1  deep"
    expect(rendered).toBe("         1  deep");
  });
});
