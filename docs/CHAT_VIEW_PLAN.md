# Rama — Chat View Implementation Plan

Phases here are **CV0–CV6** so they never collide with the build phases 0–8
(`IMPLEMENTATION_PLAN.md`), redesign R0–R7 (`REDESIGN_PLAN.md`), settings S0–S5
(`SETTINGS_PLAN.md`), harness H0–H6 (`HARNESS_DESIGN.md`), tool layer TL0–TL7
(`TOOL_LAYER_PLAN.md`), providers P0–P6 (`PROVIDERS_PLAN.md`), prompt stack
PS0–PS7 (`PROMPT_STACK_PLAN.md`), Mission Control M0–M6
(`MISSION_CONTROL_PLAN.md`), loop migration LM0–LM7 (`LOOP_MIGRATION_PLAN.md`),
loop mending MD0–MD6 (`LOOP_MENDING_PLAN.md`), workspace panes W0–W7
(`WORKSPACE_PANES_PLAN.md`), symbol layer SL0–SL6 (`SYMBOL_LAYER_PLAN.md`), or
agent browser AB0–AB7 (`AGENT_BROWSER_PLAN.md`). Cite these as
"CHAT_VIEW_PLAN.md Phase CV3".

**What this document owns.** Everything between "a `SessionEvent` arrived at the
window" and "a pixel is on screen in the chat column". It covers the duplicated
assistant message, the transcript/composer measure, markdown rendering, and the
per-step block timeline. It does not touch the run loop's *decisions* (hooks,
budget, compaction), the prompt stack, providers, or Mission Control's panes —
the two engine changes it does make (CV1) are both "stop emitting the same thing
twice", not behaviour changes.

---

## 1. The framing: three of the four defects are one defect

The chat column looks unfinished because it is rendering a data model that was
flattened twice before it got here, and because two CSS rules that were supposed
to be a pair only ever shipped one half.

> **The provider hands us an ordered array of typed blocks. We turn it into two
> strings and a side-table, and then wonder why the view has no structure.**

Anthropic's wire format is `content_block_start` / `content_block_delta` /
`content_block_stop`, every frame carrying an `index` that *is* the block's
identity. `engine/src/llm/anthropic/decode.ts:112-150` reads that index and uses
it — for tool calls (`recordToolStart`, `appendToolJson`, `flushTool`) — then
throws it away for the other two block types:

```js
events.push({ type: "text.delta", text: delta.text });           // index dropped
events.push({ type: "reasoning.delta", text: delta.thinking });  // index dropped
```

The same flattening happens again one layer up. `engine/src/agent/run/step.ts:231`
pushes a genuine per-step transcript entry (`{ text, reasoning, calls }`), and
then `run.ts:377-385` concatenates every step's text into `fullText` and every
step's reasoning into `fullThinking`, which `finalizeMessage` writes as one row
with two TEXT columns. So by the time `ChatColumn` sees a run it has: one string
of prose, one string of reasoning, and a flat list of tool calls keyed by message
id — with no way to know that thinking #3 happened between tool call #2 and tool
call #4.

That single fact explains three of the four complaints:

| Symptom | Cause |
|---|---|
| One giant "thinking" block that keeps growing | N reasoning phases concatenated into one `thinking` string |
| Thinking rendered *after* the tool calls it preceded | No ordering survives; `ChatColumn.tsx:644-695` renders tools → thinking → text by fiat |
| Prose with no structure | `ChatColumn.tsx:693` is `<div>{msg.content}</div>` — a raw text node |

The fourth (the answer appearing twice) is unrelated and is a React bug, not a
model bug. It goes first anyway, because until it is gone nothing observed in
this view can be trusted.

The layout defect is its own small thing: `.rama-messages-inner` caps at 880px
with no `margin-inline` (`app-shell.css:568`) while `.rama-composer-wrap`
(`:607`) has no cap at all, so the transcript hugs the left and the composer runs
edge to edge. They were meant to be a pair.

**Two passes.** Pass 1 (CV0–CV2) makes the view trustworthy and correctly shaped
— all small, all independently shippable, no protocol or schema changes. Pass 2
(CV3–CV6) gives it structure and typography, and is where the real work is.

---

## 2. Pass 1 — Trust & Shape (CV0–CV2)

### CV0 — Stop rendering the assistant's answer twice (client)

