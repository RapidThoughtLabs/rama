// engine/src/llm/types.ts
//
// Rama's own transport types — provider-agnostic, no AI SDK dependency.
// docs/LOOP_MIGRATION_PLAN.md §4.1, §4.3, §4.4, §4.5

// ---------------------------------------------------------------------------
// Wire types — what actually goes on the network
// ---------------------------------------------------------------------------

export type WireFinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "unknown";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }; // reserved for supportsVision (LM7+)

/**
 * Rama's provider-agnostic message type. Wire encoders (openai/encode.ts, anthropic/encode.ts)
 * render this into whatever format the provider expects. The transport never edits messages —
 * they arrive pre-projected from project() and go out verbatim.
 *
 * docs/LOOP_MIGRATION_PLAN.md §4.3 — Decision 5: provider-specific markers are annotations on
 * Rama's own types, rendered by the encoder. The OpenAI encoder ignores every annotation field.
 */
export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  /**
   * Present on an assistant message that thought before answering. Kept separate from `content`
   * (the visible reply) rather than folded into it — an Anthropic thinking block's `thinking`
   * field and its `text` block are distinct wire parts, and conflating them was D6's second,
   * latent bug (the visible answer silently became the "thinking" and vanished from `content`).
   * The OpenAI encoder ignores this field, same as it ignores `annotations`.
   * docs/LOOP_MENDING_PLAN.md D6/MD4.
   */
  reasoning?: string;
  /** Present on assistant messages that made tool calls. */
  toolCalls?: { id: string; name: string; input: unknown }[];
  /** Present on tool messages — ties the result back to a specific call. */
  toolCallId?: string;
  /**
   * Provider-agnostic annotations. The OpenAI encoder ignores every field here.
   * docs/LOOP_MIGRATION_PLAN.md §4.3
   */
  annotations?: {
    /**
     * PS1 §4.2's conversation-tail breakpoint. LM7's Anthropic encoder renders this as
     * cache_control: { type: "ephemeral" } on the message's last content part.
     */
    cacheBreakpoint?: boolean;
    /**
     * LM6/LM7 — Anthropic requires the opaque signature be echoed back with a thinking block
     * or the next request 400s. Captured now, unused until LM7.
     */
    reasoningSignature?: string;
  };
}

/** A tool as described to the model. */
export interface WireTool {
  name: string;
  description: string;
  /** Full JSON Schema object (draft-2020-12 from zod 4, or raw schema from MCP). */
  inputSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Transport request / event / client
// ---------------------------------------------------------------------------

/**
 * Everything the transport needs. Already projected — the transport never edits these.
 * docs/LOOP_MIGRATION_PLAN.md §4.1, Decision 3.
 */
export interface LlmRequest {
  model: string;
  messages: WireMessage[];
  tools?: WireTool[];
  maxOutputTokens?: number;
  temperature?: number;
  signal: AbortSignal;
}

/**
 * docs/LOOP_MIGRATION_PLAN.md §4.4 — the three-bucket breakdown that PS1 §9.3 established.
 * A provider that omits usage details yields cacheReadTokens: 0 (conservative / correct fallback).
 */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** prompt_tokens - cached_tokens */
  noCacheTokens: number;
  /** prompt_tokens_details.cached_tokens ?? 0 */
  cacheReadTokens: number;
  /**
   * Always 0 for OpenAI-compatible providers (no separate write charge).
   * Anthropic explicit-cache providers will set this in LM7.
   */
  cacheWriteTokens: number;
}

/**
 * Events emitted by LlmClient.stream(). One event type per semantic unit — the loop
 * never sees a raw SSE frame.
 * docs/LOOP_MIGRATION_PLAN.md §4.1
 */
export type LlmEvent =
  | { type: "text.delta"; text: string }
  /** LM6 — emitted on thinking models; present in protocol but unconsumed until LM6. */
  | { type: "reasoning.delta"; text: string }
  /**
   * Terminal event for the reasoning stream — emitted once, after the last reasoning.delta.
   * `signature` carries Anthropic's opaque signature (from a `signature_delta` chunk) when the
   * provider sends one; absent for every provider that doesn't require echoing it back.
   * `reasoning.delta` stays a pure text stream — the signature rides its own event so a
   * provider without one never has to fake a value on every delta.
   * docs/LOOP_MENDING_PLAN.md D6/MD4.
   */
  | { type: "reasoning.done"; signature?: string }
  /**
   * Emitted once, whole — arguments are fully accumulated before this fires.
   * docs/LOOP_MIGRATION_PLAN.md §4.1: "Buffer inside the parser and emit once."
   */
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "usage"; usage: LlmUsage }
  | { type: "finish"; reason: WireFinishReason };

/**
 * The transport primitive. One request in, one event stream out.
 * No step loop, no tool execution, no retry policy.
 * docs/LOOP_MIGRATION_PLAN.md §4.1, Decision 3.
 */
export interface LlmClient {
  stream(req: LlmRequest): AsyncIterable<LlmEvent>;
}

// ---------------------------------------------------------------------------
// Typed errors  docs/LOOP_MIGRATION_PLAN.md §4.5
// ---------------------------------------------------------------------------

export type LlmErrorKind = "transient" | "durable" | "overflow" | "aborted";

/**
 * Typed error from the transport. The loop never sees a raw fetch rejection.
 *
 * - `transient` — network blip, timeout, rate limit; safe to retry
 * - `durable` — bad key, gone model, bad request (400/401/403/404 that isn't overflow)
 * - `overflow` — HTTP 400 with context_length_exceeded code or matching message;
 *   classified BEFORE the durable check so the model is never wrongly marked broken
 * - `aborted` — AbortSignal fired; not an error, just an exit
 */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status?: number;
  readonly providerCode?: string;

  constructor(
    message: string,
    kind: LlmErrorKind,
    opts?: { status?: number; providerCode?: string; cause?: unknown }
  ) {
    super(message, opts?.cause ? { cause: opts.cause } : undefined);
    this.name = "LlmError";
    this.kind = kind;
    this.status = opts?.status;
    this.providerCode = opts?.providerCode;
  }

  static isInstance(e: unknown): e is LlmError {
    return e instanceof LlmError;
  }
}
