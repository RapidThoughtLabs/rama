import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ArtifactDTO, ChatBlock, MessageDTO, PermissionScope, SessionStatusState, ToolCallDTO } from "@rama/protocol";
import { fetchArtifacts, fetchMessages, fetchToolCalls, retryTurn, undoLastRun } from "../../engine/client";
import { onEvent, send } from "../../engine/ws";
import { useNavigation } from "./NavigationProvider";
import { useProjectsData } from "./ProjectsProvider";

// Phase 2 — live conversation state (docs/IMPLEMENTATION_PLAN.md Phase 2), layered on top of
// the active chat id (useActiveSessionChatId below: ProjectsProvider's, or Home's since HD3). Deliberately a separate context: Projects/Chats CRUD +
// theme is Phase 1's concern, this one owns the WS event stream / streaming message buffer.
// Phase 3 extends it with live tool calls, artifacts, and permission requests.

export interface ChatStatus {
  state: SessionStatusState;
  verb?: string;
  runStartedAt: number | null;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  contextUsed: number;
  contextMax: number;
  // docs/PROMPT_STACK_PLAN.md Phase PS1 — undefined for a chat that hasn't sent a turn since
  // caching landed, or for a provider that doesn't report the split.
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  noCacheTokens?: number;
}

export interface PendingPermission {
  reqId: string;
  tool: string;
  input: unknown;
  risk: "low" | "high";
}

interface SessionDataValue {
  messages: MessageDTO[];
  status: ChatStatus;
  usage: UsageInfo | null;
  costUsd: number | null;
  errorMessage: string | null;
  toolCalls: ToolCallDTO[];
  artifacts: ArtifactDTO[];
  artifactBuffers: Record<string, string>;
  pendingPermission: PendingPermission | null;
  /** HD7 — `attachmentIds` are Home uploads to go on this turn; with them, the text may be empty. */
  sendUserTurn: (text: string, attachmentIds?: string[]) => void;
  /** Same as `sendUserTurn`, but for a chat that isn't `activeChatId` yet — a chat this render
   *  just created from a draft, before the `selectChat` that made it active has re-rendered.
   *  Subscribes first so the run's events aren't missed (engine/src/server.ts's `broadcast`
   *  only reaches sockets that called `subscribeChat` for that chat id). */
  sendUserTurnTo: (chatId: string, text: string, attachmentIds?: string[]) => void;
  interrupt: () => void;
  approvePermission: (reqId: string, approve: boolean, scope?: PermissionScope) => void;
  /** docs/TOOL_LAYER_PLAN.md §5.2 — `/undo`: restores the project's files to the state before
   *  the last run and drops a local system-style note into the transcript with the result. */
  restoreLastRun: () => void;
  /** HOME_REDESIGN_PLAN.md HD6 — Home's "Try again": drops a user turn (its 0-based position among
   *  the user messages; the last when omitted) and everything after it, here and in the engine,
   *  which then runs the same text again. */
  retryTurn: (userTurn?: number) => void;
}

const DEFAULT_STATUS: ChatStatus = { state: "idle", runStartedAt: null };

/** HOME_REDESIGN_PLAN.md Phase HD3 — the one chat this window's live session follows: the open
 *  Home chat while the Home section is showing, the active Code chat otherwise. Still one live
 *  session per window, as before. */
export function useActiveSessionChatId(): string | null {
  const { section, homeChatId } = useNavigation();
  const { activeChatId } = useProjectsData();
  return section === "home" ? homeChatId : activeChatId;
}

const SessionContext = createContext<SessionDataValue | null>(null);