`apps/desktop/src/app/data/SessionProvider.tsx:183-204` calls
`appendLocalMessage(...)` **inside** the updater function passed to
`setPendingByChat`. That is a side effect in a state updater, and `main.tsx:6`
wraps the app in `<React.StrictMode>`, which double-invokes updaters in
development precisely to surface impure ones. Both invocations queue a
functional update, so the run's final assistant message is appended twice — with
the same React key, `local-${runId}`.

This is dev-only, deterministic, and has nothing to do with the model.

**Confirm first (30 seconds):** temporarily remove the `StrictMode` wrapper in
`main.tsx`, send one turn, observe a single answer. Then put it back. Do not
"fix" this by dropping StrictMode — it caught a real bug.

**Change.** Mirror the pending buffer into a ref alongside the state (same
pattern already used for `activeRunIdByChatRef` / `hadToolCallsByRunIdRef` at
`SessionProvider.tsx:99-105`, and for the same stated reason), then handle
`message.done` as two ordinary sequential setState calls outside any updater:
read the pending buffer from the ref, `appendLocalMessage(...)`, then
`setPendingByChat` to clear. The `setToolCallsByChat` re-tag at `:207-214` is
already pure and stays as it is.

**Audit while in here.** Grep the `onEvent` switch for any other setState that
calls a second setState from inside an updater. There should be none after this;
if one appears later it will produce the same class of ghost.

**Done when.** With StrictMode on, one turn produces exactly one assistant
message, and React logs no duplicate-key warning for `local-*`.

### CV1 — Stop producing the answer twice (engine)

Two independent paths, both production-real, neither currently visible because
CV0's ghost masks them.

**CV1a — the completion gate invites a second summary.**
`engine/src/agent/run/hooks.ts:188-210` fires whenever a step made no tool calls
and `unverifiedWrites` is non-empty. By then the model has already written its
closing summary; the nudge (`engine/src/agent/completionGate.ts:21-28`) ends
with *"Run check now, or say plainly why verification doesn't apply here — then
finish"*, which reads as an instruction to write another one. Both land in
`fullText` (`run.ts:377-379`) and both are persisted.

Two changes: rewrite the nudge to say verify-then-stop and explicitly not to
restate the summary; and tighten the hook's condition so it only fires when the
step produced no tool calls **and** no text — a step that already wrote prose has
finished its answer, and the gate should have caught it a step earlier.
`completionGate.test.ts` and `hooks.test.ts` both cover this hook; update rather
than add.

**CV1b — `message.done` can be broadcast twice.** It is emitted at `run.ts:488`
inside the try and again at `run.ts:534` in the catch. Anything throwing between
them — `recordUsage`, `estimateCostUsdDetailed`, a `broadcast` — re-runs
`finalizeMessage` and re-emits. The client tolerates it today only by accident
(the pending buffer is already cleared, so the second one no-ops), and CV5 makes
the client stateful enough that it will stop being harmless. A `let doneEmitted
= false` guard around both call sites closes it.

**Done when.** A write-heavy turn ends with one closing summary in the
transcript, and a forced throw after `run.ts:488` emits `message.done` once.

### CV2 — One measure, one gutter

The terminal/document tension resolves as: **express the measure in `ch`, not
`px`.** The UI is monospace, so `88ch` is literally 88 columns — a terminal
width that is also a good prose measure. That is the whole bridge, and it is why
this is a token and not a magic number.

**Changes, all in `app-shell.css`:**

1. Add `--measure: 88ch` and `--measure-wide: 120ch` alongside the existing
   layout tokens.
2. `.rama-messages-inner` (`:568`): `max-width: min(var(--measure), 100%)` plus
   `margin-inline: auto`. Drop the literal `880px`.
3. Wrap the composer's contents in a `.rama-composer-inner` with the identical
   rule, so the composer box sits directly under the text column. Unify the
   horizontal padding — `.rama-messages` is `0 30px` and `.rama-composer-wrap`
   is `0 18px` (`:567`, `:607`), so even their left edges currently disagree.
4. **Gutter as a real grid column.** Today `.rama-msg-user` and
   `.rama-msg-assistant` (`:570`, `:573`) position their glyphs with flex+gap
   while `.rama-tool-call` (`:583`) and `.rama-clarify-questions` use a hardcoded
   `margin-left: 22px`. Replace all four with one shared
   `grid-template-columns: 18px minmax(0, 1fr)` row, applied to user turns,
   assistant turns, tool cards, and the composer alike. When the `❯` in the
   composer lands in the same column as the `❯` on every past user turn, the
   view reads as a shell rather than a chat app — that alignment is the point of
   this phase, not the centering.
