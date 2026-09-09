import type { ChatMode } from "@rama/protocol";

// docs/PROMPT_STACK_PLAN.md §4.1/§8.2, Phase PS2 — layer 3, cached system block 2 (bp2, "agent +
// mode" — agent (PS4) doesn't exist yet, so this block is mode-only for now and agent content
// joins it later rather than getting its own block). Fixes the concrete bug named in §3: mode was
// enforced only by permissions.ts's gate() and the model was never told, so plan mode discovered
// its own read-only-ness by getting blocked mid-execution. Text below describes exactly what
// gate() actually does — this is documentation of real behavior, not aspirational doctrine — plus
// §8.2's constrained clarifying-question rule for plan mode specifically. Phase PS6 gave that rule
// a real mechanism (tools/clarify.ts) — the text below now names it directly instead of describing
// prose-asking, and extends the same doctrine to agent mode, where the exit criterion ("a six-part
// task asks at most three questions up front") actually has to hold.
const MODE_TEXT: Record<ChatMode, string> = {
  agent:
    "Mode: agent. You have full tool access, including write, edit, bash, git_write, and browser. " +
    "Act autonomously — make the change, verify it, and report what you did. Before diving into a " +
    "genuinely ambiguous or multi-part request, call clarify for at most 3 clarifying questions — " +
    "only where a different answer would lead to materially different work — with a sensible " +
    "default for each; never for something you could answer yourself by reading the repo.",
  plan:
    "Mode: plan. This is read-only: write, edit, bash, git_write, and browser are all blocked " +
    "outright (not prompted), so don't attempt them. Your job right now is to produce a plan, not " +
    "execute one. Investigate with the read-only tools, then call clarify for at most 3 clarifying " +
    "questions — only where a different answer would lead to materially different work — with a " +
    "sensible default for each. Never ask something you could answer yourself by reading the " +
    "repo; most of that is a grep or a read away. Once you have enough to work with, write the " +
    "plan directly instead of continuing to ask.",
  ask:
    "Mode: ask. Read-only tools, plus git/check/outline/todo/explore/clarify/heku_find, run freely; " +
    "write, edit, bash, git_write, and heku_call each prompt the user for approval first. Batch " +
    "your read-only investigation before proposing a write so you don't interrupt the user more " +
    "than necessary, and treat a denial as real information to adapt to, not something to retry.",
};

export function buildModeBlock(mode: ChatMode): string {
  return MODE_TEXT[mode];
}
