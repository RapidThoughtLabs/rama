# Rama — Loop Mending Implementation Plan

Phases here are **MD0–MD6** so they never collide with the build phases 0–8
(`IMPLEMENTATION_PLAN.md`), redesign R0–R7 (`REDESIGN_PLAN.md`), settings S0–S5
(`SETTINGS_PLAN.md`), harness H0–H6 (`HARNESS_DESIGN.md`), tool layer TL0–TL7
(`TOOL_LAYER_PLAN.md`), providers P0–P6 (`PROVIDERS_PLAN.md`), prompt stack
PS0–PS7 (`PROMPT_STACK_PLAN.md`), Mission Control M0–M6
(`MISSION_CONTROL_PLAN.md`), or loop migration LM0–LM7
(`LOOP_MIGRATION_PLAN.md`). Cite these as "LOOP_MENDING_PLAN.md Phase MD2".

**What this document owns.** Finishing the job `LOOP_MIGRATION_PLAN.md` started.
It has two halves, and they are different in kind:

- **Defects (`D1`–`D11`)** — places where the LM0–LM7 implementation is wrong.
  These were never planned; they were found by review.
- **Deferred gaps (`G1`–`G5`)** — places where `LOOP_MIGRATION_PLAN.md` §3 said
  *"let it break, we will fix it later."* This is later. Nothing here is a
  surprise; §3 named every one of them in advance, which is the whole reason
  that trade was acceptable.

**What it does not own.** Anything LM0–LM7 got right. The transport shape, the
`Transcript`/`project()` split, the hook interface, the terminal-state enum, and
the removal of the AI SDK are all sound and are not revisited.

---

## 0. Summary — read this first if you are starting cold

You are picking this up in a fresh session with no prior context. This section
is the entire briefing; the rest of the document assumes it.

### 0.1 What Rama is

A local-first AI coding assistant: a Tauri desktop app (`apps/desktop`, React)
talking over WebSocket to a Bun agent engine (`engine/`), with shared types in
`packages/protocol`. SQLite is the durable store. It is a Bun workspace monorepo.

### 0.2 What just happened

`docs/LOOP_MIGRATION_PLAN.md` (703 lines, phases LM0–LM7) specified replacing the
Vercel AI SDK's `streamText`/`generateText` with an in-house transport and step
loop, so that steering and auto-compaction become possible — both were
structurally impossible while the SDK owned the message array between steps.

**All eight phases were then implemented in a single pass by a different model.**
That work is uncommitted, in the working tree. It is structurally faithful to the
plan and it is not a rewrite candidate — the bones are right. But it has never
run against a live provider, and it has defects concentrated in exactly the
phases that motivated the migration.

### 0.3 Where things stand, factually

Verified on 2026-09-09 at the time of writing:

- `cd engine && bun x tsc --noEmit` → clean. (Confirmed the checker actually
  runs by planting a deliberate type error; it was caught.)
- `cd engine && bun test` → 136 pass, 0 fail, 16 files.
- `engine/package.json` carries `@ai-sdk/mcp` and nothing else from the SDK.
  `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible` are gone.
  `LOOP_MIGRATION_PLAN.md` §8 rule 8 is satisfied.
- `engine/src/agent/loop.ts` is deleted. `server.ts:11` imports
  `runTurn`/`getPromptPreview`/`interrupt`/`isRunning` from `./agent/run/run`.

**Treat none of that as evidence the loop works.** A green checkout here means
"it compiles and the tests that exist pass". The tests that exist do not cover
the OpenAI path at all (see `D7`), and the single largest defect (`D1`) is
invisible to every one of them.

### 0.4 The map

```
engine/src/llm/                    the transport (LM0)
  types.ts                         WireMessage, LlmEvent, LlmUsage, LlmError
  sse.ts                           generic SSE frame reader
  client.ts                        resolveClient() — provider row -> LlmClient
  complete.ts                      one-shot non-streaming helper
  openai/{encode,decode,stream}.ts OpenAI Chat Completions    <- no tests
  anthropic/{encode,decode,stream}.ts  Anthropic Messages API <- 348 lines of tests

engine/src/tools/define.ts         defineTool / defineRawTool (LM1)
engine/src/agent/run/              the loop (LM3-LM5)
  run.ts        runTurn, the step loop, terminal states, getPromptPreview
  step.ts       one step: project -> stream -> accumulate -> execute tools
  transcript.ts Transcript, TranscriptEntry, project()
  hooks.ts      the 7 between-step hooks
  budget.ts     per-mode step budget
  compact.ts    decay (C7) + structured compaction (C8)
```

