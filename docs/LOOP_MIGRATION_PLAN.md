# Rama — Loop Migration Implementation Plan

Phases here are **LM0–LM7** so they never collide with the build phases 0–8
(`IMPLEMENTATION_PLAN.md`), redesign R0–R7 (`REDESIGN_PLAN.md`), settings S0–S5
(`SETTINGS_PLAN.md`), harness H0–H6 (`HARNESS_DESIGN.md`), tool layer TL0–TL7
(`TOOL_LAYER_PLAN.md`), providers P0–P6 (`PROVIDERS_PLAN.md`), prompt stack
PS0–PS7 (`PROMPT_STACK_PLAN.md`), or Mission Control M0–M6
(`MISSION_CONTROL_PLAN.md`). Cite these as "LOOP_MIGRATION_PLAN.md Phase LM3".

**What this document owns.** Everything between "the projection produced a
message array" and "a token arrived back". That is exactly the seam
`PROMPT_STACK_PLAN.md` declared out of scope ("it does not touch tools,
providers, or the loop's control flow") and `TOOL_LAYER_PLAN.md` assumed
existed. It replaces the Vercel AI SDK's `streamText`/`generateText` with an
in-house transport and an in-house step loop.

**What it does not own.** Prompt assembly (`agent/prompt/*` stays, PS0–PS7),
tool bodies (`tools/*` bodies stay, TL0–TL7), the provider catalog and roster
(P0–P6), the WS protocol shape, or the UI.

| This plan | Same work as | Note |
|---|---|---|
| LM3 | `HARNESS_MAP.md` §3.8 | the closed set of terminal states, finally an enum |
| LM4 | `HARNESS_DESIGN.md` L1 (H1) | the between-step hook, as a first-class thing |
| LM4 | `HARNESS_DESIGN.md` L3 (H4) | mid-run steering |
| LM5 | `HARNESS_DESIGN.md` C7/C8/L4 (H3) | decay, compaction, overflow-and-retry |
| LM6 | `PROMPT_STACK_PLAN.md` §9.2 | `supportsThinking` finally means something |

---

## 1. Why this exists

The AI SDK is not badly built. It is built for a different shape of program:
one where the caller hands over a message array and gets a finished turn back.
Rama needs the opposite — a loop it owns, where every step is an opportunity to
edit the conversation before the next request goes out.

Three places in the current code already document the collision.

**The completion gate is an SDK workaround, in writing.** `loop.ts:369` explains
that PS6's gate had to be built as an *outer retry around the entire
`streamText` call*, because `stopWhen` can only shorten a run — it can never
force a step past the model's own "I'm done, no more tool calls", which the SDK
treats as unconditional. So a gate that wants one more step has to throw the
whole call away and start a second one, replaying `responseMessages` by hand.
That works exactly once (`MAX_COMPLETION_NUDGES = 1`) and would not survive
being asked to do it twice.

**There is no compaction anywhere in `engine/src`.** Grep for it: every hit is
in `HARNESS_DESIGN.md` (C7, C8, L4) and none are in code. This is not an
oversight, it is structural. `streamText` owns the message array between steps;
`prepareStep` can rewrite what the next step *sends*, but it cannot restart a
step that already failed, so L4's "context overflow triggers compaction and
retries the step" has nowhere to live.

**Reasoning is declared and never delivered.** `thinking.delta` and
`thinking.done` exist in `packages/protocol/src/index.ts:13`, emitted by nobody
and consumed by nobody. `messages.thinking` is a dead column
(`db/schema.ts:44`). The UI contract has been waiting for this since the schema
was written.

Add the incidental tax: five separate copies of `resolveModel`, in `loop.ts`,
`titling.ts`, `complexity.ts`, `instructionsInit.ts` and `curator/curator.ts`.

---

## 2. Decisions taken in this pass (2026-09-09)

| # | Decision | Consequence |
|---|---|---|
| 1 | **OpenAI Chat Completions is the only wire format built here.** Anthropic's native format is LM7, after the loop's shape has settled. | Anthropic chats are broken from LM3 until LM7 lands. Accepted — §3. |
| 2 | **Build fresh, do not port.** The new loop is written against what Rama wants, not against what `streamText` allowed. No adapter-over-the-SDK compatibility phase. | Faster to the flexibility that motivated this; costs a window where behavior regresses. §3. |
| 3 | **The transport is a single-request primitive.** One request in, one event stream out. It contains no step loop, no tool execution, no retry policy. | The loop cannot inherit a constraint the transport never had. §4.1. |
| 4 | **The loop owns a `Transcript`, not a message array.** Wire messages are a *projection* of it, recomputed per step. | Compaction, decay, steering and cache markers all become edits to one object with one renderer. §5. |
| 5 | **Provider-specific markers are annotations on Rama's own types, rendered by the encoder.** `cacheBreakpoint` exists from LM0 and renders to nothing under OpenAI. | LM7 is "write an encoder", not "thread a new concept through the loop". §4.3. |
| 6 | **Tool execution is the loop's job.** Including concurrency policy for read-only tools. | TL1's unmet exit criterion ("three read-only calls in one step run concurrently") becomes reachable. §6.3. |
| 7 | **Every exit path assigns a terminal state from a closed enum.** `HARNESS_MAP.md` §3.8's set, in `@rama/protocol`. | Replaces today's free-form `summary: "blocked-on-question"` string. §6.5. |
| 8 | **`generateText` callers collapse into one `complete()` helper.** | Deletes four duplicated `resolveModel` bodies. LM1. |

---

## 3. What breaks, named rather than discovered

Decision 2 says build fresh and fix the fallout. That is only a reasonable
trade if the fallout is enumerated up front, so here it is.

**Broken from LM3 until LM7:**
- **Anthropic providers do not work at all.** Three catalog models
  (`claude-sonnet-5`, `claude-opus-4-8`, `claude-haiku-4-5-20251001`). The
  `anthropic` provider kind has no encoder until LM7.
- **Explicit prompt caching does nothing.** `cacheStyle: "explicit"` is
  Anthropic-only in the catalog today, so PS1's `markCacheBoundary` work is
  dormant, not deleted — `cache.ts` becomes an annotation on the transcript
  that the OpenAI encoder drops. Automatic caching (Together, OpenAI, Groq,
  OpenRouter) is unaffected because it needs no markers.
- **`supportsMidConversationSystem` stops mattering.** It exists because
  `claude-sonnet-5` rejects a mid-conversation `role: "system"`. Every
  OpenAI-compatible provider accepts one, so the fallback path in
  `ephemeral.ts:buildEphemeralMessage` goes untested until LM7. Keep the
  branch; do not delete it.

**Broken briefly, within a phase:**
- **Cost accounting is wrong between LM3 and the end of LM3.** `usage.inputTokenDetails`
  disappears with the SDK; §4.4 defines the replacement mapping. Until it is
  wired, `estimateCostUsdDetailed` bills every input token at the no-cache rate
  — the exact bug PS1 §9.3 fixed. Re-fixing it is an LM3 exit criterion, not a
  later cleanup.
- **`prompt-preview` (`server.ts:287`) breaks during LM2** because it calls
  `toModelMessages` + `markCacheBoundary` directly. It is repointed at the
  projection in the same phase.

**Deliberately not preserved:**
- `stepCountIs(8)` as a hard number. It becomes a hook with a policy behind it
  (§6.4), and the budget becomes per-mode.
- The SDK's `finishReason` vocabulary. Replaced by §6.5's enum.
- `MAX_COMPLETION_NUDGES = 1`. Once the gate is a real hook it does not need a
  one-shot cap to avoid hanging; it needs a step budget, which it now has.

**Not touched, on purpose:** `@ai-sdk/mcp` stays. `mcp/client.ts`,
`mcp/registry.ts` and `heku/tools.ts`'s external-call path are a separate axis
from the loop, ~90 LOC, and moving them buys nothing. `heku` tools still enter
the loop through the normal tool contract; only their *schema* origin differs
(real JSON Schema, not zod — see §6.2).

---

## 4. The transport — `engine/src/llm/`

### 4.1 The shape

```ts
// engine/src/llm/types.ts
export interface LlmRequest {
  model: string;
  messages: WireMessage[];      // already projected — the transport never edits these
  tools?: WireTool[];
  maxOutputTokens?: number;
  temperature?: number;
  signal: AbortSignal;
}

export type LlmEvent =
  | { type: "text.delta"; text: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }   // emitted once, complete
  | { type: "usage"; usage: LlmUsage }
  | { type: "finish"; reason: WireFinishReason };

export interface LlmClient {
  stream(req: LlmRequest): AsyncIterable<LlmEvent>;
}
```

Three properties, each of which the SDK denied us:

1. **No step loop.** `stream()` performs exactly one HTTP request. Steps are the
   caller's concept.
2. **No tool execution.** `tool_call` is data. The transport does not know that
   tools have bodies.
3. **No retry.** A failure is a typed throw (§4.5) and the caller decides. This
   is what makes overflow-compact-retry expressible.

`tool_call` is emitted *whole*, after the arguments have finished streaming.
Partial tool-call JSON has no consumer — the UI's `tool.call` event carries a
complete `input`, and no tool can start before its arguments are parsed. Buffer
inside the parser and emit once.

### 4.2 Files

```
engine/src/llm/
  types.ts        Rama's message/content/tool/usage/event types + error classes
  client.ts       resolveClient(providerRow, model, apiKey) -> LlmClient   [the 5 copies collapse here]
  sse.ts          generic SSE line reader: yields parsed data frames, skips comments and [DONE]
  openai/
    encode.ts     Transcript projection -> OpenAI request body   (pure, testable, no I/O)
    decode.ts     SSE frames -> LlmEvent                          (pure, testable, no I/O)
    stream.ts     fetch + wire the two together
  complete.ts     one-shot non-streaming helper (replaces 4x generateText)
```

`encode.ts` and `decode.ts` being pure and I/O-free is the load-bearing part:
every vendor quirk in §4.6 becomes a table-driven unit test against a recorded
frame sequence, not an integration test that needs a key and a network.

### 4.3 The message model, and where the Anthropic marker will go

Rama's own types, not OpenAI's, so LM7 is an encoder and nothing more.

```ts
export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  toolCalls?: { id: string; name: string; input: unknown }[];   // assistant only
  toolCallId?: string;                                           // tool only
  /** Provider-agnostic annotations. The OpenAI encoder ignores every field here. */
  annotations?: {
    /** PS1 §4.2's conversation-tail breakpoint. LM7's Anthropic encoder renders this as
     *  cache_control: { type: "ephemeral" } on the message's last content part. */
    cacheBreakpoint?: boolean;
    /** LM6/LM7 — Anthropic requires the opaque signature be echoed back with a
     *  thinking block or the next request 400s. Captured now, unused until LM7. */
    reasoningSignature?: string;
  };
}
```

This is decision 5 in concrete form. `annotations` is the marker slot. It costs
one optional field today and it means LM7 does not have to reach back into the
transcript, the projection, or the loop to add a concept — the concept is
already there, only the renderer is missing.

`agent/prompt/cache.ts` shrinks to setting `annotations.cacheBreakpoint = true`
on the last message when `policy.style === "explicit"`. Its current comment —
which records behavior verified against `@ai-sdk/anthropic@4.0.12`'s
`convertToAnthropicPrompt` internals — must be rewritten in LM7 to describe
Rama's own encoder instead, because that verification does not survive the
migration and a stale comment here is worse than none.

### 4.4 Usage, and the cost bug this must not reintroduce

PS1 §9.3 established that `inputTokens` is the sum of three buckets and billing
it flat is a bug. The SDK supplied `usage.inputTokenDetails`. The replacement:

```ts
export interface LlmUsage {
  inputTokens: number; outputTokens: number; totalTokens: number;
  noCacheTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
}
```

Mapping from an OpenAI-compatible final chunk:

| Rama field | Source |
|---|---|
| `inputTokens` | `usage.prompt_tokens` |
| `outputTokens` | `usage.completion_tokens` |
| `cacheReadTokens` | `usage.prompt_tokens_details.cached_tokens ?? 0` |
| `cacheWriteTokens` | `0` — no OpenAI-compatible provider bills a separate write |
| `noCacheTokens` | `inputTokens - cacheReadTokens` |
| `totalTokens` | `usage.total_tokens ?? inputTokens + outputTokens` |

Usage requires `stream_options: { include_usage: true }` in the request body,
and arrives on a final chunk whose `choices` array is empty. A provider that
omits it entirely yields `cacheReadTokens: 0`, which degrades to
`noCacheTokens === inputTokens` — the correct conservative answer, and the same
fallback `loop.ts:508` already uses.

### 4.5 Typed errors

```ts
export class LlmError extends Error {
  kind: "transient" | "durable" | "overflow" | "aborted";
  status?: number;
  providerCode?: string;
}
```

Three notes on the mapping:

- The `durable` set stays as `loop.ts:73` defines it — `400, 401, 403, 404` —
  because P1's rule still holds: misclassifying a rate limit as durable hides a
  model the user relies on.
- **`overflow` is new and is the point.** A context-length 400 is currently
  classified `durable`, which marks the model broken in `providerModels` when
  the model is fine and the conversation is too long. Detect it *before* the
  durable check: HTTP 400 plus either `error.code === "context_length_exceeded"`
  or a message matching `/maximum context length|context length|too many tokens/i`.
  Nothing consumes `overflow` until LM5; classifying it correctly from LM0 is
  free and stops the misclassification immediately.
- No status at all stays `transient` (network blip), same reasoning as today.

### 4.6 The vendor long tail

Six providers ship in the catalog; five are OpenAI-compatible and each diverges.
This table is the **verification checklist for LM0**, not a set of claims — each
row is confirmed against the live provider and then encoded as a `decode.ts`
fixture. Do not implement from memory.

| Provider | Verify | Likely handling |
|---|---|---|
| all | SSE frames that are comments (`:` prefix) or keepalives | `sse.ts` skips any line not starting `data: ` |
| all | trailing `data: [DONE]` | sentinel, ends the stream |
| Together | duplicate/empty final chunk; `reasoning_content` on thinking models | tolerate `choices: []` on any chunk, not just the usage one |
| OpenAI | `prompt_tokens_details.cached_tokens` present | the reference implementation |
| Groq | whether usage rides a vendor envelope rather than `usage` | read `usage` first, fall back to a vendor path if confirmed |
| OpenRouter | keepalive comment lines during long waits; `reasoning` vs `reasoning_content` | accept both reasoning keys |
| Ollama | whether `stream_options` is accepted; whether tool calls stream in fragments or arrive whole; whether `id` is populated | tolerate a whole-call delta; synthesize `call_<n>` when `id` is missing |

The accumulator must therefore be defensive by construction: tool calls are
keyed by `delta.tool_calls[].index`, `id` and `function.name` are taken from
whichever fragment first carries them, and `function.arguments` is concatenated
as an opaque string and `JSON.parse`d once at `finish`. A parse failure emits
the call with `input: {}` and lets the tool's own schema validation produce the
error the model reads — never throws out of the stream.

**LM0 is verified against Ollama first.** It is local, free, keyless, and the
sloppiest of the five, so it exercises every defensive path before a single
paid token is spent.

---

## 5. The transcript — `engine/src/agent/run/transcript.ts`

The single most consequential change, and the one that makes LM4 and LM5
possible at all.

**Today** there are four things editing the outbound message array, none of
which can see each other: `toModelMessages()` builds it from the DB;
`withTodoReminder()` splices a reminder in and strips the previous one by string
prefix; `markCacheBoundary()` clones the last message; `prepareStep` appends the
ephemeral block. The completion gate then concatenates `responseMessages` onto a
*different* array and starts a second `streamText`. Nothing owns the result.

**Instead:** one object per run, and one pure renderer.

```ts
export interface Transcript {
  /** Durable turns, in order. The only thing compaction and decay rewrite. */
  entries: TranscriptEntry[];
  /** Regenerated every step, never persisted, never part of `entries`. */
  ephemeral: EphemeralSlots;
}

export type TranscriptEntry =
  | { kind: "user";      id: string; text: string }
  | { kind: "assistant"; id: string; text: string; reasoning?: string;
      calls: { id: string; name: string; input: unknown }[] }
  | { kind: "tool";      callId: string; name: string; ok: boolean; content: string }
  | { kind: "summary";   id: string; covers: string[]; fields: CompactionFields }  // LM5
  | { kind: "injected";  id: string; role: "system" | "user"; text: string;
      tag: string; ttl: "step" | "run" };                                          // LM4

/** Pure. Transcript + policy -> exactly what goes on the wire. */
export function project(t: Transcript, policy: ProjectionPolicy): WireMessage[];
```

`project()` absorbs, in one place and in a fixed order: entry-to-message
expansion (an assistant entry with calls becomes an assistant message plus a
tool message, exactly as `toModelMessages` does today), `summary` entries
rendering in place of what they cover, `injected` entries landing at their tag's
defined position, the todo reminder, the ephemeral block trailing everything,
and `cacheBreakpoint` on the last durable message.

The four consequences, which are the entire reason for the refactor:

- **The todo reminder stops being a string-prefix hack.** It is an `injected`
  entry with `tag: "todo"` and `ttl: "step"`; replacing it is a keyed
  operation, not a `startsWith` filter (`loop.ts:189`).
- **The completion gate stops needing a second `streamText`.** It appends an
  `injected` entry and the loop takes another step. That is the whole fix.
- **Compaction has an object to rewrite.** Replace a span of `entries` with one
  `summary` entry; `project()` renders the new array. Nothing else changes.
- **`prompt-preview` gets accurate for free.** It calls `project()` — the same
  function the run calls — instead of re-deriving an approximation.

`entries` is built from the DB at run start (the `toModelMessages` logic, moved)
and appended to as the run proceeds. The DB stays the durable record; the
transcript is the run's working copy. Persistence is unchanged — `messages` and
`tool_calls` rows are written exactly as they are today.

---

## 6. The loop — `engine/src/agent/run/`

### 6.1 Shape

```
engine/src/agent/run/
  run.ts          runTurn: setup, the step loop, terminal-state assignment, teardown
  step.ts         one step: project -> stream -> accumulate -> execute tools
  transcript.ts   §5
  hooks.ts        §6.4 — the between-step hook and the built-in hooks
  budget.ts       step/token/wall-clock budgets, per mode
  compact.ts      LM5
```

`loop.ts` is deleted at the end of LM3. `runTurn` keeps its signature
(`(chatId, text) => Promise<void>`) and its `server.ts:854` call site, so
nothing above the engine notices.

### 6.2 The tool contract, off the SDK

`ai`'s `tool()` is replaced by `engine/src/tools/define.ts`:

```ts
export function defineTool<S extends z.ZodType>(spec: {
  description: string;
  inputSchema: S;
  execute: (input: z.infer<S>, options: { toolCallId: string }) => Promise<ToolResult>;
}): RamaTool;

export function defineRawTool(spec: {                 // heku's promoted MCP tools
  description: string;
  jsonSchema: Record<string, unknown>;                 // real JSON Schema, not zod
  execute: (input: unknown, options: { toolCallId: string }) => Promise<ToolResult>;
}): RamaTool;

export type RamaToolSet = Record<string, RamaTool>;
```

Chosen to be signature-identical to what the 29 `tool({...})` call sites already
pass, so LM1 is an import-line change in 22 files and nothing more.
`options.toolCallId` is the only execute-context field any tool uses (10 sites,
all `createArtifact`) — everything else in the SDK's options object is unused.

Schema conversion is `z.toJSONSchema(spec.inputSchema)` (zod 4, already a
dependency at `^4.4.3`; verified present and emitting draft-2020-12 with
`description`, `required` and `additionalProperties: false` intact), computed
once at definition time and cached on the tool. `defineRawTool` skips
conversion entirely and replaces `jsonSchema()` from `ai`.

One conversion detail to settle in LM1 rather than discover in LM3: zod 4 emits
`additionalProperties: false`, which OpenAI's strict function-calling mode
requires but some OpenAI-*compatible* vendors reject or ignore. Emit it, and if
§4.6's verification turns up a vendor that chokes, strip it in `encode.ts` —
per rule 6, behind a catalog field, not an `if (providerId === …)`.

Validation moves to us: parse the model's arguments with the zod schema before
`execute`, and on failure return a `ToolResult` with `ok: false` and the zod
error message as `content`. That is strictly better than today, where a bad
argument throws into `tool-error` and the model gets a stringified exception.

`ToolSet` in `effectiveTools.ts`, `toolInventory.ts`, `subagentRunner.ts`,
`skills/tools.ts` and `search/providers/tools.ts` becomes `RamaToolSet`. No
logic in any of those files changes; `computeEffectiveTools` and `sortTools`
work on a `Record` either way.

### 6.3 One step

```
project(transcript, policy)  ->  client.stream(request)  ->  accumulate events
  text.delta       -> append to buffer, broadcast message.delta
  reasoning.delta  -> append to buffer, broadcast thinking.delta        [LM6]
  tool_call        -> createToolCall row, broadcast tool.call, queue for execution
  usage            -> accumulate into the run's usage totals
  finish           -> stream complete; execute the queued calls
```

Tool execution is ours now, so the policy is ours to state:

- Calls whose tools are **all** pure filesystem/git reads (`read`, `glob`,
  `grep`, `tree`, `outline`, `git`) run with `Promise.all`. Anything else in
  the batch forces the whole batch sequential — a permission prompt (`gate()`)
  and a checkpoint must not race another mutation. This is TL1's unmet exit
  criterion.
- **`check` is excluded from the parallel set despite being `risk: "low"`.**
  Risk is a permission ceiling, not a concurrency property: `check` spawns the
  project's real typecheck/lint/test/build commands through
  `ctx.diagnostics.full()`, which contend on build caches and lockfiles with
  each other and with any concurrent `bash`. Same reasoning excludes `explore`,
  `review` and `test`, which run whole nested sub-agents. The parallel set is
  an explicit allowlist in `step.ts`, not derived from `HARNESS_TOOL_RISK`.
- Each result appends a `tool` entry to the transcript, writes its `tool_calls`
  row and broadcasts `tool.result`, exactly as today.
- A tool that throws becomes `ok: false` with the message as `content`. Tools
  are not allowed to kill a run; that rule is already in `types.ts` and is now
  enforced by the loop rather than by the SDK.

### 6.4 The between-step hook — `hooks.ts`

`HARNESS_DESIGN.md` L1, as an actual interface rather than a comment about one.

```ts
export interface StepHook {
  name: string;
  after(ctx: StepContext): Promise<HookVerdict> | HookVerdict;
}

export type HookVerdict =
  | { action: "continue" }
  | { action: "inject"; entry: TranscriptEntry }        // force another step
  | { action: "compact"; reason: string }               // LM5
  | { action: "stop"; state: TerminalState; note?: string };
```

Hooks run in a fixed order after every step, and the **first non-`continue`
verdict wins**. Ordering is policy and belongs in one readable list:

| Order | Hook | Verdict | Replaces |
|---|---|---|---|
| 1 | `aborted` | `stop: "interrupted-by-user"` | the abort catch |
| 2 | `repeatedToolCall` | `stop: "stopped-loop-detected"` | `loopGuard.ts`'s `StopCondition` |
| 3 | `budget` | `stop: "stopped-by-budget"` | `stepCountIs(8)` |
| 4 | `blockedOnQuestion` | `stop: "blocked-on-permission"` | `hasToolCall("clarify")` |
| 5 | `steering` | `inject` a queued user message | **new** — H4 |
| 6 | `completionGate` | `inject` the nudge | the outer retry at `loop.ts:369` |
| 7 | `contextPressure` | `compact` above the watermark | **new** — LM5 |

<!-- docs/LOOP_MENDING_PLAN.md D10/MD3 — the original ordering here (blockedOnQuestion last,
     after contextPressure) was the defect: a `clarify` call on a step that also tripped the
     watermark got compacted instead of ending the run blocked-on-permission, because the first
     non-`continue` verdict in *this* order was `contextPressure`'s `compact`, and it ran before
     blockedOnQuestion ever got a turn. The principle: verdicts that *end* the run outrank verdicts
     that only *shape* it. `contextPressure` is the only `compact` verdict, so it moved after every
     `stop` hook, not just past `blockedOnQuestion`. -->

`loopGuard.ts`'s `stuckOnRepeatedToolCall` is pure and keeps working verbatim —
only its `hasRepeatedToolCall` wrapper (which returns an SDK `StopCondition`)
is deleted. `completionGate.ts`'s `formatUnverifiedWrites` and
`buildCompletionGateNudge` likewise survive; the nudge just becomes an
`injected` entry instead of a `ModelMessage` fed to a second `streamText`.

**Steering (hook 4) is what the SDK made impossible.** A `sendUserTurn` arriving
mid-run currently hits `activeRuns` and is rejected outright
(`loop.ts:220`). With a real hook it lands in a per-chat queue and is injected
at the next step boundary. LM4 ships the queue and the injection; whether the UI
offers "steer" versus "interrupt" is a Mission Control question, not this
document's.

### 6.5 Terminal states

`HARNESS_MAP.md` §3.8's closed set, defined once in `@rama/protocol` next to
`SessionEvent`, with every exit path assigning exactly one:

```ts
export type TerminalState =
  | "completed" | "stopped-by-budget" | "interrupted-by-user"
  | "blocked-on-permission" | "failed-permanent" | "failed-transient-exhausted"
  | "stopped-loop-detected" | "compacted-and-resumed";
```

`run.finished` gains a typed `state: TerminalState`. Today's free-form
`summary?: string` stays for one release so nothing in the UI breaks on the
change, then goes. `"compacted-and-resumed"` is LM5's addition to the
`HARNESS_MAP` set and is a *non-terminal* marker used only for the run-event
log — a compacted run continues.

---

## 7. Phases

### LM0 — Transport ★ blocks everything
- `llm/types.ts`, `llm/sse.ts`, `llm/openai/{encode,decode,stream}.ts`,
  `llm/client.ts`, `llm/complete.ts`.
- `resolveClient()` absorbs all five `resolveModel` bodies, including
  P5's header-auth branch (`auth_style === "header"`, which must not also send
  `Authorization: Bearer`) and `extra_headers_json`.
