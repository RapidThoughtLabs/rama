import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  APICallError,
  hasToolCall,
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
import type { ToolCtx, ToolResult } from "../tools/types";
import { broadcast } from "../ws";
import { resolveAgent } from "./agents/discover";
import { computeEffectiveTools } from "./agents/effectiveTools";
import type { AgentDef } from "./agents/types";
import { getCachePolicy, getSupportsMidConversationSystem } from "./catalog";
import { classifyComplexity } from "./complexity";
import { buildCompletionGateNudge, formatUnverifiedWrites, MAX_COMPLETION_NUDGES } from "./completionGate";
import { estimateCostUsdDetailed, getChatRoleModel } from "./config";
import { getGlobalInstructions, getProjectInstructions } from "./instructions";
import { hasRepeatedToolCall, stuckOnRepeatedToolCall, STUCK_LOOP_NOTE } from "./loopGuard";
import { buildPrompt, type PromptBlocks } from "./prompt/build";
import { markCacheBoundary } from "./prompt/cache";
import { buildEphemeralMessage, buildEphemeralText, getVolatileEnv } from "./prompt/ephemeral";
import type { ProjectKnowledgeInputs } from "./prompt/project";
import { getStaticEnv } from "./prompt/sources";
import { sortTools } from "./prompt/toolInventory";
import { getSubagentTarget } from "./subagentRole";
import { maybeTitleChat } from "./titling";
import { runCurator } from "./curator/curator";

// docs/PROMPT_STACK_PLAN.md §7.1, Phase PS3 — reads whatever RAMA.md files exist right now; no
// caching here beyond the filesystem's own, so an edit mid-session is visible on the very next
// turn (the exit criterion: "editing it mid-session invalidates only bp3 onward").
function readProjectKnowledge(projectPath: string): ProjectKnowledgeInputs {
  return {
    global: getGlobalInstructions()?.content ?? null,
    project: getProjectInstructions(projectPath)?.content ?? null,
  };
}

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

