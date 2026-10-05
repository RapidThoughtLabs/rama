// engine/src/agent/run/compact.ts
//
// HARNESS_DESIGN.md C7/C8/L4, docs/LOOP_MIGRATION_PLAN.md §5, §6.1, LM5.
//
// Compaction & Decay:
// 1. C7 decay: stale tool results shrink, superseded read results drop when file read again later.
// 2. C8 structured compaction: summarizes span of entries into named fields (summary, filesModified,
//    keyDecisions, openQuestions) using the chat's own model via complete().
// 3. L4 reactive recovery: catches overflow LlmError, triggers emergency compaction, and retries.
//
// The real transcript in the DB is untouched — entries is the run's working copy.

import { recordUtilityUsage } from "../../db/chats";
import { newId } from "../../db/ids";
import { listMessages } from "../../db/messages";
import { getProvider, providerRequiresKey, type ProviderRow } from "../../db/providers";
import { createCompaction } from "../../db/compactions";
import { complete } from "../../llm/complete";
import { getSecret } from "../../secrets";
import { estimateCostUsdDetailed } from "../config";
import { getSummarizeTarget, type SummarizeTarget } from "../summarizeRole";
import { decayedPlaceholder, type CompactionFields, type Transcript, type TranscriptEntry } from "./transcript";

// docs/CONTEXT_BUDGET_PLAN.md CB3 — opencode's own starting numbers (prompt.ts's PRUNE_PROTECT /
// PRUNE_MINIMUM): a starting point to tune against CB0's measurements once they exist, not
// gospel. PROTECTED_TOKEN_BUDGET is the newest N tokens of tool output that are never evicted
// regardless of turn structure; PROTECTED_TURNS is the number of most-recent user turns that are
// never touched regardless of size; MINIMUM_TOKENS_TO_FREE is the "don't bother" floor — an
// eviction pass that wouldn't free at least this much commits nothing, so decay doesn't spend a
// step nibbling single small entries for no measurable effect.
const PROTECTED_TOKEN_BUDGET = 40_000;
const PROTECTED_TURNS = 2;
const MINIMUM_TOKENS_TO_FREE = 20_000;
const CHARS_PER_TOKEN = 4;

// CB3 — decay never touches these regardless of age or size: a stale todo list or clarify
// question is either still the live state or a dead end, never "history worth pruning."
const NEVER_DECAY_TOOLS = new Set(["todo", "clarify"]);

// CB3 — grep/glob/bash don't have a single stable identity like a file path; an exact repeat of
// the same call is the strongest signal available that the earlier result is dead weight.
const SUPERSEDE_ON_EXACT_REPEAT_TOOLS = new Set(["grep", "glob", "bash"]);

function isBrowserSnapshotCall(name: string, input: unknown): boolean {
  return name === "browser" && typeof input === "object" && input !== null && (input as { op?: unknown }).op === "snapshot";
}

// Both decay's own two passes (below) and any earlier pass (this step or a prior one, before a
// restart persisted it) mark content with one of these prefixes — the single source of truth for
// "already decayed," so a second pass over the same entry is a no-op instead of double-counting.
function isAlreadyDecayed(content: string): boolean {
  return content.startsWith("[Superseded") || content.startsWith("[Decayed:");
}

export interface CompactOptions {
  chatId: string;
  transcript: Transcript;
  providerRow: ProviderRow;
  model: string;
  apiKey?: string;
  signal: AbortSignal;
  unverifiedWrites?: ReadonlySet<string>;
  /**
   * CB4 testability seam — omit to resolve the `summarize` role normally (production default);
   * pass `null` to force the chat-model fallback deterministically (no live role lookup against
   * the shared DB), or a specific target to pin it. Never read in production code, only by tests.
   */
  summarizeTarget?: SummarizeTarget | null;
  /** Opt-in gate for decay's pass 2 (age/budget eviction) — see `decayTranscript`'s doc comment. */
  pruneOldToolOutputs?: boolean;
}

export interface CompactResult {
  summary: string;
  tokensSaved: number;
}