### 0.5 How to verify anything

```bash
cd engine && bun x tsc --noEmit && bun test
```

Provider order for live verification is unchanged from `LOOP_MIGRATION_PLAN.md`
LM0: **Ollama first** — local, free, keyless, and the sloppiest, so it exercises
the defensive paths before a paid token is spent — then Together, then OpenAI.
OpenAI is not optional at the end; `D4` is a defect only OpenAI proper will show
you.

### 0.6 The one thing to internalise

The failure mode of this codebase right now is **silence**. The system prompt is
dropped and nothing errors (`D1`). Tool calls are dropped and the run just ends
(`D5`). Compaction fires spuriously and the run merely stalls (`D3`). Every
defect below was found by reading, not by running, because running produces
plausible-looking output. Do not accept "it seemed to work" as an exit criterion
anywhere in this plan — that is why every phase below ends in an assertion, not
an impression.

---

## 1. The defects, named

Severity is about blast radius, not effort. Most of these are a few lines.

### D1 — The system prompt is never sent ★ blocks everything

`engine/src/agent/run/run.ts:211` calls `buildPrompt({...})` and **discards the
return value**. `buildPrompt` returns `{ system: WireMessage[], blocks, hash }`
(`engine/src/agent/prompt/build.ts:55`), and `project()`
(`engine/src/agent/run/transcript.ts`) takes no system input at all — its
`ProjectionPolicy` is only `{ cacheStyle, supportsMidConversationSystem }`.

So every request goes out with no kernel prompt, no tool inventory, no heku
manifest, no agent block, no mode block, no static env, and no project
knowledge. The entire PS0–PS7 prompt stack is assembled and thrown away. The old
loop did this correctly at `loop.ts:391` (`system: promptBlocks.system`).

This is the defect that explains the others' invisibility: a model with no system
prompt still answers, so the app looks alive.

It is also why the prompt-preview route is actively misleading.
`getPromptPreview` (`run.ts:554`) calls `buildPrompt` and *does* use the result,
so the preview renders the full system stack. A user checking the preview to see
what gets sent is shown something the run does not send. See `G5`.

Two contributing factors worth knowing:

- `engine/src/agent/prompt/build.ts` contains a literal NUL byte at line 78, used
  as a hash delimiter in `.join(...)`. It is intentional and pre-existing,
  unchanged by the migration. But `file(1)` reports the file as `data`, so
  **`grep -r` silently skips it**. Any search for `PromptBlocks` or `buildPrompt`
  across `engine/src` misses its definition. This is a live search hazard for
  whoever works on `D1`; use `grep -a`. Fixed in `MD6`.
- The result of `buildPrompt` is discarded with no `void` and no assignment, so
  nothing — not `tsc`, not lint — objects.

### D2 — Compaction emits an invalid message sequence ★ blocks LM5

`engine/src/agent/run/compact.ts:160` cuts at `entries.length - 2`. That index
can land between an assistant's `tool_calls` and its `tool` results, swallowing
the assistant into the summary and leaving the results orphaned. Demonstrated:

```
entries after compaction: summary, tool, tool
wire roles:               system,  tool, tool     <- tool with no preceding tool_calls
```

Every OpenAI-compatible provider rejects that with a 400.

The consequence compounds. `run.ts:249` catches an `overflow` `LlmError`,
compacts, and retries the same step. The retry now 400s. `run.ts:399` classifies
that 400 as `durable` and hands it to `recordModelError`, which marks the model
broken in `providerModels`. That is precisely the failure the `overflow` error
kind was introduced to prevent (`LOOP_MIGRATION_PLAN.md` §4.5), reintroduced one
layer up.

### D3 — The compaction trigger measures the wrong quantity ★ blocks LM5

`engine/src/agent/run/hooks.ts:184` compares `usageTotals.totalTokens` against
80% of `contextMax`. `usageTotals.totalTokens` is a **running sum across steps**
(`run.ts:281`), not context occupancy. Eight steps of a 20k prompt on a 200k
model is ~10% full and trips the watermark:

