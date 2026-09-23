// engine/src/llm/openai/stream.ts
//
// OpenAI-compatible streaming transport: fetch + SSE reader + frame decoder.
// docs/LOOP_MIGRATION_PLAN.md §4.1, §4.5, §4.6

import { logContextBudgetStep } from "../contextBudgetLog";
import { readSSE } from "../sse";
import { LlmError } from "../types";
import type { LlmClient, LlmEvent, LlmRequest, LlmUsage } from "../types";
import { ToolCallAccumulator, decodeFrame } from "./decode";
import { encodeRequest } from "./encode";

// HTTP status codes that indicate a durable (non-retriable) failure.
// docs/LOOP_MIGRATION_PLAN.md §4.5, PROVIDERS_PLAN.md Phase P1
const DURABLE_STATUS_CODES = new Set([400, 401, 403, 404]);

// Patterns that identify a context-length overflow in the error body.
// docs/LOOP_MIGRATION_PLAN.md §4.5 — classified BEFORE the durable check so the model
// is never wrongly marked broken when the conversation is simply too long.
const OVERFLOW_PATTERN = /maximum context length|context length|context_length_exceeded|too many tokens/i;

/**
 * Classify an HTTP error response into a typed LlmError.
 * Overflow is detected before the durable check to avoid misclassifying a
 * too-long conversation as a broken model.
 * docs/LOOP_MIGRATION_PLAN.md §4.5
 */
function classifyHttpError(status: number, body: unknown): LlmError {
  // Extract a human-readable message and provider error code from the body
  let message = "";
  let code = "";
  if (typeof body === "object" && body !== null) {
    const b = body as Record<string, unknown>;
    const err = b["error"];
    if (typeof err === "string") {
      message = err;
    } else if (typeof err === "object" && err !== null) {
      const e = err as Record<string, unknown>;
      message = typeof e["message"] === "string" ? e["message"] : JSON.stringify(err);
      code = typeof e["code"] === "string" ? e["code"] : "";
    } else {
      message = JSON.stringify(body);
    }
  } else {
    message = String(body);
  }

  // Overflow check — before durable, per §4.5
  if (status === 400 && (code === "context_length_exceeded" || OVERFLOW_PATTERN.test(message))) {
    return new LlmError(message, "overflow", { status, providerCode: code || undefined });
  }

  if (DURABLE_STATUS_CODES.has(status)) {
    return new LlmError(message, "durable", { status, providerCode: code || undefined });
  }

  return new LlmError(message, "transient", { status, providerCode: code || undefined });
}

export interface OpenAIStreamClientOptions {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

/**
 * An LlmClient backed by the OpenAI Chat Completions streaming API.
 * Works with any OpenAI-compatible provider (Together, Groq, OpenRouter, Ollama, OpenAI).
 *
 * One stream() call = one HTTP request. No retries, no step loop, no tool execution.
 * docs/LOOP_MIGRATION_PLAN.md §4.1, Decision 3.
 */
export class OpenAIStreamClient implements LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: OpenAIStreamClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, ""); // strip trailing slash
    this.apiKey = opts.apiKey;
    this.extraHeaders = opts.headers ?? {};
  }

  async *stream(req: LlmRequest): AsyncGenerator<LlmEvent> {
    if (req.signal.aborted) {
      throw new LlmError("aborted", "aborted");
    }

    const body = encodeRequest(req);
    const bodyJson = JSON.stringify(body);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.extraHeaders,
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: bodyJson,
        signal: req.signal,
      });
    } catch (err) {
      if (req.signal.aborted) {
        throw new LlmError("aborted", "aborted", { cause: err });
      }
      // Network failure — transient
      throw new LlmError(err instanceof Error ? err.message : String(err), "transient", { cause: err });
    }

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = await response.text().catch(() => "");
      }
      throw classifyHttpError(response.status, errorBody);
    }

    if (!response.body) {
      throw new LlmError("Empty response body from provider", "transient");
    }

    const acc = new ToolCallAccumulator();
    let sawFinish = false;
    let lastUsage: LlmUsage | undefined;
    try {
      for await (const data of readSSE(response.body)) {
        if (req.signal.aborted) {
          throw new LlmError("aborted", "aborted");
        }
        const events = decodeFrame(data, acc);
        for (const event of events) {
          if (event.type === "finish") sawFinish = true;
          if (event.type === "usage") lastUsage = event.usage;
          yield event;
        }
      }
    } catch (err) {
      if (LlmError.isInstance(err)) throw err;
      if (req.signal.aborted) {
        throw new LlmError("aborted", "aborted", { cause: err });
      }
      throw new LlmError(err instanceof Error ? err.message : String(err), "transient", { cause: err });
    }

    // D5: a stream that ends on `[DONE]` or plain EOF without ever sending a finish_reason
    // must not silently drop buffered tool-call fragments, and the loop must never see a step
    // that ended with neither a tool call nor a finish event. Flush whatever the accumulator
    // still holds and synthesise the finish the provider never sent.
    // docs/LOOP_MENDING_PLAN.md D5/MD1.
    if (!sawFinish) {
      const flushed = acc.flush();
      for (const event of flushed) {
        yield event;
      }
      yield { type: "finish", reason: flushed.length > 0 ? "tool_calls" : "stop" };
    }

    if (lastUsage) {
      logContextBudgetStep({
        provider: "openai",
        model: req.model,
        messageCount: body.messages.length,
        requestBytes: bodyJson.length,
        inputTokens: lastUsage.inputTokens,
        promptTokens: lastUsage.promptTokens,
        cacheReadTokens: lastUsage.cacheReadTokens,
        cacheWriteTokens: lastUsage.cacheWriteTokens,
        outputTokens: lastUsage.outputTokens,
      });
    }
  }
}