const COMPACTION_SYSTEM_PROMPT =
  "You are an AI assistant performing conversation compaction for a coding agent.\n" +
  "Summarize the preceding conversation history into a concise, structured JSON object with the following schema:\n" +
  "{\n" +
  '  "summary": "Concise summary of user request, goals, and work accomplished so far",\n' +
  '  "filesModified": ["list", "of", "files", "written", "or", "modified"],\n' +
  '  "keyDecisions": ["list", "of", "architectural", "or", "implementation", "decisions", "made"],\n' +
  '  "openQuestions": ["list", "of", "unresolved", "issues", "or", "pending", "items"]\n' +
  "}\n" +
  "Respond with ONLY the JSON object, with no preamble or explanation.";

export interface DecayResult {
  decayedCount: number;
  approxTokensSaved: number;
  /** CB3 — callIds newly decayed this pass; the caller (run.ts) persists these via
   * db/toolCalls.markToolCallDecayed so the decision survives a reload (CB2). */
  decayedCallIds: string[];
}

/**
 * C7/CB3 Decay: cheap, pure in-memory reductions on transcript entries. Two independent passes:
 *
 * 1. Supersession (correctness-driven, unconditional, no size floor) — the entry's content is
 *    provably stale, not just old: a superseded read/snapshot/repeat is *wrong* to act on, not
 *    merely space to reclaim. Covers `read` by path (unchanged), `browser` snapshot (every
 *    snapshot before the latest is superseded — refs are invalid by contract regardless of URL,
 *    the strongest case here), and `grep`/`glob`/`bash` repeated with byte-identical input.
 * 2. Age/budget eviction (space-driven, opencode's shape) — walk backwards from the most recent
 *    entry, protecting `PROTECTED_TOKEN_BUDGET` tokens of recent tool output outright and the
 *    last `PROTECTED_TURNS` user turns outright (both unconditional, independent protections);
 *    anything older than both is a candidate. Only commits if the whole pass would free at least
 *    `MINIMUM_TOKENS_TO_FREE` — otherwise decay sits this step out rather than evict one small
 *    entry for no measurable effect.
 *
 * `todo`/`clarify` output is exempt from both passes. docs/CONTEXT_BUDGET_PLAN.md CB3.
 *
 * Pass 2 only runs when `pruneOldToolOutputs` is true (default off — see `GeneralSettingsDTO`).
 * Mirrors opencode's own `compaction.prune`, which ships "default: false" for the identical
 * reason: it's a lossy trade that can evict output a long single-turn multi-file task still
 * needs, well before the model is anywhere near its real context limit. Pass 1 (supersession) is
 * correctness-driven and always runs regardless of this flag.
 */