interface PendingAssistantMessage {
  runId: string;
  text: string;
  thinking?: string;
  /** Set once `thinking.done` arrives — docs/LOOP_MENDING_PLAN.md D9/MD6. */
  thinkingDurationMs?: number;
  blocks: ChatBlock[];
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const activeChatId = useActiveSessionChatId();
  const [messagesByChat, setMessagesByChat] = useState<Record<string, MessageDTO[]>>({});
  const [pendingByChat, setPendingByChat] = useState<Record<string, PendingAssistantMessage | undefined>>({});
  const [statusByChat, setStatusByChat] = useState<Record<string, ChatStatus>>({});
  const [usageByChat, setUsageByChat] = useState<Record<string, UsageInfo>>({});
  const [costByChat, setCostByChat] = useState<Record<string, number>>({});
  const [errorByChat, setErrorByChat] = useState<Record<string, string | undefined>>({});
  const [toolCallsByChat, setToolCallsByChat] = useState<Record<string, ToolCallDTO[]>>({});
  const [artifactsByChat, setArtifactsByChat] = useState<Record<string, ArtifactDTO[]>>({});
  const [artifactBuffers, setArtifactBuffers] = useState<Record<string, string>>({});
  const [pendingPermissionByChat, setPendingPermissionByChat] = useState<Record<string, PendingPermission | undefined>>(
    {},
  );

  const appendLocalMessage = useCallback((chatId: string, build: (nextSeq: number) => MessageDTO) => {
    setMessagesByChat((prev) => {
      const list = prev[chatId] ?? [];
      const nextSeq = (list[list.length - 1]?.seq ?? 0) + 1;
      return { ...prev, [chatId]: [...list, build(nextSeq)] };
    });
  }, []);

  // Tracks the current run's id per chat outside React state — tool.call events need it to
  // tag which (still-pending) message they belong to, but reading it from a ref instead of
  // state avoids re-subscribing the WS listener below on every delta.
  const activeRunIdByChatRef = useRef<Record<string, string>>({});

  // Tracks which runs made at least one tool call, outside React state for the same reason as
  // activeRunIdByChatRef above. A run that ends with a tool call and no closing text (common
  // once the model has 16+ tools to reach for, and stopWhen: stepCountIs(8) can cut a turn off
  // mid-loop) must still leave its tool-call cards visible — see message.done below.
  const hadToolCallsByRunIdRef = useRef<Record<string, boolean>>({});

  // Mirror of pending assistant message buffer per chat outside React state.
  // docs/CHAT_VIEW_PLAN.md CV0 — reading pending message from a ref at `message.done` lets
  // appendLocalMessage be called as an ordinary sequential action rather than inside the
  // setPendingByChat updater, preventing React.StrictMode from appending the message twice.
  const pendingByChatRef = useRef<Record<string, PendingAssistantMessage | undefined>>({});

