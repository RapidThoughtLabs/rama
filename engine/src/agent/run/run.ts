// engine/src/agent/run/run.ts
//
// The core run loop: setup, step execution, terminal state assignment, and teardown.
// Replaces engine/src/agent/loop.ts.
// docs/LOOP_MIGRATION_PLAN.md §6.1, §6.5

import type { ChatMode, GeneralSettingsDTO, TerminalState } from "@rama/protocol";
import { createCheckpointer } from "../../checkpoints";
import { clearModelError, recordModelError } from "../../db/providerModels";
import { createArtifact } from "../../db/artifacts";
import { getChat, recordUsage, stubTitleFromFirstMessage } from "../../db/chats";
import { appendMessage, finalizeMessage } from "../../db/messages";
import { getProject } from "../../db/projects";
import { finalizeOrphanedToolCalls } from "../../db/toolCalls";
import { getProvider, providerRequiresKey, type ProviderRow } from "../../db/providers";
import { getSetting } from "../../db/settings";
import { createDiagnosticRunner } from "../../diagnostics";
import { resolveClient } from "../../llm/client";
import { LlmError } from "../../llm/types";
import type { LlmUsage } from "../../llm/types";
import { getSecret } from "../../secrets";
import { createTools } from "../../tools";
import { createReadTracker } from "../../tools/readTracker";
import { createShellSession } from "../../tools/shell";
import { todoEphemeralBlock } from "../../tools/todo";
import type { ToolCtx } from "../../tools/types";
import { newId } from "../../db/ids";
import { broadcast } from "../../ws";
import { resolveAgent } from "../agents/discover";
import { computeEffectiveTools } from "../agents/effectiveTools";
import type { AgentDef } from "../agents/types";
import { getCachePolicy, getSupportsMidConversationSystem } from "../catalog";
import { classifyComplexity } from "../complexity";
import { formatUnverifiedWrites } from "../completionGate";
import { estimateCostUsdDetailed, getChatRoleModel } from "../config";
import { runCurator } from "../curator/curator";
import { buildManifest } from "../../heku";
import { createHekuTools } from "../../heku/tools";
import { getGlobalInstructions, getProjectInstructions } from "../instructions";
import type { StepLike } from "../loopGuard";
import { buildPrompt, type PromptBlocks } from "../prompt/build";
import { buildEphemeralText, getVolatileEnv } from "../prompt/ephemeral";
import type { ProjectKnowledgeInputs } from "../prompt/project";
import { getStaticEnv } from "../prompt/sources";
import { sortTools } from "../prompt/toolInventory";
import type { RamaToolSet } from "../../tools/define";
import { createSkillTools } from "../../skills/tools";
import { getSubagentTarget } from "../subagentRole";
import { maybeTitleChat } from "../titling";
import { BudgetController } from "./budget";
import { executeStep } from "./step";
import {
  buildTranscriptFromDb,
  clearStepInjected,
  project,
  removeInjectedEntry,
  setInjectedEntry,
  type ProjectionPolicy,
  type Transcript,
} from "./transcript";
import { clearSteeringQueue, enqueueSteeringMessage, runStepHooks } from "./hooks";
import { compactTranscript } from "./compact";

const DEFAULT_TITLE = "New Chat";

// Active run controllers per chat, for user cancellation via interrupt()
const activeRuns = new Map<string, AbortController>();

export function isRunning(chatId: string): boolean {
  return activeRuns.has(chatId);
}

export function interrupt(chatId: string): boolean {
  const controller = activeRuns.get(chatId);
  if (!controller) return false;
  controller.abort();
  return true;
}

function readProjectKnowledge(projectPath: string): ProjectKnowledgeInputs {
  return {
    global: getGlobalInstructions()?.content ?? null,
    project: getProjectInstructions(projectPath)?.content ?? null,
  };
}

/**
 * Names the real cause for a `tool_calls` row that never got a result — created (step.ts, before
 * execution) but the run ended before finalizeToolCall ran for it. docs/LOOP_MENDING_PLAN.md
 * D11/MD3.
 */
