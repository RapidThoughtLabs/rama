# Rama — Tool Layer Implementation Plan

Phases here are **TL0–TL7** so they never collide with the build phases 0–8
(`IMPLEMENTATION_PLAN.md`), redesign R0–R7 (`REDESIGN_PLAN.md`), settings S0–S5
(`SETTINGS_PLAN.md`), or harness H0–H6 (`HARNESS_DESIGN.md`). Cite as
"TOOL_LAYER_PLAN.md Phase TL2".

Note the letter clash: `HARNESS_DESIGN.md` uses **T1–T7** for tool *properties*.
This document uses **TL0–TL7** for tool *phases*. When this plan says "T4" it
means the property (read-before-write); when it says "TL4" it means the phase
(native git).

**Relationship to the harness plan.** TL0 and H0 are the same work seen from
two sides — H0 asks "does anything reach the model", TL0 asks "what shape is it
in". Build them as one change. Everything from TL1 on is orthogonal to H1–H6
and can interleave.

---

## 1. Scope: two layers, two contracts

```
                    ┌─────────────────────────────────────┐
   model  ─────────▶│  rama tools   (internal · ~17)      │
                    │  fixed · budgeted · ours to test    │
                    └─────────────────────────────────────┘
                    ┌─────────────────────────────────────┐
          ─────────▶│  heku_find / heku_call  (2 slots)   │
                    │        │                            │
                    │        ▼  heku broker               │
                    │   mcp A (30) · mcp B (50) · gh (12) │
                    │  unbounded · third-party · brokered │
                    └─────────────────────────────────────┘
```

| | internal (rama) | external (heku) |
|---|---|---|
| Known at | compile time | runtime |
| Count | fixed, budgeted (~17) | unbounded |
| Descriptions | written by us, treated as prompt | normalised by heku at index time |
| Risk | classified per tool/per op by us | policy per server + per tool, one chokepoint |
| Context cost | full schemas, every request | 2 schemas + a capability manifest |
| Discovery | always visible | `heku_find`, semantic |
| Tested by | our eval suite, deterministically | contract tests + health checks |
| Network | **never** (except heku itself) | usually |

**The line between them:** internal tools are local, deterministic, and
offline. The moment a capability needs the network or a credential, it belongs
to the external layer. This is what makes the internal layer replayable, which
is what makes the eval suite possible.

Native git is the sharpest instance: local repository state is internal
(`status`, `diff`, `log`, `commit`), anything touching a remote (`push`, PR
creation, review comments) is external.

---

## 2. The governing principle

> **Anything the model can do through `bash` that the harness needs to observe
> must exist as a native tool — otherwise the model routes around the
> instrumentation.**

Today `bash git commit` is invisible to checkpointing, `bash mv` is invisible to
read-tracking, `bash sed -i` is invisible to edit fidelity and post-edit
diagnostics, and `bash cat` doesn't mark a file read so read-before-write can
never fire. Every one of those is a hole through the safety and evidence layers,
and models reach for bash constantly because their priors say bash is universal.

Two mechanisms enforce it:

1. **Native coverage** — every observable operation gets a tool (§4).
2. **Shadow detection** (§5.6) — when `bash` receives a command a native tool
   covers, it returns a normal `ToolResult` pointing at the native tool instead
   of executing. Self-correcting, costs one step the first time, and it does not
   depend on winning an argument with the system prompt.

### Sizing discipline

Every tool costs description tokens in the stable prefix of *every* request and,
more expensively, costs discrimination pressure. The test for splitting:

> Two tools deserve separate slots only when the model faces a real choice
> between them with an obvious right answer.

`read` / `grep` / `glob` pass — three different questions (I know the path / I
know the content / I know the name shape). `git status` / `git diff` / `git log`
fail — one mental model with a mode selector, so they are ops inside `git`.

Budget: **~17 internal slots + 2 heku slots.** Adding an 18th requires removing
one or arguing the case in this document.

---

## 3. Foundational contracts

Everything in §4 depends on these. They land first, in TL0.

### 3.1 `ToolResult` v2 — `engine/src/tools/types.ts`

The current shape has no channel to the model at all:

```ts
// current
export interface ToolResult {
  ok: boolean;
  summary: string;        // UI chip
  detail?: string;        // populated ONLY by skills + MCP
  artifactId?: string;    // artifacts panel
}
```

Replace with:

```ts
export interface ToolResult {
  ok: boolean;

  /** For the model. The ONLY field routed into the message stream. */
  content?: string;

  /** For the UI chip. One line. Never sent to the model. */
  summary: string;

  /** For the artifacts panel. Never sent to the model. */
  artifactId?: string;

  /** Structured metadata consumed by the loop, the UI, and instrumentation. */
  meta?: ToolResultMeta;
}

export interface ToolResultMeta {
  /** Set whenever content is not the whole story. Always surfaced to the model. */
  truncated?: {
    shown: number;
    total: number;
    unit: "lines" | "bytes" | "matches" | "entries";
    /** Literal instruction for retrieving the rest, e.g. "read with offset: 2000". */
    how: string;
  };
  /** Machine-checkable feedback (V1). Populated by `check` and by post-edit runs. */
  diagnostics?: Diagnostic[];
  /** Shadow-git commit taken immediately before a mutation. */
  checkpointId?: string;
  /** Feeds the read tracker (M6). */
  filesRead?: FileStamp[];
  /** Invalidates the read tracker + drives the diagnostics scope. */
  filesWritten?: string[];
  durationMs?: number;
  /** For heku calls: which server/tool actually ran. */
  externalTool?: { server: string; tool: string };
}

export interface Diagnostic {
  file: string;
  line: number;
  col?: number;
  severity: "error" | "warning";
  message: string;
  code?: string;
  source: "tsc" | "eslint" | "biome" | "test" | "build" | string;
}

export interface FileStamp {
  path: string;      // project-relative
  mtimeMs: number;
  size: number;
}
```

**Migration.** `detail` is populated in exactly two places —
`engine/src/skills/tools.ts:28` and `engine/src/mcp/registry.ts:28`. Rename to
`content` at both; no compatibility shim.

**Rules that hold for every tool:**

- `content` is what the model sees. If a value is not in `content`, the model
  does not have it. `summary` and `artifactId` are UI-only, forever.
- `content` never silently omits. If it is short, `meta.truncated` says so and
  `how` says how to get more (T2).
- Failure is a `ToolResult` with `ok: false` and a `content` the model can act
  on — never a throw. Already the rule in `permissions.ts`; it holds everywhere.
- `content` for anything derived from file or command output is **data, not
  instruction** (S4). Fenced and labelled by the projection, not by the tool.

### 3.2 `ToolCtx` v2

```ts
export interface ToolCtx {
  chatId: string;
  projectId: string;
  projectPath: string;
  mode: ChatMode;
  abortSignal: AbortSignal;

  // new
  runId: string;
  step: number;
  reads: ReadTracker;          // §5.1
  checkpoints: Checkpointer;   // §5.2
  diagnostics: DiagnosticRunner; // §5.4
  shell: ShellSession;         // §5.5
}
```

Constructed once per run in `loop.ts` and threaded into `createTools(ctx)`
exactly as today.

### 3.3 Risk becomes per-call, not per-tool

