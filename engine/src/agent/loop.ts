import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  APICallError,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type TextPart,
  type ToolCallPart,
  type ToolResultPart,
} from "ai";
import type { GeneralSettingsDTO } from "@rama/protocol";
import { createCheckpointer } from "../checkpoints";
import { createDiagnosticRunner } from "../diagnostics";
import { DEFAULT_TITLE, getChat, recordUsage, stubTitleFromFirstMessage } from "../db/chats";
import { newId } from "../db/ids";
import { appendMessage, finalizeMessage, listMessages } from "../db/messages";
import { getProject } from "../db/projects";
import { clearModelError, recordModelError, type ModelErrorKind } from "../db/providerModels";
import { getProvider, providerRequiresKey, type ProviderRow } from "../db/providers";
import { getSetting } from "../db/settings";
import { createToolCall, finalizeToolCall, listToolCallsForHistory } from "../db/toolCalls";
import { buildManifest } from "../heku";
import { createHekuTools } from "../heku/tools";
import { checkProviderHealth } from "../providerHealth";
import { getSecret } from "../secrets";
import { createSkillTools } from "../skills/tools";
import { createReadTracker } from "../tools/readTracker";
import { createShellSession } from "../tools/shell";
import { createTools } from "../tools";
import { todoEphemeralBlock } from "../tools/todo";
import type { ToolResult } from "../tools/types";
import { broadcast } from "../ws";
import { getChatRoleModel, SYSTEM_PROMPT, estimateCostUsd } from "./config";
import { maybeTitleChat } from "./titling";

// docs/PROVIDERS_PLAN.md Phase P1 — "classify, or a rate limit will hide a model the user relies
// on." Only a `durable` failure affects a model's derived status (db/providerModels.ts's
// deriveStatus); a `transient` one is recorded for display only and never hides anything.
const DURABLE_STATUS_CODES = new Set([400, 401, 403, 404]);

function classifyModelError(err: unknown, aborted: boolean): { kind: ModelErrorKind; message: string } {
  if (aborted) return { kind: "transient", message: "aborted" };
  const message = err instanceof Error ? err.message : String(err);
  if (APICallError.isInstance(err) && err.statusCode != null) {
    return { kind: DURABLE_STATUS_CODES.has(err.statusCode) ? "durable" : "transient", message };
  }
  // No HTTP status at all — a network failure, timeout, or the SDK's own wrapper error. Treat as
  // transient: a real durable cause (bad key, gone model) will keep failing and eventually surface
  // a status code on a later attempt, whereas misclassifying a network blip as durable would hide
  // a model the user relies on over nothing more than a dropped connection.
  return { kind: "transient", message };
}

// Resolves a chat's provider row + API key into a ready-to-use LanguageModel, branching on
// `kind`: openai-compatible providers (Together, OpenAI, Groq, OpenRouter, Ollama) all share
// one adapter; Anthropic isn't OpenAI-compatible (different tool-call/thinking wire format) so
// it gets its own native adapter. Ollama is the one provider that runs without a key.
function resolveModel(providerRow: ProviderRow, model: string, apiKey: string | undefined): LanguageModel {
  if (providerRow.kind === "anthropic") {
    const anthropic = createAnthropic({ apiKey });
    return anthropic(model);
  }

  let extraHeaders: Record<string, string> = {};
  try {
    extraHeaders = JSON.parse(providerRow.extra_headers_json || "{}");
  } catch {
    extraHeaders = {};
  }

  // docs/PROVIDERS_PLAN.md Phase P5 — the `@ai-sdk/openai-compatible` `apiKey` option always
  // emits `Authorization: Bearer <key>`, so a header-style provider (configureCustomProvider's
  // "named header" choice) has to skip that option entirely and carry the key through `headers`
  // instead, same fix as providerHealth.ts's probe.
  const useHeaderAuth = providerRow.auth_style === "header" && !!providerRow.auth_header;
  const client = createOpenAICompatible({
    name: providerRow.id,
    baseURL: providerRow.base_url ?? "",
    apiKey: useHeaderAuth ? undefined : (apiKey ?? "unused"),
    headers: useHeaderAuth ? { [providerRow.auth_header!]: apiKey ?? "", ...extraHeaders } : extraHeaders,
    includeUsage: true,
  });
  return client(model);
}

// One in-flight run per chat — a second sendUserTurn while one is streaming is rejected
// rather than queued (real queuing is a nice-to-have, not required for this phase).
const activeRuns = new Map<string, AbortController>();