```
verdict at 8x20k steps (real ctx ~20k/200k): {"action":"compact", ...(160000) reached watermark (160000)}
verdict on the very next step, post-compaction: {"action":"compact", ...}
```

Compaction cannot lower a cumulative sum, so it re-fires on every remaining
step — one summarisation LLM call each, no forward progress, run ends
`stopped-by-budget`.

The signal that means "how full is the context" is the **last step's
`usage.inputTokens`**. Note that `contextUsed` being a cumulative sum is
inherited from `loop.ts:546` and is not itself new — but hook 6 is the first code
to make a control decision from it, which is what turns a cosmetic quirk into a
live bug.

### D4 — `strict: true` is unconditional and breaks OpenAI proper

`engine/src/llm/openai/encode.ts:95` sets `strict: true` on every tool. OpenAI's
strict function-calling requires every key in `properties` to appear in
`required`; zod emits only the non-optional ones:

```json
{ "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": { "path": {}, "offset": {}, "limit": {} },
  "required": ["path"],
  "additionalProperties": false }
```

There are 47 `.optional()` params across `engine/src/tools/`. `$schema` is also
passed through, which strict mode rejects independently. Most OpenAI-compatible
vendors ignore `strict` entirely, which is why this has not surfaced — OpenAI,
one of LM0's three named exit providers, does not.

### D5 — Tool calls are dropped when a stream ends without `finish_reason`

`engine/src/llm/openai/decode.ts:213` flushes the `ToolCallAccumulator` only on
`choice.finish_reason`. `engine/src/llm/openai/stream.ts` has no flush after the
SSE loop ends. A stream terminating on `[DONE]` or plain EOF without a
`finish_reason` loses every buffered call **and** emits no `finish` event.
`executeStep` then returns `toolCalls: []`, and `run.ts` reads that as "the model
is done" and completes the run. No error, no log, no trace.

### D6 — The Anthropic reasoning signature never crosses the gap

Both ends exist; the wire between them does not.

- `engine/src/llm/anthropic/decode.ts:137` captures `acc.reasoningSignature`.
- `engine/src/llm/anthropic/encode.ts:121` renders
  `msg.annotations.reasoningSignature`.
- Nothing carries it between: `LlmEvent` has no signature variant, `step.ts`
  never writes `annotations`, and `project()` drops `entry.reasoning` entirely.

Both halves are unit-tested in isolation, which is exactly why this reads as
finished. LM7's exit criterion — "a thinking model round-trips its signature
across two turns without a 400" — cannot currently pass.

There is a second, latent bug underneath it. `anthropic/encode.ts:121` builds the
thinking block as `{ type: "thinking", thinking: msg.content, ... }` — using the
assistant's **visible text** as the thinking content, and dropping the visible
text in the process. It is unreachable today only because the annotation is never
set. Fixing `D6` naively will activate it. The thinking text belongs in
`TranscriptEntry.reasoning`, not `content`.

### D7 — The OpenAI transport has no tests

`engine/src/llm/*.test.ts` and `engine/src/llm/openai/*.test.ts` do not exist.
`engine/src/llm/anthropic/anthropic.test.ts` is 348 lines. The path this
migration was explicitly scoped to (`LOOP_MIGRATION_PLAN.md` Decision 1: OpenAI
spec only, Anthropic bolted on afterwards) is the untested one.

LM0's exit criteria named four required `decode.ts` fixtures. None were written:
a fragmented tool call, a whole-call tool delta with no `id`, an empty-`choices`
usage chunk, and a keepalive comment line. The accumulator does appear to handle
the no-`id` case (`call_${index}` synthesis) — it is simply unverified, and `D5`
lives in the same file.

### D8 — `finishReason` is decoded, threaded, and never read

`StepResult.finishReason` is populated and unused. A `length` finish (output
truncated at the token cap) is indistinguishable from a clean `stop`, so a
truncated answer completes as `completed`.

### D9 — Two events are emitted with no consumer

`thinking.done` (`step.ts`) and `compaction.applied` (`run.ts`) are broadcast;
`apps/desktop/src/app/data/SessionProvider.tsx` handles `thinking.delta` only.
LM5's "a `compaction.applied` event so the user is told" is not yet true — the
user is not told.

