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

import { newId } from "../../db/ids";
import type { ProviderRow } from "../../db/providers";
import { complete } from "../../llm/complete";
import type { CompactionFields, Transcript, TranscriptEntry } from "./transcript";

export interface CompactOptions {
  chatId: string;
  transcript: Transcript;
  providerRow: ProviderRow;
  model: string;
  apiKey?: string;
  signal: AbortSignal;
  unverifiedWrites?: ReadonlySet<string>;
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

/**
 * C7 Decay: Cheap, pure in-memory reductions on transcript entries.
 * - Superseded read results drop when the same file was read later in the transcript.
 * - Stale/large tool results from older turns are truncated.
 */
export function decayTranscript(transcript: Transcript): { decayedCount: number; approxTokensSaved: number } {
  let initialChars = 0;
  for (const e of transcript.entries) {
    if (e.kind === "tool") initialChars += e.content.length;
  }

  // 1. Track read calls to identify superseded reads
  // Map callId -> file path
  const readPathByCallId = new Map<string, string>();
  for (const e of transcript.entries) {
    if (e.kind === "assistant" && e.calls) {
      for (const call of e.calls) {
        if (call.name === "read" && typeof call.input === "object" && call.input !== null) {
          const input = call.input as { path?: string; filePath?: string; file?: string };
          const filePath = input.path ?? input.filePath ?? input.file;
          if (filePath) readPathByCallId.set(call.id, filePath);
        }
      }
    }
  }

  // Find the last callId for each file path
  const lastCallIdForPath = new Map<string, string>();
  for (const [callId, path] of readPathByCallId.entries()) {
    lastCallIdForPath.set(path, callId);
  }

  let decayedCount = 0;
  const entriesCount = transcript.entries.length;

  for (let i = 0; i < entriesCount; i++) {
    const entry = transcript.entries[i];
    if (entry.kind !== "tool") continue;

    // Check if this tool entry is a superseded read
    const filePath = readPathByCallId.get(entry.callId);
    if (filePath && lastCallIdForPath.get(filePath) !== entry.callId) {
      if (!entry.content.startsWith("[Superseded")) {
        entry.content = `[Superseded by later read of ${filePath}]`;
        decayedCount++;
        continue;
      }
    }

    // Shrink older large tool results (older than the last 4 entries)
    if (i < entriesCount - 4 && entry.content.length > 1000) {
      entry.content = entry.content.slice(0, 500) + "\n...[output decayed]...";
      decayedCount++;
    }
  }

  let finalChars = 0;
  for (const e of transcript.entries) {
    if (e.kind === "tool") finalChars += e.content.length;
  }

  const approxTokensSaved = Math.max(0, Math.ceil((initialChars - finalChars) / 4));
  return { decayedCount, approxTokensSaved };
}

/**
 * The naive cut point ("everything except the last 2 entries") can land between an assistant's
 * `tool_calls` and its `tool` results, leaving a `tool` entry in the preserved tail with no
 * calling assistant ahead of it — every provider's tool_use/tool_result matching rejects that.
 * Walk the cut back to the assistant entry that owns the run of tool results straddling it, so
 * the whole group moves together (either fully covered by the summary, or fully preserved).
 * Returns 0 when even that isn't safe (a transcript that is entirely one tool-result run) —
 * callers must treat that as "nothing can be compacted right now", not as "cover nothing".
 * docs/LOOP_MENDING_PLAN.md D2/MD2 — transcript.ts's assertNoOrphanToolMessages is the actual
 * safeguard (asserted by a property test over randomised transcripts); this is what it polices.
 */
export function computeSafeCutIndex(entries: readonly TranscriptEntry[]): number {
  let cutIndex = Math.max(1, entries.length - 2);
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
  const { transcript, providerRow, model, apiKey, signal, unverifiedWrites } = opts;

  // 1. Run cheap decay first (C7)
  const decayRes = decayTranscript(transcript);

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
      providerRow,
      model,
      apiKey,
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

  // Replace covered entries with the summary entry
  transcript.entries.splice(0, cutIndex, summaryEntry);

  const finalTokens = Math.ceil(JSON.stringify(fields).length / 4);
  const tokensSaved = Math.max(0, initialTokens - finalTokens) + decayRes.approxTokensSaved;

  return {
    summary: fields.summary,
    tokensSaved,
  };
}