`gate()` in `engine/src/agent/permissions.ts` takes a fixed `risk`. Keep the
signature; move the decision to the caller so `bash` and `git_write` can compute
risk from the actual command (S2):

```ts
// bash.ts
const risk = classifyCommand(input.command);   // §5.6
return gate(ctx, { name: "bash", input, risk }, run);
```

No change to the gate's logic, mode matrix, or denial-as-result behaviour. Those
are correct and stay.

### 3.4 A `mutate()` wrapper

Checkpointing must not live inside `gate()` — permission and recovery are
different concerns and conflating them makes both harder to test. Introduce a
thin wrapper used by every mutating tool:

```ts
// engine/src/tools/mutate.ts
export async function mutate(
  ctx: ToolCtx,
  opts: { name: string; input: unknown; risk: ToolRisk; paths: string[] },
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  return gate(ctx, opts, async () => {
    const checkpointId = await ctx.checkpoints.snapshot(`${opts.name} ${opts.paths[0] ?? ""}`);
    const result = await run();
    ctx.reads.invalidate(result.meta?.filesWritten ?? opts.paths);
    return { ...result, meta: { ...result.meta, checkpointId } };
  });
}
```

### 3.5 Persist the result the model saw (M1)

`engine/src/db/toolCalls.ts` stores only `result_summary`, so sessions cannot be
re-projected or replayed (blocks V4 and the eval harness). Add to the
`tool_calls` table:

```sql
ALTER TABLE tool_calls ADD COLUMN result_content TEXT;
ALTER TABLE tool_calls ADD COLUMN result_meta_json TEXT;
```

`finalizeToolCall` writes both. `buildModelMessages` (H1) reads `result_content`
to reconstruct tool-result parts. **This is the single hard dependency the
harness plan's H1 has on this document** — build it in TL0 even though nothing
consumes it until H1.

---

## 4. The catalogue

| # | tool | phase | risk | parallel | replaces |
|---|------|-------|------|----------|----------|
| 1 | `read` | TL0 | low | ✅ | `read` |
| 2 | `glob` | TL0 | low | ✅ | — (new) |
| 3 | `grep` | TL0 | low | ✅ | `grep` |
| 4 | `tree` | TL1 | low | ✅ | `ls` |
| 5 | `outline` | TL5 | low | ✅ | — (new) |
| 6 | `edit` | TL2 | high | ❌ | `edit` |
| 7 | `write` | TL2 | high | ❌ | `write` |
| 8 | `file_op` | TL2 | high | ❌ | — (new) |
| 9 | `bash` | TL3 | computed | ❌ | `bash` |
| 10 | `process` | TL3 | computed | ❌ | — (new) |
| 11 | `git` | TL4 | low | ✅ | — (new) |
| 12 | `git_write` | TL4 | high | ❌ | — (new) |
| 13 | `check` | TL5 | low | ❌ | — (new) |
| 14 | `todo` | TL6 | low | ✅ | — (new) |
| 15 | `explore` | TL6 | low | ❌ | — (new) |
| 16 | `heku_find` | TL7 | low | ✅ | — (new) |
| 17 | `heku_call` | TL7 | computed | ❌ | `mcp_*` flattening |

Plus `skill_*`, which already exists and is correct — leave it alone.

`ls` is retired into `tree`: a single-directory listing is used for orientation,
not enumeration, and depth-limited output serves that better at similar cost.

---

## 5. Cross-cutting subsystems

These are shared machinery, not tools. Several tools are thin wrappers over
them, and they are where the repo's first unit tests should live.

### 5.1 Read tracker — `engine/src/tools/readTracker.ts` (TL2)

Backs T4 and M6. Must survive across turns in a chat, so it is a table, not a
`Map`:

```sql
CREATE TABLE file_reads (
  chat_id   TEXT NOT NULL,
  path      TEXT NOT NULL,
  mtime_ms  INTEGER NOT NULL,
  size      INTEGER NOT NULL,
  read_at   INTEGER NOT NULL,
  PRIMARY KEY (chat_id, path)
);
```

```ts
interface ReadTracker {
  record(stamps: FileStamp[]): void;
  /** "ok" | "unread" | "stale" — the mutating tools' precondition. */
  status(path: string): "ok" | "unread" | "stale";
  invalidate(paths: string[]): void;
}
```

`status` re-stats the file at call time; `stale` means the on-disk mtime or size
differs from what was recorded. `read` records; `edit`/`write`/`file_op` check.

The refusal message matters more than the check:

```
Refused: src/app.ts changed on disk since you read it at step 4
(mtime 14:22:01 → 14:23:40). Someone edited it outside this session.
Re-read it before editing — your oldString may no longer be accurate.
```

### 5.2 Checkpoints — `engine/src/checkpoints/` (TL2)

A shadow git repository that never touches the user's index, history, HEAD, or
hooks:

```
git --git-dir=<project>/.rama/checkpoints.git --work-tree=<project> ...
```

- Initialised lazily on the first mutation in a project. Works whether or not
  the project is itself a git repo, and whether or not it is clean.
- `snapshot(label): Promise<string>` — `add -A` (honouring `.gitignore` plus a
  Rama-specific ignore for `.rama/`) then `commit-tree`. Returns the commit id.
- Called at run start and immediately before every mutating tool call, via
  `mutate()` (§3.4).
- `restore(id)` — checkout the tree into the work tree.
- `diffSince(id)` — the "what did this run change" view for the UI.

**Exposure:** checkpoints are a *user* affordance in v1 — `/undo`, and a
"restore to here" control on each user message — not a model tool. The model
recovering from its own bad edit should re-edit, not time-travel; letting it
roll back can silently discard the user's concurrent work. Revisit if the eval
suite shows otherwise (§9).

Perf note: snapshotting a large repo on every edit is the obvious risk. Measure
on the dogfood repo first; if `add -A` is too slow, scope the snapshot to
`paths` from `mutate()` plus a full snapshot at run start.

### 5.3 Patch engine — `engine/src/tools/patch.ts` (TL2)

The most important pure module in the codebase. **The failed-edit rate is the
strongest single predictor of whether a coding agent finishes a task** — every
failure costs a retry, retries compound, and at three failures the model starts
rewriting whole files, which is where real damage happens.

```ts
interface EditSpec { oldString: string; newString: string; replaceAll?: boolean }

interface PatchOutcome {
  ok: boolean;
  content?: string;          // full new file content; caller writes it
  applied: number;
  failure?: {
    index: number;           // which edit in the array
    reason: "not_found" | "not_unique" | "empty_old_string";
    occurrences?: number;
    /** Nearest candidate region, for the error message. */
    nearest?: { line: number; excerpt: string };
  };
}

export function applyEdits(original: string, edits: EditSpec[]): PatchOutcome;
```

**Matching ladder**, tried in order per edit:

1. Exact match, exactly once → apply.
2. Exact match, N > 1, `replaceAll` set → apply to all.
3. Exact match, N > 1, no `replaceAll` → fail `not_unique`, report N and the
   line numbers of the first three occurrences.
4. **Indentation-tolerant match**: re-match with each line's leading whitespace
   normalised. If that yields exactly one hit, re-anchor to the *original*
   bytes at that offset and apply — never write the normalised form back.
   Models reliably mangle leading whitespace; this recovers a large fraction of
   otherwise-fatal failures without loosening correctness.