### D10 — Hook 7 sits behind hook 6 and can lose its verdict

In `hooks.ts`'s fixed order, `blockedOnQuestion` (7) runs after `contextPressure`
(6). A step that calls `clarify` while the watermark is tripped returns
`compact`, and the `blocked-on-permission` stop is discarded. The order itself is
what `LOOP_MIGRATION_PLAN.md` §6.4 specified, so this is a defect in the
specified order, not a deviation from it.

### D11 — Interrupt leaves unfinalized tool-call rows

`step.ts` writes a `tool_calls` row via `createToolCall` as each call streams in,
before execution. An interrupt or mid-stream failure means `finalizeToolCall`
never runs, and `buildTranscriptFromDb` later replays those rows as
`"tool call failed"`. Wire-valid, so not corrupting — just persistent noise in
every subsequent turn of that chat.

---

## 2. The deferred gaps, from LOOP_MIGRATION_PLAN.md §3

§3 named these in advance as acceptable breakage. Mending them is the second half
of this plan. Two are already partly closed by the LM7 implementation; the point
of this section is to say precisely how far, so nobody assumes more.

### G1 — Anthropic providers

§3: *"Anthropic providers do not work at all… until LM7."* LM7 was implemented:
`llm/anthropic/{encode,decode,stream}.ts` exist, `resolveClient` routes
`providerRow.kind === "anthropic"` to `AnthropicStreamClient`, and there is a
348-line unit-test file. **Nothing has run against the live API.** Blocked on
`D1` (no system prompt) and `D6` (signature round-trip). Three catalog models:
`claude-sonnet-5`, `claude-opus-4-8`, `claude-haiku-4-5-20251001`.

### G2 — Explicit prompt caching

§3: *"`cacheStyle: "explicit"` … PS1's `markCacheBoundary` work is dormant."*
Partly closed: `project()` marks the conversation tail, and
`anthropic/encode.ts` renders `cache_control: { type: "ephemeral" }` on both
system parts and message parts.

But PS1 §4.2 specified **four** breakpoints: three system blocks plus the
conversation tail. `buildPrompt` does annotate its three blocks — and `D1` throws
them away, so today exactly one breakpoint ships. Four is also Anthropic's hard
maximum, so the correct layout sits exactly at the limit and needs a guard, not a
hope.

`engine/src/agent/prompt/cache.ts:markCacheBoundary` is now **dead code** —
`project()` inlines the same logic and nothing else calls it. Its doc comment has
been rewritten to describe Rama's own encoder, as LM7 required.

### G3 — `supportsMidConversationSystem`

§3: *"Keep the branch; do not delete it."* The branch was kept and is now used in
three places in `project()` (summary role, injected role, ephemeral role). It has
never been exercised, because it only matters on `claude-sonnet-5` and no
Anthropic chat has run.

`engine/src/agent/prompt/ephemeral.ts:buildEphemeralMessage` survives but the
loop no longer calls it — `run.ts` uses `buildEphemeralText` and `project()`
decides the role. Its only remaining non-test caller is
`completionGate.ts:33:buildCompletionGateNudge`, which is itself dead (`hooks.ts`
uses `buildCompletionGateNudgeText`).

### G4 — Cost accounting

§3: *"Re-fixing it is an LM3 exit criterion, not a later cleanup."* The §4.4
mapping is implemented in `openai/decode.ts:decodeUsage` and the three buckets
reach `estimateCostUsdDetailed` from `run.ts`. It has never been checked against
a real second turn, which is the only way to see a non-zero `cacheReadTokens`.
The LM3 exit criterion was not met; it was skipped.

### G5 — `prompt-preview`

§3: *"It is repointed at the projection in the same phase."* It was repointed —
`getPromptPreview` calls `project()`. But it is now wrong in two ways:

1. It renders system blocks from its own `buildPrompt` call that the actual run
   does not send (`D1`). The preview is a picture of a different request.
2. `conversationTail.approxTokens` is `approxTokens(JSON.stringify(wireMessages))`
   — the whole array's JSON, not the tail — so the number is meaningless.

A preview whose job is to tell the truth about the outgoing request is the wrong
place to be approximately right.

---

## 3. Phases

### MD0 — The system prompt ★ blocks everything

Nothing below can be judged until the model receives its instructions. Do this
first and alone.