// Rebuilds full conversation history for the next call to streamText, not just the plain-text
// transcript: an assistant turn that made tool calls is replayed as an assistant message (text +
// tool-call parts) immediately followed by a tool message carrying each call's real result, so a
// later turn can actually see what an earlier tool call returned instead of just its own prose.
export function toModelMessages(chatId: string): ModelMessage[] {
  const callsByMessage = new Map<string, ReturnType<typeof listToolCallsForHistory>>();
  for (const call of listToolCallsForHistory(chatId)) {
    const list = callsByMessage.get(call.messageId) ?? [];
    list.push(call);
    callsByMessage.set(call.messageId, list);
  }

  const out: ModelMessage[] = [];
  for (const m of listMessages(chatId)) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content ?? "" });
      continue;
    }
    if (m.role === "system") {
      out.push({ role: "system", content: m.content ?? "" });
      continue;
    }

    const calls = callsByMessage.get(m.id) ?? [];
    if (calls.length === 0) {
      if (!m.content) continue; // an interrupted turn with nothing to replay
      out.push({ role: "assistant", content: m.content });
      continue;
    }

    const assistantContent: (TextPart | ToolCallPart)[] = [];
    if (m.content) assistantContent.push({ type: "text", text: m.content });
    for (const call of calls) {
      assistantContent.push({ type: "tool-call", toolCallId: call.id, toolName: call.name, input: call.input });
    }
    out.push({ role: "assistant", content: assistantContent });

    const toolContent: ToolResultPart[] = calls.map((call) => ({
      type: "tool-result",
      toolCallId: call.id,
      toolName: call.name,
      output: {
        type: call.ok ? "text" : "error-text",
        value: call.resultContent ?? call.resultSummary ?? (call.ok ? "" : "tool call failed"),
      },
    }));
    out.push({ role: "tool", content: toolContent });
  }
  return out;
}

// docs/TOOL_LAYER_PLAN.md §6.14/M5 — a minimal, todo-only stand-in for HARNESS_DESIGN.md's C9
// ephemeral layer (H2), which doesn't exist yet: "system-authored blocks appended after the last
// user message, regenerated each step, never persisted." Implemented via `streamText`'s
// `prepareStep`, whose `messages` override carries forward to later steps but is never the thing
// `finalizeMessage`/`appendMessage` persist — those read `fullText`/stream parts directly, so this
// injection never reaches the DB.
const TODO_REMINDER_MARKER = '<system-reminder id="todo-list">';

