// engine/src/llm/complete.ts
//
// One-shot non-streaming helper — collapses the four `generateText` callers
// (titling.ts, complexity.ts, instructionsInit.ts, curator/curator.ts) into
// a single function with a single copy of model resolution.
// docs/LOOP_MIGRATION_PLAN.md §4.2, Decision 8.

import type { ProviderRow } from "../db/providers";
import { resolveClient } from "./client";
import type { LlmUsage, WireMessage } from "./types";
import { LlmError } from "./types";

export interface CompleteOptions {
  /** Optional system prompt, prepended to messages. */
  system?: string;
  /** Max output tokens. Defaults to 1024 for utility callers. */
  maxOutputTokens?: number;
  /** Temperature. Defaults to provider default (undefined = omitted from request). */
  temperature?: number;
}

export interface CompleteResult {
  text: string;
  usage: LlmUsage;
}

/**
 * Send a single non-streaming request and return the full text response and usage.
 *
 * Used by utility callers (titling, complexity, instructionsInit, curator) that
 * need a complete text response, not a stream. Internally uses the streaming transport
 * and accumulates all text.delta events — the transport is streaming-only by design.
 *
 * Throws LlmError on failure. The caller is responsible for any retry policy
 * (the transport never retries — docs/LOOP_MIGRATION_PLAN.md Rule 2).
 */
export async function complete(
  providerRow: ProviderRow,
  model: string,
  apiKey: string | undefined,
  messages: WireMessage[],
  signal: AbortSignal,
  opts: CompleteOptions = {}
): Promise<CompleteResult> {
  const client = resolveClient(providerRow, model, apiKey);
  const { maxOutputTokens = 1024, temperature, system } = opts;

  const wireMessages: WireMessage[] = system
    ? [{ role: "system", content: system }, ...messages]
    : messages;

  const chunks: string[] = [];
  let usage: LlmUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    noCacheTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  try {
    for await (const event of client.stream({
      model,
      messages: wireMessages,
      maxOutputTokens,
      temperature,
      signal,
    })) {
      if (event.type === "text.delta") {
        chunks.push(event.text);
      } else if (event.type === "usage") {
        usage = event.usage;
      }
      // Ignore: finish, tool_call — utility callers never use tools
    }
  } catch (err) {
    if (LlmError.isInstance(err)) throw err;
    throw new LlmError(err instanceof Error ? err.message : String(err), "transient", {
      cause: err,
    });
  }

  return { text: chunks.join(""), usage };
}
