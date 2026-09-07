# Rama — Harness Design & Gap Analysis (pass 01)

Phases here are numbered **H0–H6** so they never collide with the build phases
0–8 in `docs/IMPLEMENTATION_PLAN.md`, the redesign phases R0–R7 in
`docs/REDESIGN_PLAN.md`, or the settings phases S0–S5 in
`docs/SETTINGS_PLAN.md`. Cite these as "HARNESS_DESIGN.md Phase H2".

`IMPLEMENTATION_PLAN.md` Phase 3 called itself the boilerplate milestone: "an
end-to-end run edits files, runs a test, and populates the artifacts panel."
That shipped. What it did **not** establish is that the model can *see* any of
it. This document is the audit of that gap and the plan to close it.

**The framing that drives every decision below.** Rama's shell is further along
than Rama's loop. The event contract, the permission gate, the artifact store,
the provider abstraction, and the MCP/skill integration are genuinely
well-built. Almost everything missing is one subsystem: **context** — what the
model is shown, when, and in what shape. A harness is not a chat UI with tools
bolted on; it is a context-management machine with a loop around it. We built
the machine's body first. This plan builds its nervous system.

**Ordering rationale.** H0 is first because nothing else can be evaluated until
tool results reach the model — every quality judgment about prompts, memory, or
compaction is unmeasurable while the agent is working blind. H1 (the projection
function) is the seam that H3–H5 all hang off, so it lands before any of them.
H2 is cheap and independently valuable. H3 is the first thing that costs real
money to get wrong. H4–H6 are expansion.

---

## 0. The premise

A language model is a pure function:

```
f(context) -> text | tool_calls
```

No memory, no filesystem, no continuity. Every part of a harness falls into
exactly three buckets:

1. **Deciding what goes into `context`** — assembly, retrieval, memory, compaction
2. **Executing what comes out** — tools, permissions, sandboxing
3. **Deciding whether to call `f` again** — the loop, stop conditions, budgets

When a design question is unclear, ask which bucket it is in. Confused harness
code is code that mixes buckets. Rama's `read` tool is the canonical example: a
bucket-2 concern (perform a read) that assumed a bucket-1 outcome (the content
lands in context) without anyone building the bridge. Its summary string —
`"412 lines · added to context"` (`engine/src/tools/read.ts:35`) — describes a
thing that does not happen.

The corollary worth internalising: **the model's competence is roughly constant;
the harness's competence is what varies.** The same model in a good harness and
a bad one produces wildly different work. Context quality dominates everything.

---

## 1. The extraction — what makes a harness good

The distilled list. Each item is a property a good harness has; §2 expands each
one and states where Rama stands.

### Context (bucket 1)

| # | Property |
|---|---|
| C1 | **Tool results carry content, not descriptions of content.** Whatever the model needs to choose its next action is *in* the result. |
| C2 | **The model-facing message array is a projection of the transcript, not the transcript.** Two data structures, one lossless, one deliberately lossy. |
| C3 | **The system prompt is assembled, not constant.** Layered: identity, mode, environment, project instructions, live tool inventory. |
| C4 | **The repo can speak.** A checked-in instruction file (`RAMA.md`) carries build commands, conventions, and gotchas into every session. |
| C5 | **Context is ordered for the prompt cache.** Stable prefix first, volatile last. This is a 10x cost lever, not a micro-optimisation. |
| C6 | **Token accounting is pre-flight.** You know the budget before you send, not after the 400. |
| C7 | **Old context decays gracefully.** Stale tool results shrink, superseded reads drop, dead-end exploration collapses — before compaction is ever needed. |
| C8 | **Compaction is structured, preemptive, and visible.** Summarise into named fields at ~80% full, tell the user, keep the real transcript. |
| C9 | **Ephemeral reminders exist.** System-authored blocks appended after the last user message, regenerated each step, never persisted. |

### Loop (bucket 3)

