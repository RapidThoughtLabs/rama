# Rama — Context Budget Implementation Plan

Phases here are **CB0–CB6** so they never collide with the build phases 0–8
(`IMPLEMENTATION_PLAN.md`), redesign R0–R7 (`REDESIGN_PLAN.md`), settings S0–S5
(`SETTINGS_PLAN.md`), harness H0–H6 (`HARNESS_DESIGN.md`), tool layer TL0–TL7
(`TOOL_LAYER_PLAN.md`), providers P0–P6 (`PROVIDERS_PLAN.md`), prompt stack
PS0–PS7 (`PROMPT_STACK_PLAN.md`), Mission Control M0–M6
(`MISSION_CONTROL_PLAN.md`), loop migration LM0–LM7 (`LOOP_MIGRATION_PLAN.md`),
loop mending MD0–MD6 (`LOOP_MENDING_PLAN.md`), workspace panes W0–W7
(`WORKSPACE_PANES_PLAN.md`), symbol layer SL0–SL6 (`SYMBOL_LAYER_PLAN.md`),
agent browser AB0–AB7 (`AGENT_BROWSER_PLAN.md`), or chat view CV0–CV6
(`CHAT_VIEW_PLAN.md`). Cite these as "CONTEXT_BUDGET_PLAN.md Phase CB3".

**What this document owns.** Everything between "the run loop has a transcript"
and "bytes leave for the provider" — how much of the conversation is sent, how
often the same bytes are re-sent, what gets forgotten and when, and what the two
numbers we call "tokens" actually mean. It does not touch what goes *into* a
tool result in the first place: per-call output caps belong to
`TOOL_LAYER_PLAN.md` and `AGENT_BROWSER_PLAN.md` AB5, and they are already
roughly right. The problem is not that individual results are too big. It is
that we never stop sending them.

**The motivating observation.** A browser-control session reports 100–150k
tokens and a repository question reports 50–70k, with input climbing every turn
while output stays flat. That asymmetry is the tell: output is genuinely new
work each step, input is the same history over and over.

---

## 1. What is actually broken

Five distinct defects, found by reading the loop end to end. They compound, which
is why the symptom looks worse than any one of them.

**1. Compaction is discarded at the end of every turn.** `compact.ts` has no DB
writes at all — its only `db/` import is `newId` (line 13). The summary entry is
spliced into the in-memory working copy (`compact.ts:216`) and dies with the run.
`run.ts:298` calls `buildTranscriptFromDb` at the start of every turn, and
`db/messages.ts:52-60` is a bare `SELECT ... WHERE chat_id = ? ORDER BY seq` with
no limit and no compaction filter. So the turn after a compaction reloads the
full raw history and compacts it again — paying the summarizer's LLM call a
second time for a result that will also be thrown away. Compaction currently buys
nothing durable. This is the single largest defect here.

**2. The cheap pruning exists and is never called.** `decayTranscript`
(`compact.ts:49-106`) drops superseded file reads and truncates stale tool
results over 1000 chars down to 500. It is pure, in-memory, and costs no API
call. Its only caller is `compactTranscript` (`compact.ts:136`) — so the free
mechanism is gated behind the expensive one. Stale browser snapshots ride along
at full size for the rest of the session, and the browser tool's own description
tells the model those refs are invalid, so they are *known-dead payload*. Its
supersession check also only matches `read` (`compact.ts:61`).

**3. The compaction trigger cannot fire on Anthropic.** `hooks.ts:226-228`
compacts when `lastStepInputTokens >= 80%` of `contextMax`. But
`anthropic/decode.ts:103` sets `inputTokens` from Anthropic's `input_tokens`,
which *excludes* `cache_read_input_tokens` and `cache_creation_input_tokens`,
while `openai/decode.ts:153` sets it from `prompt_tokens`, which *includes*
cached tokens. Same field, opposite meanings. With caching live on Anthropic that
number stays small forever and the watermark is never reached. The only remaining
brake is the reactive overflow catch (`run.ts:355-377`), capped at one retry per
run — i.e. we run until the provider rejects the request.

**4. The DB round-trip reshapes every turn, breaking the cache prefix.** During a
turn each step pushes its own assistant entry (`step.ts:287-294`). But all steps
share one DB row (`run.ts:217`), every tool call attaches to that same
`messageId` (`step.ts:252-259`), and `finalizeMessage` concatenates all step text
(`run.ts:519`). So `buildTranscriptFromDb` (`transcript.ts:136-162`) replays the
turn as *one* assistant message with all calls merged, then all tool results. The
shape sent is not the shape replayed, so the cached prefix diverges at the
previous turn's first assistant message and everything after it is re-billed as
fresh input, every turn.

