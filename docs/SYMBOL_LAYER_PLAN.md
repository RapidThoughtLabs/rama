# Rama — Symbol Layer Implementation Plan (tree-sitter)

Phases here are **SL0–SL6** so they never collide with the build phases 0–8
(`IMPLEMENTATION_PLAN.md`), redesign R0–R7 (`REDESIGN_PLAN.md`), settings S0–S5
(`SETTINGS_PLAN.md`), harness H0–H6 (`HARNESS_DESIGN.md`), tool layer TL0–TL7
(`TOOL_LAYER_PLAN.md`), providers P0–P6 (`PROVIDERS_PLAN.md`), prompt stack
PS0–PS7 (`PROMPT_STACK_PLAN.md`), Mission Control M0–M6
(`MISSION_CONTROL_PLAN.md`), loop migration LM0–LM7 (`LOOP_MIGRATION_PLAN.md`),
loop mending MD0–MD6 (`LOOP_MENDING_PLAN.md`), or workspace panes W0–W7
(`WORKSPACE_PANES_PLAN.md`). Cite these as "SYMBOL_LAYER_PLAN.md Phase SL2".

**What this document owns.** Everything between "a file path arrived" and "a
list of symbols with line numbers came back". It replaces the regex heuristic in
`engine/src/tools/outline.ts` with real tree-sitter parsing, and nothing else.
It does not touch the loop, the prompt stack, providers, or diagnostics.