5. Fail `not_found`, with `nearest` computed by finding the highest-similarity
   window in the file, so the error can show the model what is actually there.

**Byte preservation** — detect from the original and reapply to the result:
line endings (CRLF/LF, including mixed → preserve dominant), trailing newline
presence, UTF-8 BOM. Silently normalising any of these turns a three-line change
into a four-hundred-line diff and poisons every subsequent `git diff`.

**Atomicity** — all edits are applied to an in-memory string in order; a failure
at edit 3 of 5 means **nothing is written**. A half-transformed file is a state
the model recovers from badly.

**This module is pure, synchronous, and needs no model, no filesystem, and no
DB. It is where the repo's first tests go** (`find . -name "*.test.ts"`
currently returns nothing).

### 5.4 Diagnostics — `engine/src/diagnostics/` (TL5)

One engine, two entry points: automatic post-edit (T7) and explicit `check`
(V1).

```ts
interface DiagnosticRunner {
  /** Fast, file-scoped, sub-second. Runs automatically after every mutation. */
  fast(paths: string[]): Promise<Diagnostic[]>;
  /** Slow, project-wide. Only from the `check` tool. */
  full(kinds: CheckKind[]): Promise<{ diagnostics: Diagnostic[]; summary: CheckSummary }>;
}
```

**Command resolution**, in order: a `## Commands` block in `RAMA.md` (H2) >
`package.json` scripts > detection by lockfile/config presence. Cache the
resolution per project; invalidate on config mtime.

**Parsers** normalise each tool's output into `Diagnostic[]`: `tsc` pretty and
non-pretty forms, ESLint/Biome JSON, Vitest/Jest/`bun test` reporters, generic
`file:line:col: message`. Unparseable output falls back to head+tail of raw text
with a note — never dropped silently.

**Budget.** Raw test output is enormous and mostly noise; a structured failure
list is an order of magnitude smaller and strictly more actionable. Cap content
at 20 diagnostics grouped by file, with `meta.truncated` carrying the true
total.

### 5.5 Shell session — `engine/src/tools/shell.ts` (TL3)

**Amended per `docs/MISSION_CONTROL_PLAN.md` §7.4 — background processes are
no longer part of this session's lifecycle.** The original draft below put
`spawnBackground`/`readBackground`/`kill` on the same run-scoped object as
`run()`, which implied they were disposed together. They are not: a dev server
started with `bash background:true` is a project-scoped `terminals` row over
the Rust-owned PTY, re-keyed by `terminal_id` (Mission Control §6), and it
outlives the run, the abort, and the chat that started it — it is only stopped
by an explicit `process kill` or the app quitting (Mission Control §0.1,
Open Question 1). Foreground `run()` is unaffected by this and keeps its
original per-run lifetime below.

`bash` currently does `Bun.spawn(["/bin/sh", "-c", cmd])` per call
(`bash.ts:32`), so `cd`, exported vars, and activated environments evaporate
between calls. Replace with one long-lived shell per run.

**Correction: no PTY here, on either side of the split above.** The original
draft said this reused "the PTY infrastructure the Rust core already has from
Phase 8" — that pointed at `pty.rs`, which lives in the Tauri app, not the
engine. Two problems with that: TL3's own exit criterion runs the engine
headlessly (`cd packages/protocol` then `bun test`, no Tauri app involved), so
a foreground shell that depends on Rust IPC couldn't pass its own exit check;
and a PTY is for a *program that expects a terminal* (job control, tty-aware
color/prompt behavior) — exactly wrong for a tool whose output is captured,
truncated, and read by a model, where the absence of a tty is what keeps CLIs
quiet (no ANSI, no progress bars). Mission Control's PTY re-key (§6) is a
different, correct use of `pty.rs`: it backs *background* terminals the user
can see and type into. The foreground `ShellSession` below is a plain
`Bun.spawn` with piped stdio, held open for the run and driven with the
sentinel protocol — engine-only, no Tauri dependency.

```ts
interface ShellSession {
  run(cmd: string, opts: { timeoutMs: number; signal: AbortSignal }): Promise<ShellResult>;
  cwd(): string;
  dispose(): Promise<void>;
}
```

Command completion and exit-code capture use a sentinel echo
(`__rama_done_<nonce>:$?`) rather than parsing prompts. This foreground session
is disposed on run end and on abort — the existing `AbortController` wiring
extends to it unchanged. `background` on `bash` (§6.9) and the `process` tool
(§6.10) do not go through this object at all; they talk to the terminal
registry described in `docs/MISSION_CONTROL_PLAN.md` §5 and §6.

**Truncation changes from head-only to head+tail.** The current
`MAX_OUTPUT_BYTES = 100_000` head-only truncation discards exactly the part that
matters: a failing test run's summary is at the *end*. Take the first 30% and
last 70% of the budget with an explicit elision marker in between.

### 5.6 Command risk and shadow detection — `engine/src/tools/risk.ts` (TL3)

`bash` is blanket `high` today, which means every `git status` prompts in ask
mode, which trains reflexive approval and destroys the value of the gate (S3).

```ts
export function classifyCommand(cmd: string): ToolRisk;
export function findShadow(cmd: string): ShadowHint | null;
```

Classification operates on a parsed command list (split on `;`, `&&`, `||`, and
pipes; every segment classified; **the maximum wins**):

- `low` — a explicit allowlist of read-only commands: `ls`, `cat`, `pwd`, `wc`,
  `head`, `tail`, `which`, `echo`, `date`, `node -v`, `git status|diff|log|show`.
- `high` — everything else. Unknown is high. Deliberately: a false `high` costs
  one approval, a false `low` costs the user's work.
- Hard-refuse — patterns that are never worth executing from a model:
  `rm -rf /`, `:(){ :|:& };:`, `curl … | sh`, `dd of=/dev/*`, history rewrites
  on a shared branch. Refused with a `ToolResult`, not silently.

**Shadow detection** returns a redirect for commands a native tool covers:

| command shape | hint |
|---|---|
| `git commit`, `git add`, `git checkout`, `git restore` | use `git_write` |
| `git status`, `git diff`, `git log`, `git show`, `git blame` | use `git` |
| `cat <file>`, `head`, `tail`, `less` on a single file | use `read` (marks it read) |
| `mv`, `cp`, `rm`, `mkdir` | use `file_op` |
| `sed -i`, `perl -pi`, `awk … > file`, `> file` | use `edit` or `write` |
| `find … -name` | use `glob` |
| `grep -r`, `rg` | use `grep` |
| `npm test`, `tsc --noEmit`, `eslint`, `vitest` | use `check` |

The hint is returned as `ok: false` with a `content` naming the equivalent call,
**without executing**. An `override: true` arg on `bash` bypasses it for the
genuine exceptions, and its use is instrumented — a high override rate means a
native tool has a gap.

**This table is the full end-state design, not all of it live in TL3.** The
`git`/`git_write` and `check` rows name tools that don't exist until TL4/TL5 —
redirecting to a tool that isn't registered would be worse than just running
the command, so `risk.ts` only wires up the rows whose target already exists
(`read`, `file_op`, `edit`/`write`, `glob`, `grep`) and leaves the rest as a
literal no-op until the corresponding phase lands and can flip them on.
**Update (TL5):** every row is now wired up — `git`/`git_write` landed in TL4,
`check` in TL5.