export function describeOrphanedToolCallCause(state: TerminalState): string {
  return state === "interrupted-by-user" ? "interrupted" : `run ended (${state}) before this tool call finished`;
}

/**
 * A failure on the single step immediately following a compaction (reactive or proactive) is a
 * compaction bug — an invalid message sequence, or a request that's still too large — not
 * evidence the model itself is broken. Reclassified to "transient" so the outer catch's
 * recordModelError call never marks the model durable/erroring for it; the run still fails.
 * docs/LOOP_MENDING_PLAN.md D2/MD2.
 */
export function reclassifyCompactionRetryError(err: unknown, isCompactionRetryStep: boolean): unknown {
  if (isCompactionRetryStep && LlmError.isInstance(err) && err.kind !== "aborted") {
    return new LlmError(err.message, "transient", { status: err.status, providerCode: err.providerCode, cause: err });
  }
  return err;
}

/**
 * Assembles the system prompt stack and the ProjectionPolicy it feeds into project().
 * The single call site for buildPrompt — runTurn and getPromptPreview both call this and
 * nothing else, so the two paths cannot diverge (docs/LOOP_MENDING_PLAN.md MD0, closes D1).
 * Pure given its inputs; the caller computes it once per run/preview, outside any loop.
 */
export function buildProjectionContext(params: {
  providerId: string;
  model: string;
  tools: RamaToolSet;
  mode: ChatMode;
  agent: AgentDef;
  effectiveToolNames: string[];
  projectPath: string;
}): { promptBlocks: PromptBlocks; policy: ProjectionPolicy } {
  const cachePolicy = getCachePolicy(params.providerId, params.model);
  const promptBlocks = buildPrompt({
    tools: params.tools,
    hekuManifest: buildManifest(),
    staticEnv: getStaticEnv(),
    cache: cachePolicy,
    mode: params.mode,
    agent: params.agent,
    effectiveToolNames: params.effectiveToolNames,
    projectKnowledge: readProjectKnowledge(params.projectPath),
  });
  return {
    promptBlocks,
    policy: {
      cacheStyle: cachePolicy.style,
      supportsMidConversationSystem: getSupportsMidConversationSystem(params.providerId, params.model),
      system: promptBlocks.system,
    },
  };
}

function resolveSubagent(
  parentProviderRow: ProviderRow,
  parentModel: string,
  parentApiKey: string | undefined,
  parentClient: ReturnType<typeof resolveClient>
): { client: ReturnType<typeof resolveClient>; model: string } {
  const target = getSubagentTarget();
  if (!target) return { client: parentClient, model: parentModel };
  const providerRow = getProvider(target.providerId);
  const apiKey = getSecret(target.providerId);
  if (!providerRow || (!apiKey && providerRequiresKey(target.providerId))) {
    return { client: parentClient, model: parentModel };
  }
  try {
    const client = resolveClient(providerRow, target.model, apiKey);
    return { client, model: target.model };
  } catch {
    return { client: parentClient, model: parentModel };
  }
}

/**
 * Run a full turn for a user message.
 * Manages the step loop, tool execution, budget, completion gate, and terminal states.
 * docs/LOOP_MIGRATION_PLAN.md §6.1
 */