- Typed errors per §4.5, including `overflow` detection.
- Usage mapping per §4.4.
- Vendor quirks per §4.6, each captured as a `decode.ts` fixture test.
- Nothing in `agent/` imports it yet. A scratch driver script verifies it
  standalone — same role `engine/scratch-verify-allow-system.ts` played, which
  is deleted in this phase.
- **Exit:** a scratch script streams text, streams a multi-argument tool call,
  and reports non-zero usage against **Ollama, Together, and OpenAI**;
  `decode.ts` fixture tests cover a fragmented tool call, a whole-call tool
  delta with no `id`, an empty-`choices` usage chunk, and a keepalive comment
  line; an over-long request against a small-context model classifies as
  `overflow`, not `durable`.

### LM1 — Tool contract off the SDK
- `tools/define.ts` per §6.2; `defineTool` + `defineRawTool`.
- All 29 `tool({...})` sites converted — 22 files, import line plus function
  name. `jsonSchema()` in `heku/tools.ts` becomes `defineRawTool`.
- `ToolSet` → `RamaToolSet` in the five type-only consumers.
- Argument validation moves into the loop-side wrapper (§6.2).
- The four `generateText` callers (`titling`, `complexity`, `instructionsInit`,
  `curator`) move to `llm/complete.ts`; their four `resolveModel` copies die.
