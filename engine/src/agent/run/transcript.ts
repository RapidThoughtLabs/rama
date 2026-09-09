// engine/src/agent/run/transcript.ts
//
// The single most consequential change: one object per run, and one pure renderer.
// Replaces the ad-hoc splicing of toModelMessages, withTodoReminder, markCacheBoundary,
// and prepareStep.
// docs/LOOP_MIGRATION_PLAN.md §5, Decision 4.

import { getMessageReasoningSignature, listMessages } from "../../db/messages";
import { listToolCallsForHistory } from "../../db/toolCalls";
import type { CacheStyle } from "../catalog";
import type { ContentPart, WireMessage } from "../../llm/types";
import { buildEphemeralMessage } from "../prompt/ephemeral";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Structured compaction summary fields.
 * HARNESS_DESIGN.md C8, docs/LOOP_MIGRATION_PLAN.md LM5.
 */
export interface CompactionFields {
  summary: string;
  filesModified?: string[];
  keyDecisions?: string[];
  openQuestions?: string[];
}

/**
 * An entry in the run's working copy of conversation history.
 * Durable turns (user, assistant, tool) match DB rows.
 * summary entries (LM5) replace spans of entries.
 * injected entries (LM4) represent steering, completion-gate nudges, or todo reminders.
 * docs/LOOP_MIGRATION_PLAN.md §5
 */
export type TranscriptEntry =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "assistant";
      id: string;
      text: string;
      reasoning?: string;
      /** Anthropic's opaque thinking-block signature (D6/MD4) — must ride with `reasoning`. */
      reasoningSignature?: string;
      calls: { id: string; name: string; input: unknown }[];
    }
  | { kind: "tool"; callId: string; name: string; ok: boolean; content: string }
  | { kind: "summary"; id: string; covers: string[]; fields: CompactionFields }
  | {
      kind: "injected";
      id: string;
      role: "system" | "user";
      text: string;
      tag: string;
      ttl: "step" | "run";
    };

/**
 * Regenerated every step, never persisted, never part of `entries`.
 * docs/LOOP_MIGRATION_PLAN.md §5
 */
export interface EphemeralSlots {
  /** Rendered text for the trailing ephemeral block (volatileEnv, complexity, unverifiedWrites). */
  text?: string;
}

/**
 * The run's working copy of conversation state.
 * The DB stays the durable record; the Transcript is edited during the run.
 */
export interface Transcript {
  /** Durable turns in order. The only thing compaction and decay rewrite. */
  entries: TranscriptEntry[];
  /** Regenerated every step, never persisted. */
  ephemeral: EphemeralSlots;
}

/**
 * Options determining how a Transcript projects onto the wire.
 */
export interface ProjectionPolicy {
  cacheStyle: CacheStyle;
  supportsMidConversationSystem: boolean;
  /**
   * The assembled system blocks from buildPrompt().system (kernel+tools, agent+mode,
   * project+env). Emitted verbatim, in order, ahead of every transcript entry — annotations
   * (cacheBreakpoint) survive untouched. Pure and constant for the whole run; the caller
   * computes it once, outside the step loop. Undefined only in tests that don't care about
   * the system prompt. docs/LOOP_MENDING_PLAN.md MD0.
   */
  system?: WireMessage[];
}

// ---------------------------------------------------------------------------
// DB Loader: Reconstruct transcript from durable DB messages + tool calls
// ---------------------------------------------------------------------------

/**
 * Build a fresh Transcript from the database for a chat.
 * Replaces the toModelMessages() DB query logic.
 * docs/LOOP_MIGRATION_PLAN.md §5
 */