| # | Property |
|---|---|
| L1 | **There is a hook between steps.** Compaction, steering, staleness checks and budget warnings all live there. |
| L2 | **Every stop condition is legible.** A budget-exhausted stop tells the model and the user; it never looks like the model gave up. |
| L3 | **Budgets are plural** — steps, wall clock, tokens, cost — and all four are visible. |
| L4 | **Errors are classified.** Transient retries with backoff; context overflow triggers compaction and retries the step; only permanent errors fail the run. |
| L5 | **The user can steer mid-run.** A message typed at step 4 is delivered at step 4, not rejected or queued to the end. |
| L6 | **Interruption is graceful.** Partial work persists and orphaned tool calls get synthesised results so the next turn is not malformed. |
| L7 | **Loops are detected.** The same call with the same args three times running breaks and says so. |

### Tools (bucket 2)

| # | Property |
|---|---|
| T1 | **Tool descriptions are treated as prompt.** They say when to use the tool *and when not to*; constraints live in schema field descriptions. |
| T2 | **Truncation is explicit and paginable.** The model is told what was cut and how to get the rest. Never silent. |
| T3 | **Errors are actionable.** "File not found — nearest match is X" beats `ENOENT`. |
| T4 | **Read-before-write is enforced.** No edit to a file that has not been read this session, or that changed on disk since. |
| T5 | **Independent read-only calls run in parallel; writes serialise.** |
| T6 | **The shell is a session, not a spawn.** `cd`, env vars, and activated environments persist across calls. |
| T7 | **Post-edit diagnostics are automatic.** Type errors introduced by an edit come back in that edit's result. |

### State and memory

| # | Property |
|---|---|
| M1 | **Episodic memory is lossless.** The transcript records tool *results*, not just summaries, so sessions can be replayed and re-projected. |
| M2 | **Procedural memory exists** — the `RAMA.md` layer (see C4), hierarchical and bootstrappable via `/init`. |
| M3 | **Long-term memory is one fact per file, typed, indexed, and invalidatable.** Recall is cheap enough to be always-on; contradictions are edits, not appends. |
| M4 | **Derived memory is separate from authored memory.** A file tree / symbol index is regenerable and expires on mtime; a user preference is not and does not. |
| M5 | **The plan is externalised.** A todo list the agent maintains, the UI renders, and the assembler re-injects every step — it survives compaction and prevents drift. |
| M6 | **Workspace state is tracked** — which files were read, at what mtime, at which step. |

### Safety

| # | Property |
|---|---|
| S1 | **There is an OS-level sandbox**, not only application-level path scoping. |
| S2 | **Risk is per-command, not per-tool.** `git status` and `rm -rf` are not the same prompt. |
| S3 | **Approvals are rare enough to be meaningful.** Persistent, scoped allowlists; prompting on everything trains reflexive approval. |
| S4 | **Tool output is untrusted data, never instructions.** A README that addresses the agent is quoted, not obeyed. |

### Extension

| # | Property |
|---|---|
| X1 | **Instructions load progressively.** Skill descriptions always in context, bodies on demand. |
| X2 | **Tool inventory is budgeted.** Five MCP servers injecting eighty tools destroys the model's ability to choose. |
| X3 | **Lifecycle hooks exist.** Users bolt on formatters, linters, and policy without shipping a feature. |
| X4 | **Slash commands are files**, not a hardcoded switch. |

### Verification and evidence

| # | Property |
|---|---|
| V1 | **Machine-checkable feedback beats self-assessment.** Compiler, linter, tests are the ground truth; a model asked "did that work?" says yes. |
| V2 | **Runs are instrumented** — tokens by layer, cache hit rate, per-tool error rate, repeated-call count, steps-to-completion. |
| V3 | **An eval suite exists.** ~20 real tasks with programmatic success checks, run on every prompt change. |
| V4 | **Transcripts replay.** A lossless transcript lets you re-run a session against a changed prompt. |

---

## 2. Property by property: where Rama stands

### 2.1 Context assembly

Rama has exactly two injection points, both in `engine/src/agent/loop.ts`:

```
system:   SYSTEM_PROMPT           (loop.ts:142 — one hardcoded constant)
messages: listMessages(chatId)    (loop.ts:107 -> toModelMessage, loop.ts:41)
```

That is the entire context assembly. There is no environment block, no project
context, no cwd, no git state, no date, no tool inventory, no instruction file,
and no ephemeral layer.