**This closes `TOOL_LAYER_PLAN.md` Open Question 5** ("`outline` backend:
bundled tree-sitter grammars versus LSP `documentSymbol`") in favour of
tree-sitter, and settles the "more binary weight" half of that question with a
measured number: **~5.0 MB of wasm for six grammars**. §2 records why LSP is not
merely deferred but out of scope.

---

## 1. The framing: syntax is a different question from semantics

The regex outline shipped as an honest stopgap, and its own header comment
(`engine/src/tools/outline.ts:10-18`) names the end state this document builds.
The reason to finish it now is not fidelity for its own sake:

> **Reading a 2000-line file to find one function is the most common context
> waste in a coding harness** (`TOOL_LAYER_PLAN.md` §6.5). `outline` is the fix,
> and a heuristic that silently misses symbols is worse than one that doesn't,
> because the model treats absence as evidence.

The regex version cannot see method bodies for JS/TS/Go *at all* — that is a
documented limitation, not a bug. So today an agent outlining a 900-line class
gets one line back and concludes the file is nearly empty. Tree-sitter fixes
this by construction, because nesting is a property of the tree.

The second framing, which decides §2 and keeps this plan small:

> **Tree-sitter answers "what is in this file". Only a compiler answers "how
> does this connect to everything else".** They are not competing designs; they
> are different questions, and `outline` only ever asks the first one.

---

## 2. Why there is no LSP phase in this document

LSP was considered and is deliberately excluded — not staged for later, but
scoped out, because the three capabilities people bundle under "LSP" have
different owners in Rama and only one of them is unclaimed:

| Capability | Owner today | Needs a language server? |
|---|---|---|
| Type errors, syntax validity, lint | `check` tool — runs the project's real `tsc`/`eslint` and parses structured diagnostics (`engine/src/tools/check.ts:11`) | **No.** Batch compilers already produce this. |
| "What symbols are in this file" | `outline` — this document | **No.** Pure syntax. |
| "Where else is this used / defined" | nothing | **Yes.** |

So the LSP value-add over what Rama already has is narrower than it first
appears: it is the cross-file reference graph alone. That is a real capability
and worth wanting, but it costs a supervised long-lived process per language per
project (spawn, `initialize` handshake, workspace sync, crash/restart), it adds
cold-start latency on large repos to a tool whose whole purpose is being cheaper
than `read`, and every server behaves differently. **Buying reference-graph
features should be a decision made on its own merits, in its own document, not
smuggled in as an outline backend.** If it is ever built, it is additive: a
`references` tool alongside `outline`, not a second backend beneath it.

---

## 3. What is actually there today

Read before planning; the phases below are built on these facts.

| finding | where |
|---|---|
| Outline is five arrays of regexes over raw lines, no parse. | `engine/src/tools/outline.ts:36-53` |
| Method-level detection is explicitly absent for JS/TS/Go; Python and Rust fake it with a single indentation level. | `outline.ts:16-18`, `:44`, `:53` |
| Supported families are TS/JS/TSX, Python, Go, Rust, keyed by extension. | `outline.ts:22-34` |
| Output is `path (N lines)` then `  LINE  text`, two-space indent, line number padded to 4. | `outline.ts:84-86` |
| Directory mode outlines at most 40 files and reports truncation via `meta.truncated`. | `outline.ts:19`, `:130-137` |
| Symbol text is the trimmed source line with a trailing `{` stripped, capped at 120 chars. | `outline.ts:67-68` |
| The tool is registered as `outline` and gated at risk `low`. | `engine/src/tools/index.ts:31`, `agents/effectiveTools.ts:16` |
| Candidate files come from `git ls-files`, falling back to a `Bun.Glob` walk. | `engine/src/tools/projectFiles.ts:10-23` |
| The engine runs as `bun run src/index.ts` with cwd `engine/` — source, never bundled. | `apps/desktop/src-tauri/src/engine.rs:45`, `:59` |
| Packaging the engine as a real Tauri sidecar binary is explicitly deferred. | `apps/desktop/src-tauri/src/engine.rs:4` |
| `engine/package.json` has four runtime deps and no build step. | `engine/package.json` |

---

## 4. Spike results (2026-09-09) — verified, not assumed

Run against Bun 1.3.14 with `web-tree-sitter@0.27.0`. Every row below was
executed; the phases depend on them, so re-run the spike before trusting this
document if either version moves.

| # | Finding | Consequence |
|---|---|---|
| 1 | `web-tree-sitter` loads and parses under Bun with no native build. TS file parsed in **1.4 ms**; a 3,601-line file in **23 ms**, yielding 2,400 symbols. | The whole premise holds. No emscripten, no node-gyp, no per-platform binaries. |
| 2 | Every grammar package ships a **prebuilt `.wasm`** *and* a `queries/tags.scm`. Weights: ts 1.4 MB, tsx 1.4 MB, js 412 KB, py 458 KB, go 217 KB, rs 1.1 MB — **~5.0 MB total**. | No grammar compilation step. This is the real answer to "more binary weight". |
| 3 | The grammar packages' `postinstall` (native bindings) is **blocked by Bun by default and is not needed** — we consume only the `.wasm`. | Nothing to trust or unblock in `bun pm untrusted`. |
| 4 | **`tree-sitter-typescript`'s `tags.scm` alone is unusable.** It covers only TS-specific signature nodes; against a normal TS file it returned `Row`, `LanguageModel`, `Shape` — two of which are *type references*, not definitions — and missed the function, the class, the methods and the arrow const. Concatenating `tree-sitter-javascript`'s `tags.scm` first fixes it. | SL1 must compose queries per family, not load one file per language. |
| 5 | Filtering captures by name prefix (`@name`) leaks references into the outline. Definitions must be found by pairing a `@definition.*` capture with the `@name` in the **same match**. | SL1's extraction rule, and the reason finding 4 looked like a grammar bug at first. |
| 6 | `tags.scm` has **no pattern for TS `type` aliases or `enum`s** — both of which today's regex *does* catch (`outline.ts:40`). A naive swap is a regression. A two-line supplementary query restores them (verified). | SL1 ships supplements, and the acceptance test asserts no regression against the regex baseline. |
| 7 | Rust's `tags.scm` emits **duplicate rows** — `fn new` appears as both `definition.function` and `definition.method`. | SL1 must de-duplicate by (line, name). |
| 8 | The `definition.*` vocabulary is **lossy and language-flavoured**: Rust `struct` and `enum` both arrive as `class`, `trait` as `interface`. | SL1 normalises kinds per family rather than trusting the capture name. |
| 9 | Methods come out **for free** across TS, Python, Go and Rust (`helper`, `run`, `__init__`, `render`, `Start`). | This is the actual user-visible win; SL3 renders it. |
| 10 | On a file with a deliberate syntax error, the parse **degrades gracefully** (`hasError=true`, partial tree, symbols before the error still returned) but symbols *after* the break point were lost — where the regex would have found them. | A narrow, real regression class. SL2 records it; §8 open question 2 decides whether to care. |

---

## 5. Decisions taken in this pass (2026-09-09)

| # | Decision | Consequence |
|---|---|---|
| 1 | **Tree-sitter is the only backend.** No pluggable backend interface, no LSP seam left open. | Deletes an abstraction nobody is asking for. §2. |
| 2 | **Grammars are npm dependencies, loaded from `node_modules` at runtime.** Not vendored into the repo. | Version bumps are `bun add`. Revisited only when the engine becomes a compiled sidecar — SL5. |
| 3 | **Queries are composed per family from the packages' own `tags.scm`, plus a small Rama supplement.** We do not fork or vendor upstream queries. | Upstream fixes arrive free; our supplement stays reviewable at a glance. §Finding 4, 6. |
| 4 | **Grammars load lazily and are cached per process.** A session that never outlines Rust never loads 1.1 MB of Rust. | Startup cost stays zero; `Parser.init()` happens on first outline, not at boot. |
| 5 | **The output format does not change in SL2.** Same header, same `  LINE  text` shape. | The swap is verifiable as a diff of *content*, not of *format*. Nesting arrives separately in SL3. |
| 6 | **An unsupported extension stays an error, not an empty outline.** Unchanged from today (`outline.ts:114`). | Absence keeps meaning "unsupported", never "empty file". |
| 7 | **A grammar that fails to load degrades to an explicit error naming the language** — never a silent fall back to regex. | We do not ship two answers for one question. |

---

## 6. Phases

### SL0 — grammar assets and the loader

Add dependencies to `engine/package.json`: `web-tree-sitter`, and the five
grammar packages (`tree-sitter-typescript` supplies both `typescript` and `tsx`
wasm, so six wasm files come from five packages).

New file `engine/src/tools/symbols/grammars.ts`:

- A `Family` → `{ wasm: string; tagFiles: string[] }` registry, resolving paths
  relative to `import.meta.dir` so it does not depend on the engine's cwd.
- `loadLanguage(family)`: calls `Parser.init()` once (module-level promise),
  `Language.load()` once per family, memoised in a `Map`. Concurrent callers
  await the same promise.
- A compiled-`Query` cache keyed by family, since `new Query()` is not free and
  the query text never changes at runtime.

**Acceptance:** a unit test loads all six grammars and asserts each parses a
one-line sample of its language without error. This test is the canary for a
grammar version bump breaking ABI compatibility with `web-tree-sitter`.

### SL1 — the extractor

New file `engine/src/tools/symbols/extract.ts`, a pure function with no `fs` and
no tool plumbing:

```ts
export interface Symbol { line: number; endLine: number; kind: SymbolKind; name: string; text: string; depth: number; }
export function extractSymbols(family: Family, source: string): Symbol[]
```

Implementation notes, each one earned from §4:

- Match `@definition.*` and `@name` **within the same match** (finding 5).
- Compose JS + TS queries for the `js` family (finding 4).
- Append the Rama supplement for `type_alias_declaration` and `enum_declaration`
  (finding 6).
- Normalise `definition.*` to a Rama `SymbolKind` per family — Rust `struct` is
  a `struct`, not a `class` (finding 8).
- De-duplicate by `(line, name)`, keeping the more specific kind (finding 7).
- `depth` is computed by walking `node.parent` and counting only *container*
  nodes (class/impl/module bodies), not every syntax node — raw ancestor depth
  is grammar noise (the spike measured depth 5 for a plain method).
- `text` reuses today's rule: the source line, trailing `{` stripped, capped at
  `MAX_LINE_TEXT`. Keeping the presentation identical is what makes SL2's diff
  reviewable.

**Acceptance:** `engine/src/tools/symbols/extract.test.ts` with a fixture file
per family, asserting exact symbol lists. Must include: a TS class with methods,
a `type` alias, an `enum`, an arrow-function const, a Rust `impl` block, a Python
class with an `async def`, and a Go method with a pointer receiver.

### SL2 — rewire `outline`, delete the regexes

`outline.ts` keeps its shape; `symbolsFor()` and the five regex arrays
(`outline.ts:36-71`) are deleted and replaced by a call into SL1. The header
comment at `outline.ts:10-18` is replaced with a short pointer to this document.
The tool description drops "heuristic, not a full parse, so it can miss or
misidentify unusual code" — that sentence is only honest about the old backend,
and leaving it in would keep the model under-trusting a tool that now deserves
more trust.

`execute` becomes `async` in a real sense: parsing is CPU-bound and per-file, so
directory mode must `await` files sequentially rather than building a 40-way
`Promise.all` that pins the event loop.

**Acceptance:** a differential test — run both backends over Rama's own
`engine/src/` and assert the tree-sitter output is a **superset** of the regex
output, except for the known syntax-error case (finding 10). This is the phase's
whole point: prove no symbol the old tool found was lost.

### SL3 — render nesting

The capability the regex version could never have (finding 9). Methods indent
under their container:

```
engine/src/agent/run/run.ts (412 lines)
    24  function resolveModel
    58  class AgentRun
    71    method start
    96    method step
```

Two spaces per `depth` level on top of the existing indent. Nothing else about
the format changes. A `depth`-aware cap prevents a deeply nested file from
producing a staircase — flatten anything past depth 2.

**Acceptance:** golden-file test over a fixture with a class, its methods, and a
nested closure.

### SL4 — parse cache and directory budget

Directory mode currently parses up to 40 files on every call, and agents call
`outline` on the same directory repeatedly.

- Cache `Symbol[]` keyed by `path` + `mtimeMs` + `size`, reusing the `FileStamp`
  shape already in `ToolResultMeta` (`engine/src/tools/types.ts`).
- Bound the cache (LRU, a few hundred files) so a monorepo walk cannot grow it
  without limit.
- Skip files over a size threshold (~1 MB) with an explicit note rather than
  spending 200 ms on a generated bundle.

**Acceptance:** a test asserting a second outline of an unmodified file does not
re-parse (spy on the parser), and that touching the file invalidates.

### SL5 — production packaging

Today the engine runs from source (`engine.rs:45`), so `node_modules` is present
and `import.meta.dir` resolution works. **When the engine becomes a compiled
sidecar this breaks**, and it is the one thing in this plan that a future phase
can silently invalidate.

- Add the wasm files as Tauri bundle resources, and make `grammars.ts` resolve
  from an env var (`RAMA_GRAMMAR_DIR`) when set, falling back to
  `import.meta.dir` for dev.
- A missing grammar directory must produce the SL0 canary error naming the
  missing language, not a stack trace.

This phase is a **hard dependency of any future engine-packaging work** — note
it in `IMPLEMENTATION_PLAN.md` when that phase is scheduled.

### SL6 — the structural index seed (optional, deferred)

`TOOL_LAYER_PLAN.md` §6.5 observes that `outline` "doubles as the first form of
the structural index `HARNESS_DESIGN.md` wants for M4", and M4's own rule is
that derived memory is regenerable and expires on mtime
(`HARNESS_DESIGN.md:108`) — which is exactly what SL4's cache is.

So SL6 is not new machinery: it is exposing SL4's cache as a project-wide symbol
map that the curator and `explore` can read. **Do not build this until something
asks for it.** It is recorded here so that SL4's cache is designed with the
right key shape (path + stamp) rather than retrofitted later.

---

## 7. Order and dependencies

```
SL0 ──▶ SL1 ──▶ SL2 ──▶ SL3
                  └───▶ SL4 ──▶ SL6 (deferred)
SL5 independent, but blocks engine packaging
```

SL0–SL2 are the shippable unit: after SL2 the regexes are gone and the tool is
strictly better. SL3 and SL4 are each a self-contained follow-up.

---

## 8. Open questions

1. **Do we add languages beyond the current five?** Grammars are cheap to add
   (~0.5 MB and one registry row each) but every one is a new query supplement
   to maintain. Leaning: hold at five until a real project asks, then add on
   demand rather than speculatively.

2. **Is the syntax-error regression (finding 10) worth handling?** A file being
   edited by the agent is *frequently* mid-edit and invalid, which is precisely
   when it might get outlined. Options: accept it; or annotate the output with
   "parse incomplete after line N" so absence stops meaning emptiness. Leaning:
   annotate — it costs one `hasError` check and preserves the invariant that the
   model can trust what the tool does not say.

3. **Should `text` become synthesised rather than the raw source line?** The tree
   knows the signature precisely, so we could render `function foo(a, b): T`
   without the source's formatting noise. Leaning: no, not in this plan — the
   raw line is honest, matches `read`'s view of the file, and changing it makes
   SL2's differential test much harder to read.