**5. Occupancy and billing share a field.** `run.ts:395-400` sums every step's
input tokens across the turn, and that sum lands in `chats.context_used`
(`db/chats.ts:199`) and drives the context meter (`ChatColumn.tsx:644-661`). But
successive steps re-send a growing overlap of the same history — summing them
counts the same bytes once per round trip. Summing *output* across steps is
correct; summing input is not. A 6-step turn whose requests run 15k→30k reports
~135k occupancy against a real final context of 30k.

---

## 2. The principle the reference harnesses share

Surveyed `opencode` and `OpenHands` (2026-09-17). They differ in almost every
detail and agree on one thing Rama violates:

> **Persist the forgetting decision. Make the wire shape a deterministic
> projection of persisted state.**

- `opencode` marks `part.state.time.compacted` on the tool part and **persists
  it** via `session.updatePart` (`session/compaction.ts:273-317`); the renderer
  substitutes `"[Old tool result content cleared]"` from that stored flag
  (`session/message-v2.ts:294`). Pruning runs fire-and-forget every loop
  iteration (`prompt.ts:1338`), protects `PRUNE_PROTECT = 40_000` tokens of
  recent tool output, skips the last two turns, and only commits if it frees more
  than `PRUNE_MINIMUM = 20_000`.
- `OpenHands` persists a `CondensationEvent { forgotten_event_ids, summary,
  summary_offset }` as a first-class event; the LLM view is *event stream minus
  forgotten ids, summary spliced at offset* — reproducible on reload by
  construction.

Two further borrowings, both verified in source:

- **`opencode` persists one assistant message per step** with
  `id: MessageID.ascending()` (`prompt.ts:1185-1186`), so rebuilding from storage
  reproduces exactly what was sent. This is the direct fix for defect 4.
- **`opencode` marks two *trailing* cache breakpoints**, not one:
  `applyCaching` takes the first 2 system messages and the last 2 non-system
  messages (`provider/transform.ts:358-360`). The mechanic matters. A cache entry
  exists only where a previous request placed a breakpoint; the API can only look
  one up where the *current* request also has one. With a single moving trailing
  breakpoint (`transcript.ts:336-346`), every request's only anchor sits at a
  position nothing has cached yet. With two, the second-to-last anchor lands on
  the previous request's tail — a guaranteed read hit, then a fresh write at the
  new tail.