// docs/PROMPT_STACK_PLAN.md §6.1, Phase PS5 — resolves the `subagent` model role for
// explore/review/test's nested streamText calls, falling back to the parent turn's own
// provider/model/key whenever the role isn't configured yet or its provider is unhealthy. A
// sub-agent tool must never fail outright just because nobody has visited the roles settings —
// same null-safety pattern as agent/utility.ts's getUtilityTarget.
function resolveSubagentModel(fallbackProviderRow: ProviderRow, fallbackModel: string, fallbackApiKey: string | undefined): LanguageModel {
  const target = getSubagentTarget();
  if (!target) return resolveModel(fallbackProviderRow, fallbackModel, fallbackApiKey);
  const providerRow = getProvider(target.providerId);
  if (!providerRow) return resolveModel(fallbackProviderRow, fallbackModel, fallbackApiKey);
  const apiKey = getSecret(target.providerId);
  if (!apiKey && providerRequiresKey(target.providerId)) return resolveModel(fallbackProviderRow, fallbackModel, fallbackApiKey);
  return resolveModel(providerRow, target.model, apiKey);
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

  // Echoed before the provider/key checks below (which can still bail the run out) so the
  // user's own message always lands in the transcript — previously a bad/missing key made the
  // typed text vanish into just a status-line error, with no record it was ever sent.
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

  // docs/PROMPT_STACK_PLAN.md §8.1, Phase PS6 — first-turn-only. The heuristic tier (the common
  // case) is synchronous and free; only a genuinely borderline message pays for the `utility`-role
  // model call complexity.ts falls back to. "The result drives the ephemeral block, never the
  // system prompt" — it never touches buildPrompt, only the per-run ephemeral text below.
  const taskComplexityHint =
    isFirstTurn && (await classifyComplexity(chatId, text, project.path)) === "complex"
      ? "This looks like a multi-part or ambiguous request. If there are genuinely different " +
        "reasonable interpretations, call clarify now (at most 3 questions, each with a default) " +
        "before starting — otherwise proceed."
      : undefined;

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

  // Created empty up front, not appended at the end: tool_calls rows need a valid
  // message_id FK as soon as the first tool call happens, not only once the run finishes.
  const assistantMessage = appendMessage(chatId, { role: "assistant", content: null });

  const model = chat.model ?? chatRole.model;
  const controller = new AbortController();
  activeRuns.set(chatId, controller);
  const runId = newId();

  // Everything below through the streaming loop now runs inside one try block. Agent resolution,
  // tool/prompt assembly (buildPrompt, getVolatileEnv, etc.) can throw just as easily as the
  // stream itself — before this fix a throw here left `activeRuns` permanently locked, since
  // `finally` below never ran, and every later sendUserTurn for this chat hit the "a run is
  // already in progress" guard forever with no way out short of restarting the engine.
  let toolCtx: ToolCtx | undefined;
  let fullText = "";
  let sawFirstChunk = false;
  let blockedOnQuestion = false;
  let nudgesUsed = 0;
  const usageTotals = { inputTokens: 0, outputTokens: 0, noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };

  try {
  const languageModel = resolveModel(providerRow, model, apiKey);
  const subagentModel = resolveSubagentModel(providerRow, model, apiKey);
  // docs/PROMPT_STACK_PLAN.md §5.3, Phase PS4 — the chat's own agent, falling back to `default`
  // (the bundled floor) if the row names one that's since been deleted.
  const agent: AgentDef = resolveAgent({ projectId: project.id, projectPath: project.path }, chat.agentId);

  toolCtx = {
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
    languageModel,
    subagentModel,
  };
  // docs/PROMPT_STACK_PLAN.md §9.4 PS0 — sorted by name so the wire tool schemas (layer 0) can
  // never render in a different order than the generated inventory buildPrompt puts in the
  // system text, and so a promoted heku tool's call-count-ordered position (heku/promote.ts)
  // never reorders the prefix.
  const tools = sortTools({
    ...createTools(toolCtx),
    ...createSkillTools(toolCtx),
    // docs/TOOL_LAYER_PLAN.md §7 (TL7) — two static slots (heku_find/heku_call) plus any promoted
    // tools, replacing the old getServerTools flattening of every connected server's full tool
    // list into every request (X2).
    ...createHekuTools(toolCtx),
  });
  // docs/PROMPT_STACK_PLAN.md §5.2, Phase PS4 — "harness tools ∩ mode allowance ∩ agent
  // allowlist", the actual set handed to streamText. `tools` above (the full set) still goes to
  // buildPrompt for bp1's stable capability inventory — see prompt/build.ts's PromptInputs doc.
  const effectiveTools = computeEffectiveTools(tools, chat.mode, agent);

  const cachePolicy = getCachePolicy(providerId, model);
  const promptBlocks = buildPrompt({
    tools,
    // §7.7 — "regenerated on connect/disconnect and belongs in the stable prefix precisely
    // because it changes rarely." Cheap enough (one indexed sqlite read) to just recompute per
    // run rather than wiring actual connect/disconnect invalidation hooks.
    hekuManifest: buildManifest(),
    staticEnv: getStaticEnv(),
    cache: cachePolicy,
    mode: chat.mode,
    agent,
    effectiveToolNames: Object.keys(effectiveTools),
    projectKnowledge: readProjectKnowledge(project.path),
  });

  // docs/PROMPT_STACK_PLAN.md §4.2 PS2 — volatileEnv/taskComplexityHint are computed once per run
  // (not per step, decision 4); supportsMidConversationSystem picks the trailing role:"system"
  // message vs. the text-in-user-turn fallback for a model that rejects the former.
  const volatileEnv = await getVolatileEnv(project.path);
  const supportsMidConversationSystem = getSupportsMidConversationSystem(providerId, model);
  // docs/PROMPT_STACK_PLAN.md §8.3, Phase PS6 — unlike volatileEnv/taskComplexityHint above, this
  // has to be recomputed fresh on every prepareStep call: it tracks live per-run tool-call state
  // (below), not something fixed at run start.
  const unverifiedWrites = new Set<string>();
  const currentEphemeralText = () =>
    buildEphemeralText({ volatileEnv, taskComplexityHint, unverifiedWrites: formatUnverifiedWrites(unverifiedWrites) });
  // The completion gate (§8.3) only has a tool to point at if this turn's effective toolset
  // actually includes it — an agent allowlist or plan mode can remove `check` like any other tool.
  const checkAvailable = "check" in effectiveTools;

  // docs/TOOL_LAYER_PLAN.md §5.2 — marks "the state before this run" so `/undo` can restore to
  // it, independent of whatever per-mutation checkpoints happen during the run. Best-effort: a
  // project this can't snapshot (e.g. an unwritable directory) shouldn't block the run itself.
  toolCtx.checkpoints.snapshot("run start", { runStart: true }).catch((err) => {
    console.error(`[loop] run-start checkpoint failed (chat ${chatId}):`, err instanceof Error ? err.message : err);
  });

  broadcast(chatId, { type: "run.started", runId, ts: Date.now() });
  broadcast(chatId, { type: "status", state: "thinking", verb: "thinking" });

  let currentMessages = messages;

  // docs/PROMPT_STACK_PLAN.md §8.3, Phase PS6 — the between-step hook (H1), implemented as an
    // outer retry around the whole multi-step streamText call rather than inside it: the AI SDK's
    // own step loop only ever *shortens* on a stopWhen condition, it can never force a step past
    // the model's own "I'm done, no more tool calls" finish — that termination is unconditional
    // (see the SDK's `clientToolCalls.length > 0 && ...` continue-guard). So a real "cannot finish
    // with unverified writes" gate has to sit one level up: run the turn, and if it ends with
    // pending unverified writes, feed the accumulated response back in plus one synthetic nudge
    // message and run one more full streamText call. Bounded by MAX_COMPLETION_NUDGES (1) — see
    // completionGate.ts's own comment for why this is a single enforced chance, not a retry loop.
    for (;;) {
      const result = streamText({
        model: languageModel,
        system: promptBlocks.system,
        messages: currentMessages,
        tools: effectiveTools,
        // ai@7 defaults this to false and throws InvalidPromptError the moment any role:"system"
        // message shows up in `messages` — which is exactly what prepareStep below does every
        // step (layer 7's ephemeral block, buildEphemeralMessage) for every model where
        // supportsMidConversationSystem is true. Without this, every turn on every model except
        // claude-sonnet-5 (the one model with that flag false) fails before the first token.
        allowSystemInMessages: true,
        // hasToolCall("clarify") ends the run right after a clarify call, same as the model's own
        // natural stop — §8.1's "the run enters a defined terminal state" (blocked-on-question,
        // detected below from blockedOnQuestion) depends on the loop actually stopping there.
        stopWhen: [stepCountIs(8), hasToolCall("clarify"), hasRepeatedToolCall()],
        abortSignal: controller.signal,
        // docs/PROMPT_STACK_PLAN.md §4.2 PS1/PS2 — the conversation-tail breakpoint (bp4), applied
        // after the todo reminder so the marker always lands on whatever message is actually last
        // on the wire for this step, then the ephemeral block (layer 7) tacked on after — always
        // trailing, uncached, never the thing the marker lands on.
        prepareStep: async ({ messages: stepMessages }) => {
          const marked = markCacheBoundary(withTodoReminder(chatId, stepMessages), cachePolicy);
          return { messages: [...marked, buildEphemeralMessage(currentEphemeralText(), supportsMidConversationSystem)] };
        },
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
            if (part.toolName === "clarify") blockedOnQuestion = true;
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
            // §8.3's completion gate: `check` verifies everything written so far, regardless of
            // whether it came back clean — the gate is "was it run", not "did it pass". A write's
            // own successful edit/write clears any earlier partial state for the *same* path
            // implicitly (it's still unverified either way), so this only ever adds.
            if (part.toolName === "check") {
              unverifiedWrites.clear();
            } else if (output.ok && output.meta?.filesWritten?.length) {
              for (const f of output.meta.filesWritten) unverifiedWrites.add(f);
            }
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

      const usage = await result.usage;
      usageTotals.inputTokens += usage.inputTokens ?? 0;
      usageTotals.outputTokens += usage.outputTokens ?? 0;
      // docs/PROMPT_STACK_PLAN.md §9.3 PS1 — inputTokens is the sum of these three; billing it
      // flat is the bug this replaces. A provider that never populates inputTokenDetails reports 0
      // for both cache buckets, so noCacheTokens falls back to the full inputTokens per attempt.
      usageTotals.noCacheTokens += usage.inputTokenDetails.noCacheTokens ?? (usage.inputTokens ?? 0);
      usageTotals.cacheReadTokens += usage.inputTokenDetails.cacheReadTokens ?? 0;
      usageTotals.cacheWriteTokens += usage.inputTokenDetails.cacheWriteTokens ?? 0;
      usageTotals.totalTokens += usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);

      if (blockedOnQuestion) break;

      // loopGuard.ts's hasRepeatedToolCall stopWhen condition ended the loop early because the
      // model was re-issuing the same tool call step after step — surface that as text instead of
      // finalizing an empty assistant message with a pile of duplicate tool calls behind it.
      if (stuckOnRepeatedToolCall(await result.steps)) {
        // message.delta, not just the local fullText append, because the client only ever
        // materializes assistant text from delta events (SessionProvider.tsx's pendingByChat) —
        // appending here alone would persist the note to the DB but never show it live.
        const note = (fullText ? "\n\n" : "") + STUCK_LOOP_NOTE;
        fullText += note;
        broadcast(chatId, { type: "message.delta", runId, text: note });
        break;
      }

      const finishReason = await result.finishReason;
      // finishReason === "tool-calls" means stepCountIs(8) cut the run off mid-tool-use, not that
      // the model tried to stop — nudging there would just add an 9th step on top of a budget it
      // already exhausted, so only a genuine "I'm done" (stop/length/other) is eligible.
      const shouldNudge = nudgesUsed < MAX_COMPLETION_NUDGES && checkAvailable && unverifiedWrites.size > 0 && finishReason !== "tool-calls";
      if (!shouldNudge) break;

      nudgesUsed++;
      sawFirstChunk = false;
      broadcast(chatId, { type: "status", state: "thinking", verb: "thinking" });
      currentMessages = [...currentMessages, ...(await result.responseMessages), buildCompletionGateNudge(unverifiedWrites, supportsMidConversationSystem)];
    }

    finalizeMessage(assistantMessage.id, fullText || null);
    broadcast(chatId, { type: "message.done", runId });

    const { inputTokens, outputTokens, noCacheTokens, cacheReadTokens, cacheWriteTokens, totalTokens: contextUsed } = usageTotals;
    const { usd: costUsd } = estimateCostUsdDetailed(
      providerId,
      model,
      { noCacheTokens, cacheReadTokens, cacheWriteTokens },
      outputTokens,
    );
    recordUsage(chatId, { contextUsed, costUsd });
    // A completed turn is the strongest possible signal this model is fine — undoes any earlier
    // `durable` mark (tier upgraded, credit added) instead of leaving it stuck erroring forever.
    clearModelError(providerId, model);

    broadcast(chatId, {
      type: "usage.update",
      inputTokens,
      outputTokens,
      contextUsed,
      contextMax: chat.contextMax,
      cacheReadTokens,
      cacheWriteTokens,
      noCacheTokens,
    });
    broadcast(chatId, { type: "cost.update", usd: costUsd });
    broadcast(chatId, { type: "status", state: "idle" });
    // docs/HARNESS_MAP.md §3.8 — "blocked-on-question" is one name out of that section's proposed
    // closed set of run-terminal states; PS6 only wires this one (via the existing free-form
    // `summary` field), not the full six-state enum, which is broader work than clarify needs.
    broadcast(chatId, { type: "run.finished", runId, ts: Date.now(), ...(blockedOnQuestion ? { summary: "blocked-on-question" } : {}) });

    // docs/PROVIDERS_PLAN.md Phase P2, auto-titling stage 2 — fire-and-forget, fully guarded
    // inside maybeTitleChat (5s timeout, no retry, fails silent). Gated on the toggle here, before
    // anything is resolved: off means no chat content is sent anywhere for this purpose, period.
    if (isFirstTurn && (getSetting<GeneralSettingsDTO>("general")?.autoNameChats ?? true)) {
      void maybeTitleChat(chatId, text);
    }

    // docs/PROMPT_STACK_PLAN.md §7.2, Phase PS7 — fire-and-forget, same shape as auto-titling
    // above: its own evidence gate (curator.ts) makes this a no-op when nothing new happened, and
    // a single guarded utility-model call when something did. Skipped when the run only got as
    // far as a clarify question — too little happened for an evidence pass to find anything.
    if (!blockedOnQuestion) {
      void runCurator(chatId, project.id, project.path);
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
    // Optional: toolCtx is only assigned once setup succeeds, so a throw during agent/tool/prompt
    // assembly above reaches here with it still undefined.
    void toolCtx?.shell.dispose();
  }
}

export interface PromptPreviewBlock {
  label: string;
  content: string;
  cached: boolean;
  approxTokens: number;
}

export interface PromptPreview {
  system: PromptPreviewBlock[];
  ephemeral: { content: string; approxTokens: number };
  conversationTail: { cached: boolean; approxTokens: number } | null;
  /** Names of the tools actually available this turn (after mode/agent narrowing) — not bp1's
   *  full capability list, which is embedded in system[0].content instead. */
  toolNames: string[];
  agentName: string;
  hash: string;
}

// Rough char/4 estimate — no tokenizer is bundled, and this route exists to show relative sizes
// and breakpoint placement, not to bill anything (billing reads the provider's own real usage).
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// docs/PROMPT_STACK_PLAN.md Phase PS1/PS2/PS3 — `GET /chats/:id/prompt-preview`. Deliberately
// rebuilds the same tool map and prompt blocks runTurn would, rather than caching runTurn's own
// output, so what this shows is never stale: a project/mode/catalog change is reflected on the
// next call with no invalidation logic to get wrong. No side effects — the shell/checkpointer/
// diagnostics closures below are never invoked (see tools/shell.ts, checkpoints/index.ts:
// construction alone spawns nothing) and this never joins `activeRuns` or touches abort state.
// Async only because §4.2's volatile env needs a real `git status` read.
export async function getPromptPreview(chatId: string): Promise<PromptPreview | null> {
  const chat = getChat(chatId);
  if (!chat) return null;
  const project = getProject(chat.projectId);
  if (!project) return null;

  const chatRole = getChatRoleModel();
  const providerId = chat.providerId || chatRole.providerId;
  const providerRow = getProvider(providerId);
  if (!providerRow) return null;
  const model = chat.model ?? chatRole.model;
  const apiKey = getSecret(providerId);
  const languageModel = resolveModel(providerRow, model, apiKey);
  const subagentModel = resolveSubagentModel(providerRow, model, apiKey);
  const agent: AgentDef = resolveAgent({ projectId: project.id, projectPath: project.path }, chat.agentId);

  const toolCtx: ToolCtx = {
    chatId,
    projectId: project.id,
    projectPath: project.path,
    mode: chat.mode,
    abortSignal: new AbortController().signal,
    runId: newId(),
    reads: createReadTracker(chatId, project.path),
    checkpoints: createCheckpointer(project.path),
    shell: createShellSession(project.path),
    diagnostics: createDiagnosticRunner(project.path),
    languageModel,
    subagentModel,
  };
  const tools = sortTools({
    ...createTools(toolCtx),
    ...createSkillTools(toolCtx),
    ...createHekuTools(toolCtx),
  });
  const effectiveTools = computeEffectiveTools(tools, chat.mode, agent);

  const cachePolicy = getCachePolicy(providerId, model);
  const promptBlocks: PromptBlocks = buildPrompt({
    tools,
    hekuManifest: buildManifest(),
    staticEnv: getStaticEnv(),
    cache: cachePolicy,
    mode: chat.mode,
    agent,
    effectiveToolNames: Object.keys(effectiveTools),
    projectKnowledge: readProjectKnowledge(project.path),
  });

  const volatileEnv = await getVolatileEnv(project.path);
  const ephemeralText = buildEphemeralText({ volatileEnv });

  const marked = markCacheBoundary(withTodoReminder(chatId, toModelMessages(chatId)), cachePolicy);
  const last = marked[marked.length - 1];
  const conversationTail =
    last == null
      ? null
      : {
          cached: cachePolicy.style === "explicit",
          approxTokens: approxTokens(JSON.stringify(marked)),
        };

  return {
    system: promptBlocks.blocks.map((b) => ({ ...b, approxTokens: approxTokens(b.content) })),
    ephemeral: { content: ephemeralText, approxTokens: approxTokens(ephemeralText) },
    conversationTail,
    toolNames: Object.keys(effectiveTools),
    agentName: agent.name,
    hash: promptBlocks.hash,
  };
}
