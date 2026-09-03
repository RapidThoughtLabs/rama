import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { stepCountIs, streamText, type LanguageModel, type ModelMessage } from "ai";
import type { MessageDTO } from "@rama/protocol";
import { getChat, recordUsage } from "../db/chats";
import { newId } from "../db/ids";
import { appendMessage, finalizeMessage, listMessages } from "../db/messages";
import { getProject } from "../db/projects";
import { getProvider, type ProviderRow } from "../db/providers";
import { createToolCall, finalizeToolCall } from "../db/toolCalls";
import { getServerTools } from "../mcp/registry";
import { getSecret } from "../secrets";
import { createSkillTools } from "../skills/tools";
import { createTools } from "../tools";
import type { ToolResult } from "../tools/types";
import { broadcast } from "../ws";
import { DEFAULT_MODEL, DEFAULT_PROVIDER_ID, SYSTEM_PROMPT, estimateCostUsd } from "./config";

// Resolves a chat's provider row + API key into a ready-to-use LanguageModel, branching on
// `kind`: openai-compatible providers (Together, OpenAI, Groq, OpenRouter, Ollama) all share
// one adapter; Anthropic isn't OpenAI-compatible (different tool-call/thinking wire format) so
// it gets its own native adapter. Ollama is the one provider that runs without a key.
function resolveModel(providerRow: ProviderRow, model: string, apiKey: string | undefined): LanguageModel {
  if (providerRow.kind === "anthropic") {
    const anthropic = createAnthropic({ apiKey });
    return anthropic(model);
  }
  const client = createOpenAICompatible({
    name: providerRow.id,
    baseURL: providerRow.base_url ?? "",
    apiKey: apiKey ?? "unused",
    includeUsage: true,
  });
  return client(model);
}

// One in-flight run per chat — a second sendUserTurn while one is streaming is rejected
// rather than queued (real queuing is a nice-to-have, not required for this phase).
const activeRuns = new Map<string, AbortController>();

function toModelMessage(m: MessageDTO): ModelMessage {
  const content = m.content ?? "";
  switch (m.role) {
    case "user":
      return { role: "user", content };
    case "assistant":
      return { role: "assistant", content };
    case "system":
      return { role: "system", content };
  }
}

