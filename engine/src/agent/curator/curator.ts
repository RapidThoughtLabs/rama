// docs/PROMPT_STACK_PLAN.md §7.2, Phase PS7 — "The model's job is to phrase a proposal from
// those signals, not to introspect. It runs on the utility role — background, cheap, guarded,
// fails silent." Mirrors titling.ts/complexity.ts's exact shape (same resolveModel duplication,
// same timeout-and-swallow guard) with one addition: the model is only trusted to fill in
// `content` for ids the harness itself generated — it can add wording, never a new proposal, a
// new section, or its own provenance. Removal proposals (verify.ts's stale-entry check) need no
// model at all, since they're just "this exact existing line no longer checks out."
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel } from "ai";
import { recordUtilityUsage } from "../../db/chats";
import { createProposal, listDedupeKeys, type ProposalEvidence } from "../../db/curationProposals";
import { listMessagesForProject } from "../../db/messages";
import { getProvider, type ProviderRow } from "../../db/providers";
import { listToolCallsForProject } from "../../db/toolCalls";
import { getSecret } from "../../secrets";
import { estimateCostUsd } from "../config";
import { getUtilityTarget } from "../utility";
import { gatherEvidence, type EvidenceItem } from "./evidence";
import { findStaleEntries } from "./verify";

const CURATOR_TIMEOUT_MS = 8000;
const MAX_EVIDENCE_PER_RUN = 8;
const MAX_CONTENT_CHARS = 160;

const PHRASING_SYSTEM_PROMPT =
  "Each item below is an observed fact about a codebase, with an id. For each, write ONE crisp " +
  "markdown bullet line (no leading '-', under 160 characters, factual, no fluff, no first person) " +
  "suitable for a project's own README-style notes file. Reply with ONLY a JSON array like " +
  '[{"id":"commands:0","content":"..."}]. One entry per input id, same ids, nothing invented.';

function resolveModel(providerRow: ProviderRow, model: string, apiKey: string | undefined): LanguageModel {
  if (providerRow.kind === "anthropic") return createAnthropic({ apiKey })(model);
  return createOpenAICompatible({ name: providerRow.id, baseURL: providerRow.base_url ?? "", apiKey: apiKey ?? "unused" })(model);
}

function parsePhrased(text: string): Map<string, string> {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const parsed: unknown = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) return new Map();
  const out = new Map<string, string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    const content = (entry as { content?: unknown }).content;
    if (typeof id === "string" && typeof content === "string" && content.trim()) {
      out.set(id, content.trim().replace(/\s+/g, " ").slice(0, MAX_CONTENT_CHARS));
    }
  }
  return out;
}

async function phraseEvidence(chatId: string | null, items: EvidenceItem[]): Promise<Map<string, string>> {
  const target = getUtilityTarget();
  if (!target) return new Map();

  const providerRow = getProvider(target.providerId);
  const apiKey = getSecret(target.providerId);
  if (!providerRow || (!apiKey && target.providerId !== "ollama")) return new Map();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CURATOR_TIMEOUT_MS);
  try {
    const result = await generateText({
      model: resolveModel(providerRow, target.model, apiKey),
      system: PHRASING_SYSTEM_PROMPT,
      prompt: JSON.stringify(items.map((i) => ({ id: i.id, signal: i.signal, raw: i.raw }))),
      maxOutputTokens: 80 * items.length,
      temperature: 0.2,
      abortSignal: controller.signal,
    });

    const usage = await result.usage;
    if (chatId) {
      const { usd } = estimateCostUsd(target.providerId, target.model, usage.inputTokens ?? 0, usage.outputTokens ?? 0);
      recordUtilityUsage(chatId, usd);
    }

    return parsePhrased(result.text);
  } catch {
    return new Map();
  } finally {
    clearTimeout(timeout);
  }
}

// The public entry point — fire-and-forget from loop.ts after a run completes, same call shape as
// maybeTitleChat, plus a `chatId: null` path for server.ts's manual "check for suggestions"
// trigger, which has no chat to bill the utility call's cost against. Never throws, never blocks
// the caller on anything but its own bounded work.
export async function runCurator(chatId: string | null, projectId: string, projectPath: string): Promise<void> {
  try {
    for (const stale of findStaleEntries(projectPath)) {
      const evidence: ProposalEvidence = { why: "referenced script or path no longer exists." };
      createProposal({
        projectId,
        kind: "remove",
        section: stale.section,
        content: stale.line,
        signal: "stale",
        evidence,
        dedupeKey: `remove:${stale.section}:${stale.line}`,
      });
    }

    const known = listDedupeKeys(projectId);
    const rows = listToolCallsForProject(projectId);
    const messages = listMessagesForProject(projectId);
    const fresh = gatherEvidence(rows, messages, projectPath)
      .filter((item) => !known.has(item.dedupeKey))
      .slice(0, MAX_EVIDENCE_PER_RUN);
    if (fresh.length === 0) return;

    const phrased = await phraseEvidence(chatId, fresh);
    for (const item of fresh) {
      const content = phrased.get(item.id);
      if (!content) continue;
      createProposal({
        projectId,
        kind: "add",
        section: item.section,
        content,
        signal: item.signal,
        evidence: item.evidence,
        dedupeKey: item.dedupeKey,
      });
    }
  } catch {
    // Best-effort background job — a broken query or a malformed model reply should never
    // surface anywhere the user can see, same rule as maybeTitleChat.
  }
}
