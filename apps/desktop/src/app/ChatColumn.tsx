import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Button, Fluke, SegmentedControl } from "@rama/ui";
import type { ChatMode, SearchResultDTO, ToolCallDTO } from "@rama/protocol";
import { patchChat, ramaSearch } from "../engine/client";
import { useProjectsData } from "./data/ProjectsProvider";
import { useSessionData } from "./data/SessionProvider";
import { ModelPicker } from "./ModelPicker";
import { TerminalView } from "./TerminalView";

const MODES: { id: ChatMode; label: string }[] = [
  { id: "agent", label: "agent" },
  { id: "plan", label: "plan" },
  { id: "ask", label: "ask" },
];

// A bare slash command being typed, no space yet — e.g. "/" or "/re". Loses the match as soon
// as the user types a space (rama search only drives the composer's `/` picker, not the turn text).
const SLASH_SEARCH_RE = /^\/(\S*)$/;

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

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResultDTO[]>([]);
  const [searchIndex, setSearchIndex] = useState(0);

  const slashMatch = typed.match(SLASH_SEARCH_RE);
  const slashTerm = slashMatch ? slashMatch[1] : null;

  // rama search (docs/IMPLEMENTATION_PLAN.md Phase 6) — a native harness search seam, not heku
  // (heku is its own standalone MCP server scoped to config search, see Phase 7). Only the
  // "tools" domain is registered today; more domains land as a pure addition on the engine side.
  useEffect(() => {
    if (slashTerm === null) {
      setSearchOpen(false);
      setSearchResults([]);
      return;
    }
    setSearchOpen(true);
    const timer = setTimeout(() => {
      ramaSearch(slashTerm, activeProject?.id)
        .then((results) => {
          setSearchResults(results);
          setSearchIndex(0);
        })
        .catch(() => setSearchResults([]));
    }, 150);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashTerm, activeProject?.id]);

  const groupedSearchResults = useMemo(() => {
    const groups = new Map<string, SearchResultDTO[]>();
    for (const r of searchResults) {
      const list = groups.get(r.domain) ?? [];
      list.push(r);
      groups.set(r.domain, list);
    }
    return [...groups.entries()];
  }, [searchResults]);

  // `commands` domain entries execute immediately instead of inserting a mention — everything
  // else (tools/skills/mcp/docs) keeps the insert-a-mention behavior (docs/IMPLEMENTATION_PLAN.md
  // Phase 7, Part 4). Also reachable from the ⌘K palette (CommandPalette.tsx) via a window event,
  // since the palette lives outside this component's local composer state.
  function runCommand(id: string) {
    switch (id) {
      case "cmd:mode:agent":
        handleModeChange("agent");
        break;
      case "cmd:mode:plan":
        handleModeChange("plan");
        break;
      case "cmd:mode:ask":
        handleModeChange("ask");
        break;
      case "cmd:clear":
        setTyped("");
        break;
    }
  }

  // Mirrored into a ref so the mount-only listener below always calls the latest closure — it
  // captures activeChat (via handleModeChange) which changes on every chat switch.
  const runCommandRef = useRef(runCommand);
  runCommandRef.current = runCommand;

  useEffect(() => {
    function onInsert(e: Event) {
      const text = (e as CustomEvent<string>).detail;
      setTyped(text);
      textareaRef.current?.focus();
    }
    function onRunCommand(e: Event) {
      runCommandRef.current((e as CustomEvent<string>).detail);
    }
    window.addEventListener("rama:composer-insert", onInsert);
    window.addEventListener("rama:run-command", onRunCommand);
    return () => {
      window.removeEventListener("rama:composer-insert", onInsert);
      window.removeEventListener("rama:run-command", onRunCommand);
    };
  }, []);

  function selectSearchResult(result: SearchResultDTO) {
    if (result.domain === "commands") {
      runCommand(result.id);
      setSearchOpen(false);
      setSearchResults([]);
      textareaRef.current?.focus();
      return;
    }

    setTyped(`/${result.title} `);
    setSearchOpen(false);
    setSearchResults([]);
    textareaRef.current?.focus();
  }

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
    if (searchOpen && searchResults.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSearchIndex((i) => (i + 1) % searchResults.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSearchIndex((i) => (i - 1 + searchResults.length) % searchResults.length);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        selectSearchResult(searchResults[searchIndex]);
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (searchOpen) {
        setSearchOpen(false);
        setSearchResults([]);
        return;
      }
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
  const elapsedSeconds = status.runStartedAt ? Math.max(0, Math.round((now - status.runStartedAt) / 1000)) : 0;

  // A cli-backed chat (docs/IMPLEMENTATION_PLAN.md Phase 8) has no own-loop turns, messages, or
  // composer — its entire column is a live terminal. All the hooks above still ran (harmlessly)
  // so hook order stays identical regardless of which chat is active; only the returned JSX
  // differs. key={activeChat.id} forces a full unmount/remount when switching between two
  // different cli chats, rather than TerminalView silently reusing its mounted instance.
  if (activeChat?.backend.kind === "cli") {
    return <TerminalView key={activeChat.id} chat={activeChat} project={activeProject} />;
  }

  return (
    <div className="rama-chat-column">
      <div className="rama-chat-header">
        <span style={{ color: "rgba(var(--ink),0.65)" }}>⌂ {activeProject?.name ?? "—"}</span>
        <span style={{ opacity: 0.4 }}>›</span>
        <span style={{ color: "rgba(var(--ink),0.5)" }}>⑂ {activeProject?.defaultBranch ?? "no branch"}</span>
        <span style={{ flex: 1 }} />
        <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
          ctx
          <span className="rama-ctx-meter">
            <span className="rama-ctx-meter-fill" style={{ width: `${contextPct}%` }} />
          </span>
          {formatTokens(contextUsed)} / {formatTokens(contextMax)}
        </span>
      </div>

      <div className="rama-messages">
        <div className="rama-messages-inner">
          {messages.length === 0 && !activeChat && (
            <div className="rama-msg-meta">select or create a chat to get started.</div>
          )}

          {messages.length === 0 && activeChat && (
            <div className="rama-welcome">
              <Fluke className="rama-welcome-fluke" />
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
        {searchOpen && (
          <div className="rama-search-menu">
            {searchResults.length === 0 ? (
              <div className="rama-search-menu-empty">{slashTerm ? "no matches" : "type to search tools…"}</div>
            ) : (
              (() => {
                let flatIndex = -1;
                return groupedSearchResults.map(([domain, items]) => (
                  <div key={domain}>
                    <div className="rama-search-menu-group-label">{domain}</div>
                    {items.map((r) => {
                      flatIndex += 1;
                      const i = flatIndex;
                      return (
                        <button
                          key={r.id}
                          className={`rama-search-menu-item${i === searchIndex ? " rama-search-menu-item-active" : ""}`}
                          onMouseEnter={() => setSearchIndex(i)}
                          onClick={() => selectSearchResult(r)}
                        >
                          <span className="rama-search-menu-item-title">{r.title}</span>
                          <span className="rama-search-menu-item-subtitle">{r.subtitle}</span>
                        </button>
                      );
                    })}
                  </div>
                ));
              })()
            )}
          </div>
        )}
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