export async function runTurn(chatId: string, text: string): Promise<void> {
  const chat = getChat(chatId);
  if (!chat) return;
  const projectRow = getProject(chat.projectId);
  if (!projectRow) return;

  if (activeRuns.has(chatId)) {
    // A run is already active: record the user message in DB, show it in UI, and enqueue for mid-run steering (LM4)
    appendMessage(chatId, { role: "user", content: text });
    broadcast(chatId, { type: "message.user", id: newId(), text, ts: Date.now() });
    enqueueSteeringMessage(chatId, text);
    return;
  }

  // Record user message
  appendMessage(chatId, { role: "user", content: text });
  broadcast(chatId, { type: "message.user", id: newId(), text, ts: Date.now() });

  const isFirstTurn = chat.title === DEFAULT_TITLE;
  const stubTitle = stubTitleFromFirstMessage(chatId, text);
  if (stubTitle) broadcast(chatId, { type: "chat.renamed", chatId, title: stubTitle.title });

  const taskComplexityHint =
    isFirstTurn && (await classifyComplexity(chatId, text, projectRow.path)) === "complex"
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
    broadcast(chatId, {
      type: "error",
      message: `no ${providerRow.label ?? providerId} key configured — add one in settings`,
    });
    return;
  }

  const assistantMessage = appendMessage(chatId, { role: "assistant", content: null });

  const model = chat.model ?? chatRole.model;
  const controller = new AbortController();
  activeRuns.set(chatId, controller);
  const runId = newId();

  let toolCtx: ToolCtx | undefined;
  let fullText = "";
  let fullThinking = "";
  // D6/MD4 — the run's single DB message row collapses every step's reasoning into one string
  // (same as fullThinking); last-write-wins matches that same collapse for the signature that
  // must ride with it.
  let fullReasoningSignature: string | undefined;
  let terminalState: TerminalState = "completed";
  let blockedOnQuestion = false;
  let overflowRetried = false;
  // D3/MD2 — entries.length right after the most recent compaction in this run, so
  // contextPressureHook can refuse to re-fire on a transcript that hasn't grown since.
  let lastCompactionEntryCount: number | null = null;
  // D2/MD2 — true only for the single step immediately following a compaction (reactive or
  // proactive). An LlmError on that step is a compaction bug (an invalid or still-too-large
  // request), never evidence the model itself is broken.
  let pendingCompactionRetryStep = false;
  const stepsHistory: StepLike[] = [];
  const unverifiedWrites = new Set<string>();

  const usageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    noCacheTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };

  try {
    const client = resolveClient(providerRow, model, apiKey);
    const subagent = resolveSubagent(providerRow, model, apiKey, client);
    const agent: AgentDef = resolveAgent({ projectId: projectRow.id, projectPath: projectRow.path }, chat.agentId);

    toolCtx = {
      chatId,
      projectId: projectRow.id,
      projectPath: projectRow.path,
      mode: chat.mode,
      abortSignal: controller.signal,
      runId,
      reads: createReadTracker(chatId, projectRow.path),
      checkpoints: createCheckpointer(projectRow.path),
      shell: createShellSession(projectRow.path),
      diagnostics: createDiagnosticRunner(projectRow.path),
      llmClient: client,
      subagentClient: subagent.client,
      subagentModel: subagent.model,
    };

    const tools = sortTools({
      ...createTools(toolCtx),
      ...createSkillTools(toolCtx),
      ...createHekuTools(toolCtx),
    });

    const effectiveTools = computeEffectiveTools(tools, chat.mode, agent);
    const checkAvailable = "check" in effectiveTools;

    const { policy: projectionPolicy } = buildProjectionContext({
      providerId,
      model,
      tools,
      mode: chat.mode,
      agent,
      effectiveToolNames: Object.keys(effectiveTools),
      projectPath: projectRow.path,
    });

    const volatileEnv = await getVolatileEnv(projectRow.path);

    const transcript: Transcript = buildTranscriptFromDb(chatId);
    const budget = new BudgetController(chat.mode);

    broadcast(chatId, { type: "run.started", runId, ts: Date.now() });
    broadcast(chatId, { type: "status", state: "thinking", verb: "thinking" });

    // -------------------------------------------------------------------------
    // The Step Loop
    // -------------------------------------------------------------------------
    while (budget.nextStep()) {
      if (controller.signal.aborted) {
        terminalState = "interrupted-by-user";
        break;
      }

      // 1. Prepare step: todo reminder
      const todoBlock = todoEphemeralBlock(chatId);
      if (todoBlock) {
        setInjectedEntry(transcript, {
          kind: "injected",
          id: "todo",
          role: "user",
          text: todoBlock,
          tag: "todo",
          ttl: "step",
        });
      } else {
        removeInjectedEntry(transcript, "todo");
      }

      // 2. Trailing ephemeral block
      transcript.ephemeral.text = buildEphemeralText({
        volatileEnv,
        taskComplexityHint,
        unverifiedWrites: formatUnverifiedWrites(unverifiedWrites),
      });

      // 3. Execute step
      const isCompactionRetryStep = pendingCompactionRetryStep;
      pendingCompactionRetryStep = false;
      let stepResult: ReturnType<typeof executeStep> extends Promise<infer R> ? R : never;
      try {
        stepResult = await executeStep({
          chatId,
          runId,
          assistantMessageId: assistantMessage.id,
          client,
          model,
          transcript,
          policy: projectionPolicy,
          tools: effectiveTools,
          toolCtx,
          unverifiedWrites,
          signal: controller.signal,
        });
      } catch (err) {
        // L4 reactive recovery: an overflow LlmError triggers emergency compaction and retries the same step
        if (LlmError.isInstance(err) && err.kind === "overflow" && !overflowRetried) {
          overflowRetried = true;
          broadcast(chatId, { type: "status", state: "thinking", verb: "compacting" });
          const compactionResult = await compactTranscript({
            chatId,
            transcript,
            providerRow,
            model,
            apiKey,
            signal: controller.signal,
            unverifiedWrites,
          });
          lastCompactionEntryCount = transcript.entries.length;
          pendingCompactionRetryStep = true;
          broadcast(chatId, {
            type: "compaction.applied",
            summary: compactionResult.summary,
            tokensSaved: compactionResult.tokensSaved,
          });
          broadcast(chatId, { type: "status", state: "thinking", verb: "thinking" });
          continue; // retry the same step with compacted transcript!
        }
        throw reclassifyCompactionRetryError(err, isCompactionRetryStep);
      }

      if (stepResult.text) {
        fullText += stepResult.text;
      }
      if (stepResult.reasoning) {
        fullThinking += stepResult.reasoning;
      }
      if (stepResult.reasoningSignature) {
        fullReasoningSignature = stepResult.reasoningSignature;
      }

      // Accumulate usage
      usageTotals.inputTokens += stepResult.usage.inputTokens;
      usageTotals.outputTokens += stepResult.usage.outputTokens;
      usageTotals.noCacheTokens += stepResult.usage.noCacheTokens;
      usageTotals.cacheReadTokens += stepResult.usage.cacheReadTokens;
      usageTotals.cacheWriteTokens += stepResult.usage.cacheWriteTokens;
      usageTotals.totalTokens += stepResult.usage.totalTokens;

      // Track step for loop guard
      stepsHistory.push({
        toolCalls: stepResult.toolCalls.map((c) => ({ toolName: c.name, input: c.input })),
      });

      // Clear step-scoped injected entries before next step
      clearStepInjected(transcript);

      // Run hooks in fixed order (§6.4)
      const verdict = await runStepHooks({
        chatId,
        runId,
        signal: controller.signal,
        budget,
        stepsHistory,
        stepResult,
        unverifiedWrites,
        checkAvailable,
        usageTotals,
        lastStepInputTokens: stepResult.usage.inputTokens,
        compactionGuard: { entryCountAtLastCompaction: lastCompactionEntryCount, currentEntryCount: transcript.entries.length },
        contextMax: chat.contextMax,
      });

      if (verdict.action === "stop") {
        terminalState = verdict.state;
        if (verdict.state === "blocked-on-permission") {
          blockedOnQuestion = true;
        }
        if (verdict.note) {
          fullText += (fullText ? "\n\n" : "") + verdict.note;
          broadcast(chatId, { type: "message.delta", runId, text: verdict.note });
        }
        break;
      }

      if (verdict.action === "inject") {
        if (verdict.entry.kind === "injected") {
          setInjectedEntry(transcript, verdict.entry);
        } else {
          transcript.entries.push(verdict.entry);
        }
        broadcast(chatId, { type: "status", state: "thinking", verb: "thinking" });
        continue;
      }

      if (verdict.action === "compact") {
        broadcast(chatId, { type: "status", state: "thinking", verb: "compacting" });
        const compactionResult = await compactTranscript({
          chatId,
          transcript,
          providerRow,
          model,
          apiKey,
          signal: controller.signal,
          unverifiedWrites,
        });
        lastCompactionEntryCount = transcript.entries.length;
        pendingCompactionRetryStep = true;
        broadcast(chatId, {
          type: "compaction.applied",
          summary: compactionResult.summary,
          tokensSaved: compactionResult.tokensSaved,
        });
        broadcast(chatId, { type: "status", state: "thinking", verb: "thinking" });
        continue;
      }

      // If tool calls were made, continue next step
      if (stepResult.toolCalls.length > 0) {
        continue;
      }

      // D8: a `length` finish means the model hit its output token cap mid-answer — it did not
      // choose to stop, so this is not "completed". docs/LOOP_MENDING_PLAN.md D8/MD1.
      if (stepResult.finishReason === "length") {
        const note = "\n\n[Response cut off: the model hit its output token limit.]";
        fullText += note;
        broadcast(chatId, { type: "message.delta", runId, text: note });
        terminalState = "stopped-output-truncated";
        break;
      }

      terminalState = "completed";
      break;
    }

    if (budget.isExhausted() && terminalState === "completed" && !blockedOnQuestion) {
      terminalState = "stopped-by-budget";
    }

    // Finalize assistant message
    finalizeMessage(assistantMessage.id, fullText || null, fullThinking || null, fullReasoningSignature);
    broadcast(chatId, { type: "message.done", runId });

    // Cost & usage accounting
    const { inputTokens, outputTokens, noCacheTokens, cacheReadTokens, cacheWriteTokens, totalTokens: contextUsed } = usageTotals;
    const { usd: costUsd } = estimateCostUsdDetailed(
      providerId,
      model,
      { noCacheTokens, cacheReadTokens, cacheWriteTokens },
      outputTokens
    );
    recordUsage(chatId, { contextUsed, costUsd });
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

    broadcast(chatId, {
      type: "run.finished",
      runId,
      ts: Date.now(),
      state: terminalState,
      ...(blockedOnQuestion ? { summary: "blocked-on-question" } : {}),
    });

    // Fire-and-forget: auto-titling stage 2
    if (isFirstTurn && (getSetting<GeneralSettingsDTO>("general")?.autoNameChats ?? true)) {
      void maybeTitleChat(chatId, text);
    }

    // Fire-and-forget: instructions curator
    if (!blockedOnQuestion) {
      void runCurator(chatId, projectRow.id, projectRow.path);
    }
  } catch (err) {
    const aborted = controller.signal.aborted;
    finalizeMessage(assistantMessage.id, fullText || null, fullThinking || null, fullReasoningSignature);
    broadcast(chatId, { type: "message.done", runId });

    if (aborted) {
      terminalState = "interrupted-by-user";
      broadcast(chatId, {
        type: "run.finished",
        runId,
        ts: Date.now(),
        state: "interrupted-by-user",
        summary: "interrupted",
      });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      broadcast(chatId, { type: "error", message });

      let kind: "durable" | "transient" = "transient";
      if (LlmError.isInstance(err)) {
        if (err.kind === "durable" || err.kind === "overflow") {
          kind = "durable";
          terminalState = "failed-permanent";
        } else {
          terminalState = "failed-transient-exhausted";
        }
      } else {
        terminalState = "failed-transient-exhausted";
      }

      recordModelError(providerId, model, message, kind, Date.now());
      broadcast(chatId, {
        type: "run.finished",
        runId,
        ts: Date.now(),
        state: terminalState,
        summary: message,
      });
    }

    broadcast(chatId, { type: "status", state: aborted ? "idle" : "error" });
  } finally {
    activeRuns.delete(chatId);
    clearSteeringQueue(chatId);
    void toolCtx?.shell.dispose();
    // D11/MD3 — the terminal state is known by now regardless of exit path (normal completion,
    // interrupt, or error), so this is the one place that can finalize every tool_calls row this
    // run left unfinalized, naming the real cause instead of letting it replay as "tool call
    // failed" on the next turn.
    finalizeOrphanedToolCalls(assistantMessage.id, describeOrphanedToolCallCause(terminalState));
  }
}

