import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Button, Fluke } from "@rama/ui";
import type { ArtifactDTO, ChatMode, SearchResultDTO, ToolCallDTO } from "@rama/protocol";
import { fetchArtifactContent, patchChat, ramaSearch } from "../engine/client";
import { useProjectsData } from "./data/ProjectsProvider";
import { useProvidersData } from "./data/ProvidersProvider";
import { useSessionData } from "./data/SessionProvider";
import { useWindowTabsData } from "./data/WindowTabsProvider";
import { AgentPicker } from "./AgentPicker";
import { ModelPicker } from "./ModelPicker";
import { ProviderSetupWizard } from "./ProviderSetupWizard";
import { DiffView } from "./diff/DiffView";
import { Markdown } from "./chat/Markdown";
import { requestOpenFile } from "./mission-control/panes/openFileBridge";

const MODES: { id: ChatMode; label: string }[] = [
  { id: "agent", label: "agent" },
  { id: "plan", label: "plan" },
  { id: "ask", label: "ask" },
];

// Mode is one tile showing one value, not a three-way segmented control showing every option at
// once (vim's status line shows "-- INSERT --", not every mode it has) — clicking cycles through
// them in order; ⌃M and the cmd:mode:* palette commands still jump straight to one.
function nextMode(current: ChatMode): ChatMode {
  const i = MODES.findIndex((m) => m.id === current);
  return MODES[(i + 1) % MODES.length].id;
}

// A bare slash command being typed, no space yet — e.g. "/" or "/re". Loses the match as soon
// as the user types a space (rama search only drives the composer's `/` picker, not the turn text).
const SLASH_SEARCH_RE = /^\/(\S*)$/;

function formatTokens(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// docs/LOOP_MENDING_PLAN.md D9/MD6 — the thinking block's summary label once `thinking.done`
// has landed; sub-second durations still count as thinking, not nothing.
function formatThinkingDuration(durationMs: number): string {
  const seconds = durationMs / 1000;
  return seconds < 1 ? "Thought for <1s" : `Thought for ${Math.round(seconds)}s`;
}

function formatToolTarget(name: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "read":
    case "write":
    case "edit":
    case "tree":
      return typeof obj.path === "string" ? obj.path : "";
    case "file_op":
      if (typeof obj.from === "string" && typeof obj.to === "string") return `${obj.from} → ${obj.to}`;
      return typeof obj.path === "string" ? obj.path : "";
    case "grep": {
      const pattern = typeof obj.pattern === "string" ? obj.pattern : "";
      const path = typeof obj.path === "string" ? obj.path : "";
      return `"${pattern}"${path ? ` ${path}` : ""}`;
    }
    case "bash":
      return typeof obj.command === "string" ? obj.command : "";
    case "browser":
      return typeof obj.url === "string" ? obj.url : "";
    case "clarify": {
      const n = Array.isArray(obj.questions) ? obj.questions.length : 0;
      return `${n} question${n === 1 ? "" : "s"}`;
    }
    default:
      return "";
  }
}

function getToolTargetPath(name: string, input: unknown): string | null {
  const obj = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "read":
    case "write":
    case "edit":
      return typeof obj.path === "string" ? obj.path : null;
    case "file_op":
      return typeof obj.to === "string" ? obj.to : typeof obj.path === "string" ? obj.path : null;
    default:
      return null;
  }
}

interface ClarifyQuestion {
  question: string;
  default?: string;
}

function isClarifyQuestion(v: unknown): v is ClarifyQuestion {
  return !!v && typeof (v as ClarifyQuestion).question === "string";
}