export function decayTranscript(transcript: Transcript, opts?: { pruneOldToolOutputs?: boolean }): DecayResult {
  const entries = transcript.entries;
  let initialChars = 0;
  for (const e of entries) {
    if (e.kind === "tool") initialChars += e.content.length;
  }

  const decayedCallIds: string[] = [];

  // ---- Pass 1: supersession ----

  const readPathByCallId = new Map<string, string>();
  const repeatKeyByCallId = new Map<string, string>();
  const snapshotCallIds: string[] = [];

  for (const e of entries) {
    if (e.kind !== "assistant") continue;
    for (const call of e.calls) {
      if (call.name === "read" && typeof call.input === "object" && call.input !== null) {
        const input = call.input as { path?: string; filePath?: string; file?: string };
        const filePath = input.path ?? input.filePath ?? input.file;
        if (filePath) readPathByCallId.set(call.id, filePath);
      } else if (isBrowserSnapshotCall(call.name, call.input)) {
        snapshotCallIds.push(call.id);
      } else if (SUPERSEDE_ON_EXACT_REPEAT_TOOLS.has(call.name)) {
        repeatKeyByCallId.set(call.id, `${call.name}:${JSON.stringify(call.input)}`);
      }
    }
  }

  const lastReadCallIdForPath = new Map<string, string>();
  for (const [callId, path] of readPathByCallId) lastReadCallIdForPath.set(path, callId);
  const lastCallIdForRepeatKey = new Map<string, string>();
  for (const [callId, key] of repeatKeyByCallId) lastCallIdForRepeatKey.set(key, callId);
  const lastSnapshotCallId = snapshotCallIds[snapshotCallIds.length - 1];

  for (const e of entries) {
    if (e.kind !== "tool" || NEVER_DECAY_TOOLS.has(e.name) || isAlreadyDecayed(e.content)) continue;

    if (e.name === "read") {
      const path = readPathByCallId.get(e.callId);
      if (path && lastReadCallIdForPath.get(path) !== e.callId) {
        e.content = `[Superseded by a later read of ${path}]`;
        decayedCallIds.push(e.callId);
      }
      continue;
    }
    if (e.name === "browser" && snapshotCallIds.includes(e.callId)) {
      if (lastSnapshotCallId && e.callId !== lastSnapshotCallId) {
        e.content = `[Superseded by a later browser snapshot — these refs are no longer valid]`;
        decayedCallIds.push(e.callId);
      }
      continue;
    }
    if (SUPERSEDE_ON_EXACT_REPEAT_TOOLS.has(e.name)) {
      const key = repeatKeyByCallId.get(e.callId);
      if (key && lastCallIdForRepeatKey.get(key) !== e.callId) {
        e.content = `[Superseded by an identical later ${e.name} call]`;
        decayedCallIds.push(e.callId);
      }
    }
  }

  // ---- Pass 2: age/budget eviction (opt-in — see doc comment above) ----

  if (!opts?.pruneOldToolOutputs) {
    let finalCharsNoPass2 = 0;
    for (const e of entries) {
      if (e.kind === "tool") finalCharsNoPass2 += e.content.length;
    }
    const approxTokensSavedNoPass2 = Math.max(0, Math.ceil((initialChars - finalCharsNoPass2) / CHARS_PER_TOKEN));
    return { decayedCount: decayedCallIds.length, approxTokensSaved: approxTokensSavedNoPass2, decayedCallIds };
  }

  const turnStartIndices: number[] = [];
  entries.forEach((e, i) => {
    if (e.kind === "user") turnStartIndices.push(i);
  });
  const protectedFromIndex =
    turnStartIndices.length > PROTECTED_TURNS ? turnStartIndices[turnStartIndices.length - PROTECTED_TURNS] : 0;

  let runningBudgetChars = 0;
  const evictionCandidates: Extract<TranscriptEntry, { kind: "tool" }>[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind !== "tool" || NEVER_DECAY_TOOLS.has(e.name) || isAlreadyDecayed(e.content)) continue;

    if (runningBudgetChars < PROTECTED_TOKEN_BUDGET * CHARS_PER_TOKEN) {
      runningBudgetChars += e.content.length;
      continue; // protected: inside the recent-output token budget
    }
    if (i >= protectedFromIndex) continue; // protected: inside the last two turns regardless of budget

    if (e.content.length > 1000) evictionCandidates.push(e);
  }

  const wouldFreeChars = evictionCandidates.reduce((sum, e) => sum + e.content.length, 0);
  if (wouldFreeChars / CHARS_PER_TOKEN >= MINIMUM_TOKENS_TO_FREE) {
    for (const e of evictionCandidates) {
      e.content = decayedPlaceholder(e.name, e.summary);
      decayedCallIds.push(e.callId);
    }
  }

  let finalChars = 0;
  for (const e of entries) {
    if (e.kind === "tool") finalChars += e.content.length;
  }

  const approxTokensSaved = Math.max(0, Math.ceil((initialChars - finalChars) / CHARS_PER_TOKEN));
  return { decayedCount: decayedCallIds.length, approxTokensSaved, decayedCallIds };
}

// docs/CONTEXT_BUDGET_PLAN.md CB4 — opencode's own tail_start_id number: a starting point to tune
// against CB0's measurements once they exist, not gospel (same caveat as CB3's
// PROTECTED_TOKEN_BUDGET). Replaces the old "everything but the last 2 entries" cut, which fired
// rarely and then erased almost everything the one time it did — a token budget keeps however
// many recent entries actually fit, which for most turns is far more than 2.
const RAW_TAIL_TOKEN_BUDGET = 40_000;

