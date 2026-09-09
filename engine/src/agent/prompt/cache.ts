import type { ModelMessage } from "ai";
import type { CachePolicy } from "../catalog";

const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" as const };

// docs/PROMPT_STACK_PLAN.md §4.2 PS1 — the conversation-tail breakpoint. Verified against
// @ai-sdk/anthropic@4.0.12's convertToAnthropicPrompt: a user message's LAST content part
// inherits cache_control from the *message's* providerOptions when no part carries its own
// override, so marking the whole message (not each part) is enough — Anthropic's own SDK does
// the per-part plumbing. Only the last message in the array gets marked; every message before it
// is already covered by whatever breakpoint came before, and marking more than one moving target
// would just waste one of the four breakpoints Anthropic allows per request.
export function markCacheBoundary(messages: ModelMessage[], policy: CachePolicy): ModelMessage[] {
  if (policy.style !== "explicit" || messages.length === 0) return messages;

  const last = messages[messages.length - 1];
  const existingAnthropic = (last.providerOptions?.anthropic ?? {}) as Record<string, unknown>;
  const marked: ModelMessage = {
    ...last,
    providerOptions: {
      ...last.providerOptions,
      anthropic: { ...existingAnthropic, cacheControl: EPHEMERAL_CACHE_CONTROL },
    },
  } as ModelMessage;

  return [...messages.slice(0, -1), marked];
}