export function buildTranscriptFromDb(chatId: string): Transcript {
  const callsByMessage = new Map<string, ReturnType<typeof listToolCallsForHistory>>();
  for (const call of listToolCallsForHistory(chatId)) {
    const list = callsByMessage.get(call.messageId) ?? [];
    list.push(call);
    callsByMessage.set(call.messageId, list);
  }

  const entries: TranscriptEntry[] = [];
  for (const m of listMessages(chatId)) {
    if (m.role === "user") {
      entries.push({ kind: "user", id: m.id, text: m.content ?? "" });
      continue;
    }
    if (m.role === "system") {
      entries.push({
        kind: "injected",
        id: m.id,
        role: "system",
        text: m.content ?? "",
        tag: "system",
        ttl: "run",
      });
      continue;
    }

    // D6/MD4 — m.thinking (already persisted by finalizeMessage) and its signature (stored in
    // meta_json, since there's no dedicated column) both round-trip across a reload here; a
    // reasoning model's next request would otherwise silently lose the thinking block for this
    // historical turn.
    const reasoning = m.thinking ?? undefined;
    const reasoningSignature = m.thinking ? getMessageReasoningSignature(m.id) : undefined;

    const calls = callsByMessage.get(m.id) ?? [];
    if (calls.length === 0) {
      if (!m.content) continue; // an interrupted turn with nothing to replay
      entries.push({ kind: "assistant", id: m.id, text: m.content, reasoning, reasoningSignature, calls: [] });
      continue;
    }

    // Assistant entry with tool calls
    entries.push({
      kind: "assistant",
      id: m.id,
      text: m.content ?? "",
      reasoning,
      reasoningSignature,
      calls: calls.map((c) => ({ id: c.id, name: c.name, input: c.input })),
    });

    // Each tool call has its own result entry
    for (const call of calls) {
      entries.push({
        kind: "tool",
        callId: call.id,
        name: call.name,
        ok: !!call.ok,
        content: call.resultContent ?? call.resultSummary ?? (call.ok ? "" : "tool call failed"),
      });
    }
  }

  return {
    entries,
    ephemeral: {},
  };
}

// ---------------------------------------------------------------------------
// Injected entry helpers
// ---------------------------------------------------------------------------

/**
 * Set or update an injected entry by tag.
 * Replaces any existing injected entry with the same tag.
 */
export function setInjectedEntry(transcript: Transcript, entry: Extract<TranscriptEntry, { kind: "injected" }>): void {
  // Remove existing entry with the same tag if present
  const idx = transcript.entries.findIndex((e) => e.kind === "injected" && e.tag === entry.tag);
  if (idx !== -1) {
    transcript.entries[idx] = entry;
  } else {
    transcript.entries.push(entry);
  }
}

/**
 * Remove an injected entry by tag.
 */
export function removeInjectedEntry(transcript: Transcript, tag: string): void {
  const idx = transcript.entries.findIndex((e) => e.kind === "injected" && e.tag === tag);
  if (idx !== -1) {
    transcript.entries.splice(idx, 1);
  }
}

/**
 * Clean up all injected entries whose ttl is "step".
 * Called at the end of each step before preparing the next.
 */
export function clearStepInjected(transcript: Transcript): void {
  transcript.entries = transcript.entries.filter(
    (e) => !(e.kind === "injected" && e.ttl === "step")
  );
}

// ---------------------------------------------------------------------------
// Compaction Summary formatting (LM5)
// ---------------------------------------------------------------------------

