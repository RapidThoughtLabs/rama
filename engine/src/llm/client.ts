// engine/src/llm/client.ts
//
// resolveClient() — the single place that translates a ProviderRow + model + API key
// into a ready-to-use LlmClient. Absorbs all five copies of `resolveModel` that
// existed across loop.ts, titling.ts, complexity.ts, instructionsInit.ts and curator/curator.ts.
// docs/LOOP_MIGRATION_PLAN.md §4.2, Decision 8.

import type { ProviderRow } from "../db/providers";
import type { LlmClient } from "./types";
import { OpenAIStreamClient } from "./openai/stream";
import { AnthropicStreamClient } from "./anthropic/stream";

/**
 * Resolve a chat's provider row + API key into a ready-to-use LlmClient.
 *
 * Handles:
 * - OpenAI-compatible providers (Together, OpenAI, Groq, OpenRouter, Ollama) → OpenAIStreamClient
 * - Anthropic Messages API providers → AnthropicStreamClient (LM7)
 * - auth_style === "header": key goes in a named header, NOT Authorization: Bearer
 * - extra_headers_json: arbitrary extra headers from the provider row
 * - Ollama / keyless providers: omit the Authorization header entirely
 */
export function resolveClient(
  providerRow: ProviderRow,
  _model: string,
  apiKey: string | undefined
): LlmClient {
  // Parse extra headers from the provider row (stored as a JSON string)
  let extraHeaders: Record<string, string> = {};
  try {
    extraHeaders = JSON.parse(providerRow.extra_headers_json || "{}") as Record<string, string>;
  } catch {
    extraHeaders = {};
  }

  // Header-auth providers (e.g. custom enterprise endpoints) carry the key in a named
  // request header; the standard Authorization: Bearer must NOT also be sent.
  // docs/PROVIDERS_PLAN.md Phase P5
  const useHeaderAuth = providerRow.auth_style === "header" && !!providerRow.auth_header;
  const mergedHeaders: Record<string, string> = { ...extraHeaders };
  if (useHeaderAuth && providerRow.auth_header && apiKey) {
    mergedHeaders[providerRow.auth_header] = apiKey;
  }

  if (providerRow.kind === "anthropic") {
    return new AnthropicStreamClient({
      baseUrl: providerRow.base_url ?? undefined,
      apiKey,
      headers: Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined,
    });
  }

  const clientApiKey = useHeaderAuth ? undefined : apiKey;

  return new OpenAIStreamClient({
    baseUrl: providerRow.base_url ?? "",
    apiKey: clientApiKey,
    headers: Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined,
  });
}