- **Exit:** no file under `engine/src/tools/`, `engine/src/skills/` or
  `engine/src/agent/` imports from `ai`; `bun test` passes; auto-titling and the
  curator still fire on a real turn. `@ai-sdk/mcp` imports remain, and are the
  only ones.

### LM2 — The transcript and its projection
- `run/transcript.ts` per §5: `Transcript`, `TranscriptEntry`, `project()`.
- `toModelMessages` logic moves in as the DB-to-entries builder.
- `withTodoReminder` becomes a keyed `injected` entry.
- `markCacheBoundary` becomes `annotations.cacheBreakpoint`; `prompt/cache.ts`
  is reduced to setting the flag.
- `buildEphemeralMessage` output becomes the trailing ephemeral slot.
- `getPromptPreview` repointed at `project()`.
- Still driven by `streamText` — this phase changes *what* is assembled, not
  who sends it.
- **Exit:** `project()` on a transcript rebuilt from a real chat is byte-identical
  to what `toModelMessages` + `withTodoReminder` + `markCacheBoundary` produced
  for that chat, asserted by a test over a fixture DB. `prompt-preview` renders
  unchanged.

### LM3 — The step loop
The load-bearing phase. Anthropic breaks here.
- `run/run.ts` + `run/step.ts` + `run/budget.ts`. `agent/loop.ts` deleted.
- Per-step tool execution with §6.3's concurrency rule.
- `TerminalState` in `@rama/protocol`; every exit path assigns one.
- Usage aggregation rewired to §4.4 so `estimateCostUsdDetailed` gets the same
  three buckets it gets today.