---

## 6. Tool specifications

Schemas are Zod, matching the existing `tool({ description, inputSchema,
execute })` pattern. Descriptions below are content, not final copy — but they
are prompt (T1), so they state **when not to** use the tool as well as when to.

### 6.1 `read` — TL0

```ts
inputSchema: z.object({
  path: z.string().describe("Path relative to the project root"),
  offset: z.number().optional().describe("1-indexed first line to return. Use with limit to page a large file."),
  limit: z.number().optional().describe("Lines to return. Default 2000."),
})
```

**Description:** reads a file into context with line numbers. Prefer `outline`
first for files over ~500 lines; prefer `grep` when you know what you are
looking for but not where. Do not use `bash cat` — it does not mark the file as
read, and `edit` will refuse afterwards.

**Content format** — the gutter is `%4d| `:

```
src/agent/loop.ts (1–120 of 412 lines)
   1| import { createAnthropic } from "@ai-sdk/anthropic";
   2| import { stepCountIs, streamText } from "ai";
```

The description must state explicitly that **line-number gutters are display
only and must never appear in `edit`'s `oldString`**. This is the single most
common failure mode introduced by adding line numbers, and it is entirely
preventable in the description.

**Side effects:** `meta.filesRead` populated → read tracker records the stamp.

**Non-text files:** images return an image content part when the model's
registry entry declares vision, else `[image · 42KB · image/png — this model
cannot view images]`. Other binaries return
`[binary · 1.2MB · application/zip]`. Never dump bytes.

**Errors:** `ENOENT` runs a basename glob and returns
`not found: src/util.ts — did you mean src/utils.ts, src/util/index.ts?` (T3).
`EISDIR` redirects to `tree`.

### 6.2 `glob` — TL0

```ts
inputSchema: z.object({
  pattern: z.string().describe('Glob, e.g. "src/**/*.ts" or "**/*.test.*"'),
  path: z.string().optional(),
  limit: z.number().optional().describe("Default 200."),
})
```

Honours `.gitignore` plus the existing `EXCLUDE_DIRS` set from `grep.ts:9`.
**Sorted by mtime descending, not alphabetically** — the recently-touched file
is nearly always the relevant one, and the ordering costs nothing.

Content: a count header, then relative paths one per line.

### 6.3 `grep` — TL0

```ts
inputSchema: z.object({
  pattern: z.string().describe("Regex (Rust regex syntax under ripgrep, POSIX ERE under the fallback)"),
  path: z.string().optional(),
  glob: z.string().optional().describe('Restrict to matching files, e.g. "*.ts"'),
  caseInsensitive: z.boolean().optional(),
  contextLines: z.number().optional().describe("Lines of context around each match. Default 0."),
  mode: z.enum(["content", "files", "count"]).default("content")
    .describe('"count" first when a pattern may be broad — it is one line per file and lets you narrow before pulling matches.'),
  limit: z.number().optional().describe("Max matches. Default 200."),
})
```

Backed by `rg` when present, falling back to the current `grep -rn` invocation
(`grep.ts:26`) otherwise. **`mode: "count"` is the highest-leverage addition** —
it lets the model widen and narrow before spending context, and saves more
tokens than most of the projection's decay rules.

Content in `content` mode: a per-file count table, then the matches.

```
"createTool" — 37 matches in 6 files

  engine/src/tools/index.ts        6
  engine/src/tools/read.ts         1
  …

engine/src/tools/index.ts:11:    read: createReadTool(ctx),
```

### 6.4 `tree` — TL1 (replaces `ls`)

```ts
inputSchema: z.object({
  path: z.string().optional(),
  depth: z.number().optional().describe("Default 2."),
  limit: z.number().optional().describe("Max entries. Default 200."),
})
```

Indented tree, directories first, gitignored paths collapsed to a count
(`node_modules/ (4,812 entries, ignored)`). Truncation is breadth-first so the
shape of the project survives the cap.

### 6.5 `outline` — TL5

```ts
inputSchema: z.object({ path: z.string().describe("A file, or a directory to outline every file within") })
```

Symbols with line numbers, no bodies. Backed by tree-sitter (bundled grammars
for TS/JS/TSX/Rust/Python/Go to start) with an LSP `documentSymbol` path where a
server is already running.

**Reading a 2000-line file to find one function is the most common context waste
in a coding harness**, and this is the fix. It doubles as the first form of the
structural index `HARNESS_DESIGN.md` wants for M4 — build it as a tool, get the
index for free.

```
engine/src/agent/loop.ts (412 lines)
  24  function resolveModel(providerRow, model, apiKey): LanguageModel
  41  function toModelMessage(m): ModelMessage
  58  export function interrupt(chatId): boolean
```

### 6.6 `edit` — TL2

```ts
inputSchema: z.object({
  path: z.string(),
  edits: z.array(z.object({
    oldString: z.string().describe("Exact text to replace. Never include read's line-number gutter."),
    newString: z.string(),
    replaceAll: z.boolean().optional(),
  })).min(1).describe("Applied in order, atomically — if any edit fails, none are written."),
})
```

The array is the change from today's single-edit shape (`edit.ts:31`). Batching
edits to one file into one call cuts steps, and atomicity means a partial
failure can never leave a half-transformed file.

**Preconditions**, checked before anything is written:
1. `ctx.reads.status(path)` is `"ok"` — else refuse with the §5.1 message.
2. `applyEdits` (§5.3) succeeds for every edit.

**Post-conditions:** checkpoint via `mutate()`, then `ctx.diagnostics.fast([path])`,
with results in both `meta.diagnostics` and `content`. An edit that introduces a
type error reports it in that edit's own result — the model fixes it in the next
step instead of discovering it ten steps later (T7).

**Content on success:**

```
src/agent/loop.ts · 2 edits applied · +12 −3

@@ -41,7 +41,7 @@
-function toModelMessage(m: MessageDTO): ModelMessage {
+function toModelMessage(m: MessageDTO): ModelMessage | null {

1 new diagnostic:
  src/agent/loop.ts:107  error  TS2345: Argument of type 'ModelMessage | null' …
```

**Content on failure** — the model needs to see what is actually there:

```
No edit applied (edits are atomic).

edit 2 of 3 failed: oldString not found in src/agent/loop.ts
Nearest match at line 41 (whitespace differs):

  41|   function toModelMessage(m: MessageDTO): ModelMessage {
        ^^ file has 2-space indent; your oldString has 4

Re-read the file or adjust the indentation.
```

### 6.7 `write` — TL2

```ts
inputSchema: z.object({
  path: z.string(),
  content: z.string(),
  overwrite: z.boolean().optional().describe("Required to replace an existing file with substantially less content."),
})
```

**Shrink guard.** If the file exists, is over 50 lines, and the new content is
under 50% of its size, refuse unless `overwrite: true`:

```
Refused: this would shrink src/agent/loop.ts from 412 lines to 38 (−91%).
If you meant to make a targeted change, use `edit`. If you really mean to
replace the whole file, pass overwrite: true.
```

This catches the classic failure where a model emits a stub with
`// ... rest of the file unchanged`, which is silent, catastrophic, and
currently unguarded (`write.ts` overwrites unconditionally).

Same read-precondition as `edit` when the file already exists.