function estimateEntryChars(e: TranscriptEntry): number {
  switch (e.kind) {
    case "user":
      return e.text.length;
    case "assistant":
      return e.text.length + e.calls.reduce((sum, c) => sum + JSON.stringify(c.input ?? {}).length, 0);
    case "tool":
      return e.content.length;
    case "summary":
      return JSON.stringify(e.fields).length;
    case "injected":
      return e.text.length;
  }
}

/**
 * Walks backward from the end of the transcript, keeping entries in the preserved raw tail until
 * doing so would cross `RAW_TAIL_TOKEN_BUDGET` — always keeping at least one entry regardless of
 * its own size, so a single oversized entry can't push the tail to zero. That token-budget cut
 * point can still land between an assistant's `tool_calls` and its `tool` results, leaving a
 * `tool` entry in the preserved tail with no calling assistant ahead of it — every provider's
 * tool_use/tool_result matching rejects that. Walk the cut back to the assistant entry that owns
 * the run of tool results straddling it, so the whole group moves together (either fully covered
 * by the summary, or fully preserved). Returns 0 when even that isn't safe (a transcript that is
 * entirely one tool-result run, or small enough that nothing crosses the budget) — callers must
 * treat that as "nothing can be compacted right now", not as "cover nothing".
 * docs/LOOP_MENDING_PLAN.md D2/MD2 — transcript.ts's assertNoOrphanToolMessages is the actual
 * safeguard (asserted by a property test over randomised transcripts); this is what it polices.
 */
export function computeSafeCutIndex(entries: readonly TranscriptEntry[]): number {
  let tailChars = 0;
  let cutIndex = entries.length;
  while (cutIndex > 0) {
    const entryChars = estimateEntryChars(entries[cutIndex - 1]);
    if (tailChars > 0 && tailChars + entryChars > RAW_TAIL_TOKEN_BUDGET * CHARS_PER_TOKEN) break;
    tailChars += entryChars;
    cutIndex--;
  }
  while (cutIndex > 0 && entries[cutIndex]?.kind === "tool") {
    cutIndex--;
  }
  return cutIndex;
}

/**
 * C8 Structured Compaction:
 * Replaces older transcript entries with a single structured summary entry.
 */