**C1 — tool results carry content. ❌ Missing, and it is the root defect.**
`read` returns `{ok, summary, artifactId}` (`engine/src/tools/read.ts:35`). The
body goes to an `artifacts` row. `getArtifactContent` is called in exactly one
place — `engine/src/server.ts:182` — serving the UI panel. Nothing routes an
artifact body back into the message stream. The same holds for `grep`, `ls`,
`bash`, `write` and `edit`: the model receives `"37 matches across 6 files"`,
`"exit 0 · 42 lines"`, `"+12 -3"`.

The `ToolResult.detail` field exists in `engine/src/tools/types.ts` but is
populated only by skills (`engine/src/skills/tools.ts:28`) and MCP
(`engine/src/mcp/registry.ts:28`) — so third-party tools work correctly and all
six builtins do not. An agent that can call `read` and be told it succeeded
without learning the contents will hallucinate the file or reach for
`bash cat`, which also returns only an exit code. Multi-step work is not
possible in this state.

**C2 — projection, not transcript. ❌ Missing.** `toModelMessage`
(`loop.ts:41`) is a 1:1 row mapper over `role`/`content`. Tool calls and results
live in the `tool_calls` table and are never reconstructed. Within one run the
AI SDK holds steps in memory so it works; turn two begins with no memory of what
turn one did.

There is a latent failure here too: a turn ending in tool calls with no text
finalises as `content: null` (`loop.ts:218`, `loop.ts:234`), which
`toModelMessage` turns into `{role: "assistant", content: ""}`. Anthropic
rejects empty content blocks — a 400 waiting on the next turn.

The absence of a `buildModelMessages()` seam is the structural problem, not just
a missing feature: **every context capability we want — result eviction,
truncation policy, compaction, staleness pruning — lives inside that function,
and there is nowhere to put them.**

**C3 — assembled system prompt. ❌ Missing.** One constant,
`engine/src/agent/config.ts:11`, five sentences, imported once at
`loop.ts:142`. It is:
- *Stale* — claims "you have six tools" while `createSkillTools` and
  `getServerTools` inject arbitrarily many more in the same file.
- *Static* — identical for `agent`, `plan` and `ask`. Plan mode is enforced only
  by the runtime gate in `engine/src/agent/permissions.ts`; the model is never
  told it is in plan mode, so it plans nothing and gets blocked mid-execution.
- *Contextless* — never names the project, its path, or anything about the repo.

**C4 — repo instructions. ❌ Missing.** No `RAMA.md` / `AGENTS.md` loading
anywhere (grepped; nothing exists). This is the highest-leverage prompt feature
available and the cheapest: it is where "run `bun test`, not `npm test`" lives.

**C5 — cache ordering. ❌ Missing.** No `cacheControl` breakpoints anywhere.
A coding session should run 60–90% cache hits; cached input is roughly 10x
cheaper. This is currently pure waste.

**C6 — pre-flight accounting. ❌ Missing.** `contextUsed` is read from the
provider's reported `totalTokens` *after* the fact (`loop.ts:226`). `contextMax`
is a hardcoded column default of `200000` (`engine/src/db/schema.ts:30`) rather
than being read from `MODEL_REGISTRY[...].contextWindow`, so a 32k Qwen chat
displays a 200k meter. Overflow is discovered by receiving an error.

**C7 / C8 — decay and compaction. ❌ Missing.** Neither exists. A long chat
simply eventually fails. Note that C7 is much cheaper than C8 and captures most
of the value: evicting old `read` bodies and old `bash` output in the projection
often means the compaction threshold is never reached.

**C9 — ephemeral layer. ❌ Missing.** No concept of it. This is where the plan
mode reminder, the todo list, the budget warning, and the staleness notice all
belong — position-privileged, cheap, self-cleaning.

### 2.2 The loop

**L1 — between-step hook. ❌ Missing.** `stopWhen: stepCountIs(8)`
(`loop.ts:145`) delegates the loop entirely to `streamText`. The SDK's
`prepareStep` is unused, so there is no point at which compaction, steering, or
a staleness check could run.

**L2 — legible stops. ⚠️ Partial.** The hard cap of 8 steps is not
configurable, not surfaced, and not communicated to the model. A run that hits
it looks identical to a run where the model chose to stop.

**L3 — plural budgets. ⚠️ Partial.** Cost is computed
(`estimateCostUsd`, `engine/src/agent/config.ts`) and displayed, but it is a
readout, not a budget — nothing consumes it. No wall-clock or token budget.

