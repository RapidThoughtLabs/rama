// docs/SYMBOL_LAYER_PLAN.md Phase SL1 — pure symbol extractor.
// No fs, no tool plumbing. All ten spike findings are addressed here:
//   F4  JS+TS query composition — done in grammars.ts
//   F5  @definition.* + @name must be in the same match — enforced below
//   F6  Rama supplement for type aliases / enums — in grammars.ts query text
//   F7  Rust duplicate rows (fn new as both .function and .method) — dedup by (line,name)
//   F8  definition.* vocabulary is lossy — normaliseKind() per family
//   F9  Methods come out for free — depth > 0 when inside a container
//   F10 hasError → partial tree — callers receive whatever the parser produced

import type { SyntaxNode } from "web-tree-sitter";
import { getParser, getQuery, type Family } from "./grammars";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type_alias"
  | "enum"
  | "struct"
  | "trait"
  | "impl"
  | "module"
  | "macro"
  | "constant"
  | "unknown";

export interface Symbol {
  /** 1-based line number of the definition node start. */
  line: number;
  /** 1-based line number of the definition node end. */
  endLine: number;
  kind: SymbolKind;
  name: string;
  /** Raw source line, trailing `{` stripped, capped at MAX_LINE_TEXT chars. */
  text: string;
  /** Container depth: 0 = top-level, 1 = inside a class/impl/module body, etc. */
  depth: number;
}

const MAX_LINE_TEXT = 120;

// ---------------------------------------------------------------------------
// Kind normalisation (spike finding 8)
// The tags.scm vocabulary uses JS-centric names like `definition.class` for
// Rust structs/enums/unions. We map these to Rama-native kinds per family.
// ---------------------------------------------------------------------------

function normaliseKind(family: Family, captureName: string): SymbolKind {
  // Strip the "definition." prefix so we only match the leaf name.
  const leaf = captureName.replace(/^definition\./, "");

  // Rama supplement captures
  if (leaf === "type_alias") return "type_alias";
  if (leaf === "enum") return "enum";

  switch (family) {
    case "rs":
      // Rust tags.scm uses "class" for struct, enum, union, and type aliases.
      // We've already handled "enum" above; the rest are structs/unions/type_items.
      // "interface" means trait in Rust.
      if (leaf === "class") return "struct";
      if (leaf === "interface") return "trait";
      if (leaf === "method") return "method";
      if (leaf === "function") return "function";
      if (leaf === "module") return "module";
      if (leaf === "macro") return "macro";
      break;
    case "js":
      if (leaf === "class") return "class";
      if (leaf === "function") return "function";
      if (leaf === "method") return "method";
      if (leaf === "interface") return "interface";
      if (leaf === "constant") return "constant";
      if (leaf === "module") return "module";
      break;
    case "py":
      if (leaf === "class") return "class";
      if (leaf === "function") return "function";
      if (leaf === "constant") return "constant";
      break;
    case "go":
      if (leaf === "function") return "function";
      if (leaf === "method") return "method";
      if (leaf === "type") return "type_alias"; // Go type spec
      if (leaf === "interface") return "interface";
      break;
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Container node detection for depth calculation.
// We only count *semantic* containers, not every grammar node — the spike
// measured depth 5 for a plain method when counting raw ancestors.
// ---------------------------------------------------------------------------
const CONTAINER_TYPES = new Set([
  // JS/TS
  "class_body",
  "class_declaration",
  "abstract_class_declaration",
  "export_statement",
  "module",
  "namespace_body",
  // Python
  "class_definition",
  "block",
  // Go
  "type_declaration",
  // Rust
  "declaration_list", // impl/trait body
  "impl_item",
  "trait_item",
  "mod_item",
]);

function containerDepth(node: SyntaxNode): number {
  let depth = 0;
  let cur: SyntaxNode | null = node.parent;
  while (cur) {
    if (CONTAINER_TYPES.has(cur.type)) depth++;
    cur = cur.parent;
  }
  return depth;
}

// ---------------------------------------------------------------------------
// Text formatting — mirrors the regex version's presentation so SL2's diff
// stays readable (spike decision 5).
// ---------------------------------------------------------------------------
function formatText(sourceLine: string): string {
  const trimmed = sourceLine.replace(/\s*\{?\s*$/, "").trim();
  return trimmed.length > MAX_LINE_TEXT
    ? `${trimmed.slice(0, MAX_LINE_TEXT)}…`
    : trimmed;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Parse `source` as `family` and return the list of symbols it contains.
 * Pure: no I/O. Throws only if the grammar fails to load or the query is
 * invalid — never on a syntax error in `source` (hasError → partial tree).
 */
export async function extractSymbols(
  family: Family,
  source: string
): Promise<{ symbols: Symbol[]; hasError: boolean }> {
  const [parser, query] = await Promise.all([
    getParser(family),
    getQuery(family),
  ]);

  const tree = parser.parse(source);
  const lines = source.split("\n");

  // Collect matches. Each match has a set of captures keyed by name.
  // We need @definition.* and @name in the same match (spike finding 5).
  const matches = query.matches(tree.rootNode);

  const rawSymbols: Symbol[] = [];

  for (const match of matches) {
    // Find @definition.* capture and @name capture in this match.
    let defNode: Parser.SyntaxNode | null = null;
    let nameNode: Parser.SyntaxNode | null = null;
    let defCaptureName = "";

    for (const capture of match.captures) {
      if (capture.name.startsWith("definition.")) {
        defNode = capture.node;
        defCaptureName = capture.name;
      } else if (capture.name === "name") {
        nameNode = capture.node;
      }
    }

    // Skip matches without both a definition and a name (e.g., reference captures).
    if (!defNode || !nameNode) continue;

    const name = nameNode.text;
    if (!name) continue;

    const line = defNode.startPosition.row + 1; // 1-based
    const endLine = defNode.endPosition.row + 1;
    const sourceLine = lines[line - 1] ?? "";
    const kind = normaliseKind(family, defCaptureName);
    const depth = containerDepth(defNode);

    rawSymbols.push({
      line,
      endLine,
      kind,
      name,
      text: formatText(sourceLine),
      depth,
    });
  }

  // De-duplicate by (line, name) — keep the entry with the more specific kind
  // (spike finding 7: Rust emits fn new as both definition.function and definition.method).
  const kindSpecificity: Record<SymbolKind, number> = {
    method: 10,
    function: 9,
    class: 8,
    struct: 8,
    trait: 8,
    impl: 7,
    interface: 7,
    enum: 6,
    type_alias: 5,
    module: 4,
    macro: 3,
    constant: 2,
    unknown: 0,
  };

  const seen = new Map<string, Symbol>();
  for (const sym of rawSymbols) {
    const key = `${sym.line}:${sym.name}`;
    const existing = seen.get(key);
    if (
      !existing ||
      (kindSpecificity[sym.kind] ?? 0) > (kindSpecificity[existing.kind] ?? 0)
    ) {
      seen.set(key, sym);
    }
  }

  const symbols = Array.from(seen.values()).sort((a, b) => a.line - b.line);

  return { symbols, hasError: tree.rootNode.hasError };
}
