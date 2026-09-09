// docs/SYMBOL_LAYER_PLAN.md Phase SL0 — grammar loader.
// All paths are resolved via import.meta.resolve so the engine can be started from any cwd.
// Lazy per family: a session that never outlines Rust never loads the 1.1 MB Rust wasm.
//
// NOTE: This file targets web-tree-sitter@0.27.0. That version's API differs from <=0.24:
//   - `Language` is a top-level named export, not `Parser.Language`.
//   - Queries are created with `new Query(lang, text)`, not `lang.query(text)`.
//   See grammars.test.ts which is the canary for a version-bump ABI break.
//
// TODO SL5: when the engine becomes a compiled Tauri sidecar, resolve wasm from
//   process.env.RAMA_GRAMMAR_DIR (Tauri will set that and bundle wasm as resources).
//   For now, import.meta.resolve works because the engine runs from source (engine.rs:45).

import { Parser, Language, Query } from "web-tree-sitter";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Family = "js" | "py" | "go" | "rs";

// ---------------------------------------------------------------------------
// Package-root resolution.
// import.meta.resolve() returns a file:// URL to the package's main entry point,
// which for grammar packages sits deep inside bindings/node/. We walk up to the
// directory that actually contains package.json (= the package root where the
// wasm and queries/ directory live).
// ---------------------------------------------------------------------------

function pkgDir(pkg: string): string {
  const entryUrl = import.meta.resolve(pkg);
  let dir = dirname(fileURLToPath(entryUrl));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  throw new Error(`Rama symbol layer: could not find package root for ${pkg}`);
}

// ---------------------------------------------------------------------------
// Registry: for each family, the wasm path and the ordered list of tags.scm
// files whose text will be concatenated before compiling the query.
// Order matters for js: JS tags first, then TS-specific tags (spike finding 4).
// ---------------------------------------------------------------------------

interface GrammarEntry {
  wasm: string;
  tagFiles: string[];
}

const REGISTRY: Record<Family, GrammarEntry> = {
  js: {
    // TypeScript files are parsed with the TypeScript grammar (it is a superset of JS).
    // But the TS tags.scm alone is incomplete (spike finding 4): it misses function
    // declarations, class declarations, and arrow-function consts — those come from the
    // JS tags.scm. So we concatenate JS first, then TS.
    wasm: join(pkgDir("tree-sitter-typescript"), "tree-sitter-typescript.wasm"),
    tagFiles: [
      join(pkgDir("tree-sitter-javascript"), "queries", "tags.scm"),
      join(pkgDir("tree-sitter-typescript"), "queries", "tags.scm"),
    ],
  },
  py: {
    wasm: join(pkgDir("tree-sitter-python"), "tree-sitter-python.wasm"),
    tagFiles: [join(pkgDir("tree-sitter-python"), "queries", "tags.scm")],
  },
  go: {
    wasm: join(pkgDir("tree-sitter-go"), "tree-sitter-go.wasm"),
    tagFiles: [join(pkgDir("tree-sitter-go"), "queries", "tags.scm")],
  },
  rs: {
    wasm: join(pkgDir("tree-sitter-rust"), "tree-sitter-rust.wasm"),
    tagFiles: [join(pkgDir("tree-sitter-rust"), "queries", "tags.scm")],
  },
};

// Rama supplement: type aliases and enums are not in the TS tags.scm (spike finding 6).
const TS_SUPPLEMENT = `
(type_alias_declaration
  name: (type_identifier) @name) @definition.type_alias

(enum_declaration
  name: (identifier) @name) @definition.enum
`;

// ---------------------------------------------------------------------------
// Module-level initialisation promise — Parser.init() must be called once
// before Language.load() or new Query() can be used.
// ---------------------------------------------------------------------------
let initPromise: Promise<void> | null = null;

function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init({
      locateFile: () => join(pkgDir("web-tree-sitter"), "web-tree-sitter.wasm"),
    });
  }
  return initPromise;
}

// ---------------------------------------------------------------------------
// Per-family caches.
// ---------------------------------------------------------------------------
const languageCache = new Map<Family, Language>();
const queryCache = new Map<Family, Query>();
const parserCache = new Map<Family, Parser>();

/** Load (and cache) the Language for a family. Throws with a clear message on failure. */
export async function loadLanguage(family: Family): Promise<Language> {
  const cached = languageCache.get(family);
  if (cached) return cached;

  await ensureInit();

  const entry = REGISTRY[family];
  let lang: Language;
  try {
    lang = await Language.load(entry.wasm);
  } catch (e) {
    throw new Error(
      `Rama symbol layer: failed to load ${family} grammar from ${entry.wasm}: ${e}`
    );
  }
  languageCache.set(family, lang);
  return lang;
}

/** Return a cached Parser instance ready to parse `family`. */
export async function getParser(family: Family): Promise<Parser> {
  const cached = parserCache.get(family);
  if (cached) return cached;

  const lang = await loadLanguage(family);
  const parser = new Parser();
  parser.setLanguage(lang);
  parserCache.set(family, parser);
  return parser;
}

/** Return the compiled Query for a family (compiled once, reused forever). */
export async function getQuery(family: Family): Promise<Query> {
  const cached = queryCache.get(family);
  if (cached) return cached;

  const lang = await loadLanguage(family);
  const entry = REGISTRY[family];

  let queryText = entry.tagFiles.map((f) => readFileSync(f, "utf8")).join("\n");
  // Append the Rama supplement for the JS/TS family (spike finding 6).
  if (family === "js") queryText += TS_SUPPLEMENT;

  let query: Query;
  try {
    // web-tree-sitter@0.27.0: new Query(lang, text) — not lang.query(text).
    query = new Query(lang, queryText);
  } catch (e) {
    throw new Error(
      `Rama symbol layer: failed to compile query for ${family}: ${e}`
    );
  }
  queryCache.set(family, query);
  return query;
}
