// docs/PROVIDERS_PLAN.md Phase P2 — auto-titling stage 2: after the first assistant run
// completes, ask the utility model for a real title. Every guard here is deliberate: a title is
// not worth a retry, a hang, or a user-visible error — the stage-1 stub (chats.ts) always stands
// if this fails for any reason at all.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel } from "ai";
import { recordUtilityUsage, updateChat } from "../db/chats";
import { getProvider, type ProviderRow } from "../db/providers";
import { getSecret } from "../secrets";
import { broadcast } from "../ws";
import { estimateCostUsd } from "./config";
import { getUtilityTarget } from "./utility";

const TITLE_TIMEOUT_MS = 5000;
const TITLE_SYSTEM_PROMPT =
  "Reply with only a short chat title (3-6 words, no quotes, no trailing punctuation) that summarizes the " +
  "user's message below. Nothing else — no preamble, no explanation.";

function resolveTitleModel(providerRow: ProviderRow, model: string, apiKey: string | undefined): LanguageModel {
  if (providerRow.kind === "anthropic") return createAnthropic({ apiKey })(model);
  return createOpenAICompatible({ name: providerRow.id, baseURL: providerRow.base_url ?? "", apiKey: apiKey ?? "unused" })(model);
}

// Fails completely silent by design: no toast, no error event, no blocked send — this must never
// be visible as anything other than "the title changed" or "the title stayed the stub".
export async function maybeTitleChat(chatId: string, firstUserMessage: string): Promise<void> {
  const target = getUtilityTarget();
  if (!target) return;

  const providerRow = getProvider(target.providerId);
  const apiKey = getSecret(target.providerId);
  if (!providerRow || (!apiKey && target.providerId !== "ollama")) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
  try {
    const result = await generateText({
      model: resolveTitleModel(providerRow, target.model, apiKey),
      system: TITLE_SYSTEM_PROMPT,
      prompt: firstUserMessage.slice(0, 4000),
      maxOutputTokens: 24,
      temperature: 0.2,
      abortSignal: controller.signal,
    });

    const title = result.text.trim().replace(/^["'“]+|["'”]+$/g, "");
    if (title) {
      const updated = updateChat(chatId, { title });
      if (updated) broadcast(chatId, { type: "chat.renamed", chatId, title });
    }

    const usage = await result.usage;
    const { usd } = estimateCostUsd(target.providerId, target.model, usage.inputTokens ?? 0, usage.outputTokens ?? 0);
    recordUtilityUsage(chatId, usd);
  } catch {
    // Stage-1 stub stands. No retry, no surfaced error.
  } finally {
    clearTimeout(timeout);
  }
}
