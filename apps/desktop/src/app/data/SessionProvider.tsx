import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ArtifactDTO, MessageDTO, SessionStatusState, ToolCallDTO } from "@rama/protocol";
import { fetchArtifacts, fetchMessages, fetchToolCalls } from "../../engine/client";
import { onEvent, send } from "../../engine/ws";
import { useProjectsData } from "./ProjectsProvider";

// Phase 2 — live conversation state (docs/IMPLEMENTATION_PLAN.md Phase 2), layered on top of
// ProjectsProvider's activeChatId. Deliberately a separate context: Projects/Chats CRUD +
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
  sendUserTurn: (text: string) => void;
  interrupt: () => void;
  approvePermission: (reqId: string, approve: boolean) => void;
}

const DEFAULT_STATUS: ChatStatus = { state: "idle", runStartedAt: null };

const SessionContext = createContext<SessionDataValue | null>(null);

interface PendingAssistantMessage {
  runId: string;
  text: string;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const { activeChatId } = useProjectsData();
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
          }));
          break;
        case "run.started":
          activeRunIdByChatRef.current = { ...activeRunIdByChatRef.current, [chatId]: event.runId };
          setStatusByChat((prev) => ({ ...prev, [chatId]: { state: "thinking", runStartedAt: event.ts } }));
          setErrorByChat((prev) => ({ ...prev, [chatId]: undefined }));
          // Seeded empty (not on first text delta) so a stable `pending-${runId}` message id
          // exists from the start of the run for tool-call cards to attach to, even if the
          // run's first step is a tool call with no text before it.
          setPendingByChat((prev) => ({ ...prev, [chatId]: { runId: event.runId, text: "" } }));
          break;
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
        case "message.delta":
          setPendingByChat((prev) => {
            const existing = prev[chatId];
            const text = existing && existing.runId === event.runId ? existing.text + event.text : event.text;
            return { ...prev, [chatId]: { runId: event.runId, text } };
          });
          break;
        case "message.done":
          setPendingByChat((prev) => {
            const pending = prev[chatId];
            if (pending && pending.text) {
              appendLocalMessage(chatId, (seq) => ({
                id: `local-${event.runId}`,
                chatId,
                seq,
                role: "assistant",
                content: pending.text,
                thinking: null,
                createdAt: Date.now(),
              }));
            }
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
        case "usage.update":
          setUsageByChat((prev) => ({
            ...prev,
            [chatId]: {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              contextUsed: event.contextUsed,
              contextMax: event.contextMax,
            },
          }));
          break;
        case "cost.update":
          setCostByChat((prev) => ({ ...prev, [chatId]: event.usd }));
          break;
        case "error":
          setErrorByChat((prev) => ({ ...prev, [chatId]: event.message }));
          break;
        case "tool.call": {
          const runId = activeRunIdByChatRef.current[chatId];
          const messageId = runId ? `pending-${runId}` : `pending-unknown`;
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
    (text: string) => {
      const trimmed = text.trim();
      if (!activeChatId || !trimmed) return;
      void send({ type: "sendUserTurn", chatId: activeChatId, text: trimmed });
    },
    [activeChatId],
  );

  const interrupt = useCallback(() => {
    if (!activeChatId) return;
    void send({ type: "interrupt", chatId: activeChatId });
  }, [activeChatId]);

  const approvePermission = useCallback((reqId: string, approve: boolean) => {
    void send({ type: "approvePermission", reqId, approve });
  }, []);

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
      thinking: null,
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
      interrupt,
      approvePermission,
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
      interrupt,
      approvePermission,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSessionData(): SessionDataValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSessionData must be used within a SessionProvider");
  return ctx;
}
