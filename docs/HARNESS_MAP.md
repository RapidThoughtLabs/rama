# Rama — Harness Map (companion to HARNESS_DESIGN.md)

`HARNESS_DESIGN.md` is the audit: what a good harness has, where Rama stands,
and phases H0–H6 to close it. This document is the **map** — the dependency
spine through that plan, plus nine things a coding harness must get right that
the audit does not currently cover.

Read this one for *shape*. Read that one for *detail*.

---

## 1. The spine

Nine things in strict dependency order. Each one is unmeasurable, unbuildable,
or actively harmful before the one above it lands.

```
1. Tool results carry content            (C1 · H0)   ── nothing is an agent before this
2. Full results persisted                (M1 · H1)   ── the projection needs input
3. The projection seam                   (C2 · H1)   ── every context feature hangs here
4. The between-step hook                 (L1 · H1)   ── every loop feature hangs here
5. A thin eval                           (V3 · ???)  ── everything after this is measured
6. Assembled prompt + RAMA.md            (C3/C4· H2)
7. Edit fidelity + read-tracking         (T4 · H3)   ── the failure mode users don't forgive
8. Cache ordering + pre-flight tokens    (C5/C6· H3)
9. Decay, then compaction                (C7→C8· H1/H5)
```

Two observations about that order.

**Steps 3 and 4 are seams, not features.** They ship doing almost nothing. Their
value is that H2–H5 have somewhere to live. Building any later feature before
its seam exists means building it twice.

**Step 5 is out of position in the current plan.** `HARNESS_DESIGN.md` puts
evals at H6, and §5 concedes the consequence: "prompt changes are measured after
H6. Before H6, they are guesses; say so." But H2, H3, H4 and H5 are *entirely*
prompt-and-context changes. That schedules four phases of unmeasurable work. A
minimal eval — five real tasks, a programmatic check each, one command, no
framework — is a couple of days and turns the rest of the plan from guessing
into engineering. It belongs immediately after H1, when the projection seam
first makes runs reproducible. Leave the full ~20-task suite at H6.

---

## 2. The layer map

Eight layers. For each: what "getting it right" means, and the failure it
prevents.

### Perception — can the model see?
Tool results carry what the next decision needs. Truncation is explicit and
paginable. Errors name the fix, not the errno. Reads carry line numbers.
*Failure prevented:* the agent hallucinates file contents and edits blind.
**Rama: broken.** Six builtins return summaries; only skills and MCP populate
`detail`.

### Projection — what is it shown?
One lossless transcript, one deliberately lossy model-facing array, and exactly
one function between them. Everything that shrinks, elides, reorders, or
re-injects lives in that function.
*Failure prevented:* eviction logic scattered across the DAO, un-auditable.
**Rama: missing.** `toModelMessage` is a 1:1 row mapper; tool history is never
reconstructed across turns.

### Instruction — what is it told?
Layered system prompt: identity, mode, environment, repo instructions, live tool
inventory. Plus an ephemeral layer regenerated each step and never persisted.
*Failure prevented:* plan mode that plans nothing; `npm test` in a Bun repo.
**Rama: one constant, five sentences, identical in all three modes, and stale
about its own tool count.**

### Action — can it change the world reliably?
Tool descriptions written as prompt. Read-before-write enforced. Parallel reads,
serial writes. A persistent shell. Post-edit diagnostics in the same result.
*Failure prevented:* silently clobbering the user's concurrent edits.
**Rama: strong contract (`ToolResult`, `ToolRisk`), thin implementations.**

### Control — when does it stop?
Plural budgets (steps, wall clock, tokens, cost), all visible, all legible when
hit. Classified errors: transient retries, overflow compacts and retries, only
permanent fails. Steering delivered mid-run. Loop detection.
*Failure prevented:* a 429 at minute nine discards the run.
**Rama: `stepCountIs(8)` and a throw on the first error part.**