export function interrupt(chatId: string): boolean {
  const controller = activeRuns.get(chatId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function isRunning(chatId: string): boolean {
  return activeRuns.has(chatId);
}

export async function runTurn(chatId: string, text: string): Promise<void> {
  if (activeRuns.has(chatId)) {
    broadcast(chatId, { type: "error", message: "a run is already in progress for this chat" });
    return;
  }

  const chat = getChat(chatId);
  if (!chat) {
    broadcast(chatId, { type: "error", message: `chat ${chatId} not found` });
    return;
  }

  // A cli-backed chat's "turns" are driven by its PTY (see /chats/:id/pty/* routes), not this
  // loop — the composer isn't even used for these chats client-side, but guard here too in case
  // a stale client still sends one.
  if (chat.backend.kind === "cli") {
    broadcast(chatId, { type: "error", message: "this chat is backed by a CLI process — use its terminal, not chat turns" });
    return;
  }

  const project = getProject(chat.projectId);
  if (!project) {
    broadcast(chatId, { type: "error", message: `project ${chat.projectId} not found` });
    return;
  }

  const providerId = chat.providerId || DEFAULT_PROVIDER_ID;
  const providerRow = getProvider(providerId);
  const apiKey = getSecret(providerId);
  if (!providerRow) {
    broadcast(chatId, { type: "error", message: `unknown provider "${providerId}" — pick one in settings` });
    return;
  }
  if (!apiKey && providerId !== "ollama") {
    broadcast(chatId, { type: "error", message: `no ${providerRow.label ?? providerId} key configured — add one in settings` });
    return;
  }

  appendMessage(chatId, { role: "user", content: text });
  broadcast(chatId, { type: "message.user", id: newId(), text, ts: Date.now() });

  // Model history is captured now, before the assistant placeholder row below exists — an
  // empty trailing assistant message would otherwise get sent as conversation history.
  const messages = listMessages(chatId).map(toModelMessage);

  // Created empty up front, not appended at the end: tool_calls rows need a valid
  // message_id FK as soon as the first tool call happens, not only once the run finishes.
  const assistantMessage = appendMessage(chatId, { role: "assistant", content: null });

  const model = chat.model ?? DEFAULT_MODEL;
  const controller = new AbortController();
  activeRuns.set(chatId, controller);
  const runId = newId();

  const languageModel = resolveModel(providerRow, model, apiKey);

  const toolCtx = {
    chatId,
    projectId: project.id,
    projectPath: project.path,
    mode: chat.mode,
    abortSignal: controller.signal,
  };
  const tools = {
    ...createTools(toolCtx),
    ...createSkillTools(toolCtx),
    ...(await getServerTools(toolCtx)),
  };

  broadcast(chatId, { type: "run.started", runId, ts: Date.now() });
  broadcast(chatId, { type: "status", state: "thinking", verb: "thinking" });

  let fullText = "";
  let sawFirstChunk = false;

  try {
    const result = streamText({
      model: languageModel,
      system: SYSTEM_PROMPT,
      messages,
      tools,
      stopWhen: stepCountIs(8),
      abortSignal: controller.signal,
      // Without this, the SDK's default onError does a raw console.error(error) dump of the
      // full APICallError (headers, request body, retry chain) on every stream failure. The
      // "error" case below is what actually surfaces the failure to the user; this is just
      // sane server-side logging.
      onError: ({ error }) => {
        console.error(`[loop] stream error (chat ${chatId}):`, error instanceof Error ? error.message : error);
      },
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta": {
          if (!sawFirstChunk) {
            sawFirstChunk = true;
            broadcast(chatId, { type: "status", state: "streaming", verb: "responding" });
          }
          fullText += part.text;
          broadcast(chatId, { type: "message.delta", runId, text: part.text });
          break;
        }
        case "tool-call": {
          createToolCall({
            id: part.toolCallId,
            messageId: assistantMessage.id,
            chatId,
            name: part.toolName,
            input: part.input,
            startedAt: Date.now(),
          });
          broadcast(chatId, {
            type: "tool.call",
            callId: part.toolCallId,
            name: part.toolName,
            input: part.input,
            ts: Date.now(),
          });
          broadcast(chatId, { type: "status", state: "tool", verb: `running ${part.toolName}` });
          break;
        }
        case "tool-result": {
          const output = part.output as ToolResult;
          finalizeToolCall(part.toolCallId, { ok: output.ok, resultSummary: output.summary, endedAt: Date.now() });
          broadcast(chatId, {
            type: "tool.result",
            callId: part.toolCallId,
            ok: output.ok,
            summary: output.summary,
            artifactId: output.artifactId,
          });
          broadcast(chatId, { type: "status", state: "thinking", verb: "thinking" });
          break;
        }
        case "tool-error": {
          const message = part.error instanceof Error ? part.error.message : String(part.error);
          finalizeToolCall(part.toolCallId, { ok: false, resultSummary: message, endedAt: Date.now() });
          broadcast(chatId, { type: "tool.result", callId: part.toolCallId, ok: false, summary: message });
          broadcast(chatId, { type: "status", state: "thinking", verb: "thinking" });
          break;
        }
        case "error": {
          // Request/stream failures (provider 5xx, network errors, etc.) surface as a stream
          // part rather than a thrown exception from the async iterator. Throwing here routes
          // it through the same catch block below instead of silently falling through to
          // `default` and letting the loop finish "successfully" with no text.
          throw part.error instanceof Error ? part.error : new Error(String(part.error));
        }
        default:
          break;
      }
    }

    finalizeMessage(assistantMessage.id, fullText || null);
    broadcast(chatId, { type: "message.done", runId });

    const usage = await result.usage;
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const contextUsed = usage.totalTokens ?? inputTokens + outputTokens;
    const costUsd = estimateCostUsd(providerId, model, inputTokens, outputTokens);
    recordUsage(chatId, { contextUsed, costUsd });

    broadcast(chatId, { type: "usage.update", inputTokens, outputTokens, contextUsed, contextMax: chat.contextMax });
    broadcast(chatId, { type: "cost.update", usd: costUsd });
    broadcast(chatId, { type: "status", state: "idle" });
    broadcast(chatId, { type: "run.finished", runId, ts: Date.now() });
  } catch (err) {
    const aborted = controller.signal.aborted;
    finalizeMessage(assistantMessage.id, fullText || null);
    broadcast(chatId, { type: "message.done", runId });
    if (aborted) {
      broadcast(chatId, { type: "run.finished", runId, ts: Date.now(), summary: "interrupted" });
    } else {
      broadcast(chatId, { type: "error", message: err instanceof Error ? err.message : String(err) });
    }
    broadcast(chatId, { type: "status", state: aborted ? "idle" : "error" });
  } finally {
    activeRuns.delete(chatId);
  }
}
