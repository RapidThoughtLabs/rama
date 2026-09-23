// engine/src/llm/anthropic/stream.ts
//
// Anthropic Messages API streaming transport: fetch + wire SSE reader + decoder.
// docs/LOOP_MIGRATION_PLAN.md §4.1, §4.5, LM7

import { logContextBudgetStep } from "../contextBudgetLog";
import { readSSE } from "../sse";
import { LlmError } from "../types";
import type { LlmClient, LlmEvent, LlmRequest } from "../types";
import { AnthropicAccumulator, decodeFrame } from "./decode";
import { encodeRequest } from "./encode";

const OVERFLOW_PATTERN = /prompt is too long|context length|too many tokens|max_tokens/i;

function classifyHttpError(status: number, body: unknown): LlmError {
  let message = "";
  let errorType = "";
  if (typeof body === "object" && body !== null && "error" in body) {
    const errObj = (body as { error: unknown }).error;
    if (typeof errObj === "object" && errObj !== null) {
      message = String((errObj as { message?: unknown }).message ?? "");
      errorType = String((errObj as { type?: unknown }).type ?? "");
    } else {
      message = String(errObj);
    }
  } else {
    message = typeof body === "string" ? body : JSON.stringify(body);
  }

  // Overflow check before durable (§4.5)
  if (status === 400 && OVERFLOW_PATTERN.test(message)) {
    return new LlmError(message, "overflow", { status, providerCode: errorType || undefined });
  }

  if (status === 400 || status === 401 || status === 403 || status === 404) {
    return new LlmError(message, "durable", { status, providerCode: errorType || undefined });
  }

  return new LlmError(message, "transient", { status, providerCode: errorType || undefined });
}

export interface AnthropicStreamClientOptions {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export class AnthropicStreamClient implements LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: AnthropicStreamClientOptions = {}) {
    const rawUrl = opts.baseUrl?.trim() || "https://api.anthropic.com";
    this.baseUrl = rawUrl.replace(/\/$/, "");
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
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
      ...this.extraHeaders,
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: bodyJson,
        signal: req.signal,
      });
    } catch (err) {
      if (req.signal.aborted) {
        throw new LlmError("aborted", "aborted", { cause: err });
      }
      throw new LlmError(
        err instanceof Error ? err.message : String(err),
        "transient",
        { cause: err }
      );
    }

    if (!response.ok) {
      let errBody: unknown;
      try {
        errBody = await response.json();
      } catch {
        errBody = await response.text().catch(() => "");
      }
      throw classifyHttpError(response.status, errBody);
    }

    if (!response.body) {
      throw new LlmError("Empty response body from Anthropic", "transient");
    }

    const acc = new AnthropicAccumulator();
    try {
      for await (const data of readSSE(response.body)) {
        if (req.signal.aborted) {
          throw new LlmError("aborted", "aborted");
        }
        const events = decodeFrame(data, acc);
        for (const event of events) {
          yield event;
        }
      }
    } catch (err) {
      if (LlmError.isInstance(err)) throw err;
      if (req.signal.aborted) {
        throw new LlmError("aborted", "aborted", { cause: err });
      }
      throw new LlmError(
        err instanceof Error ? err.message : String(err),
        "transient",
        { cause: err }
      );
    }

    logContextBudgetStep({
      provider: "anthropic",
      model: req.model,
      messageCount: body.messages.length,
      requestBytes: bodyJson.length,
      inputTokens: acc.usage.inputTokens,
      promptTokens: acc.usage.promptTokens,
      cacheReadTokens: acc.usage.cacheReadTokens,
      cacheWriteTokens: acc.usage.cacheWriteTokens,
      outputTokens: acc.usage.outputTokens,
    });
  }
}