### 6.8 `file_op` — TL2

```ts
inputSchema: z.discriminatedUnion("op", [
  z.object({ op: z.literal("move"),   from: z.string(), to: z.string() }),
  z.object({ op: z.literal("copy"),   from: z.string(), to: z.string() }),
  z.object({ op: z.literal("remove"), path: z.string(), recursive: z.boolean().optional() }),
  z.object({ op: z.literal("mkdir"),  path: z.string() }),
])
```

Thin, but it exists so the file lifecycle is not invisible: every op checkpoints
and invalidates the read tracker. `remove` on a directory requires
`recursive: true`. All paths through `resolveInProject` (`paths.ts`).

Uses `git mv` when the project is a git repo and the path is tracked, so history
follows the rename.

### 6.9 `bash` — TL3

```ts
inputSchema: z.object({
  command: z.string(),
  timeoutMs: z.number().optional(),
  background: z.boolean().optional().describe("Start a long-running process (dev server, watcher) and return immediately."),
  override: z.boolean().optional().describe("Run even if a native tool covers this command. Prefer the native tool."),
})
```

Changes from today: persistent session (§5.5), computed risk (§5.6), shadow
detection (§5.6), head+tail truncation, and `background`.

Keeps everything that is already right: live artifact streaming, abort wiring
into subprocess kill, the timeout cap.

**`content`** carries exit code, duration, cwd if it changed, and the truncated
output with an explicit elision marker. Streaming to the artifact panel is
unchanged and remains UI-only.

### 6.10 `process` — TL3

```ts
inputSchema: z.discriminatedUnion("op", [
  z.object({ op: z.literal("list") }),
  z.object({ op: z.literal("read"), id: z.string(), since: z.number().optional() }),
  z.object({ op: z.literal("kill"), id: z.string() }),
])
```

The companion to `bash background`. Dev servers and test watchers are the real
use case, and they are also the thing that makes a persistent shell worth its
complexity. **Amended per `docs/MISSION_CONTROL_PLAN.md` §7.4:** background
processes are *not* killed on run end or on abort — a dev server that dies when
the turn ends is useless. They outlive the run entirely and are visible in
Mission Control's Terminal pane for as long as the app is open; only an
explicit `process kill` (refused on `owner: 'user'`, Mission Control §7.3) or
an app quit stops one (Mission Control Open Question 1).

### 6.11 `git` (read) — TL4

```ts
inputSchema: z.discriminatedUnion("op", [
  z.object({ op: z.literal("status") }),
  z.object({ op: z.literal("diff"), ref: z.string().optional(), staged: z.boolean().optional(),
             path: z.string().optional(), hunks: z.boolean().optional()
               .describe("Default false: file list and stats only. Set true for full hunks — expensive.") }),
  z.object({ op: z.literal("log"), path: z.string().optional(), ref: z.string().optional(), limit: z.number().optional() }),
  z.object({ op: z.literal("show"), ref: z.string(), path: z.string().optional() }),
  z.object({ op: z.literal("blame"), path: z.string(), startLine: z.number().optional(), endLine: z.number().optional() }),
])
```

Low risk, parallel-safe, offline. Implemented over porcelain v2 / `-z` formats,
never by scraping human-readable output.

**`hunks: false` by default is the point of the tool.** A raw `git diff` over 40
changed files is thousands of tokens of noise; file list plus per-file stats is
a few hundred, and the model asks for hunks on the three files it cares about.
That is an intelligent truncation policy you cannot apply to bash output.

`log` and `blame` are the underrated ops: "why is this code like this" is
answerable from history and models almost never look, because the affordance
isn't there.

**`status` should usually not be a tool call at all.** A compact branch +
dirty-file summary belongs in the **ephemeral block** (C9, H2), refreshed each
step. That kills the most common wasted first step in every session. The tool
remains for detail and for post-mutation confirmation.

### 6.12 `git_write` — TL4

```ts
inputSchema: z.discriminatedUnion("op", [
  z.object({ op: z.literal("stage"),    paths: z.array(z.string()) }),
  z.object({ op: z.literal("unstage"),  paths: z.array(z.string()) }),
  z.object({ op: z.literal("commit"),   message: z.string(), stageAll: z.boolean().optional() }),
  z.object({ op: z.literal("branch"),   name: z.string(), from: z.string().optional() }),
  z.object({ op: z.literal("checkout"), ref: z.string() }),
  z.object({ op: z.literal("restore"),  paths: z.array(z.string()) }),
  z.object({ op: z.literal("stash"),    pop: z.boolean().optional() }),
])
```

**Deliberately absent, and the description says so:** `push`, `pull`, `fetch`,
`merge`, `rebase`, `reset --hard`, `clean`, `commit --amend`, anything `--force`.
Remote operations are the external layer's business (§7). History rewriting and
hard resets are what checkpoints (§5.2) exist for; exposing both is how you get
a model choosing the destructive one.

**Refusals:**
- `checkout` / `restore` with uncommitted changes to the affected paths →
  refused, with the changed paths named and `stash` suggested.
- `commit` with nothing staged and no `stageAll` → refused with the status.
- `commit` on a detached HEAD or mid-rebase/merge → refused with the state.

**Commit messages follow the repo's rule** (`~/.claude/CLAUDE.md`): no
co-authorship trailer. The tool strips any `Co-authored-by:` line the model
emits rather than relying on the prompt to suppress it — a policy the harness
can enforce mechanically should not be left to the prompt.

### 6.13 `check` — TL5

```ts
inputSchema: z.object({
  kinds: z.array(z.enum(["typecheck", "lint", "test", "build"])).optional()
    .describe("Defaults to typecheck + lint. Add test explicitly — it is slow."),
  path: z.string().optional().describe("Scope to one file or directory where the underlying tool supports it."),
})
```

The V1 tool: **machine-checkable feedback beats self-assessment**, because a
model asked "did that work?" says yes.

Not `bash npm test` — it resolves the project's real commands (§5.4), runs them,
and returns structured diagnostics. Content is grouped by file, capped at 20,
with `meta.truncated` carrying the total:

```
typecheck: 2 errors · lint: clean · (test not run)

engine/src/agent/loop.ts
  107:24  error  TS2345  Argument of type 'ModelMessage | null' is not assignable…
  118:9   error  TS2532  Object is possibly 'undefined'.
```

The description must say **run this before declaring work complete** — the
single highest-value sentence in the whole tool inventory.

### 6.14 `todo` — TL6

```ts
inputSchema: z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), items: z.array(z.object({ text: z.string() })) }),
  z.object({ op: z.literal("update"), index: z.number(), status: z.enum(["pending", "active", "done"]) }),
])
```

M5. The list is re-injected into the **ephemeral block** every step, so it
survives compaction in ~150 tokens, resists drift on long tasks, gives the UI a
progress view, and gives the user an interception point. Exactly one item may be
`active`; setting a second one moves the first to `done` — a constraint enforced
in the tool, not asked for in the prompt.