`OpenHands` also splits the two numbers defect 5 conflates: it aggregates
`context_window` and `per_turn_token` ("tokens currently held in the agent's
context") with `Math.max`, and the billing counters with `+`.

---

## 3. Decisions taken in this pass (2026-09-18)

**D1. Persist the decision, never destroy the bytes.** Decay and compaction set
flags and write summary rows; `tool_calls.result_content` is never mutated. The
human transcript keeps showing the full result — only the *model-facing
projection* substitutes. This makes forgetting reversible, auditable, and
deterministic on reload, which is the actual precondition for cache hits.

**D2. `buildTranscriptFromDb` is the single projection seam.** Everything that
decides what the model sees happens there, reading persisted flags. Nothing
filters in SQL. One place to test, one place to break.

**D3. Occupancy and billing are different numbers and never share a field.**
Occupancy is the full prompt size including cache reads and writes; it is a
`max`/last-value, never a sum. Billing counters are additive. A provider adapter
that cannot produce both is not finished.

**D4. Decay is not compaction and is not gated on it.** Decay is pure, local,
idempotent and free; it runs every step. Compaction costs an LLM call and loses
information; it stays rare. Today we have this exactly inverted.

**D5. The breakpoint budget forces a merge, and that is fine.** Anthropic allows
4 `cache_control` markers and `encode.ts:227-232` already throws above that.
Rama spends 3 on system blocks + 1 trailing. A second trailing anchor needs one
back, so system blocks 2 and 3 (`agent+mode` and `project+env`, `build.ts:65-69`)
merge into one. They change at the same frequency — per chat, per project — so
splitting them was never buying a partial hit.

**D6. Compaction keeps a raw tail, and the first reason is wire validity.**
Recorded because "why not just keep the summary and drop everything else" is the
obvious question and deserves a written answer. Compaction fires as a step-hook
verdict *mid-run* and then retries the same step (`run.ts:460-480`); at that
moment an assistant message can hold open `tool_use` blocks whose `tool_result`s
must stay paired with it. That is what `assertNoOrphanToolMessages`
(`transcript.ts:372-393`) and the cut-walk-back in `computeSafeCutIndex`
(`compact.ts:121-124`) enforce. Cutting to zero is not available; the cut lands
on a turn boundary or it produces an invalid request.

Three further reasons the tail earns its tokens. **Precision:** a summary is good
compression of the past and bad compression of the present — it keeps gist and
drops exact failing test output, the line numbers being edited, the ref numbers
from the latest snapshot, which is precisely the state the next action depends
on. **Cache:** a summary is new bytes near the front of the conversation, so
regenerating it invalidates the whole prefix; written once with the tail growing
on top, the prefix stays stable until the next compaction. Re-summarizing every
turn would break the cache every turn — the disease this document exists to cure.
**Decay:** `compact.ts:166` already feeds `Previous Summary: …` back into the
next summarization, so every pass blurs what the last one produced; a longer raw
tail means fewer generations of summary-of-summary.

The framing that follows from this: "summarize the old, keep everything since"
*is* summary-plus-tail — the tail is just the not-yet-summarized part. The open
question is never whether to have one, only how long, and today's "last two
entries" is the wrong answer at the far end.

---

## 4. Phases

### CB0 — measure before changing anything

Everything in §1 is read from source, not observed. Two claims in particular
decide how much of this plan is worth building: whether cross-turn cache reads
are actually zero, and what the real per-request size curve looks like.

Add temporary structured logging at the one place that sees the whole request —
`llm/anthropic/stream.ts` and its OpenAI counterpart — recording per step:
`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`,
`output_tokens`, projected message count, and serialized request bytes. Write
one line per step to a JSONL file under the project's data dir.

**Done (2026-09-20).** `llm/contextBudgetLog.ts` appends one JSONL line per
completed request to `~/.rama/context-budget-cb0.jsonl`. Both stream clients
call it after their SSE loop ends: `anthropic/stream.ts` reads the final state
off `AnthropicAccumulator.usage`; `openai/stream.ts` has no equivalent
accumulator field, so it captures the last `usage` event emitted during the
loop instead. Each line carries `provider`, `model`, `messageCount`,
`requestBytes` (the same serialized string sent over the wire), and the four
usage fields above. The module resolves `~/.rama` independently rather than
importing `db/index.ts`'s `RAMA_HOME`, so the `llm/` layer keeps its existing
zero-runtime-dependency on `db/` (only `import type` today). Marked temporary
in its own header — delete the file and its two call sites once the table
below is filled in. Not yet run against real traffic; that is the remaining
half of this phase.

Then run three scenarios and tabulate: a 10-turn repo Q&A, a 20-step browser
scenario, and a long session that crosses the compaction watermark.

**Acceptance:** a table answering (a) is `cache_read` ever non-zero on turn ≥2,
(b) the per-request prompt size curve per scenario, (c) how many times compaction
fires and how many of those are the same work repeated. Write the results into
this section as a verified table, the way `SYMBOL_LAYER_PLAN.md` §4 does. If
cache reads turn out healthy, CB5 and CB6 are re-prioritized on the evidence
rather than on this document's reasoning.

### CB1 — one meaning per number

`llm/types.ts`: `LlmUsage` gains `promptTokens` — the full request size, cache
inclusive. `totalTokens` either dies or is renamed to something that says
"billing" out loud.

- `anthropic/decode.ts:98-107`: `promptTokens = input_tokens + cache_read +
  cache_creation`; `noCacheTokens = input_tokens` with no subtraction (the
  current `input_tokens - cacheRead` double-subtracts from an already-net field).
- `openai/decode.ts:153-162`: `promptTokens = prompt_tokens` (already
  cache-inclusive); `noCacheTokens = prompt_tokens - cached_tokens` stays.
- `run.ts:395-400`: occupancy becomes the last step's `promptTokens`. The billing
  counters keep summing — that part was always right.
- `db/chats.ts:199` stores occupancy; `hooks.ts:228` compares against it;
  `estimateCostUsdDetailed` (`run.ts:532`) gets the corrected `noCacheTokens`.

**Acceptance:** a per-provider fixture test asserting that the same logical
request yields the same `promptTokens` under both adapters. After a 6-step
browser turn the meter reads within 10% of the final projected size instead of
roughly 5×. A new provider adapter without this test is not mergeable.

**Done (2026-09-21).** `LlmUsage` gains `promptTokens` (cache-inclusive,
one meaning on every provider); `totalTokens` is gone — nothing needed it once
`promptTokens` exists, and keeping a stale combined field around was the exact
"one field, two meanings" shape this phase closes. `anthropic/decode.ts`:
`noCacheTokens = inputTokens` (no more double-subtraction),
`promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens`.
`openai/decode.ts`: `promptTokens = prompt_tokens` (already cache-inclusive),
`noCacheTokens` unchanged. `run.ts` now tracks `lastPromptTokens` — the last
step's `promptTokens` — separately from `usageTotals` (billing counters,
still summed across steps); `recordUsage` and the `usage.update` broadcast
both read `lastPromptTokens` for `contextUsed` instead of a per-turn sum
(defect 5). `runStepHooks`'s `lastStepInputTokens` now reads
`stepResult.usage.promptTokens` instead of the raw `inputTokens`, which is
the literal fix for defect 3 — Anthropic's watermark can now actually fire,
since `promptTokens` means the same thing there as on OpenAI.
`llm/usageParity.test.ts` is the required fixture test: same logical request
(1000 prompt tokens, 700 cache-read) decoded through both providers'
`decodeFrame` yields identical `promptTokens`. `bunx tsc --noEmit` shows only
the six pre-existing, unrelated `blocks`-missing errors in `hooks.test.ts`
(in-flight chat-view work, not CB1's); all touched test suites pass (42/42).

### CB2 — persist the forgetting decision

Schema, via the guarded helper at `db/index.ts:21-26`:

- `addColumnIfMissing("tool_calls", "decayed_at", "decayed_at INTEGER")`.
- A new `compactions` table: `id`, `chat_id`, `boundary_seq`, `fields_json`
  (the `CompactionFields` shape), `covered_ids_json`, `created_at`.

`listToolCallsForHistory` returns `decayed_at` — it does not filter.
`buildTranscriptFromDb` (`transcript.ts:103-163`) becomes the projection seam per
D2: a decayed tool row projects as a placeholder, and rows before a compaction
boundary project as the summary entry. Raw content stays untouched per D1, so
`ChatColumn` keeps rendering the real result to the human.

**Acceptance:** the property test that makes this whole plan safe — decay a
transcript, restart the engine, rebuild from DB, and assert the projection is
byte-identical to the pre-restart projection. Extend
`assertNoOrphanToolMessages` (`transcript.ts:386`) coverage over every projection
the new flags can produce.

**Done (2026-09-21).** Schema: `tool_calls.decayed_at` (guarded
`addColumnIfMissing`) and a new `compactions` table (`id`, `chat_id`,
`boundary_seq`, `fields_json`, `covered_ids_json`, `created_at`) —
`boundary_seq` is the highest `messages.seq` a compaction covers, inclusive.
`db/toolCalls.ts` gains `markToolCallDecayed` (write) and
`listToolCallsForHistory` now returns `decayedAt` without filtering on it, per
plan. New `db/compactions.ts`: `createCompaction` / `getLatestCompaction` —
only the latest row is ever read, since each new compaction's boundary is a
superset of the last (it re-summarizes "not yet summarized" plus the previous
summary's own text). `transcript.ts` is split into a pure core,
`projectTranscriptEntries(messages, callsByMessage, compaction)`, and a thin
DB-reading `buildTranscriptFromDb` wrapper around it — the split makes the
projection seam testable without a database. The pure function: a message
with `seq <= boundarySeq` collapses (with everything it covers) into one
`summary` entry the first time the boundary is crossed; a decayed tool call
projects a generic placeholder (`decayedPlaceholder`) instead of its real
content, while `result_content` in the DB stays untouched (D1) — the call
itself is never dropped, so it stays paired with its assistant message
(no orphan risk; covering happens at whole-message granularity, which is
always atomic since every tool call belongs to exactly one message).
`transcript.test.ts` adds three CB2 tests: a decayed call projects a
placeholder and passes `assertNoOrphanToolMessages`; a compaction boundary
collapses covered entries into one summary and lets later entries replay
normally; and a restart round-trip — two independently-built fixture sets for
"the same persisted state" (distinct object graphs, not shared references)
project to `toEqual` entries and wire messages, proving the projection is a
pure function of persisted rows, not of any run-scoped state. Verified
against the real `~/.rama/rama.db`: `decayed_at` and `compactions` both exist
after a normal module load. Full suite: 246/246 pass; `bunx tsc --noEmit`
shows only the six pre-existing `hooks.test.ts` errors from the unrelated
in-flight chat-view work.

CB3 and CB4 are the phases that start actually *calling*
`markToolCallDecayed` and `createCompaction` from the run loop — CB2 only
builds the schema and the read side (the projection) plus the write
primitives, so wiring a live caller in is a small, focused diff on top.

### CB3 — run decay every step, and teach it the tools that matter

Call `decayTranscript` from the step loop in `run.ts` before `executeStep`, and
have it persist what it decides (CB2's `decayed_at`). Then widen it:

- Supersession past `read` (`compact.ts:61`): browser `snapshot` and action
  results (a superseded snapshot's refs are invalid *by contract* — the strongest
  case in the codebase), plus repeated `grep`/`glob`/`bash` with identical input.
- Replace the fixed `i < entriesCount - 4` window (`compact.ts:95`) with
  `opencode`'s shape: walk backwards protecting a *token budget* of recent tool
  output, skip the last two turns, and only commit if the walk frees more than a
  floor. Their numbers (40k protected, 20k minimum) are a starting point to tune
  against CB0's measurements, not gospel.
- Never decay `todo` or `clarify` output.

The placeholder should name what was dropped — `[browser snapshot of
localhost:5173, 47 refs — cleared]` — not a generic string. A model that knows a
snapshot *was* here re-snapshots; one told nothing assumes nothing was there.

**Acceptance:** the 20-step browser scenario from CB0 re-run, with stale
snapshots contributing under ~200 tokens each to the final request, and no run
in which the model acts on a decayed ref.

**Done (2026-09-23), pending the live re-run.** `run.ts`'s step loop now calls
`decayTranscript(transcript)` every step, before `executeStep` (D4 — pure,
local, free, unlike compaction which stays rare), and persists every callId
it decayed via `markToolCallDecayed` (CB2) so the decision survives past this
run. `decayTranscript` is now two independent passes:

- **Supersession** (correctness-driven, no size floor — the content is wrong
  to act on, not merely old): `read` by path (unchanged); `browser` snapshot
  — every snapshot before the latest is superseded regardless of URL, since
  refs are invalid *by contract* the instant a newer snapshot exists (the
  strongest case, per the plan text); `grep`/`glob`/`bash` repeated with
  byte-identical input.
- **Age/budget eviction** (space-driven, opencode's shape): walks backward
  from the most recent entry, protecting the newest `PROTECTED_TOKEN_BUDGET`
  (40k) tokens of tool output and the last `PROTECTED_TURNS` (2) user turns
  as two independent, unconditional protections — neither yields to the
  other — then only commits if the whole pass would free at least
  `MINIMUM_TOKENS_TO_FREE` (20k) tokens; otherwise nothing is evicted this
  step. All three constants are opencode's own starting numbers, not yet
  tuned against real CB0 measurements (still pending).

`todo`/`clarify` output is exempt from both passes. Placeholders now name
what was dropped: a decayed entry with a tool-provided `summary` (browser's
own `"snapshot of https://x — 47 interactive elements"`, read's own line
range, etc.) renders as `[Decayed: <summary>]`; supersession keeps its own
more specific wording (`[Superseded by a later read of <path>]`, `[...a
later browser snapshot — these refs are no longer valid]`, `[...an identical
later <name> call]`). `TranscriptEntry`'s `tool` variant gained an optional
`summary` field (threaded from `step.ts`'s live tool output and from
`ToolCallHistoryEntry.resultSummary` on reload) so both the live decay path
and CB2's DB-projection path build the *same* placeholder from the *same*
source — `decayedPlaceholder` is now exported from `transcript.ts` and
shared by both, rather than CB2's DB-only generic form. Both passes clear
content fully (no more partial 500-char truncation) — once something is
worth dropping, a short named label plus "you can re-fetch this" beats a
stale half-visible excerpt, and it keeps the live and reload-projected
placeholders the same shape.

Full suite: 250/250 pass, 9 of them CB3-specific (eviction commits above the
floor while protecting recent turns/budget; a lone small stale entry stays
untouched below the floor; `todo`/`clarify` are never touched regardless of
size; every browser snapshot but the latest supersedes regardless of URL;
`grep`/`glob`/`bash` supersede only on a byte-identical repeat, never a
different call to the same tool). `bunx tsc --noEmit` shows only the six
pre-existing `hooks.test.ts` errors from the unrelated in-flight chat-view
work. **Not yet re-verified against a live 20-step browser scenario** — that
observational half of the acceptance criterion is still open, same gap as
CB0's own scenario runs.

### CB4 — make compaction durable

`compactTranscript` writes a `compactions` row; the next turn's projection
honours it. Compaction stops being per-run work.

Also fix what it keeps: `computeSafeCutIndex` (`compact.ts:121`) cuts everything
except the last two entries, which is far too aggressive in the other direction —
it fires rarely and then erases almost everything. Replace with a token-budget
raw tail (`opencode`'s `tail_start_id`), still walking the cut back off a
tool-result run the way the current safe-cut logic correctly does, per D6. The
budget itself comes from CB0's measurements, not from `opencode`'s 40k.

**Wire the `summarize` model role.** `ModelRole` already has `"summarize"`
(`db/modelRoles.ts:8`), reserved for exactly this and never read by anything;
`compactTranscript` instead runs the summarizer on the chat's own model
(`run.ts:462-468`). Compaction is a blocking mid-run call, so that choice costs
both frontier price and frontier latency for a job a small fast model does well.
Resolve it the way `getChatRoleModel` / `getSubagentTarget` already resolve
theirs (`agent/config.ts`, `agent/subagentRole.ts`), including their fallback
behaviour: an unset or unreachable `summarize` role falls back to the chat's
model rather than failing the compaction — a compaction that throws takes the run
down with it, which is strictly worse than a slightly expensive summary.

Route the spend to `chats.utility_cost_usd` (`schema.ts:30`) rather than
`cost_usd`, which is what that column was added for (P2) and what keeps a
background call from polluting the chat's own cost line. This closes §7 question
2.

**Acceptance:** compaction fires once; the following three turns do not
re-summarize, and their prompt size stays flat instead of returning to
pre-compaction levels. Summarization traffic bills against the `summarize` role's
model and lands in `utility_cost_usd`, and an unset role still compacts
successfully on the chat's model.

**Done (2026-09-23), pending the live re-run.** `compactTranscript` now writes a
`compactions` row (via `createCompaction`) once it has a real boundary, keyed off
the highest `messages.seq` actually covered — computed from the covered entries'
own message ids, not guessed. The next `buildTranscriptFromDb` call (CB2's
projection seam) honours it automatically, so a compacted chat never
re-summarizes the same span on a later turn. Deleting a compacted chat needed a
fix too: `deleteChatTx` (`db/chats.ts`) never cleaned up `compactions` rows, so
with `PRAGMA foreign_keys = ON` the first deletion of a chat that had ever been
compacted would throw — fixed alongside this.

`computeSafeCutIndex` (`compact.ts`) is now a token-budget raw tail
(`RAW_TAIL_TOKEN_BUDGET`, 40k — opencode's own starting number, same
not-yet-tuned-against-CB0 caveat as CB3's constants), walking backward from the
end and keeping entries in the preserved tail until the next one would cross the
budget (always keeping at least one entry, so a single oversized entry can't
zero out the tail). The tool-result-run walk-back it already did stays exactly
as before. A transcript that entirely fits under the budget correctly cuts
nothing (cutIndex 0, "nothing worth compacting yet") — this only reads as a
behavior change on tiny fixtures; a real compaction call is only ever triggered
once the transcript is already large, so in practice the budget is what
determines the cut, not the entry count.

**Wired the `summarize` role**: new `agent/summarizeRole.ts` mirrors
`subagentRole.ts` exactly (`maybeDefaultSummarizeRole`/`getSummarizeTarget`,
tiers `["small", "workhorse"]` since a compaction call reads a much larger raw
chunk than a one-line utility call), wired into `server.ts` at the same four
call sites as `subagent`. `compactTranscript` resolves it and falls back to the
chat's own provider/model/key when unset or unreachable, exactly per plan.
Compaction's spend (resolved-role or fallback alike) now bills through
`recordUtilityUsage` → `chats.utility_cost_usd`, never `cost_usd`. `CompactOptions`
gained an optional `summarizeTarget` override — undefined resolves the role
normally (production default); tests pass `null` to pin the fallback path
deterministically, since this codebase's tests run against the real singleton
`~/.rama/rama.db` (no scratch-DB seam for role lookups) and the real DB already
has `chat`/`utility`/`subagent` roles configured — without the override, a test
run after `summarize` is later auto-defaulted for real would silently make a
live, billed network call.

Full suite: 256/256 pass (net +6 over CB3's 250 — 3 new `computeSafeCutIndex`
token-budget tests, 1 new CB4 persistence test that exercises the real
`createCompaction`/`buildTranscriptFromDb` round trip end-to-end through
`compactTranscript`, plus the CB5 tests below). `bunx tsc --noEmit` shows only
the same six pre-existing `hooks.test.ts` errors. **Not yet re-verified against
a live run**: whether `compactTranscript` actually fires exactly once per
overflow and keeps three subsequent turns' prompt size flat is an observational
claim about real provider traffic, same open gap as CB0/CB3.

### CB5 — cache layout

- `project()` (`transcript.ts:336-346`) marks two trailing anchors: the last
  durable message and the previous turn's last durable message.
- `build.ts:65-69` merges system blocks 2 and 3 per D5, freeing the budget.
  `encode.ts:227-232`'s guard stays exactly as it is — it is the thing that will
  catch the next person who adds a block.
- Stop re-splicing the todo reminder into the middle of the array every step
  (`transcript.ts:300-329`). Pin it at a fixed position, the way `opencode`
  persists reminders as parts on the user message (`reminders.ts:28-45`), so it
  stops perturbing the prefix mid-turn.

**Acceptance:** non-zero `cache_read` on step 2+ of every turn, measured against
CB0's baseline table. Cross-turn cache reads will still be limited until CB6 —
that is expected, and the number to watch is the within-turn one.

**Done (2026-09-23), pending the live re-run.** `build.ts` merges `agent+mode`
and `project+env` into one `agent+mode+project+env` block — `buildPrompt` now
emits exactly 2 system blocks instead of 3. `encode.ts`'s `MAX_CACHE_BREAKPOINTS`
guard and its throw logic are untouched, per the plan; only the descriptive text
naming the layout ("3 buildPrompt system blocks + 1 conversation tail" →
"2 buildPrompt system blocks + 2 conversation-tail anchors") was updated, since
leaving it as literally-3-blocks would have been actively wrong about the real
layout it exists to describe — the mechanism it guards (throw above 4) is
exactly as it was.

`project()` now tracks `previousTurnBoundaryWireIndex` while it walks
`t.entries`: every time it's about to render a `kind: "user"` entry, it records
the wire index of whatever came immediately before (skipped for the very first
turn, which has no previous one). That index is fixed for the rest of the
current turn — the current turn's own steps only ever append *after* it — so
every step of a turn re-marks the exact position the previous turn's own last
step wrote a cache entry at, which is the mechanism that turns step 2+ of a turn
into a cache read instead of a cold prefix. The existing trailing marker (the
true last durable message) is untouched and still moves every step.

The todo reminder no longer gets spliced in right after the last user message
(which shifted everything between there and the tail on every step its content
or presence changed, perturbing what should have been a stable prefix). It's now
appended once, uncached, after both cache anchors are marked and before the
ephemeral block — outside the cached prefix entirely, the same treatment the
ephemeral block already had.

Full suite: 256/256 pass — `build.test.ts`'s block-count assertions updated for
the 2-block layout (labels, indices), `anthropic.test.ts`'s breakpoint-guard
fixtures relabeled to the new 2+2 shape (still exercising the same throw-above-4
mechanism), `run.test.ts`'s "3 buildPrompt blocks" test updated to 2, and
`transcript.test.ts` gained 4 new/rewritten tests: two for the second cache
anchor (marks it; stays at the same position and byte-identical content across
steps of the same turn) and two for the pinned todo reminder (renders after all
durable entries, not spliced mid-array; changing its content across steps never
shifts any earlier entry). `bunx tsc --noEmit` shows only the same six
pre-existing `hooks.test.ts` errors. **Not yet re-verified against a live run**:
whether this actually produces non-zero `cache_read` on step 2+ against a real
Anthropic account is an observational claim, same open gap as CB0/CB3/CB4.

### CB6 — one assistant row per step

The reshape fix, last because it is the widest. Each step appends its own
assistant row with an ascending `seq`, its own tool calls attached to it, and its
own text and thinking — replacing the one-row-per-turn model (`run.ts:217`,
`step.ts:287-294`, `finalizeMessage` at `run.ts:519`). `buildTranscriptFromDb`
then reproduces exactly what was sent.

Ripples to work through: `finalizeOrphanedToolCalls(assistantMessage.id, …)`
(`run.ts:629`), `accumulatedBlocks` and `ChatBlock.stepIndex` (the UI already
groups blocks by step, so this may *simplify* the frontend), `maybeTitleChat`,
and `artifacts.message_id`. Old chats keep the merged shape and simply never
cache well — no backfill, no migration of historical rows.

**Acceptance:** for a fresh N-step turn, the projection rebuilt from DB is
byte-identical to the array sent on that turn's final step, ephemerals excluded.
A property test, not a snapshot test.

**Done (2026-09-23), pending the live re-run.** `run.ts`'s step loop now creates
a fresh `appendMessage(chatId, { role: "assistant", content: null })` row at the
top of every iteration (before `executeStep`, so `step.ts`'s `createToolCall`
has a real `message_id` to attach to while the step is still streaming) instead
of the one row created once before the loop. A `finalizeStep(extraNote?)`
closure, defined once `stepResult` is known, persists that row's own
text/thinking/reasoningSignature/blocks — called eagerly right after the step
completes (so a later throw in `runStepHooks` or compaction never loses that
step's content, which is strictly *more* durable than the old model, where
nothing was saved until the very end of the whole run) and, in the two branches
that attach a note (a `stop` verdict's note, or the `length`-finish truncation
notice), called a second time to overwrite with the fuller text/blocks. The
run-level `fullText`/`fullThinking`/`fullReasoningSignature`/`accumulatedBlocks`
accumulators are gone entirely — every branch that used to append to them now
either does nothing (the row's eager save already covers it) or calls
`finalizeStep` with its note.

`buildTranscriptFromDb`/`projectTranscriptEntries` needed **zero changes** —
both were already written per-DB-row (each message row becomes its own
`assistant` entry, with whatever tool calls are attached to its `message_id`);
the reason they only ever produced one assistant entry per turn was that
`runTurn` only ever persisted one row per turn. Once the row count changed, the
existing projection logic reproduced exactly what CB6 asks for, including the
pre-existing D11/MD3 orphan-tool-call case (a row left with `content: null`
because the run was interrupted mid-tool-execution still projects an assistant
entry declaring that step's tool calls, once `finalizeOrphanedToolCalls` marks
them `ok = 0` — covered by a new test, see below).

`finalizeOrphanedToolCalls` (`db/toolCalls.ts`) changed its filter from a single
`message_id` to `chat_id`: a run now spans several assistant rows, and
`run.ts`'s `activeRuns` map (one active run per chat) guarantees any
`tool_calls` row still `ok IS NULL` for a chat when its run ends belongs to that
run, regardless of which step's row it's attached to — simpler than tracking
every step's message id through the run just to finalize orphans across all of
them.

The two ripples the plan flagged turned out to be non-issues on inspection, not
things that needed fixing:
- `ChatBlock.stepIndex`/`blockIndex` and the frontend's block rendering
  (`ChatColumn.tsx`) already render per-DB-row with no wrapping card/border tied
  to a row boundary (`app-shell.css` has no such style) — splitting one row's
  blocks across N rows produces byte-identical DOM output. The live-streaming
  "pending" bubble (`SessionProvider.tsx`) is built entirely from broadcast
  events (`message.delta`/`thinking.delta`/`tool.call`/`message.done`), which
  still fire exactly as before — `message.done` still fires once per *run*, not
  once per step, so the pending-bubble UX (one growing bubble across every step
  of a turn) is unchanged. No frontend changes were needed.
- `artifacts.message_id` is optional and unused by every current `createArtifact`
  call site (`write.ts`, `edit.ts`, etc. key artifacts by `toolCallId`, not
  `messageId`) — nothing to update.
- `maybeTitleChat` reads chat text directly, never the messages table's row
  shape — no ripple.

Full suite: 258/258 pass (net +2 over CB5's 256) — two new tests in
`transcript.test.ts`'s new "CB6: one assistant row per step" describe block: a
property test (per the acceptance criterion) that persists a simulated 3-step
turn through the exact DB primitives `run.ts`/`step.ts` use
(`appendMessage`/`createToolCall`/`finalizeToolCall`/`finalizeMessage`) and
asserts `project(buildTranscriptFromDb(chatId), policy)` is byte-identical to
`project()` of the equivalent hand-built live `Transcript`, plus a second test
for the D11/MD3 orphan case above. `bunx tsc --noEmit` shows only the same six
pre-existing `hooks.test.ts` errors. **Not yet re-verified against a live run**:
whether a real multi-step turn's reload matches what was actually sent, and
whether old (pre-CB6) chats' merged single-row shape continues to load and
render correctly (no backfill, no migration, per the plan), are both
observational claims against real chat history, same open gap as CB0/CB3/CB4/CB5.

---

## 5. Order and dependencies

```
CB0 ──▶ CB1 ──▶ CB2 ──┬──▶ CB3 ──▶ CB5 ──▶ CB6
                      └──▶ CB4
```

**CB0–CB3 is the first shippable unit** and probably captures most of the win:
after it, the free pruning actually runs, it survives a reload, and the trigger
that decides when to do more can read a number that means what it says. CB4 is
independent of CB3 and can land in either order. CB5 is cheap but its cross-turn
payoff is gated on CB6. CB6 is the only phase that should wait for evidence from
CB0 before being scheduled at all.

---

## 6. Risk register

1. **CB0 shows caching is already working.** Then §1 defect 4 is smaller than
   argued and CB5/CB6 drop down the list. This is the cheapest thing to find out
   and the reason CB0 exists.
2. **Decay removes something the run still needed.** The failure is a model
   acting on output it can no longer see. Mitigated by the protected recent-token
   budget, never decaying the last two turns, exempting `todo`/`clarify`, and by
   placeholders that name what was dropped so the model can re-fetch.
3. **The 4-breakpoint budget.** D5 spends the slack CB5 needs. Anything added
   later must take one back from somewhere; `encode.ts:227` throws rather than
   silently regressing, and that guard must not be loosened.
4. **CB6 ripples into UI block grouping and artifact foreign keys.** The widest
   blast radius in the plan, which is why it is last and why its acceptance is a
   property test rather than eyeballing a transcript.
5. **A third provider gets the usage semantics wrong again.** Two providers
   already disagree on what `input_tokens` means. CB1's fixture test is the
   guard, and it must be required for any new adapter.

---

## 7. Open questions

1. **Should `contextMax` come from the catalog per model** rather than the chat's
   stored `200000` default (`schema.ts:32`)? A 1M-context model and a 200k model
   sharing one watermark is wrong in both directions.
2. ~~Should compaction and decay spend be bucketed out of the chat's cost line?~~
   **Resolved 2026-09-19 in CB4:** yes — `chats.utility_cost_usd`
   (`schema.ts:30`) exists for this shape of background call, and CB4 now also
   wires the `summarize` model role so the summarizer stops running on the chat's
   frontier model.
3. **Does decay need a user-visible surface** — a line in the transcript saying
   what was dropped, so a human reading back does not silently see a different
   conversation than the model did? D1 keeps the bytes, so this is a UI question,
   and it likely belongs to `CHAT_VIEW_PLAN.md`.
4. **Is the 8000-char head+tail cap (`browser.ts:85`, `bash.ts:17`) the right
   shape** now that decay handles staleness? `opencode` spills overflow to a file
   on disk and puts a preview plus path in context, which preserves the data;
   Rama's middle-drop loses it permanently. Belongs to `TOOL_LAYER_PLAN.md` but
   is worth deciding alongside CB3.