5. **Break-out lane.** A `.rama-breakout { max-width: min(var(--measure-wide),
   100%) }` for code fences, diffs, tables, and `.rama-tool-call-body`, so prose
   stays at 88 columns while a long `bash` line does not wrap into soup.

**One layout, not two.** Do **not** branch on `.rama-body-panel-collapsed`
(`app-shell.css:187`). With `min(measure, 100%)` the slack simply vanishes when
Mission Control opens and the column degrades to today's full-width look on its
own. Two layouts means two layouts to maintain badly.

**Done when.** With the panel collapsed the transcript and composer are centered
on the same axis with matching left edges; with it open nothing jumps, shifts
gutter, or overflows horizontally; the glyph column is continuous top to bottom.

---

## 3. Pass 2 — Structure & Render (CV3–CV6)

### CV3 — Markdown core

`ChatColumn.tsx:693` renders `msg.content` as a text node. There is no parser in
the desktop app. The tell that this was planned and abandoned: `.rama-inline-code`
is fully styled at `app-shell.css:576` and **no component in the tree ever emits
that class** — the CSS shipped, the renderer did not.

**Library: `marked`'s lexer plus our own React renderer.** Not `react-markdown`:
it drags unified/remark/rehype in and then fights every custom fence component,
and fences are where all the interesting behaviour lives. `marked` is already
GFM-compliant, so GFM parity is free — what we are choosing is not *which
syntax to support* but *which token types get a bespoke component*. Start with
roughly ten (paragraph, strong, em, inline code, fenced code, `ul`/`ol`, table,
link, heading, hr) and let everything else fall through to plain text. Add
components when a model is observed emitting something ugly, not before.

**Streaming is the hard part.** Re-lexing a whole message on every delta will
flicker and burn CPU on long answers. Split content into blocks at blank lines
and fence boundaries, memoize completed blocks by index, and re-parse only the
tail. Critically: an **unclosed** fence renders as a code block in progress, not
as three literal backticks sitting there for four seconds.

**Security.** Disable raw HTML in the lexer. The only
`dangerouslySetInnerHTML` in this path is hljs output, which matches what
`FilesStage.tsx` already does.

**Typography.** Two weights, not six heading sizes — a web page pasted into a
shell is worse than no formatting. Spacing carries hierarchy. Keep
`.rama-msg-user-text` literal: your own typed input is terminal echo and must
not reflow into bullets.

**Done when.** A reply containing bold, a list, a table, inline code, and a
fenced block renders correctly both while streaming and after reload, and
`.rama-inline-code` is finally used.

### CV4 — Fences, file links, diagrams

1. **Reuse the existing highlighter.** `highlight.js` is already a dependency and
   `mission-control/panes/syntax.ts:112`'s `highlightCode(code, filePath)`
   already does path → language → hljs → per-line HTML for the Files pane. Call
   it; do not add a second highlighting path. Fences get a header strip (language
   or file path) and a copy button, and sit in CV2's break-out lane.
2. **File paths become links — the highest-leverage detail in this plan.**
   Inline code matching a path shape (contains `/`, or has a known extension)
   renders with the existing `FileIcon` from `@rama/ui` and dispatches
   `rama:open-file` on click. That wiring is already complete end to end:
   `ChatColumn.tsx:209` fires it, `AppShell.tsx:42-54` catches it, activates the
   Files pane, and expands the panel if collapsed. So every `engine/src/agent/run/run.ts`
   in prose becomes a live jump into the workspace for the cost of a regex.
3. **Mermaid, lazily.** `import()` the library on first mermaid fence only —
   it is ~600KB and most turns have none. Render to SVG, feed it the active
   theme's CSS vars so it is not a light-mode rectangle in a dark app, and make
   click-to-expand hand it to a Mission Control pane.

**Done when.** A fenced `ts` block is highlighted identically to the same file in
the Files pane; clicking an inline path opens that file in the Files pane; a
mermaid fence renders themed, and a chat with no mermaid never loads the library.

### CV5 — The block timeline on the wire

Make the ordering survive the trip. This is additive to the protocol and needs no
schema change.