**L4 — error classification. ❌ Missing.** The first `error` stream part throws
(`loop.ts:206`) and kills the run, transient or not. A 429 during a ten-minute
task discards the whole run.

**L5 — steering. ❌ Missing, by explicit design.** A second turn while running
is rejected outright (`loop.ts:65`). This is the largest single UX gap in the
loop: "no, use the other file" landing at step 4 instead of step 12 saves a
minute and a dollar every time it happens.

**L6 — graceful interrupt. ⚠️ Partial.** Abort wiring is genuinely good — the
`AbortController` reaches down into subprocess kills (`engine/src/tools/bash.ts`,
`engine/src/tools/procRun.ts`) and into pending permission promises
(`permissions.ts`). What is missing is synthesising results for orphaned tool
calls, which is currently masked only because tool history is not reconstructed
at all (C2).

**L7 — loop detection. ❌ Missing.**

**Reasoning is dropped entirely.** `thinking.delta` / `thinking.done` exist in
`packages/protocol/src/index.ts`, the `messages.thinking` column exists in
`engine/src/db/schema.ts:42`, and the `supportsThinking` badge renders in
`apps/desktop/src/app/ModelPicker.tsx:77` — but the `fullStream` switch has no
`reasoning-delta` case, so it falls to `default: break` (`loop.ts:213`). Every
downstream piece is built; one `case` is missing.

### 2.3 Tools

**T1 — descriptions as prompt. ⚠️ Weak.** Descriptions are accurate but thin:
`"Search file contents for a regex pattern, scoped to the project directory."`
says nothing about when to prefer it, what it excludes, or how results are
shaped. With `skill_*` and `mcp_*` tools in the same namespace, discrimination
pressure is already high and the system prompt is actively misinforming the
model about how many tools exist.

**T2 — explicit truncation. ⚠️ Partial and currently moot.** `MAX_LINES = 4000`
(`read.ts:9`) and `MAX_LINES = 200` (`grep.ts:10`) are reasonable numbers with
correct "… truncated" markers — attached to bodies that never reach the model.
Once C1 lands these become real, and `read` will need `offset`/`limit` so the
model can page rather than being stuck at 4000.

**T3 — actionable errors. ⚠️ Mixed.** `edit`'s non-unique-match error
(`engine/src/tools/edit.ts`) is the good version and should be the template.
Most other failures are raw. There are no line numbers on `read` output, so the
model cannot reference positions precisely.

**T4 — read-before-write. ❌ Missing.** Nothing tracks which files were read or
whether they changed. This is the worst class of bug available in a coding
harness — editing from a stale mental model silently destroys concurrent user
changes — and it is roughly thirty lines to prevent.

**T5 — parallelism. ❌ Missing.** The `ToolRisk` tier already encodes exactly
the right distinction (`low` = safe to parallelise, `high` = must serialise) and
is used only for permissions.

**T6 — shell session. ❌ Missing.** `Bun.spawn(["/bin/sh", "-c", ...])`
per call (`engine/src/tools/bash.ts:32`) means no persistent `cd`, no env vars,
no activated venv, no background processes. The Rust core already has PTY
infrastructure from Phase 8 that could back this.

**T7 — post-edit diagnostics. ❌ Missing.** Probably the highest
quality-per-line-of-code feature not yet built.

**Missing tool: `glob`.** Filename-pattern search is a distinct need from
content search, and `ls` (`engine/src/tools/ls.ts`, single-directory) is a poor
substitute for it.

### 2.4 State and memory

**M1 — lossless episodic. ⚠️ Partial.** `messages` / `tool_calls` / `artifacts`
are well-modelled, and the artifact store (inline-vs-blob threshold, streaming
bash bodies, trailing truncation for PTY) is one of the better-built parts of the
codebase. But `tool_calls` stores only `result_summary`
(`engine/src/db/toolCalls.ts`), not the result the model saw — so sessions cannot
be faithfully replayed or re-projected, which also blocks V4.

**M2 — procedural. ❌ Missing.** See C4.

