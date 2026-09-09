// docs/SYMBOL_LAYER_PLAN.md Phase SL0 acceptance test.
// Loads all six grammars and asserts each parses a one-line sample of its language
// without crashing. This is the canary for a grammar version bump breaking ABI
// compatibility with web-tree-sitter.

import { describe, it, expect } from "bun:test";
import { loadLanguage, getParser, type Family } from "./grammars";

const SAMPLES: Record<Family, string> = {
  js: `function hello() {}`,
  py: `def hello(): pass`,
  go: `func hello() {}`,
  rs: `fn hello() {}`,
};

describe("SL0: grammar loader", () => {
  for (const [family, sample] of Object.entries(SAMPLES) as [Family, string][]) {
    it(`loads ${family} grammar and parses a one-line sample without error`, async () => {
      const lang = await loadLanguage(family);
      expect(lang).toBeTruthy();

      const parser = await getParser(family);
      const tree = parser.parse(sample);
      expect(tree).toBeTruthy();
      expect(tree.rootNode).toBeTruthy();
      // The one-liner must not produce a parse error.
      expect(tree.rootNode.hasError).toBe(false);
    });
  }

  // TypeScript is loaded via the js family but uses the TypeScript grammar.
  it("js family actually parses TypeScript syntax (class with type annotation)", async () => {
    const parser = await getParser("js");
    const tree = parser.parse(`class Foo { bar: string = "x"; }`);
    expect(tree.rootNode.hasError).toBe(false);
  });
});
