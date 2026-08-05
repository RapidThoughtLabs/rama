// Default provider/model for new chats, plus the model registry: capability flags (tools?
// thinking?) and $/million-token pricing, keyed by provider then model id. Phase 4
// (docs/IMPLEMENTATION_PLAN.md) generalized this from a single Together-only table so
// loop.ts and the /providers endpoint can both read model metadata from one place.

import type { ModelInfo } from "@rama/protocol";

export const DEFAULT_PROVIDER_ID = "together";
export const DEFAULT_MODEL = "meta-llama/Llama-3.3-70B-Instruct-Turbo";

export const SYSTEM_PROMPT =
  "You are Rama, a coding assistant running in a desktop terminal-chat app, working in a real " +
  "project directory on disk. You have six tools, all scoped to that project directory: " +
  "read, write, edit (exact string replace), grep, ls, and bash. Use them whenever a task needs " +
  "real file or shell access instead of guessing. Depending on the chat's mode, a write/edit/bash " +
  "call may come back blocked (read-only mode) or denied (the user was asked and said no) — " +
  "treat that as real information and adapt, don't just retry the same call.";

interface ModelSpec extends ModelInfo {
  inputPerMillion: number;
  outputPerMillion: number;
}

// Approximate pricing — several of these providers don't report a dollar cost directly, so
// cost.update is estimated from this table. Adjust as needed; it's a display nicety, not
// billing. Context windows and tool/thinking support are likewise best-effort, used to drive
// the model picker UI rather than to gate requests.
export const MODEL_REGISTRY: Record<string, ModelSpec[]> = {
  together: [
    {
      id: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      label: "Llama 3.3 70B Turbo",
      supportsTools: true,
      supportsThinking: false,
      contextWindow: 128_000,
      inputPerMillion: 0.88,
      outputPerMillion: 0.88,
    },
    {
      id: "deepseek-ai/DeepSeek-V3",
      label: "DeepSeek V3",
      supportsTools: true,
      supportsThinking: false,
      contextWindow: 128_000,
      inputPerMillion: 1.25,
      outputPerMillion: 1.25,
    },
    {
      id: "Qwen/Qwen2.5-72B-Instruct-Turbo",
      label: "Qwen 2.5 72B Turbo",
      supportsTools: true,
      supportsThinking: false,
      contextWindow: 32_000,
      inputPerMillion: 1.2,
      outputPerMillion: 1.2,
    },
  ],
  openai: [
    {
      id: "gpt-4.1",
      label: "GPT-4.1",
      supportsTools: true,
      supportsThinking: false,
      contextWindow: 1_000_000,
      inputPerMillion: 2,
      outputPerMillion: 8,
    },
    {
      id: "gpt-4.1-mini",
      label: "GPT-4.1 mini",
      supportsTools: true,
      supportsThinking: false,
      contextWindow: 1_000_000,
      inputPerMillion: 0.4,
      outputPerMillion: 1.6,
    },
    {
      id: "o4-mini",
      label: "o4-mini",
      supportsTools: true,
      supportsThinking: true,
      contextWindow: 200_000,
      inputPerMillion: 1.1,
      outputPerMillion: 4.4,
    },
  ],
  anthropic: [
    {
      id: "claude-sonnet-5",
      label: "Claude Sonnet 5",
      supportsTools: true,
      supportsThinking: true,
      contextWindow: 200_000,
      inputPerMillion: 3,
      outputPerMillion: 15,
    },
    {
      id: "claude-opus-4-8",
      label: "Claude Opus 4.8",
      supportsTools: true,
      supportsThinking: true,
      contextWindow: 200_000,
      inputPerMillion: 15,
      outputPerMillion: 75,
    },
    {
      id: "claude-haiku-4-5-20251001",
      label: "Claude Haiku 4.5",
      supportsTools: true,
      supportsThinking: true,
      contextWindow: 200_000,
      inputPerMillion: 0.8,
      outputPerMillion: 4,
    },
  ],
  groq: [
    {
      id: "llama-3.3-70b-versatile",
      label: "Llama 3.3 70B (Groq)",
      supportsTools: true,
      supportsThinking: false,
      contextWindow: 128_000,
      inputPerMillion: 0.59,
      outputPerMillion: 0.79,
    },
  ],
  openrouter: [
    {
      id: "meta-llama/llama-3.3-70b-instruct",
      label: "Llama 3.3 70B (OpenRouter)",
      supportsTools: true,
      supportsThinking: false,
      contextWindow: 128_000,
      inputPerMillion: 0.6,
      outputPerMillion: 0.6,
    },
  ],
  ollama: [
    {
      id: "llama3.3",
      label: "Llama 3.3 (local)",
      supportsTools: true,
      supportsThinking: false,
      contextWindow: 128_000,
      inputPerMillion: 0,
      outputPerMillion: 0,
    },
  ],
};

export function getModelsForProvider(providerId: string): ModelInfo[] {
  return (MODEL_REGISTRY[providerId] ?? []).map(({ inputPerMillion, outputPerMillion, ...m }) => m);
}

export function estimateCostUsd(providerId: string, model: string, inputTokens: number, outputTokens: number): number {
  const spec =
    MODEL_REGISTRY[providerId]?.find((m) => m.id === model) ?? MODEL_REGISTRY[DEFAULT_PROVIDER_ID][0];
  return (inputTokens / 1_000_000) * spec.inputPerMillion + (outputTokens / 1_000_000) * spec.outputPerMillion;
}