**M3 — long-term. ❌ Missing.** No cross-session memory of any kind. Design
target when we build it: one fact per file with frontmatter, typed
(`user` / `feedback` / `project` / `reference`), a one-line index loaded every
session with bodies fetched on demand. Prefer the index over embedding retrieval
initially — a memory that should have fired and did not is *visible* in an
index and invisible in a vector store. The hard parts are not storage: they are
**write policy** (over-saving dilutes recall), **invalidation** (a memory naming
a function must be verified before it is acted on), and **contradiction
resolution** (edit the old memory, never append a second one).

**M4 — derived vs authored. ❌ Neither exists yet.** When Phase 6 ("heku",
`IMPLEMENTATION_PLAN.md`) is built, start it as a structural index — file tree
plus symbols — not a vector store. Code has exact identifiers; `grep` beats
embeddings for most real queries and needs no index maintenance. Semantic search
earns its place only when we can name the queries it unlocks.

**M5 — externalised plan. ❌ Missing.** A todo tool is cheap, survives
compaction in ~150 tokens, prevents drift on long tasks, gives the user a
progress view and an interception point, and is the main reason agents finish
the last part of multi-part tasks. High value per line.

**M6 — workspace state. ❌ Missing.** Prerequisite for T4.

### 2.5 Safety

This is Rama's strongest area and the design is sound.

**S1 — sandbox. ⚠️ Partial.** `resolveInProject` (`engine/src/tools/paths.ts`)
correctly blocks `..` and absolute escapes — but only for the tools that call it.
`bash` bypasses it entirely and is `cwd`-scoped only, so `cd /` works today.
`IMPLEMENTATION_PLAN.md` §8 already flags "should Rust core mediate tool
execution for stronger sandboxing" as open; it remains open.

**S2 — per-command risk. ❌ Missing.** `bash` is blanket `high`
(`engine/src/tools/bash.ts`). A rule table over the parsed command turns this
from "always prompt" into "prompt when it matters".

**S3 — meaningful approvals. ⚠️ Partial.** The gate itself
(`engine/src/agent/permissions.ts`) is the best-designed piece in the engine:
mode x risk, promise-based approval over WS, abort-aware, and — critically —
denials return as normal `ToolResult`s so the model can adapt rather than the
run dying. What is missing is persistence: `apps/desktop/src/app/SettingsModal.tsx:350`
concedes in its own copy that rules are saved and displayed but the loop's
automatic allow/deny does not consume them.

**S4 — untrusted tool output. ❌ Missing.** No system-prompt rule, no
delimiting of tool output as data. This matters more the moment web fetch or
richer MCP servers land. Treating every MCP tool as `high` risk
(`engine/src/mcp/registry.ts`) is the right instinct and the right place to
build from.

### 2.6 Extension

**X1 — progressive disclosure. ✅ Have.** `engine/src/skills/discover.ts` +
`engine/src/skills/tools.ts` implement description-always / body-on-demand
correctly, with global and project-local scanning and project-wins dedup. Note
that this is one of only two subsystems that actually returns content to the
model.

**X2 — tool budgeting. ❌ Missing.** `getServerTools`
(`engine/src/mcp/registry.ts`) flattens every connected server's full tool list
into every request with no cap.

**X3 — hooks. ❌ Missing.** A user hook that runs `prettier` after every edit is
worth more than a formatting feature.

**X4 — commands as files. ❌ Missing.** Four hardcoded entries in
`engine/src/search/providers/commands.ts`, executed by switching on `id` in
`ChatColumn.tsx`. Should be a directory scan of parameterised prompt templates.

**Namespacing. ✅ Have.** Builtins unprefixed, `skill_*`, `mcp_<server>_<tool>` —
collision-free by construction.

### 2.7 Verification

**V1 — machine-checkable feedback. ❌ Missing.** Nothing runs a type checker, a
linter, or a test suite as part of the loop. The agent's only signal about its
own work is its own judgement, which is the weakest available signal in a domain
where the compiler is right there.

### 2.8 Observability

**V2 — instrumentation. ⚠️ Thin.** Token and cost totals are recorded per turn
(`recordUsage`, `engine/src/db/chats.ts`). Nothing tracks per-tool error rates,
repeated identical calls, cache hit rate, or steps-to-completion — which are the
metrics that actually predict harness quality. A tool with a 30% error rate has a
bad schema, not a bad model.

**V3 — evals. ❌ Missing.** Zero tests exist in the repo
(`find . -name "*.test.ts"` returns nothing), despite
`IMPLEMENTATION_PLAN.md` §7 listing "engine loop + tool contracts (unit)". This
matters beyond hygiene: prompt changes routinely make things *worse*, and
without an eval there is no way to know.