- `ProjectionPolicy` gains the assembled system blocks (`WireMessage[]` from
  `buildPrompt().system`). `project()` emits them, in order, ahead of every
  transcript entry.
- `run.ts:211` assigns `buildPrompt`'s result and threads it into the projection
  for every step. `buildPrompt` stays outside the step loop — it is pure and its
  inputs do not change within a run.
- Their `annotations.cacheBreakpoint` — already set by `buildPrompt` when
  `cache.style === "explicit"` — must survive projection untouched. This is what
  unblocks `G2`.
- `getPromptPreview` is repointed at the *same* projection call, so preview and
  run cannot diverge again. It stops calling `project()` differently from how the
  run calls it.

**Exit:** a unit test asserts `project()` output begins with exactly the three
blocks `buildPrompt` returned, in order, with annotations intact; a real turn
against Ollama shows the model aware of its tools (it calls one by name without
being told the name); `prompt-preview`'s system blocks are the same objects the
run projects, asserted by a test that compares the two paths rather than by
inspection.

### MD1 — Transport correctness and the LM0 tests that were never written

Closes `D4`, `D5`, `D8`, `D7`.

- **`D4`**: stop emitting `strict: true` unconditionally. Default it off. Strip
  `$schema` in `encodeTool`. If strict is wanted for OpenAI proper later, it is a
  catalog field plus a schema transform that adds every property key to
  `required` — per `LOOP_MIGRATION_PLAN.md` §8 rule 6, provider divergence lives
  in the catalog, never in `if (providerId === …)`.
- **`D5`**: flush the accumulator when the SSE stream ends, not only on
  `finish_reason`. If tool calls were flushed at EOF with no `finish` event seen,
  synthesise `{ type: "finish", reason: "tool_calls" }`; if nothing was
  accumulated, synthesise `"stop"`. The loop must never see a step that silently
  had neither.
- **`D8`**: surface `finishReason`. A `length` finish appends a visible note to
  the assistant message and does not report `completed`.
- **`D7`**: write `engine/src/llm/openai/decode.test.ts` with LM0's four
  fixtures — fragmented tool call, whole-call delta with no `id`,
  empty-`choices` usage chunk, keepalive comment line — plus a fifth for `D5`
  (EOF with no `finish_reason`) and a sixth for `D4` (a schema with optional
  fields encodes to something OpenAI accepts). Also `encode.test.ts` and
  `sse.test.ts`.

**Exit:** `bun test` covers the OpenAI transport with at least the six fixtures
above; a tool call fragmented across five frames reassembles to one `tool_call`
event with complete arguments; a stream cut off after tool-call fragments with no
`finish_reason` still yields those calls; a live turn against **OpenAI proper**
(not a compatible vendor) completes a tool call — this is the only way `D4` is
proven closed.

### MD2 — Compaction that produces a valid transcript

Closes `D2`, `D3`. This is LM5 done properly; it is the reason the migration
happened.

- **`D2`**: the cut index must land on a boundary where no `tool` entry is left
  without the assistant that called it. Scan back from the naive cut to the last
  index at which every `tool` entry that follows has its assistant ahead of it.
  Add an invariant check — `project()` output must never contain a `tool` message
  that is not preceded by an assistant carrying its `toolCallId` — and assert it
  in tests rather than trusting the cut logic.
- **`D3`**: the watermark reads the **last step's `usage.inputTokens`**, not
  `usageTotals.totalTokens`. Thread the last step's usage into `StepHookContext`
  as its own field so the cumulative totals cannot be reached by accident.
- Compaction must be able to observe its own effect. After compacting, the next
  step's `inputTokens` is the measurement; if it has not fallen below the
  watermark, do not compact again on the following step — one summarisation per
  run unless the transcript has grown since.
- The reactive overflow path (`run.ts:249`) keeps its one-shot guard, but its
  retry must not be able to convert a compaction bug into a `durable` model
  error. A 400 on the retry of a compacted request is a compaction failure, not a
  broken model: do not call `recordModelError` for it.

**Exit:** the orphan-tool-message invariant holds over a property test across
randomised cut points; a session driven past its context window completes instead
of erroring; the summary is visible in the UI and the full transcript is still
scrollable; a deliberately over-long single step compacts and retries rather than
failing the run; token count after compaction is measurably below the watermark
*on the next real request*, not by estimate; and a run at 10% real occupancy over
eight steps never compacts.