### Recovery — can it be undone?
Checkpoints before every run and every write. Graceful interrupt that synthesises
results for orphaned tool calls. Staleness detection on every tracked file.
*Failure prevented:* the user is afraid to leave it unattended, so they approve
everything manually, so the harness feels slow.
**Rama: interrupt wiring is good; checkpoints do not exist.** See §3.2.

### Trust — what can it be tricked into?
OS-level sandbox, not just path scoping. Per-command risk, not per-tool.
Persistent scoped allowlists so approvals stay meaningful. Tool output framed as
untrusted data.
*Failure prevented:* approval fatigue, then a rubber-stamped `rm -rf`.
**Rama: the best-designed area — mode×risk gate, denials-as-results — with two
holes: `bash` bypasses `resolveInProject`, and saved rules are displayed but not
consumed.**

### Evidence — is any of this working?
An eval suite with programmatic checks. Per-tool error rates, repeated-call
counts, cache hit rate, steps-to-completion. Replayable transcripts.
*Failure prevented:* a prompt "improvement" that regresses the suite and nobody
notices for three weeks.
**Rama: zero tests in the repo.**

---

## 3. Nine things the audit does not cover

### 3.1 Edit fidelity is a subsystem, not a tool
`HARNESS_DESIGN.md` treats `edit` as one of six builtins and praises its
non-unique-match error. Correct, but under-weighted: **the failed-edit rate is
the single strongest predictor of whether a coding agent finishes a task.** Every
failed edit costs a retry, and retries compound — three failures and the model
starts rewriting whole files, which is where real damage happens.

What has to be right:
- Exact match with a uniqueness check (have) — plus indentation-tolerant retry
  before giving up, since models reliably normalise leading whitespace.
- Multi-edit atomicity: N edits to one file apply all-or-nothing, so a partial
  failure never leaves a half-transformed file.
- Byte-level preservation: CRLF, trailing newline, BOM, tabs-vs-spaces. Silently
  normalising these turns a 3-line change into a 400-line diff.
- A `write` guard: refusing to replace a large existing file with a much smaller
  body without an explicit override catches the classic "rewrote the file as a
  stub with a `// ... rest unchanged` comment" failure.
- Failure messages that push toward recovery: "no match; the file changed at
  line 40 — re-read and retry" beats "string not found".

Track failed-edit rate as a first-class metric under V2.

### 3.2 Checkpoints and undo
Not mentioned anywhere in the plan. A harness that mutates a working tree needs
a rewind, and it is the precondition for the thing that makes a harness feel
fast: users only enable broad auto-approval when they know they can revert.

Cheapest good version: a shadow git repo under `.rama/` with its own `--git-dir`,
never touching the user's index or history. Snapshot before each run and after
each write-tool call. Surface as `/undo` plus a per-message "restore the tree to
here". Independent of whether the user's own repo is clean, mid-rebase, or not a
repo at all.