1. **Stop dropping the index.** In `engine/src/llm/anthropic/decode.ts:123-142`,
   carry `index` onto the `text.delta` and `reasoning.delta` events the way it is
   already carried for `input_json_delta`. The OpenAI decoder has no per-block
   index (`openai/decode.ts` handles `reasoning_content` / `reasoning` as flat
   deltas), so it synthesizes one: a counter that increments whenever the delta
   channel changes between text and reasoning. Same downstream shape either way.
2. **Widen the events.** `packages/protocol/src/index.ts:27-31` — add
   `blockIndex: number` to `thinking.delta`, `message.delta`, `thinking.done`,
   and `tool.call`, and a `stepIndex: number` to the same four (`run.ts` already
   has the loop counter). The pair `(stepIndex, blockIndex)` is a stable,
   monotonic block identity for a run. Both fields optional on the wire so an
   in-flight run during a reload degrades instead of crashing.
3. **Rebuild the timeline client-side.** `SessionProvider`'s pending buffer stops
   being `{ text, thinking }` and becomes an ordered `blocks: Block[]` where
   `Block` is `{kind:'thinking', text, durationMs?}` | `{kind:'text', text}` |
   `{kind:'tool', callId}`. A delta appends to the block matching its
   `(stepIndex, blockIndex, kind)` or starts a new one. `thinking.done` stamps
   `durationMs` on the block it names rather than on the whole run.
4. **Render the timeline.** `ChatColumn.tsx:644-695` stops rendering
   tools-then-thinking-then-text and walks `blocks` in order. Each thinking block
   collapses with its own "Thought for Xs"; the last one auto-expands while
   streaming and all collapse when the run ends.

**Done when.** A multi-step turn shows reasoning → tool → reasoning → tool →
answer in the order it actually happened, each thinking block with its own
duration.

### CV6 — Block persistence

Without this, CV5 is a live-only illusion: reload flattens everything back into
one blob, because `finalizeMessage` writes `fullText`/`fullThinking` into two
columns.

**No migration needed.** `messages.meta_json` already exists
(`db/schema.ts:45`) and is already used exactly this way for
`reasoningSignature` (`db/messages.ts:56-79`, with its own note that it rides
`meta_json` "rather than adding a migration for one nullable string"). Blocks
ride the same field. **Watch the clobber**: `finalizeMessage` currently
*overwrites* `meta_json` wholesale with `{ reasoningSignature }` — it must merge
from here on, not replace.

- Keep `content` and `thinking` populated as flat derived mirrors, so
  `transcript.ts`'s `buildTranscriptFromDb`, compaction, titling, and the curator
  all keep working untouched. Blocks are additive presentation state, not the
  source of truth for the model's context.
- `listMessages` parses `meta_json.blocks` when present and falls back to
  `{content, thinking}` as a single text block plus a single thinking block when
  absent — every chat that exists today reloads exactly as it does now.
- `MessageDTO` gains `blocks?: Block[]`. `thinkingDurationMs` (`protocol:225`,
  currently documented as never persisted) moves onto the block that owns it.

**Done when.** A multi-step turn reloads with the same block structure it had
live, and a chat recorded before this phase still renders.

---

## 4. Deliberately out of scope

- **The run loop's decisions.** CV1 makes it stop emitting duplicates; it does
  not change when the loop stops, compacts, or injects.
- **Reasoning arriving on the content channel.** The blob in the reported
  screenshot reads like deliberation rendered as prose. `openai/decode.ts` does
  map both `reasoning_content` and `reasoning` (there are tests), so this is not
  a missing adapter — it is the provider inlining reasoning into `content`. Dump
  the raw SSE for one GLM turn before designing around it; if confirmed it is a
  provider-layer issue, not a chat-view one, and belongs in its own note.
- **Full GFM parity as a goal.** The parser gives it to us; we are choosing
  which tokens get designed for. See CV3.
- **A second layout for the panel-open case.** See CV2.

---

## 5. Sequencing

CV0 → CV1 → CV2 land as Pass 1 and are independently revertable. CV0 goes first
and alone: until the ghost message is gone, nothing observed in this view is
evidence of anything.

Pass 2 runs CV3 → CV4 → CV5 → CV6. Markdown before blocks, because the markdown
renderer is a self-contained leaf (`<Markdown text={...} />` replaces one text
node) while CV5 restructures the render loop around it — doing it the other way
means building the leaf twice.