### MD3 — Hook order and terminal-state fidelity

Closes `D10`, `D11`.

- **`D10`**: `blockedOnQuestion` moves ahead of `contextPressure`. The ordering
  principle is that verdicts which *end* the run outrank verdicts which *shape*
  it; `contextPressure` is the only `compact` verdict and belongs after all four
  `stop` hooks. Revise `LOOP_MIGRATION_PLAN.md` §6.4's table to match — the order
  there is what produced this defect, so leaving it unamended reintroduces it.
- **`D11`**: on any run exit, finalize every `tool_calls` row for the run that
  has no result, with `ok: false` and a summary naming the real cause
  (`interrupted`, or the error). Do this in `runTurn`'s `finally`, where the
  terminal state is already known.

**Exit:** a `clarify` call on a step that also trips the watermark still ends the
run `blocked-on-permission`; interrupting a run mid-tool leaves no unfinalized
rows, asserted against a fixture DB; the next turn in that chat replays no
`"tool call failed"` entries.

### MD4 — The reasoning round-trip

Closes `D6`. Mends the half of `G1` that `MD5` depends on.

- `LlmEvent` gains a way to carry the signature — cleanest as a field on a
  `reasoning.done`-style terminal event, so `reasoning.delta` stays a pure text
  stream.
- `step.ts` records it on the assistant `TranscriptEntry` alongside `reasoning`.
- `project()` stops dropping `reasoning`: an assistant entry with reasoning
  projects with `annotations.reasoningSignature` set, and the reasoning text
  carried where the encoder expects it.
- Fix `anthropic/encode.ts:121` so the thinking block's `thinking` field is the
  **reasoning text**, not `msg.content`, and the visible text still ships as its
  own `text` part. This bug is latent today and becomes live the moment the
  annotation is set — fix it in the same change, not after.
- `messages.thinking` is already persisted by `finalizeMessage`; confirm it
  rehydrates on reload.

**Exit:** a reasoning model on Together or OpenRouter streams a visible,
collapsible thinking block that persists across a reload; an Anthropic thinking
model completes two consecutive turns without a 400, asserted by the second turn
succeeding — the round-trip is only proven by turn two.

### MD5 — Mending the deliberate breaks

Closes `G1`–`G5`. This phase is mostly verification, and it is where the §3 trade
gets settled.

- **`G2`** — four breakpoints, now that `MD0` ships the system blocks: three
  system + conversation tail. Add a hard guard that the Anthropic encoder never
  emits more than four `cache_control` markers, with a test — the correct layout
  sits exactly at Anthropic's limit, so any future block added to `buildPrompt`
  silently breaks caching without it. Delete the dead `markCacheBoundary`.
- **`G3`** — exercise `supportsMidConversationSystem: false` on
  `claude-sonnet-5`: the summary, injected, and ephemeral roles must all fall
  back to `user`. One test per site plus one live turn. Delete the dead
  `buildCompletionGateNudge`; keep `buildEphemeralMessage` only if `G3`'s
  fallback still routes through it, otherwise delete it too.
- **`G4`** — the cost check that LM3 skipped. Two turns on Together, then two on
  Anthropic: the second turn reports `cacheReadTokens > 0` and the cost line
  falls. PS1 §9.3's standing cache-read test passes again.
- **`G5`** — `prompt-preview` tells the truth: same projection as the run
  (already done in `MD0`), and `conversationTail.approxTokens` measures the tail
  rather than the whole array.
- **`G1`** — the end-to-end Anthropic turn, which every item above feeds.

**Exit:** an Anthropic chat completes a multi-step turn on all three catalog
models; the second turn reports `cacheReadTokens > 0` and a lower cost line;
`prompt-preview`'s block list and token counts match a real request byte for
byte, asserted by a test that projects both and diffs them;
`supportsMidConversationSystem: false` is covered by tests at all three
projection sites.

### MD6 — Surfacing and cleanup

Closes `D9`, and the loose ends.

- `SessionProvider` handles `thinking.done` (stop the thinking indicator, keep
  the duration) and `compaction.applied` (a visible, dismissible marker in the
  transcript — LM5 promised the user is told).