// docs/PROMPT_STACK_PLAN.md §8.1, Phase PS6 — "a tool call is legible... the UI renders a question
// card" is the reason clarify exists as a tool instead of prose. This is that card: every other
// tool call gets the one-line ToolCallCard treatment above, clarify gets its questions spelled out.
function ClarifyCard({ toolCall }: { toolCall: ToolCallDTO }) {
  const raw = (toolCall.input as Record<string, unknown> | null)?.questions;
  const questions = Array.isArray(raw) ? raw.filter(isClarifyQuestion) : [];
  return (
    <div className="rama-tool-call rama-clarify-card">
      <div className="rama-tool-call-head">
        <span className="rama-tool-call-status" style={{ color: "var(--accent)" }}>
          ●
        </span>
        <div className="rama-tool-call-summary">
          <span className="rama-tool-call-name">clarify</span>
        </div>
      </div>
      <ol className="rama-clarify-questions">
        {questions.map((q, i) => (
          <li key={i}>
            <span>{q.question}</span>
            {q.default && <span className="rama-clarify-default"> (default: {q.default})</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function isBackgroundBash(input: unknown): boolean {
  return !!(input as Record<string, unknown> | null)?.background;
}

// docs/MISSION_CONTROL_PLAN.md §8 Phase M6 — the `browser` tool's own version of §7.1's
// "the gate's prompt copy must say what this actually does" note: `open` can load any URL the
// agent gives it, and (like a background shell) the page it opens stays up after approval.
function isBrowserOpen(input: unknown): boolean {
  return (input as Record<string, unknown> | null)?.op === "open";
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

function ToolCallCard({
  toolCall,
  isExpanded,
  onToggle,
  artifact,
  streamingBuffer,
}: {
  toolCall: ToolCallDTO;
  isExpanded: boolean;
  onToggle: () => void;
  artifact?: ArtifactDTO;
  streamingBuffer?: string;
}) {
  const [fetchedContent, setFetchedContent] = useState<string | null>(null);
  const dotColor = toolCall.ok === null ? "var(--accent)" : toolCall.ok ? "var(--good)" : "var(--bad)";
  const hasArtifact = !!toolCall.artifactId;

  useEffect(() => {
    if (!isExpanded || !toolCall.artifactId || artifact?.status === "streaming" || fetchedContent !== null) {
      return;
    }
    let cancelled = false;
    fetchArtifactContent(toolCall.artifactId)
      .then((res) => {
        if (!cancelled) setFetchedContent(res.content);
      })
      .catch((err) => {
        console.error("[rama] failed to fetch artifact content", err);
      });
    return () => {
      cancelled = true;
    };
  }, [isExpanded, toolCall.artifactId, artifact?.status, fetchedContent]);

  const content =
    artifact?.status === "streaming"
      ? (streamingBuffer ?? "")
      : (fetchedContent ?? streamingBuffer ?? "");

  const kind = artifact?.kind ?? (toolCall.name === "patch" || toolCall.name === "git" ? "diff" : "doc");

  return (
    <div className={`rama-tool-call${hasArtifact ? " rama-tool-call-expandable" : ""}${isExpanded ? " rama-tool-call-open" : ""}`}>
      <div
        className="rama-tool-call-head"
        onClick={hasArtifact ? onToggle : undefined}
        style={hasArtifact ? { cursor: "pointer" } : undefined}
      >
        <span className="rama-tool-call-status" style={{ color: dotColor }}>
          ●
        </span>
        <div className="rama-tool-call-summary">
          <span className="rama-tool-call-name">{toolCall.name}</span>
          {(() => {
            const targetPath = getToolTargetPath(toolCall.name, toolCall.input);
            const targetLabel = formatToolTarget(toolCall.name, toolCall.input);
            return (
              <span
                className="rama-tool-call-target"
                style={targetPath ? { cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted" } : undefined}
                title={targetPath ? `Open ${targetPath} in Files pane` : undefined}
                onClick={
                  targetPath
                    ? (e) => {
                        e.stopPropagation();
                        requestOpenFile(targetPath);
                      }
                    : undefined
                }
              >
                {targetLabel}
              </span>
            );
          })()}
          {hasArtifact && (
            <span className={`rama-tool-call-chevron${isExpanded ? " rama-tool-call-chevron-open" : ""}`}>
              ▸
            </span>
          )}
        </div>
      </div>
      <div className="rama-tool-call-result">
        <span className="rama-tool-call-result-glyph">⎿</span>
        <div className="rama-tool-call-result-summary">
          {toolCall.resultSummary ? renderResultSummary(toolCall.resultSummary) : <span>running…</span>}
        </div>
      </div>
      {isExpanded && hasArtifact && (
        <div className="rama-tool-call-body rama-breakout">
          {kind === "diff" ? (
            <DiffView diff={content} />
          ) : (
            <pre className="rama-tool-call-content">{content}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({
  text,
  durationMs,
  autoExpand,
}: {
  text: string;
  durationMs?: number;
  autoExpand: boolean;
}) {
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const isOpen = userToggled ?? autoExpand;

  return (
    <details
      className="rama-thinking-block"
      open={isOpen}
      onToggle={(e) => {
        setUserToggled((e.currentTarget as HTMLDetailsElement).open);
      }}
      style={{
        marginBottom: 6,
        fontSize: "var(--fs-xs)",
        color: "rgba(var(--ink), 0.7)",
        background: "rgba(var(--ink), 0.03)",
        borderRadius: 4,
        padding: "4px 8px",
      }}
    >
      <summary style={{ cursor: "pointer", userSelect: "none", fontWeight: 500 }}>
        {durationMs != null ? formatThinkingDuration(durationMs) : "thinking"}
      </summary>
      <div
        style={{
          whiteSpace: "pre-wrap",
          marginTop: 4,
          paddingLeft: 8,
          borderLeft: "2px solid rgba(var(--ink), 0.2)",
        }}
      >
        {text}
      </div>
    </details>
  );
}

export function ChatColumn() {
  const { projects, allChats, activeChatId, draft, viewingDraft, updateDraftText, updateDraftMode, updateDraftModel, updateDraftAgent } =
    useProjectsData();
  const { promoteDraft } = useWindowTabsData();
  const { providers, loading: providersLoading } = useProvidersData();
  const {
    messages,
    status,
    usage,
    errorMessage,
    toolCalls,
    artifacts,
    artifactBuffers,
    pendingPermission,
    sendUserTurn,
    sendUserTurnTo,
    interrupt,
    approvePermission,
    restoreLastRun,
  } = useSessionData();

  const activeChat = allChats.find((c) => c.id === activeChatId);
  // While viewing the draft, `activeChat`/`activeProject` above still point at whichever real
  // chat was last active (see ProjectsProvider.openDraft — it deliberately never touches
  // activeChatId) — everything the header and composer rail show has to read the draft's own
  // project instead, or it'd render that stale chat's mode/model/messages underneath the "new
  // chat" screen.
  const draftProject = draft ? projects.find((p) => p.id === draft.projectId) : undefined;
  const activeProject = viewingDraft ? draftProject : activeChat ? projects.find((p) => p.id === activeChat.projectId) : undefined;
  const displayChat = viewingDraft ? undefined : activeChat;

  const [toolCallOverrides, setToolCallOverrides] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setToolCallOverrides({});
  }, [activeChatId]);

  const lastToolCallId = toolCalls.length > 0 ? toolCalls[toolCalls.length - 1]!.id : null;

  const toggleToolCall = useCallback((id: string) => {
    setToolCallOverrides((prev) => ({
      ...prev,
      [id]: !(prev[id] !== undefined ? prev[id] : id === lastToolCallId),
    }));
  }, [lastToolCallId]);

  const artifactsById = useMemo(() => {
    const map: Record<string, ArtifactDTO> = {};
    for (const a of artifacts) {
      map[a.id] = a;
    }
    return map;
  }, [artifacts]);

  const toolCallsByMessage = useMemo(() => {
    const map: Record<string, ToolCallDTO[]> = {};
    for (const tc of toolCalls) {
      (map[tc.messageId] ??= []).push(tc);
    }
    return map;
  }, [toolCalls]);

  const toolCallsById = useMemo(() => {
    const map: Record<string, ToolCallDTO> = {};
    for (const tc of toolCalls) {
      map[tc.id] = tc;
    }
    return map;
  }, [toolCalls]);

  const renderToolCall = useCallback(
    (tc: ToolCallDTO) =>
      tc.name === "clarify" ? (
        <ClarifyCard key={tc.id} toolCall={tc} />
      ) : (
        <ToolCallCard
          key={tc.id}
          toolCall={tc}
          isExpanded={
            !!tc.artifactId &&
            (toolCallOverrides[tc.id] !== undefined
              ? toolCallOverrides[tc.id]!
              : tc.id === lastToolCallId)
          }
          onToggle={() => toggleToolCall(tc.id)}
          artifact={tc.artifactId ? artifactsById[tc.artifactId] : undefined}
          streamingBuffer={tc.artifactId ? artifactBuffers[tc.artifactId] : undefined}
        />
      ),
    [toolCallOverrides, lastToolCallId, toggleToolCall, artifactsById, artifactBuffers],
  );

  const [typed, setTyped] = useState("");
  const [mode, setMode] = useState<ChatMode>(activeChat?.mode ?? "agent");
  const [composerFocused, setComposerFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  // docs/LOOP_MENDING_PLAN.md D9/MD6 — local-only, so a dismissed marker reappears on reload;
  // that's fine, these are transient run notices (compaction, /undo), not durable history.
  const [dismissedMetaIds, setDismissedMetaIds] = useState<Set<string>>(new Set());

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
  // Keyed off `displayChat` (undefined while viewing the draft) rather than `activeChat` so
  // switching to "new chat" picks up the draft's own mode instead of showing whatever real
  // chat's mode was active before — `displayChat?.id` alone already flips on every transition
  // into and out of the draft screen, since `displayChat` is undefined throughout it.
  useEffect(() => {
    setMode(viewingDraft ? (draft?.mode ?? "agent") : (displayChat?.mode ?? "agent"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayChat?.id]);

  // The composer's text follows whichever screen is on display: the draft's own saved text
  // while viewing it, empty otherwise. This is what makes an unsent "New chat" prompt come back
  // intact after visiting an old chat and clicking "New chat" again — the draft (and its text)
  // lives in ProjectsProvider and outlives the navigation, this just resyncs the textarea to it.
  useEffect(() => {
    setTyped(viewingDraft ? (draft?.text ?? "") : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewingDraft, activeChatId]);

  // ...and the other direction: while viewing the draft, every keystroke is saved back into it
  // so it survives navigating away before the first message is sent.
  useEffect(() => {
    if (viewingDraft) updateDraftText(typed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed, viewingDraft]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [typed]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  // A draft has no run of its own — ignore whatever status the last real chat left behind.
  const isBusy = !viewingDraft && (status.state === "thinking" || status.state === "streaming");

  useEffect(() => {
    if (!isBusy || !status.runStartedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isBusy, status.runStartedAt]);

  function handleModeChange(next: ChatMode) {
    setMode(next);
    if (viewingDraft) {
      updateDraftMode(next);
      return;
    }
    if (activeChat) {
      patchChat(activeChat.id, { mode: next }).catch((err) => {
        console.error("[rama] failed to persist mode", err);
      });
    }
  }

  function submit() {
    if (isBusy) return;
    const text = typed;
    if (!text.trim()) return;

    // The draft only becomes a real chat now, on its first message — this is the one and only
    // place that happens. promoteDraft creates it, registers it as this window's tab, and
    // selects it; sendUserTurnTo (not sendUserTurn) targets that new chat id directly rather
    // than waiting for `activeChatId` to catch up on the next render.
    if (viewingDraft) {
      if (!draft) return;
      void promoteDraft()
        .then((chat) => {
          if (chat) sendUserTurnTo(chat.id, text);
        })
        .catch((err) => {
          console.error("[rama] failed to create chat from draft", err);
        });
      setTyped("");
      return;
    }

    if (!activeChat) return;
    // docs/TOOL_LAYER_PLAN.md §5.2 — a client-side command, not a model turn: restores the
    // project's files rather than asking the model to do anything.
    if (text.trim() === "/undo") {
      restoreLastRun();
      setTyped("");
      return;
    }
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

  // Roving focus across the rail's tiles — arrow keys walk between them (tab order already
  // follows DOM order, right after the textarea, so no explicit tabIndex juggling is needed).
  // Escape here only fires once a tile's own menu (if any) is already closed — an open menu
  // eats its own Escape first (see ModelPicker/AgentPicker's onTriggerKeyDown) — so by the time
  // it reaches us it means "leave the rail," and focus goes back to the text.
  function handleRailKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      textareaRef.current?.focus();
      return;
    }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const rail = railRef.current;
    if (!rail) return;
    const tiles = Array.from(rail.querySelectorAll<HTMLButtonElement>(".rama-tile:not(:disabled)"));
    const currentIndex = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (currentIndex === -1) return;
    e.preventDefault();
    const nextIndex = e.key === "ArrowRight" ? (currentIndex + 1) % tiles.length : (currentIndex - 1 + tiles.length) % tiles.length;
    tiles[nextIndex]?.focus();
  }

  const contextUsed = viewingDraft ? 0 : (usage?.contextUsed ?? activeChat?.contextUsed ?? 0);
  const contextMax = viewingDraft ? 200000 : (usage?.contextMax ?? activeChat?.contextMax ?? 200000);
  const contextPct = contextMax > 0 ? Math.min(100, (contextUsed / contextMax) * 100) : 0;
  const elapsedSeconds = status.runStartedAt ? Math.max(0, Math.round((now - status.runStartedAt) / 1000)) : 0;

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
          {!viewingDraft && messages.length === 0 && !activeChat && (
            <div className="rama-msg-meta">select or create a chat to get started.</div>
          )}

          {/* docs/PROVIDERS_PLAN.md Phase P5 — "first run, which is currently broken: the app
              boots with no keys and a default provider that is not configured, into a chat that
              cannot send. First run routes to this flow instead." providersLoading guards against
              flashing the wizard for one frame before the initial GET /providers resolves.
              `viewingDraft` reaches this same welcome/wizard screen — an unsent draft renders
              exactly like an empty real chat, it just isn't one yet. And it deliberately ignores
              `messages`/`activeChat` while true: those still describe whatever real chat was
              last open, not the blank screen the user is looking at. */}
          {(viewingDraft || (activeChat && messages.length === 0)) && !providersLoading && providers.length === 0 && (
            <div className="rama-welcome rama-welcome-wizard">
              <Fluke className="rama-welcome-fluke rama-welcome-fluke-sm" />
              <div className="rama-welcome-wizard-title">connect a provider to start chatting</div>
              <ProviderSetupWizard onDone={() => {}} />
            </div>
          )}

          {(viewingDraft || (activeChat && messages.length === 0)) && (providersLoading || providers.length > 0) && (
            <div className="rama-welcome">
              <Fluke className="rama-welcome-fluke" />
            </div>
          )}

          {!viewingDraft && messages.map((msg) => {
            if (msg.role === "system") {
              if (dismissedMetaIds.has(msg.id)) return null;
              return (
                <div key={msg.id} className="rama-msg-meta" style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  <span style={{ flex: 1 }}>{msg.content}</span>
                  <button
                    type="button"
                    onClick={() => setDismissedMetaIds((prev) => new Set(prev).add(msg.id))}
                    aria-label="Dismiss"
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "inherit",
                      opacity: 0.6,
                      fontSize: "var(--fs-xs)",
                      padding: 0,
                    }}
                  >
                    ×
                  </button>
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
            const isMessageStreaming = msg.id.startsWith("pending-");

            if (msg.blocks && msg.blocks.length > 0) {
              let lastThinkingIdx = -1;
              for (let i = msg.blocks.length - 1; i >= 0; i--) {
                if (msg.blocks[i].kind === "thinking") {
                  lastThinkingIdx = i;
                  break;
                }
              }

              return (
                <div key={msg.id}>
                  {msg.blocks.map((block, bIdx) => {
                    if (block.kind === "thinking") {
                      return (
                        <ThinkingBlock
                          key={`th-${bIdx}`}
                          text={block.text}
                          durationMs={block.durationMs}
                          autoExpand={isMessageStreaming && bIdx === lastThinkingIdx && block.durationMs == null}
                        />
                      );
                    }
                    if (block.kind === "tool") {
                      const tc = toolCallsById[block.callId];
                      if (!tc) return null;
                      return renderToolCall(tc);
                    }
                    if (block.kind === "text") {
                      return (
                        <div key={`txt-${bIdx}`} className="rama-msg-assistant">
                          <span className="rama-msg-assistant-glyph">◆</span>
                          <div className="rama-msg-assistant-text">
                            <Markdown content={block.text} />
                          </div>
                        </div>
                      );
                    }
                    return null;
                  })}
                </div>
              );
            }

            return (
              <div key={msg.id}>
                {(toolCallsByMessage[msg.id] ?? []).map(renderToolCall)}
                {msg.thinking && (
                  <ThinkingBlock
                    text={msg.thinking}
                    durationMs={msg.thinkingDurationMs ?? undefined}
                    autoExpand={isMessageStreaming && msg.thinkingDurationMs == null}
                  />
                )}
                {msg.content && (
                  <div className="rama-msg-assistant">
                    <span className="rama-msg-assistant-glyph">◆</span>
                    <div className="rama-msg-assistant-text">
                      <Markdown content={msg.content} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {!viewingDraft && errorMessage && (
            <div className="rama-status-line">
              <span style={{ color: "#e5484d" }}>⚠ {errorMessage}</span>
            </div>
          )}

          {!viewingDraft && pendingPermission && (
            <div
              className="rama-tool-call"
              style={{ background: "rgba(var(--warn-rgb),0.06)", border: "1px solid rgba(var(--warn-rgb),0.25)" }}
            >
              <div className="rama-tool-call-head">
                <span className="rama-tool-call-status" style={{ color: "var(--warn)" }}>●</span>
                <div className="rama-tool-call-summary">
                  <span className="rama-tool-call-name">permission needed</span>
                  <span className="rama-tool-call-target">
                    {pendingPermission.tool} {formatToolTarget(pendingPermission.tool, pendingPermission.input)}
                  </span>
                </div>
              </div>
              {/* docs/MISSION_CONTROL_PLAN.md §8 Phase M4 — "the gate's prompt copy must say the
                  process outlives the turn" (§7.1): approving a background bash call is a
                  materially different ask than a normal one. */}
              {pendingPermission.tool === "bash" && isBackgroundBash(pendingPermission.input) && (
                <div style={{ fontSize: "var(--fs-xs)", color: "var(--warn)", padding: "2px 0 0 18px" }}>
                  this starts a process that keeps running after you approve — it won't stop when this turn ends.
                </div>
              )}
              {pendingPermission.tool === "browser" && isBrowserOpen(pendingPermission.input) && (
                <div style={{ fontSize: "var(--fs-xs)", color: "var(--warn)", padding: "2px 0 0 18px" }}>
                  this opens a page in the Web pane that stays open after you approve — it can load any URL the agent gives it.
                </div>
              )}
              <div style={{ display: "flex", gap: 8, padding: "4px 0 2px 18px" }}>
                <Button size="sm" onClick={() => approvePermission(pendingPermission.reqId, true)}>
                  approve
                </Button>
                <Button size="sm" variant="ghost" onClick={() => approvePermission(pendingPermission.reqId, false)}>
                  deny
                </Button>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="rama-composer-wrap">
        <div className="rama-composer-inner">
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
                disabled={!activeChat && !viewingDraft}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={handleKeyDown}
                onFocus={() => setComposerFocused(true)}
                onBlur={() => setComposerFocused(false)}
              />
            </div>
            <div className="rama-composer-rail" ref={railRef} onKeyDown={handleRailKeyDown}>
              <button
                type="button"
                className="rama-tile rama-tile-mode"
                disabled={(!displayChat && !viewingDraft) || isBusy}
                onClick={() => handleModeChange(nextMode(mode))}
                title="cycle mode — agent → plan → ask"
              >
                {mode}
              </button>
              <ModelPicker
                chat={displayChat}
                disabled={isBusy}
                draftValue={viewingDraft ? { providerId: draft?.providerId ?? null, model: draft?.model ?? null } : undefined}
                onDraftChange={updateDraftModel}
              />
              <AgentPicker
                chat={displayChat}
                disabled={isBusy}
                draftProjectId={viewingDraft ? draft?.projectId : undefined}
                draftAgentId={viewingDraft ? draft?.agentId : undefined}
                onDraftChange={updateDraftAgent}
              />
              <div className="rama-tile-status">
                {isBusy ? (
                  <>
                    <span className="rama-status-verb">✻ {status.verb ?? status.state}…</span>
                    <span className="rama-status-meta">{elapsedSeconds}s · esc</span>
                    <span className="rama-caret" />
                  </>
                ) : (
                  <span className={`rama-tile-hint${composerFocused && !typed.trim() ? "" : " rama-tile-hint-hidden"}`}>⇧⏎ nl</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