This belongs at **H3, alongside read-tracking** — they are the same concern
(don't destroy work) approached from prevention and from cure.

### 3.3 Output-token truncation
No handling of `finishReason: "length"`. If the model runs out of output budget
mid tool-call arguments or mid code block, Rama will currently persist whatever
arrived. For a coding harness this is a corruption path, not an edge case —
long file writes hit it routinely.

Needs: detect the length finish, never apply a truncated tool call, and either
continue the generation or fail the step with a message the model can act on.
The structural mitigation is preferring patch-shaped edits over whole-file
rewrites, which shrinks output per step by an order of magnitude.

### 3.4 Provider conformance
The audit calls the provider/model registry split a strength and stops there.
The split *is* clean, but a clean split is not portability. Across the providers
Rama already targets, these differ in ways that break tool-use loops:

- parallel tool calls: supported, silently serialised, or rejected
- JSON schema strictness and unsupported keyword handling
- tool-name charset and length limits
- system-message placement (some OpenAI-compatible endpoints fold it into user)
- prompt caching: Anthropic-specific `cache_control` shapes, absent elsewhere
- reasoning/thinking wire formats
- `finishReason` semantics and streamed tool-argument deltas
- empty-content-block tolerance (the latent 400 the audit already flags)

Two things fix this: a capability matrix in `MODEL_REGISTRY` that the loop
actually branches on, and a conformance suite — the same ~10 tool-use scenarios
run against every configured provider. H0's exit criterion already says "against
Anthropic and against Together"; make that a standing test rather than a
one-time demo, or Together degrades silently the first time a prompt changes.

### 3.5 Visual input
No handling of images. For a desktop coding app with a Tauri shell, this is
larger than it looks: front-end work is a big share of coding tasks, and the gap
between "the model reads the CSS" and "the model sees the rendered result" is
the difference between guessing and iterating. Minimum: paste/drag a screenshot
into a turn, and a tool that captures the app under development. Gate on the
model's declared vision capability in the registry.

### 3.6 The unit of concurrency is the working tree, not the chat
`loop.ts:65` enforces one run per chat. The real invariant is **one run per
working tree** — two chats in the same project editing the same file corrupt
each other, and neither one's read-tracking will notice, because the mtime check
sees a "legitimate" external change.

Either a per-project run lock (simple, blocks a real workflow) or per-run git
worktrees (correct, more machinery). Decide before H4 makes concurrent runs
attractive. Also worth confirming SQLite write-contention behaviour under two
streaming runs.

### 3.7 Sub-agents belong before compaction, not after
The plan lists sub-agents in H5 next to compaction. They solve the same problem
from opposite ends, and the cheap end is first: **not putting exploration into
the main context beats summarising it after the fact.** A search that reads
thirty files to answer one question should return a paragraph, not thirty file
bodies, and no compaction pass recovers the tokens as well as never spending
them.

Given the projection seam lands at H1 and skill discovery already proves the
description-always/body-on-demand pattern, a read-only sub-agent is buildable
much earlier than H5, and it lowers the odds that compaction is needed at all.

### 3.8 The run's terminal states are a closed set
L2 asks for legible stops. Generalise it: every run ends in exactly one of a
small enumerated set, each with a distinct UI treatment and a distinct next
action offered to the user.

```
completed · stopped-by-budget · interrupted-by-user ·
blocked-on-permission · failed-permanent · failed-transient-exhausted ·
stopped-loop-detected
```

Define this enum once in `@rama/protocol` alongside `SessionEvent` and make the
loop's every exit path assign one. It is the difference between "the agent gave
up" and "the agent hit your step cap, here's the resume button".

### 3.9 Latency is a harness property
Nothing in the plan budgets time-to-first-token, and several planned features
(RAMA.md loading, tool inventory assembly, git state, environment block) sit
directly on the critical path to the first request. Cache them, compute them off
the hot path where possible, and — the large win — keep the stable prefix
genuinely stable, since cache hits cut latency as much as cost.

Corollary worth stating in §5's rules: **a context layer that changes every step
is a latency regression as well as a cost one.**

---

## 4. Answers to two of the open questions

**"Do we hand-roll the step loop or keep `streamText` + `prepareStep`?"**
Decide at H1, not H3. Compaction-and-retry (H3) and mid-run steering (H4) both
want control over the step boundary that `prepareStep` does not cleanly give —
particularly re-issuing a step against a rewritten message array. Retrofitting a
hand-rolled loop after three phases have been built on the SDK's boundary is
strictly worse than paying for it once at the seam. Keep `streamText` for a
single model call; own the loop around it.

**"Compaction summariser: the chat's own model or a fixed cheap one?"**
The chat's own model, at least until the eval suite exists. Compaction quality
is one of the hardest things to notice regressing — a bad summary produces
confident, subtly wrong work several turns later, with no error anywhere. Make
it configurable, default it to the session model, and revisit once §V3 can
measure the difference.

---

## 5. One-line summary of the map

Make the agent able to see (H0), give context one owner and the loop one hook
(H1), prove you can measure a prompt change (thin eval), then tell it where it
is (H2), stop it from destroying work and money (H3 + checkpoints + edit
fidelity), let the user work alongside it (H4), and only then spend effort on
memory, compaction, and breadth.
