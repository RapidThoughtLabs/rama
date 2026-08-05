import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Button, SegmentedControl } from "@rama/ui";
import type { ChatMode, ToolCallDTO } from "@rama/protocol";
import { patchChat } from "../engine/client";
import { useProjectsData } from "./data/ProjectsProvider";
import { useSessionData } from "./data/SessionProvider";
import { ModelPicker } from "./ModelPicker";

const MODES: { id: ChatMode; label: string }[] = [
  { id: "agent", label: "agent" },
  { id: "plan", label: "plan" },
  { id: "ask", label: "ask" },
];

function formatTokens(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatToolTarget(name: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "read":
    case "write":
    case "edit":
    case "ls":
      return typeof obj.path === "string" ? obj.path : "";
    case "grep": {
      const pattern = typeof obj.pattern === "string" ? obj.pattern : "";
      const path = typeof obj.path === "string" ? obj.path : "";
      return `"${pattern}"${path ? ` ${path}` : ""}`;
    }
    case "bash":
      return typeof obj.command === "string" ? obj.command : "";
    default:
      return "";
  }
}

function renderResultSummary(summary: string): ReactNode {
  const match = summary.match(/^\+(\d+) −(\d+)$/);
  if (!match) return <span>{summary}</span>;
  return (
    <>
      <span style={{ color: "var(--good)" }}>+{match[1]}</span> <span style={{ color: "var(--bad)" }}>−{match[2]}</span>
    </>
  );
}

function ToolCallCard({ toolCall }: { toolCall: ToolCallDTO }) {
  const dotColor = toolCall.ok === null ? "var(--accent)" : toolCall.ok ? "var(--good)" : "var(--bad)";
  return (
    <div className="rama-tool-call">
      <div className="rama-tool-call-head">
        <span className="rama-tool-call-status" style={{ color: dotColor }}>
          ●
        </span>
        <span className="rama-tool-call-name">{toolCall.name}</span>
        <span className="rama-tool-call-target">{formatToolTarget(toolCall.name, toolCall.input)}</span>
      </div>
      <div className="rama-tool-call-result">
        <span>⎿</span>
        {toolCall.resultSummary ? renderResultSummary(toolCall.resultSummary) : <span>running…</span>}
      </div>
    </div>
  );
}