**V4 — replay. ❌ Blocked on M1.**

---

## 3. Scorecard

| Area | Have | Partial | Missing |
|---|---|---|---|
| Context | — | — | C1 C2 C3 C4 C5 C6 C7 C8 C9 |
| Loop | — | L2 L3 L6 | L1 L4 L5 L7 |
| Tools | — | T1 T2 T3 | T4 T5 T6 T7 |
| Memory | — | M1 | M2 M3 M4 M5 M6 |
| Safety | — | S1 S3 | S2 S4 |
| Extension | X1 | — | X2 X3 X4 |
| Verification | — | V2 | V1 V3 V4 |

**Severity read.** C1 and C2 are not features, they are defects — the harness
does not currently function as an agent without them. C3, C4, T4, M5 and V1 are
the difference between "functions" and "is good". C5 is the difference between
"is good" and "is affordable". Everything else is expansion.

**What is genuinely strong and should not be rewritten:** the `SessionEvent`
contract (`packages/protocol/src/index.ts`), the permission gate
(`engine/src/agent/permissions.ts`), the artifact store
(`engine/src/db/artifacts.ts`), tool namespacing, the provider/model registry
split (`engine/src/agent/config.ts`), and skill discovery. The plan below builds
on all of them and replaces none of them.

---

## 4. Phases

Each phase has a concrete exit criterion you can demo.

### Phase H0 — Tool results reach the model  ★ THE UNBLOCKER
**Goal:** the agent can see what its tools did.
- Add `content` to `ToolResult` (`engine/src/tools/types.ts`), distinct from
  `summary` (UI) and `artifactId` (UI). Route `content` to the model.
- Populate it in all six builtins. `read` gains line numbers and
  `offset`/`limit`; `grep` gains a per-file count table above its matches;
  `bash` returns head+tail on overflow.
- Fix the empty-assistant-content case (`loop.ts:218`, `loop.ts:234`) so a
  tool-only turn cannot 400 Anthropic on the next turn.
- Delete the "added to context" summary string, which is now either true or
  redundant.
- **Exit:** `read a file, then edit based on what you read` works end to end in
  one turn, against Anthropic and against Together.

### Phase H1 — The projection seam
**Goal:** one function owns what the model sees.
- Introduce `buildModelMessages(chatId, budget): ModelMessage[]`, reading
  `messages` + `tool_calls` and reconstructing assistant tool-call parts and
  tool-result parts. Replace `toModelMessage` (`loop.ts:41`) at its only call
  site (`loop.ts:107`).
- Persist full tool results (M1) so the projection has something to project.
- Add the first decay rule (C7): tool result bodies older than N messages
  collapse to `[elided — re-read if needed]`.
- Wire `prepareStep` so a between-step hook exists (L1), even if it does
  nothing yet.
- **Exit:** a multi-turn session where turn 3 references a file read in turn 1
  without re-reading it; a 60-message session that would previously have
  overflowed still runs.

### Phase H2 — The prompt stack
**Goal:** the system prompt knows what session it is in.
- `buildSystemPrompt(ctx)` replacing the constant at
  `engine/src/agent/config.ts:11`: identity core, mode block (plan mode finally
  tells the model it is in plan mode), environment block (cwd, platform, shell,
  date, git branch, dirty state), live tool inventory.
- `RAMA.md` loading: `~/.rama/RAMA.md` then `<project>/RAMA.md`, concatenated
  with headers, size-warned past 500 lines.
- `/init` command that reads the repo and drafts one.
- Ephemeral layer (C9): a block appended after the last user message each step.
- **Exit:** plan mode produces a plan instead of a blocked write; a project
  with `RAMA.md` saying "use bun" never suggests npm.

### Phase H3 — Cost and correctness
**Goal:** stop wasting money and stop corrupting files.
- Prompt cache breakpoints on the stable prefix (C5). Instrument the hit rate.
- Pre-flight token accounting; `contextMax` from `MODEL_REGISTRY` rather than
  the `200000` default at `engine/src/db/schema.ts:30` (C6).
