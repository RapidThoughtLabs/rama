// engine/src/llm/index.ts
// Public API of the llm transport layer.
// docs/LOOP_MIGRATION_PLAN.md §4.2

export type {
  LlmRequest,
  LlmEvent,
  LlmClient,
  LlmUsage,
  LlmErrorKind,
  WireMessage,
  WireTool,
  WireFinishReason,
  ContentPart,
} from "./types";
export { LlmError } from "./types";

export { resolveClient } from "./client";
export { complete } from "./complete";
export type { CompleteOptions, CompleteResult } from "./complete";

export { readSSE } from "./sse";

export { OpenAIStreamClient } from "./openai/stream";
export { encodeRequest } from "./openai/encode";
export { decodeFrame, ToolCallAccumulator } from "./openai/decode";