**Implemented (TL6) as a minimal, todo-only stand-in for C9**, not the general
reminder framework `HARNESS_DESIGN.md` H2 will eventually build: `agent/loop.ts`
uses `streamText`'s `prepareStep` to strip any previously-injected reminder
message and, while the list has open items, splice a fresh
`<system-reminder id="todo-list">` block back in right after the run's user
message — never persisted, regenerated every step, exactly what C9 (H2) itself
specifies, just scoped to one reminder kind instead of a general layer. When H2
lands for real, this collapses into a call into it rather than a rewrite. State
lives in a new `chat_todos` table (`db/todos.ts`), one row per chat, broadcast
over `todo.updated` for the future Mission Control "Todos" pane
(`apps/desktop/src/app/mission-control/panes.ts` already anticipates it).

### 6.15 `explore` — TL6

```ts
inputSchema: z.object({
  question: z.string().describe("A specific question about the codebase, answered by reading it."),
  hint: z.string().optional().describe("Where to start looking, if you know."),
})
```

A nested run with an isolated context and a **read-only toolset** — `read`,
`glob`, `grep`, `tree`, `outline`, and nothing else. Its own step budget
(default 12), same provider and model, returns prose plus cited paths.

**This is the cheapest context lever available.** A search that reads thirty
files to answer one question should return a paragraph, not thirty file bodies,
and no compaction pass recovers those tokens as well as never spending them.
`HARNESS_DESIGN.md` schedules sub-agents at H5 next to compaction; they should
land earlier, because they reduce the odds compaction is needed at all.

The nested transcript is written to the artifacts panel so the run is auditable,
but only the summary enters the parent's context.

---

## 7. heku — the external layer (TL7)

### 7.1 What changes from today

`getServerTools` (`engine/src/mcp/registry.ts`) flattens every connected
server's full tool list into every request with no cap (X2). Five servers at
twenty tools each is a hundred schemas in the stable prefix, and it destroys the
model's ability to choose.

heku collapses that into two slots.

### 7.2 Why the gateway shape is right

**It solves X2 structurally rather than with a cap.** A cap is arbitrary and
makes some capabilities randomly unreachable. Ninety-two external tools costing
two slots is not a compromise, it is the correct answer. It is the same
progressive-disclosure pattern `engine/src/skills/discover.ts` already
implements correctly for instructions — descriptions always, bodies on demand —
applied one level up, to capabilities.

**Description normalisation.** Third-party MCP descriptions are wildly
inconsistent, and T1 says descriptions *are* prompt. Behind a gateway they get
rewritten into a consistent shape at index time. The index entry is our text.

**One risk chokepoint.** Every external call passes one gate: per-server and
per-tool policy, allowlists, and the untrusted-output framing (S4) applied
uniformly. Treating all MCP as `high` today is the right instinct; the gateway
is where it becomes granular without becoming scattered.

**Lifecycle isolation.** MCP servers crash, hang, and start slowly. Behind heku,
a dead server degrades `heku_find` results instead of breaking the loop's tool
assembly. **Lazy connect** — don't spawn a server until one of its tools is
called — turns cold start from a per-session tax into a per-use one.

### 7.3 The two real costs, and their mitigations

**Two-step invocation** spends an extra round trip and a step of budget.
Mitigated partly by having `heku_find` return full schemas so `heku_call` is
immediate; mitigated properly by **promotion** (§7.6).

**Indirection degrades tool-call fidelity.** A model reliably calls `read`; it
is measurably less reliable at `heku_call({ tool, args })`, because nested
arbitrary JSON inside a fixed schema loses the provider's own schema validation
on the inner args. heku must validate against the real schema itself and return
errors the model can act on (T3). This is the strongest argument for promotion,
and it should be measured (§8) rather than assumed away.

### 7.4 Architecture

```
engine/src/heku/
  index.ts       // broker: find / call / manifest
  indexer.ts     // pulls tool lists at connect, normalises, embeds
  store.ts       // sqlite: heku_tools(server_id, name, description, schema_json, embedding)
  policy.ts      // per-server + per-tool risk, allowlists
  promote.ts     // §7.6
  tools.ts       // heku_find + heku_call as rama tools
```

**In-process broker, not a separate MCP server.** The existing comments at
`engine/src/search/types.ts:2` and `packages/protocol/src/index.ts:183` describe
heku as "its own standalone MCP server scoped to config search" — that framing
predates this design and should be updated. As *the* external tool layer it
should live in the engine, because a broker that can crash is strictly worse
than one that cannot; the process boundary buys no isolation that the MCP
servers behind it don't already provide; and the index has to serve both the ⌘K
palette and the model from one place. The elegance of "heku is itself an MCP
server" is paid for on every external call. (Flagged in §9 — this is the one
call in this document I would most want challenged.)

**Reuse the existing search seam.** `engine/src/search/types.ts` already defines
a `SearchProvider` interface with `list()` required and `search()` optional,
explicitly anticipating "a teammate's embeddings-based indexer". heku registers
as the provider for the external-tools domain. The palette and the model then
share one index, which is the unification that seam was built for.

### 7.5 The two tools

```ts
// heku_find
inputSchema: z.object({
  intent: z.string().describe('What you want to do, in plain language — "create a pull request", "screenshot a page".'),
  limit: z.number().optional().describe("Default 5."),
})
```

Returns ranked tools with **full input schemas**, so the follow-up call needs no
second lookup:

```
3 tools for "create a pull request":

github.create_pull_request  (risk: high)
  Open a PR from a branch. args: { title, body, head, base, draft? }
…
```

```ts
// heku_call
inputSchema: z.object({
  tool: z.string().describe("Exact id from heku_find, e.g. github.create_pull_request"),
  args: z.record(z.unknown()),
})
```

Validates `args` against the cached schema *before* dispatch and returns
field-level errors on mismatch. Applies the policy gate. Normalises the result
through the existing `normalizeCallToolResult` logic
(`engine/src/mcp/registry.ts:17`), now populating `content` rather than `detail`.
Frames output as untrusted data (S4).

### 7.6 Promotion — the hybrid that makes it work in practice

Pure gateway is architecturally clean and slightly worse in practice. Frequently
used or user-pinned external tools get lifted into the inventory as first-class
slots:

```ts
interface PromotionPolicy {
  pinned: string[];        // user-chosen, from settings
  autoPromote: boolean;    // promote tools called >N times in the last M sessions
  maxPromoted: number;     // default 5 — the budget stays a budget
}
```

Promoted tools are generated as real `tool()` entries with their own schemas.
`gh_create_pr` becomes a real tool; the other eighty-nine stay behind the
gateway.

### 7.7 The capability manifest — the part that decides whether any of this works

**If external tools are invisible, the model never thinks to search for them.**
The fix is small and belongs in the stable prefix of the system prompt (C3):
one line per connected server, categories not tools.

```
External capabilities (search with heku_find):
  github — repositories, pull requests, issues, reviews
  playwright — browser automation, screenshots, DOM inspection
  postgres — schema inspection, read-only queries
```

Fifty tokens instead of twenty thousand, and it is the difference between heku
being used and heku being decorative. It is regenerated on connect/disconnect
and belongs in the stable prefix precisely because it changes rarely.

### 7.8 Ranking: embeddings earn their place here

`HARNESS_DESIGN.md` argues, correctly, that *code* search should start
structural and lexical, because code has exact identifiers and grep beats
embeddings for most real queries.

**Tool search is the opposite case.** The model queries by intent — "create a
pull request", "take a screenshot" — not by identifier, and it does not know the
vocabulary the third-party author chose. `heku_find("screenshot a page")` must
match a tool described as "capture the viewport". Lexical scoring cannot do
that.