export function formatSummary(fields: CompactionFields): string {
  const parts: string[] = [`Summary: ${fields.summary}`];
  if (fields.filesModified && fields.filesModified.length > 0) {
    parts.push(`Files modified: ${fields.filesModified.join(", ")}`);
  }
  if (fields.keyDecisions && fields.keyDecisions.length > 0) {
    parts.push(`Key decisions:\n${fields.keyDecisions.map((d) => `- ${d}`).join("\n")}`);
  }
  if (fields.openQuestions && fields.openQuestions.length > 0) {
    parts.push(`Open questions:\n${fields.openQuestions.map((q) => `- ${q}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// project: Pure renderer (Transcript + policy -> WireMessage[])
// ---------------------------------------------------------------------------

/**
 * Pure function. Transcript + policy -> exactly what goes on the wire.
 *
 * Absorbs in a fixed order:
 * 1. Entry-to-message expansion (assistant with calls + tool result messages)
 * 2. Summary entries rendering in place of what they cover
 * 3. Injected entries landing at their defined positions (todo reminder after last user message)
 * 4. Cache breakpoint on the last durable message
 * 5. Ephemeral block trailing everything
 *
 * docs/LOOP_MIGRATION_PLAN.md §5
 */
export function project(t: Transcript, policy: ProjectionPolicy): WireMessage[] {
  const wire: WireMessage[] = [];

  // The assembled system stack (kernel+tools, agent+mode, project+env) always leads, verbatim,
  // annotations intact. docs/LOOP_MENDING_PLAN.md MD0 — this is what D1 discarded.
  if (policy.system) {
    wire.push(...policy.system);
  }

  let todoInjected: Extract<TranscriptEntry, { kind: "injected" }> | null = null;

  for (const entry of t.entries) {
    switch (entry.kind) {
      case "user": {
        wire.push({ role: "user", content: entry.text });
        break;
      }
      case "assistant": {
        const msg: WireMessage = {
          role: "assistant",
          content: entry.text,
        };
        // D6/MD4 — reasoning text and its signature both survive projection; previously dropped
        // entirely, which is why the round-trip could never work regardless of what the
        // encoder did with it.
        if (entry.reasoning) {
          msg.reasoning = entry.reasoning;
        }
        if (entry.reasoningSignature) {
          msg.annotations = { ...msg.annotations, reasoningSignature: entry.reasoningSignature };
        }
        if (entry.calls && entry.calls.length > 0) {
          msg.toolCalls = entry.calls.map((c) => ({
            id: c.id,
            name: c.name,
            input: c.input,
          }));
        }
        wire.push(msg);
        break;
      }
      case "tool": {
        wire.push({
          role: "tool",
          toolCallId: entry.callId,
          content: entry.content,
        });
        break;
      }
      case "summary": {
        const role = policy.supportsMidConversationSystem ? "system" : "user";
        wire.push({
          role,
          content: `<system-summary id="${entry.id}">\n${formatSummary(entry.fields)}\n</system-summary>`,
        });
        break;
      }
      case "injected": {
        if (entry.tag === "todo") {
          // Handled below — positioned specifically after the last user message
          todoInjected = entry;
          break;
        }
        const role =
          entry.role === "system" && !policy.supportsMidConversationSystem ? "user" : entry.role;
        wire.push({ role, content: entry.text });
        break;
      }
    }
  }

  // Position todo reminder after the last user message (same position withTodoReminder used)
  if (todoInjected) {
    let lastUserIdx = -1;
    for (let i = wire.length - 1; i >= 0; i--) {
      if (wire[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    const todoMsg: WireMessage = { role: "user", content: todoInjected.text };
    if (lastUserIdx !== -1) {
      wire.splice(lastUserIdx + 1, 0, todoMsg);
    } else {
      wire.push(todoMsg);
    }
  }

  // Explicit cache breakpoint: mark the LAST durable message before the ephemeral block.
  // `systemCount` excludes the leading system stack — an empty transcript (system blocks only)
  // must not re-mark a system block that buildPrompt already annotated.
  // docs/PROMPT_STACK_PLAN.md §4.2 PS1/PS2, docs/LOOP_MIGRATION_PLAN.md §4.3
  const systemCount = policy.system?.length ?? 0;
  if (policy.cacheStyle === "explicit" && wire.length > systemCount) {
    const lastIdx = wire.length - 1;
    const last = wire[lastIdx];
    wire[lastIdx] = {
      ...last,
      annotations: {
        ...last.annotations,
        cacheBreakpoint: true,
      },
    };
  }

  // Trailing ephemeral block (layer 7) — always last, uncached, never carries cacheBreakpoint.
  // buildEphemeralMessage is prompt/ephemeral.ts's own system/user fallback (G3/MD5) — routed
  // through here rather than reimplemented so there is exactly one place that decides it.
  // docs/LOOP_MIGRATION_PLAN.md §5
  if (t.ephemeral.text) {
    wire.push(buildEphemeralMessage(t.ephemeral.text, policy.supportsMidConversationSystem));
  }

  return wire;
}

// ---------------------------------------------------------------------------
// Wire invariant: no orphan tool messages
// docs/LOOP_MENDING_PLAN.md MD2, D2 — every provider's tool_use/tool_result matching rejects a
// `tool` message with no preceding assistant `tool_calls` entry declaring its id. This is the
// actual safeguard against a bad compaction cut; compact.ts's cut-boundary logic is trusted only
// because this holds over every cut it can produce (asserted by a property test), not the other
// way around.
// ---------------------------------------------------------------------------

/**
 * Returns the first `tool` WireMessage in `wire` whose `toolCallId` was never declared by an
 * earlier assistant message's `toolCalls`, or `null` if every tool message is properly paired.
 */
export function findOrphanToolMessage(wire: WireMessage[]): WireMessage | null {
  const openCallIds = new Set<string>();
  for (const msg of wire) {
    if (msg.role === "assistant" && msg.toolCalls) {
      for (const call of msg.toolCalls) openCallIds.add(call.id);
    } else if (msg.role === "tool") {
      if (!msg.toolCallId || !openCallIds.has(msg.toolCallId)) return msg;
      openCallIds.delete(msg.toolCallId);
    }
  }
  return null;
}

/** Throws with a descriptive message if `wire` contains an orphan tool message. */
export function assertNoOrphanToolMessages(wire: WireMessage[]): void {
  const orphan = findOrphanToolMessage(wire);
  if (orphan) {
    throw new Error(
      `project() produced a tool message with no preceding assistant tool_calls entry: toolCallId=${orphan.toolCallId ?? "(none)"}`
    );
  }
}