export async function compactTranscript(opts: CompactOptions): Promise<CompactResult> {
  const { chatId, transcript, providerRow, model, apiKey, signal, unverifiedWrites } = opts;

  // CB4 — compaction is a blocking mid-run call; resolve the `summarize` role so it runs on a
  // small fast model instead of the chat's own frontier one. An unset or unreachable role falls
  // back to the chat's own provider/model/key exactly as passed in — a compaction that throws
  // takes the whole run down with it, which is strictly worse than a slightly expensive summary.
  let summarizeProviderRow = providerRow;
  let summarizeModel = model;
  let summarizeApiKey = apiKey;
  const summarizeTarget = opts.summarizeTarget !== undefined ? opts.summarizeTarget : getSummarizeTarget();
  if (summarizeTarget) {
    const row = getProvider(summarizeTarget.providerId);
    const key = getSecret(summarizeTarget.providerId);
    if (row && (key || !providerRequiresKey(summarizeTarget.providerId))) {
      summarizeProviderRow = row;
      summarizeModel = summarizeTarget.model;
      summarizeApiKey = key;
    }
  }

  // 1. Run cheap decay first (C7)
  const decayRes = decayTranscript(transcript, { pruneOldToolOutputs: opts.pruneOldToolOutputs });

  // If there are fewer than 3 entries, compaction has little to summarize
  if (transcript.entries.length < 3) {
    return {
      summary: "Transcript decayed; minimal entries present.",
      tokensSaved: decayRes.approxTokensSaved,
    };
  }

  const cutIndex = computeSafeCutIndex(transcript.entries);
  if (cutIndex < 1) {
    // No boundary is safe to cut on right now (e.g. the whole transcript is one tool-result
    // run) — decay already ran above; structured compaction just sits this one out.
    return {
      summary: "Transcript decayed; no safe boundary to structurally compact yet.",
      tokensSaved: decayRes.approxTokensSaved,
    };
  }
  const coveredEntries = transcript.entries.slice(0, cutIndex);

  // Format text representation for summarization model
  const formattedText = coveredEntries
    .map((e) => {
      if (e.kind === "user") return `User: ${e.text}`;
      if (e.kind === "assistant") {
        const tools = e.calls?.map((c) => c.name).join(", ");
        return `Assistant: ${e.text}${tools ? ` [Tools called: ${tools}]` : ""}`;
      }
      if (e.kind === "tool") return `Tool (${e.name}): ${e.content.slice(0, 400)}`;
      if (e.kind === "summary") return `Previous Summary: ${e.fields.summary}`;
      if (e.kind === "injected") return `Injected (${e.role}): ${e.text.slice(0, 200)}`;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");

  const initialTokens = Math.ceil(formattedText.length / 4);

  let fields: CompactionFields;
  try {
    const summaryResponse = await complete(
      summarizeProviderRow,
      summarizeModel,
      summarizeApiKey,
      [
        { role: "system", content: COMPACTION_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Please summarize this conversation history into structured JSON:\n\n${formattedText}`,
        },
      ],
      signal,
      { maxOutputTokens: 1024, temperature: 0.2 }
    );

    const jsonMatch = summaryResponse.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      fields = JSON.parse(jsonMatch[0]) as CompactionFields;
    } else {
      fields = { summary: summaryResponse.text.trim() };
    }

    // CB4 — compaction is background/administrative work, not part of the turn's own output;
    // billed against utility_cost_usd (P2's column, added for exactly this) so it never inflates
    // the chat's headline cost_usd line, regardless of whether the summarize role resolved or
    // this fell back to the chat's own model.
    const { usd } = estimateCostUsdDetailed(
      summarizeProviderRow.id,
      summarizeModel,
      {
        noCacheTokens: summaryResponse.usage.noCacheTokens,
        cacheReadTokens: summaryResponse.usage.cacheReadTokens,
        cacheWriteTokens: summaryResponse.usage.cacheWriteTokens,
      },
      summaryResponse.usage.outputTokens
    );
    recordUtilityUsage(chatId, usd);
  } catch {
    // Fallback heuristic if complete() throws or fails
    fields = {
      summary: `Conversation summarized: ${coveredEntries.length} previous steps compacted.`,
      filesModified: unverifiedWrites ? Array.from(unverifiedWrites) : undefined,
    };
  }

  const summaryEntry: TranscriptEntry = {
    kind: "summary",
    id: newId(),
    covers: coveredEntries
      .map((e) => (e.kind === "tool" ? e.callId : "id" in e ? e.id : ""))
      .filter(Boolean),
    fields,
  };

  // CB4 — persist the verdict (D2) so the next turn's buildTranscriptFromDb honours it too,
  // instead of compaction being work this run alone remembers. boundarySeq is the highest real
  // `messages.seq` now covered — a "tool" entry has no row of its own in `messages` (it belongs to
  // the assistant message that made the call), so only "user"/"assistant" covered entries count.
  const seqById = new Map(listMessages(chatId).map((m) => [m.id, m.seq]));
  let boundarySeq: number | null = null;
  for (const e of coveredEntries) {
    if (e.kind !== "user" && e.kind !== "assistant") continue;
    const seq = seqById.get(e.id);
    if (seq != null) boundarySeq = boundarySeq == null ? seq : Math.max(boundarySeq, seq);
  }
  if (boundarySeq != null) {
    createCompaction({ chatId, boundarySeq, fields, coveredIds: summaryEntry.covers });
  }

  // Replace covered entries with the summary entry
  transcript.entries.splice(0, cutIndex, summaryEntry);

  const finalTokens = Math.ceil(JSON.stringify(fields).length / 4);
  const tokensSaved = Math.max(0, initialTokens - finalTokens) + decayRes.approxTokensSaved;

  return {
    summary: fields.summary,
    tokensSaved,
  };
}