So: local embeddings (a small sentence model, ~50MB, computed once per tool at
index time) with a lexical BM25 blend for exact names. Cheap — the corpus is
hundreds of short strings, not a codebase — and re-indexed only on connect.
Don't let the right skepticism about vector search for code talk you out of
embeddings for tools.

---

## 8. Testing, evals, and determinism

The repo currently has zero tests (`find . -name "*.test.ts"` returns nothing),
and `HARNESS_DESIGN.md` §V3 schedules evals last while conceding that everything
before them is guesswork. The tool layer is where that gets fixed cheaply,
because most of it is testable **without a model**.

### 8.1 Three tiers

**Unit (TL2 onward).** `patch.ts` (§5.3) is pure, synchronous, needs no
filesystem or DB, and encodes the most consequential logic in the layer. Its
test file is the first one in the repo. Cases: exact/unique, non-unique with and
without `replaceAll`, indentation-tolerant recovery, CRLF preservation, BOM
preservation, trailing-newline preservation, multi-edit atomicity on
mid-sequence failure, `nearest` computation. Same treatment for `risk.ts` and
each diagnostic parser.

**Contract (TL3 onward).** Every tool, against a fixture project, asserting the
shape of `content` — not just `ok`. `content` is prompt, so a change to it is a
prompt change and needs a test. Includes the negative cases: stale-file refusal,
shrink guard, shadow redirect, non-unique edit error.

**Eval (after TL5).** ~20 real tasks with programmatic success checks, driving
the real loop. Half of them should be tasks the tool layer specifically
enables — "fix the type error", "rename this symbol across the repo", "find why
this test fails" — so the suite measures tool quality rather than model quality.

### 8.2 Determinism requirements

These are properties to design in now, not retrofit:

- **No interactive prompts on the tool path.** The permission policy is
  injectable; the eval harness supplies a scripted one. `gate()` already takes
  `ctx.mode`, so this is a `ToolCtx` addition, not a rewrite.
- **Tool behaviour is fully determined by args plus filesystem state.** No
  ambient reads of user config from inside a tool.
- **A fixture project per test**, created and torn down, so checkpoints and the
  read tracker have somewhere real to operate.
- **Network never touched by the internal layer** (§1). This is the property
  that makes the whole suite fast and reproducible, and it is the practical
  reason for the internal/external line.

### 8.3 Metrics the layer must emit (V2)

Per tool, per session: call count, error rate, p50/p95 duration, truncation
rate, repeated-identical-call count. Plus three specific to this design:

- **failed-edit rate**, split by failure reason. The single best proxy for
  harness quality; a rise after any prompt change is a regression.
- **bash override rate.** A high rate means a native tool has a gap.
- **heku find→call conversion.** Searches that produce no call mean ranking is
  bad or the manifest is misleading.

---

## 9. Phases and exit criteria

### TL0 — Results reach the model  ★ blocks everything
Fused with harness H0.
- `ToolResult` v2 (§3.1); rename `detail` → `content` at its two call sites.
- Populate `content` in all six existing tools. Delete the
  `"… added to context"` summary at `read.ts:35`, which describes a thing that
  does not happen.
- `read` gains `offset`/`limit` and line numbers; `grep` gains the per-file
  count table; `bash` switches to head+tail truncation.
- New: `glob`.
- Persist `result_content` + `result_meta_json` on `tool_calls` (§3.5).
- **Exit:** read a file, then edit based on what was read, in one turn, against
  Anthropic and against Together. A second turn can reference the first turn's
  tool results.

### TL1 — Navigation
- `tree` replaces `ls`. `grep` gains `mode`, `glob`, `contextLines`, ripgrep
  backend with fallback. `read` gains nearest-match errors and binary/image
  handling.
- All navigation tools marked parallel-safe; the loop honours it (T5).
- **Exit:** orienting in an unfamiliar 500-file repo takes three tool calls, and
  three read-only calls in one step run concurrently.

### TL2 — Mutation safety
The most important phase in this document.
- `patch.ts` (§5.3) + its tests — the repo's first tests.
- Read tracker (§5.1) + `file_reads` table.
- Checkpoints (§5.2) + `/undo` + per-message restore in the UI.
- `edit` takes an edit array; `write` gains the shrink guard; `file_op` lands.
- **Exit:** an edit to a file changed on disk mid-run is refused with a re-read
  instruction; a five-edit call that fails on edit three writes nothing; a CRLF
  file stays CRLF; `/undo` restores the tree after a bad run.

### TL3 — Execution
- Persistent shell (§5.5) over the Rust core's PTY.
- `risk.ts`: per-command classification + hard-refuse list (§5.6).
- Shadow detection + `override`.
- **`bash background` + `process` are deferred to Mission Control M4, not built
  here.** Both need a real project-scoped, re-keyed PTY (`terminals` table,
  `pty_list_running`) that doesn't exist until Mission Control M2/M3 land —
  building an engine-only stand-in now (in-memory `Bun.spawn` tracking, say)
  would be thrown away the moment M4 replaces it, per §5.5/§6.10's amendment
  above. The `background`/`override` fields can still be added to `bash`'s
  input schema here so the shape is stable, but they should no-op (or refuse
  with "not yet supported") until M4 wires them to the real terminal registry.
- **Exit:** `cd packages/protocol` then `bun test` works across two calls;
  `git status` no longer prompts in ask mode while `rm -rf` still does;
  `bash mv`/`bash find … -name` redirect to `file_op`/`glob` instead of running.
  (`bash git commit` redirecting to `git_write` is TL4's exit criterion, not
  this phase's — `git_write` doesn't exist until then, see §5.6's shadow table
  note. Dev-server persistence across steps/abort is likewise Mission
  Control M4's, not this phase's — see `docs/MISSION_CONTROL_PLAN.md` §8
  Phase M4.)