  // Single global listener for the whole app-lifetime WS connection; every event carries its
  // own chatId (see engine/src/ws.ts's broadcast envelope), so this doesn't need to know which
  // chat is "active" — it just files events under the chat they belong to.
  useEffect(() => {
    return onEvent((chatId, event) => {
      switch (event.type) {
        case "message.user":
          appendLocalMessage(chatId, (seq) => ({
            id: event.id,
            chatId,
            seq,
            role: "user",
            content: event.text,
            thinking: null,
            createdAt: event.ts,
            ...(event.attachments?.length ? { attachments: event.attachments } : {}),
          }));
          break;
        case "run.started": {
          activeRunIdByChatRef.current = { ...activeRunIdByChatRef.current, [chatId]: event.runId };
          setStatusByChat((prev) => ({ ...prev, [chatId]: { state: "thinking", runStartedAt: event.ts } }));
          setErrorByChat((prev) => ({ ...prev, [chatId]: undefined }));
          // Seeded empty (not on first text delta) so a stable `pending-${runId}` message id
          // exists from the start of the run for tool-call cards to attach to, even if the
          // run's first step is a tool call with no text before it.
          const initialPending: PendingAssistantMessage = { runId: event.runId, text: "", blocks: [] };
          pendingByChatRef.current[chatId] = initialPending;
          setPendingByChat((prev) => ({ ...prev, [chatId]: initialPending }));
          break;
        }
        case "status":
          setStatusByChat((prev) => ({
            ...prev,
            [chatId]: {
              state: event.state,
              verb: event.verb,
              runStartedAt:
                event.state === "idle" || event.state === "error" ? null : (prev[chatId]?.runStartedAt ?? null),
            },
          }));
          if (event.state !== "waiting_permission") {
            setPendingPermissionByChat((prev) => (prev[chatId] ? { ...prev, [chatId]: undefined } : prev));
          }
          break;
        case "thinking.delta": {
          const existing = pendingByChatRef.current[chatId];
          const thinking =
            existing && existing.runId === event.runId
              ? (existing.thinking ?? "") + event.text
              : event.text;

          const stepIndex = event.stepIndex ?? 0;
          const blockIndex = event.blockIndex ?? 0;
          const nextBlocks: ChatBlock[] = existing && existing.runId === event.runId ? [...existing.blocks] : [];
          const matchIdx = nextBlocks.findIndex(
            (b) => b.kind === "thinking" && b.stepIndex === stepIndex && b.blockIndex === blockIndex,
          );

          if (matchIdx !== -1) {
            const current = nextBlocks[matchIdx] as ChatBlock & { kind: "thinking" };
            nextBlocks[matchIdx] = {
              ...current,
              text: current.text + event.text,
            };
          } else {
            nextBlocks.push({
              kind: "thinking",
              text: event.text,
              stepIndex,
              blockIndex,
            });
          }

          const nextPending: PendingAssistantMessage = {
            runId: event.runId,
            text: existing?.text ?? "",
            thinking,
            thinkingDurationMs: existing?.thinkingDurationMs,
            blocks: nextBlocks,
          };
          pendingByChatRef.current[chatId] = nextPending;
          setPendingByChat((prev) => ({
            ...prev,
            [chatId]: nextPending,
          }));
          break;
        }
        case "message.delta": {
          const existing = pendingByChatRef.current[chatId];
          const text = existing && existing.runId === event.runId ? existing.text + event.text : event.text;

          const stepIndex = event.stepIndex ?? 0;
          const blockIndex = event.blockIndex ?? 0;
          const nextBlocks: ChatBlock[] = existing && existing.runId === event.runId ? [...existing.blocks] : [];
          const matchIdx = nextBlocks.findIndex(
            (b) => b.kind === "text" && b.stepIndex === stepIndex && b.blockIndex === blockIndex,
          );

          if (matchIdx !== -1) {
            const current = nextBlocks[matchIdx] as ChatBlock & { kind: "text" };
            nextBlocks[matchIdx] = {
              ...current,
              text: current.text + event.text,
            };
          } else {
            nextBlocks.push({
              kind: "text",
              text: event.text,
              stepIndex,
              blockIndex,
            });
          }

          const nextPending: PendingAssistantMessage = {
            runId: event.runId,
            text,
            thinking: existing?.thinking,
            thinkingDurationMs: existing?.thinkingDurationMs,
            blocks: nextBlocks,
          };
          pendingByChatRef.current[chatId] = nextPending;
          setPendingByChat((prev) => ({
            ...prev,
            [chatId]: nextPending,
          }));
          break;
        }
        // docs/LOOP_MENDING_PLAN.md D9/MD6 — was previously falling into `default: break`, so the
        // reasoning phase never had a visible end: the collapsible block stayed labeled "thinking"
        // forever, live or after reload alike, with no sign the model had actually finished.
        case "thinking.done": {
          const existing = pendingByChatRef.current[chatId];
          if (existing && existing.runId === event.runId) {
            const nextBlocks: ChatBlock[] = [...existing.blocks];
            const stepIndex = event.stepIndex;
            const blockIndex = event.blockIndex;
            let matchIdx = -1;
            if (stepIndex != null && blockIndex != null) {
              matchIdx = nextBlocks.findIndex(
                (b) => b.kind === "thinking" && b.stepIndex === stepIndex && b.blockIndex === blockIndex,
              );
            }
            if (matchIdx === -1) {
              for (let i = nextBlocks.length - 1; i >= 0; i--) {
                if (nextBlocks[i].kind === "thinking") {
                  matchIdx = i;
                  break;
                }
              }
            }
            if (matchIdx !== -1) {
              const current = nextBlocks[matchIdx] as ChatBlock & { kind: "thinking" };
              nextBlocks[matchIdx] = { ...current, durationMs: event.durationMs };
            }
            const nextPending: PendingAssistantMessage = {
              ...existing,
              thinkingDurationMs: event.durationMs,
              blocks: nextBlocks,
            };
            pendingByChatRef.current[chatId] = nextPending;
            setPendingByChat((prev) => ({ ...prev, [chatId]: nextPending }));
          }
          break;
        }
        case "message.done": {
          const hadToolCalls = hadToolCallsByRunIdRef.current[event.runId] ?? false;
          delete hadToolCallsByRunIdRef.current[event.runId];
          const pending = pendingByChatRef.current[chatId];
          delete pendingByChatRef.current[chatId];

          // A turn that ended on a tool call with no closing text still needs its message row
          // materialized — otherwise the re-tag below points tool-call cards at a message id
          // that was never created, and they vanish the instant the run finishes.
          if (pending && (pending.text || hadToolCalls || pending.thinking || (pending.blocks && pending.blocks.length > 0))) {
            appendLocalMessage(chatId, (seq) => ({
              id: `local-${event.runId}`,
              chatId,
              seq,
              role: "assistant",
              content: pending.text,
              thinking: pending.thinking ?? null,
              thinkingDurationMs: pending.thinkingDurationMs,
              blocks: pending.blocks,
              createdAt: Date.now(),
            }));
          }
          setPendingByChat((prev) => {
            if (!(chatId in prev)) return prev;
            const next = { ...prev };
            delete next[chatId];
            return next;
          });
          // Re-tag any tool calls filed under the pending bubble's synthetic id so they stay
          // attached once that bubble becomes a real local message.
          setToolCallsByChat((prev) => {
            const list = prev[chatId];
            if (!list || list.length === 0) return prev;
            const fromId = `pending-${event.runId}`;
            const toId = `local-${event.runId}`;
            const remapped = list.map((tc) => (tc.messageId === fromId ? { ...tc, messageId: toId } : tc));
            return { ...prev, [chatId]: remapped };
          });
          break;
        }
        case "usage.update":
          setUsageByChat((prev) => ({
            ...prev,
            [chatId]: {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              contextUsed: event.contextUsed,
              contextMax: event.contextMax,
              cacheReadTokens: event.cacheReadTokens,
              cacheWriteTokens: event.cacheWriteTokens,
              noCacheTokens: event.noCacheTokens,
            },
          }));
          break;
        case "cost.update":
          setCostByChat((prev) => ({ ...prev, [chatId]: event.usd }));
          break;
        case "error":
          setErrorByChat((prev) => ({ ...prev, [chatId]: event.message }));
          break;
        // docs/LOOP_MENDING_PLAN.md D9/MD6 — LM5 promised the user is told when compaction runs;
        // this was firing into `default: break` and never reaching the transcript at all. A
        // local system-role note, same mechanism as /undo's result note below.
        case "compaction.applied":
          appendLocalMessage(chatId, (seq) => ({
            id: `compaction-${Date.now()}`,
            chatId,
            seq,
            role: "system",
            content:
              `Conversation compacted — older turns summarized.` +
              (event.summary ? ` ${event.summary}` : "") +
              (event.tokensSaved ? ` (~${event.tokensSaved.toLocaleString()} tokens saved)` : ""),
            thinking: null,
            createdAt: Date.now(),
          }));
          break;
        case "tool.call": {
          const runId = activeRunIdByChatRef.current[chatId];
          const messageId = runId ? `pending-${runId}` : `pending-unknown`;
          if (runId) hadToolCallsByRunIdRef.current[runId] = true;

          const existing = pendingByChatRef.current[chatId];
          if (existing) {
            const nextBlocks = [...existing.blocks];
            const alreadyHas = nextBlocks.some((b) => b.kind === "tool" && b.callId === event.callId);
            if (!alreadyHas) {
              nextBlocks.push({
                kind: "tool",
                callId: event.callId,
                stepIndex: event.stepIndex,
                blockIndex: event.blockIndex,
              });
            }
            const nextPending: PendingAssistantMessage = {
              ...existing,
              blocks: nextBlocks,
            };
            pendingByChatRef.current[chatId] = nextPending;
            setPendingByChat((prev) => ({ ...prev, [chatId]: nextPending }));
          }

          setToolCallsByChat((prev) => {
            const list = prev[chatId] ?? [];
            const entry: ToolCallDTO = {
              id: event.callId,
              messageId,
              chatId,
              name: event.name,
              input: event.input,
              ok: null,
              resultSummary: null,
              startedAt: event.ts,
              endedAt: null,
              artifactId: null,
            };
            return { ...prev, [chatId]: [...list, entry] };
          });
          break;
        }
        case "tool.result":
          setToolCallsByChat((prev) => {
            const list = prev[chatId];
            if (!list) return prev;
            const idx = list.findIndex((tc) => tc.id === event.callId);
            if (idx === -1) return prev;
            const nextList = [...list];
            nextList[idx] = {
              ...nextList[idx],
              ok: event.ok,
              resultSummary: event.summary,
              endedAt: Date.now(),
              artifactId: event.artifactId ?? null,
            };
            return { ...prev, [chatId]: nextList };
          });
          break;
        case "artifact.created":
          setArtifactsByChat((prev) => {
            const list = prev[chatId] ?? [];
            const entry: ArtifactDTO = {
              id: event.artifactId,
              chatId,
              projectId: "",
              messageId: null,
              toolCallId: null,
              kind: event.kind,
              name: event.name,
              meta: event.meta as Record<string, unknown>,
              size: 0,
              status: "streaming",
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
            return { ...prev, [chatId]: [entry, ...list] };
          });
          break;
        case "artifact.updated":
          if (event.delta) {
            setArtifactBuffers((prev) => ({ ...prev, [event.artifactId]: (prev[event.artifactId] ?? "") + event.delta }));
          }
          setArtifactsByChat((prev) => {
            const list = prev[chatId];
            if (!list) return prev;
            const idx = list.findIndex((a) => a.id === event.artifactId);
            if (idx === -1) return prev;
            const nextList = [...list];
            nextList[idx] = { ...nextList[idx], status: event.status, updatedAt: Date.now() };
            return { ...prev, [chatId]: nextList };
          });
          break;
        case "permission.request":
          setPendingPermissionByChat((prev) => ({
            ...prev,
            [chatId]: { reqId: event.reqId, tool: event.tool, input: event.input, risk: event.risk },
          }));
          break;
        default:
          break;
      }
    });
  }, [appendLocalMessage]);

  const activeChatIdRef = useRef<string | null>(null);

  useEffect(() => {
    const prevChatId = activeChatIdRef.current;
    if (prevChatId && prevChatId !== activeChatId) {
      void send({ type: "unsubscribeChat", chatId: prevChatId });
    }
    activeChatIdRef.current = activeChatId;
    if (!activeChatId) return;

    void send({ type: "subscribeChat", chatId: activeChatId });

    let cancelled = false;
    fetchMessages(activeChatId)
      .then((history) => {
        if (cancelled) return;
        setMessagesByChat((prev) => ({ ...prev, [activeChatId]: history }));
      })
      .catch((err) => {
        console.error("[rama] failed to fetch chat history", err);
      });
    fetchToolCalls(activeChatId)
      .then((history) => {
        if (cancelled) return;
        setToolCallsByChat((prev) => ({ ...prev, [activeChatId]: history }));
      })
      .catch((err) => {
        console.error("[rama] failed to fetch tool calls", err);
      });
    fetchArtifacts(activeChatId)
      .then((history) => {
        if (cancelled) return;
        setArtifactsByChat((prev) => ({ ...prev, [activeChatId]: history }));
      })
      .catch((err) => {
        console.error("[rama] failed to fetch artifacts", err);
      });

    return () => {
      cancelled = true;
    };
  }, [activeChatId]);

  const sendUserTurn = useCallback(
    (text: string, attachmentIds?: string[]) => {
      const trimmed = text.trim();
      if (!activeChatId || (!trimmed && !attachmentIds?.length)) return;
      void send({ type: "sendUserTurn", chatId: activeChatId, text: trimmed, ...(attachmentIds?.length ? { attachmentIds } : {}) });
    },
    [activeChatId],
  );

  const sendUserTurnTo = useCallback((chatId: string, text: string, attachmentIds?: string[]) => {
    const trimmed = text.trim();
    if (!trimmed && !attachmentIds?.length) return;
    void send({ type: "subscribeChat", chatId });
    void send({ type: "sendUserTurn", chatId, text: trimmed, ...(attachmentIds?.length ? { attachmentIds } : {}) });
  }, []);

  const interrupt = useCallback(() => {
    if (!activeChatId) return;
    void send({ type: "interrupt", chatId: activeChatId });
  }, [activeChatId]);

  const approvePermission = useCallback((reqId: string, approve: boolean, scope?: PermissionScope) => {
    void send({ type: "approvePermission", reqId, approve, scope });
  }, []);

  const restoreLastRun = useCallback(() => {
    const chatId = activeChatId;
    if (!chatId) return;
    undoLastRun(chatId)
      .then((result) => {
        appendLocalMessage(chatId, (seq) => ({
          id: `undo-${Date.now()}`,
          chatId,
          seq,
          role: "system",
          content: result.message,
          thinking: null,
          createdAt: Date.now(),
        }));
      })
      .catch((err) => {
        appendLocalMessage(chatId, (seq) => ({
          id: `undo-${Date.now()}`,
          chatId,
          seq,
          role: "system",
          content: `undo failed: ${err instanceof Error ? err.message : String(err)}`,
          thinking: null,
          createdAt: Date.now(),
        }));
      });
  }, [activeChatId, appendLocalMessage]);

  const retry = useCallback(
    (userTurn?: number) => {
      const chatId = activeChatId;
      if (!chatId) return;
      setMessagesByChat((prev) => {
        const list = prev[chatId] ?? [];
        const users = list.flatMap((m, i) => (m.role === "user" ? [i] : []));
        const cut = userTurn === undefined ? users[users.length - 1] : users[userTurn];
        return cut === undefined ? prev : { ...prev, [chatId]: list.slice(0, cut) };
      });
      setErrorByChat((prev) => ({ ...prev, [chatId]: undefined }));
      retryTurn(chatId, userTurn).catch((err) => {
        console.error("[rama] try again failed", err);
        setErrorByChat((prev) => ({ ...prev, [chatId]: err instanceof Error ? err.message : String(err) }));
        // The engine refused, so nothing was dropped there: put the transcript back.
        fetchMessages(chatId)
          .then((history) => setMessagesByChat((prev) => ({ ...prev, [chatId]: history })))
          .catch(() => {});
      });
    },
    [activeChatId],
  );

  const messages = useMemo(() => {
    const base = activeChatId ? (messagesByChat[activeChatId] ?? []) : [];
    const pending = activeChatId ? pendingByChat[activeChatId] : undefined;
    if (!pending) return base;
    const seq = (base[base.length - 1]?.seq ?? 0) + 1;
    const pendingMessage: MessageDTO = {
      id: `pending-${pending.runId}`,
      chatId: activeChatId as string,
      seq,
      role: "assistant",
      content: pending.text,
      thinking: pending.thinking ?? null,
      thinkingDurationMs: pending.thinkingDurationMs,
      blocks: pending.blocks,
      createdAt: Date.now(),
    };
    return [...base, pendingMessage];
  }, [activeChatId, messagesByChat, pendingByChat]);

  const value = useMemo<SessionDataValue>(
    () => ({
      messages,
      status: (activeChatId && statusByChat[activeChatId]) || DEFAULT_STATUS,
      usage: (activeChatId && usageByChat[activeChatId]) || null,
      costUsd: activeChatId && activeChatId in costByChat ? costByChat[activeChatId] : null,
      errorMessage: (activeChatId && errorByChat[activeChatId]) || null,
      toolCalls: (activeChatId && toolCallsByChat[activeChatId]) || [],
      artifacts: (activeChatId && artifactsByChat[activeChatId]) || [],
      artifactBuffers,
      pendingPermission: (activeChatId && pendingPermissionByChat[activeChatId]) || null,
      sendUserTurn,
      sendUserTurnTo,
      interrupt,
      approvePermission,
      restoreLastRun,
      retryTurn: retry,
    }),
    [
      messages,
      activeChatId,
      statusByChat,
      usageByChat,
      costByChat,
      errorByChat,
      toolCallsByChat,
      artifactsByChat,
      artifactBuffers,
      pendingPermissionByChat,
      sendUserTurn,
      sendUserTurnTo,
      interrupt,
      approvePermission,
      restoreLastRun,
      retry,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSessionData(): SessionDataValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSessionData must be used within a SessionProvider");
  return ctx;
}