// ---------------------------------------------------------------------------
// Prompt Preview
// ---------------------------------------------------------------------------

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
  toolNames: string[];
  agentName: string;
  hash: string;
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function getPromptPreview(chatId: string): Promise<PromptPreview | null> {
  const chat = getChat(chatId);
  if (!chat) return null;
  const projectRow = getProject(chat.projectId);
  if (!projectRow) return null;

  const chatRole = getChatRoleModel();
  const providerId = chat.providerId || chatRole.providerId;
  const providerRow = getProvider(providerId);
  if (!providerRow) return null;
  const model = chat.model ?? chatRole.model;
  const apiKey = getSecret(providerId);
  const client = resolveClient(providerRow, model, apiKey);
  const subagent = resolveSubagent(providerRow, model, apiKey, client);
  const agent: AgentDef = resolveAgent({ projectId: projectRow.id, projectPath: projectRow.path }, chat.agentId);

  const toolCtx: ToolCtx = {
    chatId,
    projectId: projectRow.id,
    projectPath: projectRow.path,
    mode: chat.mode,
    abortSignal: new AbortController().signal,
    runId: newId(),
    reads: createReadTracker(chatId, projectRow.path),
    checkpoints: createCheckpointer(projectRow.path),
    shell: createShellSession(projectRow.path),
    diagnostics: createDiagnosticRunner(projectRow.path),
    llmClient: client,
    subagentClient: subagent.client,
    subagentModel: subagent.model,
  };
  const tools = sortTools({
    ...createTools(toolCtx),
    ...createSkillTools(toolCtx),
    ...createHekuTools(toolCtx),
  });
  const effectiveTools = computeEffectiveTools(tools, chat.mode, agent);

  // Same call as runTurn — buildProjectionContext is the only place buildPrompt is invoked, so
  // preview and run cannot diverge again. docs/LOOP_MENDING_PLAN.md MD0.
  const { promptBlocks, policy: projectionPolicy } = buildProjectionContext({
    providerId,
    model,
    tools,
    mode: chat.mode,
    agent,
    effectiveToolNames: Object.keys(effectiveTools),
    projectPath: projectRow.path,
  });
  const cachePolicy = getCachePolicy(providerId, model);

  const volatileEnv = await getVolatileEnv(projectRow.path);
  const ephemeralText = buildEphemeralText({ volatileEnv });

  const transcript = buildTranscriptFromDb(chatId);
  const todoBlock = todoEphemeralBlock(chatId);
  if (todoBlock) {
    setInjectedEntry(transcript, {
      kind: "injected",
      id: "todo",
      role: "user",
      text: todoBlock,
      tag: "todo",
      ttl: "step",
    });
  }
  const wireMessages = project(transcript, projectionPolicy);

  // The tail is the last durable message before the ephemeral block — the one line project()
  // marks with cacheBreakpoint — not the whole projected array. docs/LOOP_MENDING_PLAN.md G5.
  const systemCount = projectionPolicy.system?.length ?? 0;
  const tailMessage = wireMessages.length > systemCount ? wireMessages[wireMessages.length - 1] : undefined;
  const conversationTail =
    tailMessage == null
      ? null
      : {
          cached: cachePolicy.style === "explicit",
          approxTokens: approxTokens(
            typeof tailMessage.content === "string" ? tailMessage.content : JSON.stringify(tailMessage.content)
          ),
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