### TL4 — Native git
- `git` (read) and `git_write` (§6.11–6.12), porcelain-parsed.
- Compact `git status` moved into the ephemeral block (needs H2's C9 layer).
- **Exit:** the model never shells out to git; a diff across 40 files costs a
  few hundred tokens; `checkout` with uncommitted changes is refused with the
  paths named.

### TL5 — Verification
- Diagnostics engine (§5.4): command resolution, parsers, fast + full tiers.
- `check` tool; automatic post-edit diagnostics wired into `edit`/`write`.
- `outline`.
- Contract test tier (§8.1).
- **Exit:** an edit that breaks types reports the type error in the same step;
  `check` on a repo with 30 failing tests returns under 40 lines; outlining a
  2000-line file costs ~60 lines instead of 2000.

### TL6 — Plan and delegate
- `todo` + ephemeral re-injection.
- `explore` sub-agent with the read-only toolset.
- **Exit:** a six-part task completes all six parts; a question needing thirty
  file reads costs the parent context one paragraph.
- **Shipped:** `todo` (`db/todos.ts` + `tools/todo.ts`) with the exactly-one-
  active constraint enforced in `updateTodo`, and a todo-only ephemeral-block
  stand-in wired into `agent/loop.ts` via `streamText`'s `prepareStep` (see
  §6.14's note — a real C9 layer from H2 replaces this, not extends it).
  `explore` (`tools/explore.ts`) runs a real nested `streamText` call scoped to
  `read`/`glob`/`grep`/`tree`/`outline`, default 12-step budget, same
  `ctx.languageModel` as the parent turn (a new `ToolCtx` field, resolved once
  in `loop.ts`); its full transcript is saved as a `doc` artifact and only the
  final prose answer returns to the caller. Verified end-to-end (including the
  nested tool-calling loop and its artifact) against an offline
  `MockLanguageModelV3` (`ai/test`) — no live provider needed for the sub-agent
  mechanics themselves, only for judging answer quality.

### TL7 — The external layer
- `engine/src/heku/` broker, indexer, policy, store (§7.4).
- `heku_find` / `heku_call`; retire the `getServerTools` flattening.
- Capability manifest into the system prompt (§7.7).
- Promotion (§7.6). Lazy connect. Per-server health degradation.
- Update the stale heku comments at `engine/src/search/types.ts:2` and
  `packages/protocol/src/index.ts:183`.
- **Exit:** five MCP servers with ninety tools cost two schema slots plus a
  three-line manifest; a request needing an unpinned external tool succeeds in
  two calls; a crashed server degrades search instead of breaking the run.
- **Shipped:** `engine/src/heku/` — `store.ts` (the `heku_tools` sqlite table,
  §7.4's schema, `call_count`/`pinned`/`last_called_at` preserved across
  re-index), `indexer.ts` (`indexServer`/`indexAll`, description
  normalisation), `policy.ts` (promotion policy + a per-tool risk-override map
  under settings key `heku_risk_overrides`, both defaulting conservatively —
  every indexed tool is `high` until explicitly downgraded, per §7.2), `promote.ts`
  (`getPromotedTools`: pinned rows always win a slot, `autoPromote` fills the
  rest by call volume, both capped by `maxPromoted`), `index.ts` (the broker —
  lexical ranking, `validateArgs`, `buildManifest`, and `callExternalTool`, the
  one dispatch path shared by `heku_call` and every promoted tool), and
  `tools.ts` (`createHekuTools`, replacing `mcp/registry.ts`'s
  `getServerTools` flattening in `agent/loop.ts`). The capability manifest is
  appended to `SYSTEM_PROMPT` per run in `loop.ts` (cheap enough — one indexed
  sqlite read — that no connect/disconnect invalidation hooks were needed).
  Verified end-to-end against a real stdio MCP server (a throwaway
  JSON-RPC-over-stdio fixture, not a mock) — index, rank, validate, dispatch,
  artifact creation, lazy reconnect after a disconnect, promotion, and the
  risk-override path all exercised for real.
  **Three deliberate, documented scoping decisions**, matching TL3/TL5/TL6's
  precedent of shipping the real thing scoped rather than blocking on a
  missing dependency:
  - **§7.8's embeddings are not built.** No sentence-embedding model is
    bundled yet, so `heku_find` ranks with a lexical token-overlap scorer
    (name match weighted over description match) instead of the
    embeddings+BM25 blend §7.8 describes. This is the one piece of TL7 that
    is a real regression from the plan's stated design, not just a narrower
    version of it — revisit once a small bundled model is worth the binary
    weight.
  - **S4 ("tool output is untrusted data") is not built here.**
    `HARNESS_DESIGN.md` marks S4 `❌ Missing` project-wide, and §3.1's own
    rule says untrusted-output framing is "fenced and labelled by the
    projection, not by the tool" — so `heku_call`'s `content` stays plain,
    normalised tool output, matching `mcp_*`'s old shape exactly, with no
    tool-local wrapping that would contradict that stated architecture. Real
    S4 is a harness-level projection change, out of TL7's scope, same as
    C9/H2 was out of TL6's.
  - **Lazy connect is scoped to `heku_call`'s dispatch boundary, not to
    engine boot.** `mcp/registry.ts`'s `connectAll()` still connects every
    enabled server eagerly at startup, unchanged — rewriting that lifecycle
    risked the existing MCP settings UI (health checks, add/enable/delete)
    in ways this engine-only phase can't visually verify. What *is* real:
    `heku/index.ts`'s `ensureConnected` opens a connection on demand the
    first time a tool on a not-currently-connected server is actually
    called (a boot-time failure, a server added while disabled, or one that
    later crashed), instead of requiring a live connection to already
    exist — verified directly by disconnecting the fixture server mid-test
    and confirming `heku_call` reconnects and still succeeds. Full
    boot-time laziness (never eagerly connecting `connectAll()`'s enabled
    servers) is deferred.
  - Open question 1 (§11) — in-process broker vs. standalone MCP server — is
    settled as in-process, per §7.4's own argument; that is what got built.

---

## 10. Rules that hold across every phase

- **`content` is prompt.** A change to a tool's result shape is a prompt change.
  It gets a contract test, and after the eval suite exists, a measurement.
- **Never silently omit.** Truncation, refusal, degradation, and staleness are
  all stated in `content`. Silent constraints produce confident wrong behaviour.
- **Failure is a result, not an exception.** Already the rule in
  `permissions.ts`; it holds for every tool and for heku.
- **Nothing from a tool is an instruction.** File contents, command output, and
  external tool results are data. No high-risk action is auto-approved on a
  justification that traces back to tool output.
- **The internal layer never touches the network.** That property is what makes
  the eval suite possible; it is worth more than any tool it excludes.
- **Unknown risk is high risk.** A false `high` costs one approval; a false
  `low` costs the user's work.
- **Every phase ships runnable.** `main` never boots broken.

---

## 11. Open questions

1. **Is heku in-process or a separate MCP server?** §7.4 argues in-process. The
   existing code comments say otherwise, and the "heku is itself an MCP server"
   framing has a real virtue — it makes heku reusable outside Rama. Worth
   settling before TL7 starts, because it changes the module boundary.
   **Settled: in-process** (`engine/src/heku/`), per §7.4 — that's what TL7
   shipped. The "reusable outside Rama" virtue is real but unclaimed; revisit
   only if something outside Rama actually wants heku.

2. **Should the model be able to restore a checkpoint?** §5.2 says no in v1 —
   letting it roll back can discard the user's concurrent work, and re-editing
   is the correct recovery. But a model that has made three failed edits and
   knows it has made a mess currently has no clean exit. Revisit once the eval
   suite can show whether it matters.

3. **How aggressive is indentation-tolerant matching?** Step 4 of the ladder
   (§5.3) recovers many otherwise-fatal failures and is the one place the patch
   engine is not exact. Is whitespace-only normalisation the right stopping
   point, or should it extend to trailing commas and quote style? Leaning:
   whitespace only, and let the metrics argue for more.

4. **Checkpoint cost on large repos.** `add -A` per mutation may be too slow on
   a monorepo. Measure before TL2 ships; fall back to path-scoped snapshots plus
   a full snapshot at run start if needed.

5. **`outline` backend.** Bundled tree-sitter grammars (works everywhere, more
   binary weight, per-language work) versus LSP `documentSymbol` (better
   fidelity, requires a running server, per-project setup). Leaning: tree-sitter
   for the guaranteed path, LSP as an upgrade when one is already running.

6. **Does `explore` share the parent's model?** Cheaper to run exploration on a
   small fast model, but a weak explorer returns weak summaries and the parent
   cannot tell. Leaning: same model by default, configurable, and measure before
   optimising.
