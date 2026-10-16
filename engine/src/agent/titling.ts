// docs/PROVIDERS_PLAN.md Phase P2 — auto-titling stage 2: after the first assistant run
// completes, ask the utility model for a real title. Every guard here is deliberate: a title is
// not worth a retry, a hang, or a user-visible error — the stage-1 stub (chats.ts) always stands
// if this fails for any reason at all.
import { complete } from "../llm/complete";
import { recordUtilityUsage, updateChat } from "../db/chats";
import { getProvider, providerRequiresKey } from "../db/providers";
import { getSecret } from "../secrets";
import { broadcast } from "../ws";
import { estimateCostUsd } from "./config";
import { getUtilityTarget } from "./utility";

const TITLE_TIMEOUT_MS = 5000;
const TITLE_SYSTEM_PROMPT =
  "Reply with only a short chat title (3-6 words, no quotes, no trailing punctuation) that summarizes the " +
  "user's message below. Nothing else — no preamble, no explanation.";

// Fails completely silent by design: no toast, no error event, no blocked send — this must never
// be visible as anything other than "the title changed" or "the title stayed the stub".
export async function maybeTitleChat(chatId: string, firstUserMessage: string): Promise<void> {
  const target = getUtilityTarget();
  if (!target) return;

  const providerRow = getProvider(target.providerId);
  const apiKey = getSecret(target.providerId);
  if (!providerRow || (!apiKey && providerRequiresKey(target.providerId))) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
  try {
    const result = await complete(
      providerRow,
      target.model,
      apiKey,
      [{ role: "user", content: firstUserMessage.slice(0, 4000) }],
      controller.signal,
      {
        system: TITLE_SYSTEM_PROMPT,
        maxOutputTokens: 24,
        temperature: 0.2,
      }
    );

    const title = result.text.trim().replace(/^["'“]+|["'”]+$/g, "");
    if (title) {
      const updated = updateChat(chatId, { title });
      if (updated) broadcast(chatId, { type: "chat.renamed", chatId, title });
    }

    const { usd } = estimateCostUsd(target.providerId, target.model, result.usage.inputTokens, result.usage.outputTokens);
    recordUtilityUsage(chatId, usd);
  } catch {
    // Stage-1 stub stands. No retry, no surfaced error.
  } finally {
    clearTimeout(timeout);
  }
}