export function withTodoReminder(chatId: string, messages: ModelMessage[]): ModelMessage[] {
  const stripped = messages.filter((m) => !(m.role === "user" && typeof m.content === "string" && m.content.startsWith(TODO_REMINDER_MARKER)));
  const block = todoEphemeralBlock(chatId);
  if (!block) return stripped;

  // "After the last user message": in this loop's shape that is always the single message that
  // started the run (a run is one sendUserTurn call; every message after it this run is
  // assistant/tool), but finding it explicitly rather than assuming index 0 keeps this correct if
  // that ever changes.
  const lastUserIdx = stripped.map((m) => m.role).lastIndexOf("user");
  const reminder: ModelMessage = { role: "user", content: block };
  if (lastUserIdx === -1) return [...stripped, reminder];
  return [...stripped.slice(0, lastUserIdx + 1), reminder, ...stripped.slice(lastUserIdx + 1)];
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

  const project = getProject(chat.projectId);
  if (!project) {
    broadcast(chatId, { type: "error", message: `project ${chat.projectId} not found` });
    return;
  }

  const chatRole = getChatRoleModel();
  const providerId = chat.providerId || chatRole.providerId;
  const providerRow = getProvider(providerId);
  const apiKey = getSecret(providerId);
  if (!providerRow) {
    broadcast(chatId, { type: "error", message: `unknown provider "${providerId}" — pick one in settings` });
    return;
  }
  if (!apiKey && providerRequiresKey(providerId)) {
    broadcast(chatId, { type: "error", message: `no ${providerRow.label ?? providerId} key configured — add one in settings` });
    return;
  }

  appendMessage(chatId, { role: "user", content: text });
  broadcast(chatId, { type: "message.user", id: newId(), text, ts: Date.now() });

  // docs/PROVIDERS_PLAN.md Phase P2, auto-titling stage 1 — only ever fires on the very first
  // user turn (every later turn's title is already past DEFAULT_TITLE, so this no-ops). Captured
  // here, before the stub write, so stage 2 below knows whether *this* turn was the first one.
  const isFirstTurn = chat.title === DEFAULT_TITLE;
  const stubTitle = stubTitleFromFirstMessage(chatId, text);
  if (stubTitle) broadcast(chatId, { type: "chat.renamed", chatId, title: stubTitle.title });

  // Model history is captured now, before the assistant placeholder row below exists — an
  // empty trailing assistant message would otherwise get sent as conversation history.
  const messages = toModelMessages(chatId);

  // Created empty up front, not appended at the end: tool_calls rows need a valid
  // message_id FK as soon as the first tool call happens, not only once the run finishes.
  const assistantMessage = appendMessage(chatId, { role: "assistant", content: null });

  const model = chat.model ?? chatRole.model;
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
    runId,
    reads: createReadTracker(chatId, project.path),
    checkpoints: createCheckpointer(project.path),
    shell: createShellSession(project.path),
    diagnostics: createDiagnosticRunner(project.path),
    // TL6, §6.15 — the already-resolved model, reused as-is by `explore`'s nested streamText
    // call so a sub-agent always runs on the same provider/model as the parent turn.
    languageModel,
  };
  const tools = {
    ...createTools(toolCtx),
    ...createSkillTools(toolCtx),
    // docs/TOOL_LAYER_PLAN.md §7 (TL7) — two static slots (heku_find/heku_call) plus any promoted
    // tools, replacing the old getServerTools flattening of every connected server's full tool
    // list into every request (X2).
    ...createHekuTools(toolCtx),
  };

  // docs/TOOL_LAYER_PLAN.md §5.2 — marks "the state before this run" so `/undo` can restore to
  // it, independent of whatever per-mutation checkpoints happen during the run. Best-effort: a
  // project this can't snapshot (e.g. an unwritable directory) shouldn't block the run itself.
  toolCtx.checkpoints.snapshot("run start", { runStart: true }).catch((err) => {
    console.error(`[loop] run-start checkpoint failed (chat ${chatId}):`, err instanceof Error ? err.message : err);
  });

  broadcast(chatId, { type: "run.started", runId, ts: Date.now() });
  broadcast(chatId, { type: "status", state: "thinking", verb: "thinking" });

  let fullText = "";
  let sawFirstChunk = false;

  try {
    const result = streamText({
      model: languageModel,
      // §7.7 — "regenerated on connect/disconnect and belongs in the stable prefix precisely
      // because it changes rarely." Cheap enough (one indexed sqlite read) to just recompute per
      // run rather than wiring actual connect/disconnect invalidation hooks.
      system: SYSTEM_PROMPT + buildManifest(),
      messages,
      tools,
      stopWhen: stepCountIs(8),
      abortSignal: controller.signal,
      prepareStep: async ({ messages: stepMessages }) => ({ messages: withTodoReminder(chatId, stepMessages) }),
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
          // M6 — feeds the read tracker so a later edit/write in this run (or a later turn) can
          // check read-before-write. Only `read` ever populates this; grep/glob matches don't
          // count as having seen the file's current full content.
          if (output.meta?.filesRead?.length) toolCtx.reads.record(output.meta.filesRead);
          finalizeToolCall(part.toolCallId, {
            ok: output.ok,
            resultSummary: output.summary,
            resultContent: output.content ?? null,
            resultMeta: (output.meta as Record<string, unknown> | undefined) ?? null,
            endedAt: Date.now(),
          });
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
          finalizeToolCall(part.toolCallId, { ok: false, resultSummary: message, resultContent: message, endedAt: Date.now() });
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
    const { usd: costUsd } = estimateCostUsd(providerId, model, inputTokens, outputTokens);
    recordUsage(chatId, { contextUsed, costUsd });
    // A completed turn is the strongest possible signal this model is fine — undoes any earlier
    // `durable` mark (tier upgraded, credit added) instead of leaving it stuck erroring forever.
    clearModelError(providerId, model);

    broadcast(chatId, { type: "usage.update", inputTokens, outputTokens, contextUsed, contextMax: chat.contextMax });
    broadcast(chatId, { type: "cost.update", usd: costUsd });
    broadcast(chatId, { type: "status", state: "idle" });
    broadcast(chatId, { type: "run.finished", runId, ts: Date.now() });

    // docs/PROVIDERS_PLAN.md Phase P2, auto-titling stage 2 — fire-and-forget, fully guarded
    // inside maybeTitleChat (5s timeout, no retry, fails silent). Gated on the toggle here, before
    // anything is resolved: off means no chat content is sent anywhere for this purpose, period.
    if (isFirstTurn && (getSetting<GeneralSettingsDTO>("general")?.autoNameChats ?? true)) {
      void maybeTitleChat(chatId, text);
    }
  } catch (err) {
    const aborted = controller.signal.aborted;
    finalizeMessage(assistantMessage.id, fullText || null);
    broadcast(chatId, { type: "message.done", runId });
    if (aborted) {
      broadcast(chatId, { type: "run.finished", runId, ts: Date.now(), summary: "interrupted" });
    } else {
      broadcast(chatId, { type: "error", message: err instanceof Error ? err.message : String(err) });
      const { kind, message } = classifyModelError(err, aborted);
      recordModelError(providerId, model, message, kind, Date.now());
      // The strongest available signal the roster itself is wrong — don't wait for the next 30s
      // poll to find out the model that just 401'd is actually gone.
      if (kind === "durable") void checkProviderHealth(providerId).catch(() => {});
    }
    broadcast(chatId, { type: "status", state: aborted ? "idle" : "error" });
  } finally {
    activeRuns.delete(chatId);
    // §5.5 — the foreground shell is run-scoped either way; disposed here covers both a normal
    // finish and an abort (this `finally` runs in both cases) without duplicating the teardown.
    void toolCtx.shell.dispose();
  }
}