- Stop conditions ported as inline checks; `hooks.ts` is not required yet.
- `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible` and `ai` removed from
  `engine/package.json`. `@ai-sdk/mcp` stays.
- **Exit:** a multi-step agent turn against Together completes end to end —
  text streams, tools run, results feed the next step, cost and context land in
  the status bar with a non-zero cache read on the second turn; interrupt
  produces `interrupted-by-user`; the eight-step cap produces
  `stopped-by-budget`; three read-only calls in one step run concurrently
  (TL1's criterion, finally); an Anthropic chat fails with a clear
  "not supported until LM7" error rather than a stack trace.

### LM4 — The between-step hook
- `run/hooks.ts` per §6.4; the seven built-ins, in order.
- Completion gate re-expressed as `inject`. `MAX_COMPLETION_NUDGES` deleted;
  the step budget is the bound.
- Loop guard re-expressed as `stop`.
- Steering: a per-chat pending-message queue, `sendUserTurn` during a run
  enqueues instead of erroring, hook 4 injects at the boundary.
- **Exit:** a run that writes a file and tries to finish gets nudged, runs
  `check`, and finishes — in **one** `run.finished`, with no second request
  chain; a message sent mid-run appears in the model's context at the next step
  and the run continues without restarting.

### LM5 — Compaction and decay
`HARNESS_DESIGN.md` C7/C8/L4. The reason for the whole migration.
- `run/compact.ts`: structured summarization into named fields (C8), the chat's
  own model per `HARNESS_MAP.md` §4's answer, producing a `summary` entry that
  replaces a span of `entries`.
- Preemptive trigger at a watermark against `chat.contextMax` (C8: "at ~80%
  full, tell the user"), via hook 6.
- Reactive path: an `overflow` `LlmError` (already classified since LM0)
  triggers compaction and **retries the same step** — L4, and impossible before
  this phase because the SDK owned the step.
- C7 decay first, since it is cheaper: stale tool results shrink, superseded
  `read` results drop when the file was read again later.
- The real transcript is never destroyed — `entries` is the run's working copy;
  `messages`/`tool_calls` rows are untouched, so the UI still renders the full
  history.
- A `compaction.applied` event so the user is told, per C8's "visible".
- **Exit:** a session driven past its context window completes instead of
  erroring; the summary is visible in the UI and the full transcript is still
  scrollable; a deliberately over-long single step compacts and retries rather
  than failing the run; token count after compaction is measurably below the
  watermark.

### LM6 — Reasoning
- `reasoning.delta` accepted from both `delta.reasoning_content` and
  `delta.reasoning` (§4.6).
- `thinking.delta` / `thinking.done` broadcast — the protocol events that have
  existed since the schema was written and have never fired.
- `messages.thinking` populated; the dead column becomes live.
- UI renders a collapsed thinking block. Gated on the catalog's
  `supportsThinking`, which finally means something.
- **Exit:** a reasoning model on Together or OpenRouter streams a visible,
  collapsible thinking block that persists across a reload.

### LM7 — The Anthropic encoder
The marker lands.
- `llm/anthropic/{encode,decode,stream}.ts` against the Messages API.
- `annotations.cacheBreakpoint` renders as `cache_control: { type: "ephemeral" }`
  on the message's last content part. `prompt/cache.ts`'s comment rewritten to
  describe Rama's encoder, not `@ai-sdk/anthropic@4.0.12`'s internals.
- Multi-block `system` with per-block cache breakpoints — PS1 §4.2's four
  breakpoints, now under our own control rather than inferred from
  `providerOptions`.
- `content_block_start/delta/stop` framing; `input_json_delta` accumulation;
  thinking blocks with `annotations.reasoningSignature` echoed back.
- `supportsMidConversationSystem: false` path re-exercised on `claude-sonnet-5`.
- **Exit:** an Anthropic chat completes a multi-step turn; the second turn
  reports `cacheReadTokens > 0` and the cost line falls; PS1's standing
  cache-read test passes again; a thinking model round-trips its signature
  across two turns without a 400.

---

## 8. Rules that hold across every phase

1. **`encode`/`decode` stay pure.** No `fetch`, no DB, no clock. Every vendor
   quirk is a fixture test, not an integration test.
2. **The transport never retries and never loops.** If a phase wants to add
   either, it goes in the loop.
3. **Tools never kill a run.** A throw is `ok: false` with the message as
   `content` — `types.ts`'s existing rule, now enforced here.
4. **Every exit path assigns a `TerminalState`.** No exceptions, including the
   `finally`.
5. **The DB is the durable record; the transcript is a working copy.**
   Compaction and decay never delete a `messages` or `tool_calls` row.
6. **Provider divergence lives in the catalog, not in `if (providerId === …)`.**
   P0's rule. Anything §4.6 turns up that is per-provider becomes a catalog
   field, not a branch in `decode.ts`.
7. **The WS protocol only ever gains fields during LM0–LM6.** The UI is not in
   the blast radius and must not be pulled into it.
8. **`@ai-sdk/mcp` is not in scope.** If a phase finds itself editing
   `mcp/client.ts`, it has wandered.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| **The vendor tail is longer than §4.6.** Five providers, and the table is a checklist precisely because it is not yet verified. | LM0 verifies against Ollama first (free, keyless, sloppiest). Every quirk becomes a fixture, so a sixth provider is a test, not an investigation. |
| **Cost silently misreports.** `estimateCostUsdDetailed` reads three buckets; a wrong `cached_tokens` mapping makes the cost line quietly wrong, and PS1's whole cache effort with it. | §4.4's mapping is an LM3 exit criterion, asserted on a real second turn — not a later cleanup. |
| **The Anthropic window drags on.** LM3 breaks it, LM7 fixes it, and everything between is a window where the frontier models do not work. | LM7 is the smallest phase because §4.3's annotation slot and `client.ts`'s dispatch already exist. If the window is unacceptable, pull LM7 in ahead of LM5 — the phases after LM3 have no ordering dependency on each other. |
| **`project()` drifts from what the model actually received.** Today's bug class: the prompt inventory and the tool map drifting apart (PS0's own motivation). | One renderer, called by both the run and `prompt-preview`. LM2's exit criterion is byte-equality against today's output on a fixture DB. |
| **Compaction summarizes away the thing that mattered.** | C8's structured fields (not free prose), the full transcript preserved in the DB, and the summary visible in the UI so a bad one is obvious rather than silent. |
| **Scope creep into the tool layer.** `run/step.ts` will be tempted to grow tool policy. | §6.3 fixes the concurrency rule and nothing else. Anything further is a TL-phase. |

---

## 10. Out of scope, named rather than silently absent

- **Anything under `apps/` or `packages/ui/`.** Verified SDK-free; it stays that
  way.
- **`@ai-sdk/mcp`.** §3, rule 8.
- **Non-streaming chat.** `complete.ts` covers the four utility callers; the
  chat path is streaming-only, as today.
- **Images and multimodal.** `supportsVision` is in the catalog and unused. The
  `ContentPart[]` shape in §4.3 leaves room; nothing in this plan fills it.
- **Structured output.** `generateObject`/`streamObject` have zero call sites
  today. Not replaced.
- **Prompt-cache warming, speculative steps, parallel sampling.** All become
  possible once the loop is ours. None are in these phases.
- **Retry-with-backoff policy.** `LlmError` classifies from LM0; who retries and
  how often is `failed-transient-exhausted`'s eventual owner, not defined here.