- Replace the literal NUL delimiter in `engine/src/agent/prompt/build.ts:78` with
  its escape sequence. Byte-identical hash, and the file stops being binary to
  `grep -r`. Confirm with `file engine/src/agent/prompt/build.ts` reporting text.
- Delete `engine/scratch-verify-allow-system.ts` if still present, and
  `engine/src/llm/scratch-verify.ts` once `MD1`'s fixtures cover what it probed.
- Sweep for other dead code left by the migration; `markCacheBoundary` and
  `buildCompletionGateNudge` are known, there may be more.

**Exit:** compaction is visible in the UI when it happens; `grep -r` over
`engine/src` finds `PromptBlocks` in `build.ts`; no scratch files in the tree;
`bun x tsc --noEmit` and `bun test` clean.

---

## 4. Rules that hold across every phase

1. **`encode`/`decode` stay pure.** No fetch, no DB, no clock. Every vendor quirk
   is a fixture test, never a runtime branch on `providerId`.
2. **The transport never retries and never loops.** Recovery is the loop's job.
3. **Tools never kill a run.** A throwing tool becomes `ok: false` content.
4. **Every exit path assigns a `TerminalState`.**
5. **The DB is the durable record; the transcript is a working copy.** Compaction
   never deletes a row.
6. **Provider divergence lives in the catalog.** This is the rule `D4`'s fix must
   respect: no `if (providerId === "openai")`.
7. **No phase exits on an impression.** Every exit criterion above is an
   assertion someone can run. `D1` survived a full implementation pass and a
   green test suite; "it looked right" is precisely the standard that let it
   through.
8. **`@ai-sdk/mcp` stays.** Out of scope, as in `LOOP_MIGRATION_PLAN.md`.

---

## 5. Ordering, and what can run in parallel

`MD0` blocks everything — do it first, alone, and confirm it before touching
anything else.

After `MD0`: `MD1`, `MD2` and `MD3` are independent of one another and may be
done in any order. `MD4` depends on `MD1` (the transport must be sound before the
signature rides on it). `MD5` depends on `MD0`, `MD1` and `MD4`. `MD6` depends on
`MD2` for the compaction UI and is otherwise free.

If only one thing gets done: `MD0`. If two: `MD0` and `MD1`. The Anthropic work
(`MD4`, `MD5`) is the safest to defer — it is already dark and has been since
LM3, so deferring it costs nothing new.

---

## 6. Risks

- **`MD0` looks trivial and is not.** Adding system blocks to the projection
  changes the cache prefix for every provider with `cacheStyle: "explicit"`, and
  changes token counts everywhere. Expect `G4`'s numbers to move; that is the fix
  working, not a regression.
- **`MD2`'s cut-boundary logic is the kind of code that passes its own tests and
  fails on real data.** The invariant check on `project()` output is the actual
  safeguard — write it first, and let it police the cut logic rather than testing
  the cut logic directly.
- **`D4`'s fix cannot be validated on Together, Groq, Ollama, or OpenRouter.**
  They ignore `strict`. Budget one live OpenAI turn.
- **`MD4` activates a latent bug on purpose.** The thinking-block content fix is
  not optional cleanup; skipping it converts a dormant defect into a live one.
- **The review that produced this list was not exhaustive.** It read every file
  in `llm/` and `agent/run/` and spot-checked the rest. `D1` was found late, on a
  second pass, in a file `grep -r` could not see. Assume there is more in the
  parts that were only spot-checked — particularly `tools/` after the LM1
  conversion of 29 call sites across 22 files.

---

## 7. Out of scope, named rather than silently absent

- **Rewriting anything LM0–LM7 got right.** The transport shape, `Transcript`,
  `project()`, the hook interface, the terminal-state enum, `defineTool`. These
  are sound.
- **`@ai-sdk/mcp`** — unchanged, as in `LOOP_MIGRATION_PLAN.md` §3.
- **Multi-provider retry, failover, or model fallback.** Still not a thing Rama
  does.
- **Vision / `image_url`.** `ContentPart` reserves the slot; nothing fills it.
- **The cumulative `contextUsed` semantics** (`run.ts` / `usage.update`).
  Inherited from `loop.ts:546`, cosmetic in the status bar, and out of scope
  here — `MD2` only stops the *compaction trigger* from depending on it. If the
  status bar should show occupancy rather than a run total, that is its own
  change.