export function ChatColumn() {
  const { projects, allChats, activeChatId } = useProjectsData();
  const {
    messages,
    status,
    usage,
    costUsd,
    errorMessage,
    toolCalls,
    pendingPermission,
    sendUserTurn,
    interrupt,
    approvePermission,
  } = useSessionData();

  const activeChat = allChats.find((c) => c.id === activeChatId);
  const activeProject = activeChat ? projects.find((p) => p.id === activeChat.projectId) : undefined;

  const toolCallsByMessage = useMemo(() => {
    const map: Record<string, ToolCallDTO[]> = {};
    for (const tc of toolCalls) {
      (map[tc.messageId] ??= []).push(tc);
    }
    return map;
  }, [toolCalls]);

  const [typed, setTyped] = useState("");
  const [mode, setMode] = useState<ChatMode>(activeChat?.mode ?? "agent");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());

  // Resync only on chat switch, not on every activeChat field change — an optimistic mode
  // change (below) shouldn't get clobbered by a stale patchChat response for the same chat.
  useEffect(() => {
    setMode(activeChat?.mode ?? "agent");
  }, [activeChat?.id]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [typed]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const isBusy = status.state === "thinking" || status.state === "streaming";

  useEffect(() => {
    if (!isBusy || !status.runStartedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isBusy, status.runStartedAt]);

  function handleModeChange(next: ChatMode) {
    setMode(next);
    if (activeChat) {
      patchChat(activeChat.id, { mode: next }).catch((err) => {
        console.error("[rama] failed to persist mode", err);
      });
    }
  }

  function submit() {
    if (!activeChat || isBusy) return;
    const text = typed;
    if (!text.trim()) return;
    sendUserTurn(text);
    setTyped("");
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (isBusy) interrupt();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  const contextUsed = usage?.contextUsed ?? activeChat?.contextUsed ?? 0;
  const contextMax = usage?.contextMax ?? activeChat?.contextMax ?? 200000;
  const contextPct = contextMax > 0 ? Math.min(100, (contextUsed / contextMax) * 100) : 0;
  const cost = costUsd ?? activeChat?.costUsd ?? 0;
  const elapsedSeconds = status.runStartedAt ? Math.max(0, Math.round((now - status.runStartedAt) / 1000)) : 0;

  return (
    <div className="rama-chat-column">
      <div className="rama-chat-header">
        <span style={{ color: "rgba(var(--ink),0.65)" }}>⌂ {activeProject?.name ?? "—"}</span>
        <span style={{ opacity: 0.4 }}>›</span>
        <span style={{ color: "var(--accent-bright, var(--accent))" }}>{activeChat?.title ?? "no chat selected"}</span>
        <span style={{ flex: 1 }} />
        <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
          ctx
          <span className="rama-ctx-meter">
            <span className="rama-ctx-meter-fill" style={{ width: `${contextPct}%` }} />
          </span>
          {formatTokens(contextUsed)} / {formatTokens(contextMax)}
        </span>
        <span style={{ opacity: 0.35 }}>·</span>
        <span>${cost.toFixed(2)}</span>
      </div>

      <div className="rama-messages">
        <div className="rama-messages-inner">
          {messages.length === 0 && (
            <div className="rama-msg-meta">
              {activeChat ? "no messages yet — say something." : "select or create a chat to get started."}
            </div>
          )}

          {messages.map((msg) => {
            if (msg.role === "system") {
              return (
                <div key={msg.id} className="rama-msg-meta">
                  {msg.content}
                </div>
              );
            }
            if (msg.role === "user")
              return (
                <div key={msg.id} className="rama-msg-user">
                  <span className="rama-msg-user-glyph">❯</span>
                  <span className="rama-msg-user-text">{msg.content}</span>
                </div>
              );
            return (
              <div key={msg.id}>
                {(toolCallsByMessage[msg.id] ?? []).map((tc) => (
                  <ToolCallCard key={tc.id} toolCall={tc} />
                ))}
                {msg.content && (
                  <div className="rama-msg-assistant">
                    <span className="rama-msg-assistant-glyph">◆</span>
                    <div className="rama-msg-assistant-text">{msg.content}</div>
                  </div>
                )}
              </div>
            );
          })}

          {errorMessage && (
            <div className="rama-status-line">
              <span style={{ color: "#e5484d" }}>⚠ {errorMessage}</span>
            </div>
          )}

          {pendingPermission && (
            <div
              className="rama-tool-call"
              style={{ background: "rgba(var(--warn-rgb),0.06)", border: "1px solid rgba(var(--warn-rgb),0.25)" }}
            >
              <div className="rama-tool-call-head">
                <span style={{ color: "var(--warn)" }}>●</span>
                <span className="rama-tool-call-name">permission needed</span>
                <span className="rama-tool-call-target">
                  {pendingPermission.tool} {formatToolTarget(pendingPermission.tool, pendingPermission.input)}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8, padding: "4px 0 2px 3px" }}>
                <Button size="sm" onClick={() => approvePermission(pendingPermission.reqId, true)}>
                  approve
                </Button>
                <Button size="sm" variant="ghost" onClick={() => approvePermission(pendingPermission.reqId, false)}>
                  deny
                </Button>
              </div>
            </div>
          )}

          {isBusy && (
            <div className="rama-status-line">
              <span className="rama-status-verb">✻ {status.verb ?? status.state}…</span>
              <span className="rama-status-meta">({elapsedSeconds}s · esc to interrupt)</span>
              <span className="rama-caret" />
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="rama-composer-wrap">
        <div className="rama-composer">
          <div className="rama-composer-row">
            <span className="rama-composer-glyph">❯</span>
            <textarea
              ref={textareaRef}
              className="rama-composer-text"
              style={{
                background: "transparent",
                border: "none",
                outline: "none",
                resize: "none",
                font: "inherit",
                color: "inherit",
                padding: 0,
                width: "100%",
              }}
              rows={1}
              placeholder="describe what you want…"
              value={typed}
              disabled={!activeChat}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>
          <div className="rama-composer-toolbar">
            <ModelPicker chat={activeChat} disabled={isBusy} />
            <SegmentedControl options={MODES} value={mode} onChange={handleModeChange} />
            <span style={{ flex: 1 }} />
            <span className="rama-composer-hint">@ files · / commands · ⇧⏎ newline</span>
            <button className="rama-composer-send" onClick={submit} disabled={!activeChat || isBusy || !typed.trim()}>
              ⏎ send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