- Read-tracking + staleness (T4/M6): refuse edits to unread or changed files.
- Error classification with backoff (L4); context overflow triggers compaction
  and retries the step rather than failing the run.
- **Exit:** cache hit rate above 60% in a normal session; an edit to a file
  changed on disk mid-run is refused with a re-read instruction; a 429 mid-run
  does not lose the run.

### Phase H4 — Working the way people work
**Goal:** the loop stops fighting the user.
- Todo tool + ephemeral re-injection (M5).
- Steering (L5): per-run mailbox drained between steps; retire the
  "a run is already in progress" rejection at `loop.ts:65`.
- Graceful interrupt with synthesised tool results (L6).
- Reasoning: add the `reasoning-delta` case (`loop.ts:213`) and light up the
  `thinking.*` events, the `messages.thinking` column, and the collapsible
  `✻ thought for Ns` renderer that `IMPLEMENTATION_PLAN.md` Phase 2 specified
  and never got.
- Persistent bash session (T6) over the existing PTY infrastructure.
- Post-edit diagnostics (T7/V1).
- **Exit:** interrupt a run, redirect it mid-flight, watch the todo list update,
  see thinking render; an edit that breaks types reports the type error in the
  same step.

### Phase H5 — Structured compaction and memory
**Goal:** long sessions and cross-session continuity.
- Compaction (C8): structured summary fields, preemptive at ~80%, emitted as an
  event, transcript preserved.
- Long-term memory (M3): one fact per file, typed, `MEMORY.md` index loaded per
  session, bodies on demand, explicit invalidation and consolidation.
- Sub-agents: nested runs with isolated context and read-only tool sets,
  returning structured summaries. This is the main lever on context cost for
  exploration.
- **Exit:** a two-hour session that compacts twice and still knows the original
  goal; a preference stated on Monday applied on Friday.

### Phase H6 — Evidence and extension
**Goal:** know whether any of this is working.
- Eval suite (V3): ~20 real tasks, programmatic checks, run on every prompt
  change.
- Transcript replay (V4).
- Instrumentation (V2): tokens by layer, cache hits, per-tool error rate,
  repeated-call detection, steps-to-completion.
- Hooks (X3), file-based slash commands (X4), MCP tool budgeting (X2).
- Per-command bash risk (S2), persistent allowlists honoured by the loop (S3),
  untrusted-output framing (S4), OS-level sandbox (S1).
- **Exit:** a prompt change can be shown to improve or regress the suite.

---

## 5. Rules that hold across every phase

- **Two data structures, always.** The transcript is lossless and append-only.
  The model-facing array is a projection. Any feature that shrinks, elides, or
  reorders context belongs in the projection, never in the DAO.
- **The model is told the truth.** If output was truncated, a budget is nearly
  spent, a file changed, or a mode forbids something, say so in context. Silent
  constraints produce confident wrong behaviour.
- **Tool failures are results, not exceptions.** Already the rule in
  `engine/src/agent/permissions.ts`; it holds everywhere.
- **Nothing from a tool is an instruction.** File contents, command output, web
  pages and MCP results are data. No high-risk action gets auto-approved on a
  justification that traces back to tool output.
- **Cache order is part of the design.** Any new context layer states where it
  goes in the stack and why. Adding a volatile value to a stable prefix is a
  regression even if it reads well.
- **Every phase ships runnable.** `main` never boots broken.
- **Prompt changes are measured after H6.** Before H6, they are guesses; say so.

---

## 6. Open questions

- Do we hand-roll the step loop or keep `streamText` + `prepareStep`? H1
  assumes the latter; if compaction-and-retry in H3 fights the SDK, revisit.
- Compaction summariser model: the chat's own model (consistent, expensive) or a
  fixed cheap one (fast, may lose nuance)?
- Does `RAMA.md` support directory-scoped files in a monorepo, or project-root
  only for v1? (Leaning: root only, revisit if the dogfood repo hurts.)
- Long-term memory scope: per-project, or global with project tags? (Leaning:
  global with tags — user preferences are not repo-scoped.)
- Sub-agent transcripts: surfaced in the artifacts panel, or hidden behind the
  returned summary?
- Does the Rust core mediate tool execution for sandboxing (`IMPLEMENTATION_PLAN.md`
  §8 still lists this open), or does S1 ship as `sandbox-exec` around the Bun
  engine?
