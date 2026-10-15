import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon, Working, byline } from "@rama/ui";
import type { ChatBlock, ChatMode, MessageDTO, SearchResultDTO } from "@rama/protocol";
import { patchChat } from "../../engine/client";
import { useProjectsData } from "../data/ProjectsProvider";
import { useProvidersData } from "../data/ProvidersProvider";
import { useSessionData } from "../data/SessionProvider";
import { useWindowTabsData } from "../data/WindowTabsProvider";
import { errorSentence } from "../home/actLabels";
import { useModelChoices } from "../home/HomeComposer";
import { CodeLanding } from "./CodeLanding";
import { CodeComposer } from "./composer/CodeComposer";
import { useComposerContext } from "./composer/useComposerContext";
import { buildTranscript } from "./transcript/buildTranscript";
import { TranscriptEnvContext, type TranscriptEnv } from "./transcript/RowView";
import { TurnView, type TurnHandlers } from "./transcript/TurnView";
import { labelText } from "./transcript/rows";
import { workingTitle, workingVerb } from "./transcript/working";
import "./transcript/transcript.css";
import { tildePath } from "./workspace/parts";
import { useWorkspace } from "./workspace/WorkspaceContext";

/* The Code tab's chat column — docs/CODE_REDESIGN_PLAN.md CR6. It holds what the old ChatColumn held
   that isn't drawing: the composer's state (text, mode, draft sync, submit), the run's state, and
   the scroller. What the transcript says comes from buildTranscript(); how it looks is
   code/transcript/*.

   Scrolling (the same rule as Home's, D4): a chat opens at the bottom, sending scrolls to the
   bottom, and streaming sticks to the bottom unless the reader has scrolled up more than 80px. */

const RUNNING = new Set(["thinking", "streaming", "tool", "waiting_permission"]);
const STICK_PX = 80;

// Rough client-side estimate (chars/4) for the working line's tooltip — usage.update only arrives
// once, at run end, so there is no real live count to read during streaming.
function estimateStreamedTokens(blocks: ChatBlock[] | undefined): number {
  let chars = 0;
  for (const b of blocks ?? []) if (b.kind === "text" || b.kind === "thinking") chars += b.text.length;
  return Math.round(chars / 4);
}

export function CodeChat() {
  const { projects, loading: projectsLoading, activeProjectId, allChats, activeChatId, draft, viewingDraft, updateDraftText, updateDraftMode, updateDraftModel, updateDraftAgent, retargetDraft, openDraft, applyChatPatch } =
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
    retryTurn,
  } = useSessionData();
  const { resolve } = useModelChoices();
  const ws = useWorkspace();

  const activeChat = allChats.find((c) => c.id === activeChatId);
  // While viewing the draft, `activeChat` still points at whichever real chat was last active
  // (ProjectsProvider.openDraft deliberately never touches activeChatId) — everything the composer
  // shows has to read the draft's own project instead, or it would render that stale chat's state
  // under the "new chat" screen.
  const draftProject = draft ? projects.find((p) => p.id === draft.projectId) : undefined;
  const activeProject = viewingDraft ? draftProject : activeChat ? projects.find((p) => p.id === activeChat.projectId) : undefined;
  const displayChat = viewingDraft ? undefined : activeChat;
  const shownMessages = useMemo(() => (viewingDraft ? [] : messages), [viewingDraft, messages]);

  const [typed, setTyped] = useState("");
  const [mode, setMode] = useState<ChatMode>(activeChat?.mode ?? "agent");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [now, setNow] = useState(() => Date.now());
  // Local-only, so a dismissed notice reappears on reload; these are transient run notices
  // (compaction, /undo), not durable history.
  const [dismissedNotes, setDismissedNotes] = useState<Set<string>>(new Set());

  // docs/CODE_REDESIGN_PLAN.md CR5 — the chip row's state (branch, worktree, extra folders) lives in
  // a hook; `context.carryOver` is what submit() calls once a draft becomes a chat.
  const context = useComposerContext(activeProject, displayChat);

  // `commands` domain entries execute immediately instead of inserting a mention — everything else
  // (tools/skills/mcp/docs) keeps the insert-a-mention behavior (docs/IMPLEMENTATION_PLAN.md Phase 7,
  // Part 4). Also reachable from the ⌘K palette (CommandPalette.tsx) via a window event, since the
  // palette lives outside this component's local composer state.
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
      setTyped((e as CustomEvent<string>).detail);
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

  // The composer's `/` menu hands back what was picked: commands run at once, everything else
  // (tools/skills/mcp/docs) becomes a typed mention. The menu closes itself.
  function pickSlashResult(result: SearchResultDTO) {
    if (result.domain === "commands") runCommand(result.id);
    else setTyped(`/${result.title} `);
    textareaRef.current?.focus();
  }

  // Resync only on chat switch, not on every activeChat field change — an optimistic mode change
  // (below) shouldn't get clobbered by a stale patchChat response for the same chat. Keyed off
  // `displayChat` (undefined while viewing the draft) so switching to "new chat" picks up the draft's
  // own mode instead of the previously active chat's.
  useEffect(() => {
    setMode(viewingDraft ? (draft?.mode ?? "agent") : (displayChat?.mode ?? "agent"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayChat?.id]);

  // The composer's text follows whichever screen is on display: the draft's own saved text while
  // viewing it, empty otherwise. That is what brings an unsent "New chat" prompt back intact after
  // visiting an old chat — the draft lives in ProjectsProvider and outlives the navigation.
  useEffect(() => {
    setTyped(viewingDraft ? (draft?.text ?? "") : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewingDraft, activeChatId]);

  // ...and the other direction: while viewing the draft, every keystroke is saved back into it.
  useEffect(() => {
    if (viewingDraft) updateDraftText(typed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed, viewingDraft]);

  // A draft has no run of its own — ignore whatever status the last real chat left behind.
  const running = !viewingDraft && RUNNING.has(status.state);
  const isBusy = !viewingDraft && (status.state === "thinking" || status.state === "streaming");

  useEffect(() => {
    if (!running || !status.runStartedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running, status.runStartedAt]);

  function handleModeChange(next: ChatMode) {
    setMode(next);
    if (viewingDraft) {
      updateDraftMode(next);
      return;
    }
    if (activeChat) {
      patchChat(activeChat.id, { mode: next }).catch((err) => console.error("[rama] failed to persist mode", err));
    }
  }

  function submit() {
    if (running) return;
    const text = typed;
    if (!text.trim()) return;
    stick.current = true;

    // The draft only becomes a real chat now, on its first message — the one place that happens.
    // promoteDraft creates it, registers it as this window's tab, and selects it; sendUserTurnTo
    // (not sendUserTurn) targets that new chat id directly rather than waiting for `activeChatId`
    // to catch up on the next render.
    if (viewingDraft) {
      if (!draft) return;
      // CC1/CC2 — extra folders and a worktree choice made before the first message are held locally
      // (no chat id existed yet to persist them against); `context` carries them onto the new chat.
      void promoteDraft()
        .then((chat) => {
          if (!chat) return;
          sendUserTurnTo(chat.id, text);
          context.carryOver(chat.id);
        })
        .catch((err) => console.error("[rama] failed to create chat from draft", err));
      setTyped("");
      return;
    }

    if (!activeChat) return;
    // docs/TOOL_LAYER_PLAN.md §5.2 — a client-side command, not a model turn: restores the project's
    // files rather than asking the model to do anything.
    if (text.trim() === "/undo") {
      restoreLastRun();
      setTyped("");
      return;
    }
    sendUserTurn(text);
    setTyped("");
  }

  function pickModel(providerId: string, modelId: string) {
    if (viewingDraft) return updateDraftModel(providerId, modelId);
    if (!activeChat) return;
    patchChat(activeChat.id, { providerId, model: modelId })
      .then(applyChatPatch)
      .catch((err) => console.error("[rama] failed to switch provider/model", err));
  }

  function pickAgent(agentId: string) {
    if (viewingDraft) return updateDraftAgent(agentId);
    if (!activeChat) return;
    patchChat(activeChat.id, { agentId })
      .then(applyChatPatch)
      .catch((err) => console.error("[rama] failed to switch agent", err));
  }

  const contextUsed = usage?.contextUsed ?? activeChat?.contextUsed ?? 0;
  const contextMax = usage?.contextMax ?? activeChat?.contextMax ?? 200000;
  const elapsedSeconds = status.runStartedAt ? Math.max(0, Math.round((now - status.runStartedAt) / 1000)) : 0;

  // ── The transcript ──
  const env = useMemo<TranscriptEnv>(
    () => ({ artifacts: new Map(artifacts.map((a) => [a.id, a])), buffers: artifactBuffers, goto: ws.goto }),
    [artifacts, artifactBuffers, ws.goto],
  );

  // Seconds each live thinking block has been open, ticking once a second while one is.
  const seen = useRef(new Map<string, number>());
  const pendingMessage = running ? shownMessages.find((m) => m.id.startsWith("pending-")) : undefined;
  const anyLive = !!pendingMessage?.blocks?.some((b) => b.kind === "thinking" && b.durationMs == null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!anyLive) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [anyLive]);

  const turns = useMemo(
    () =>
      buildTranscript({
        messages: shownMessages,
        toolCalls,
        artifacts,
        pendingPermission,
        liveElapsed: (key) => {
          if (!seen.current.has(key)) seen.current.set(key, Date.now());
          return Date.now() - seen.current.get(key)!;
        },
      }),
    // `tick` re-derives the live "Thinking · 3 seconds" row once a second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shownMessages, toolCalls, artifacts, pendingPermission, tick],
  );
  const visibleTurns = turns.filter((t) => t.k !== "note" || !dismissedNotes.has(t.id));
  const lastTurn = turns[turns.length - 1];

  const askContext = useMemo(() => ({ cwd: activeProject ? tildePath(activeProject.path) : undefined, branch: context.branch }), [activeProject, context.branch]);
  const handlers: TurnHandlers = {
    chatId: displayChat?.id ?? null,
    askContext,
    onAnswer: approvePermission,
    onUndo: restoreLastRun,
    onDismissNote: (id) => setDismissedNotes((prev) => new Set(prev).add(id)),
  };

  // The working line: the engine's verb in plain words, the counters in its tooltip.
  const liveTurn = running && lastTurn?.k === "ai" && !lastTurn.waiting ? lastTurn : null;
  const runningRow = liveTurn?.blocks.findLast((b) => b.k === "row" && b.row.status === "running");
  const streamingProse = status.state === "streaming" && liveTurn?.blocks[liveTurn.blocks.length - 1]?.k === "prose";
  const showWorking = running && !streamingProse && !(lastTurn?.k === "ai" && lastTurn.waiting);
  const workingLine = showWorking ? (
    <div
      className="r-working-wrap"
      title={workingTitle(elapsedSeconds, estimateStreamedTokens(pendingMessage?.blocks), Math.round((pendingMessage?.blocks ?? []).reduce((s, b) => s + (b.kind === "thinking" ? (b.durationMs ?? 0) : 0), 0) / 1000))}
    >
      <Working
        verb={workingVerb({
          state: status.state,
          verb: status.verb,
          runningLabel: runningRow && runningRow.k === "row" ? labelText(runningRow.row.label) : undefined,
          elapsedSeconds,
        })}
      />
    </div>
  ) : null;
  // Between Send and the run's first event there is no AI turn yet to hold the line.
  const awaitingRun = running && lastTurn?.k !== "ai";

  const bylineFor = (provider?: string, model?: string) => {
    const m = resolve({ providerId: provider ?? displayChat?.providerId ?? null, modelId: model ?? displayChat?.model ?? null });
    return m ? byline(m.name, m.place, m.via) : "";
  };
  const lastAi = [...turns].reverse().find((t) => t.k === "ai");
  const failed = status.state === "error" || (errorMessage && !running);
  const canRetry = !running && !lastAi?.mutated;

  // ── Scrolling ──
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const openedChat = useRef<string | null>(null);
  const userTurns = shownMessages.filter((m: MessageDTO) => m.role === "user").length;
  const lastUserTurns = useRef(userTurns);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const sent = userTurns > lastUserTurns.current;
    lastUserTurns.current = userTurns;
    if (openedChat.current !== activeChatId || sent) stick.current = true;
    if (shownMessages.length) openedChat.current = activeChatId;
    if (stick.current) el.scrollTop = el.scrollHeight;
  });

  // A chat that isn't on screen — none yet, or its last one just went — opens the active project's
  // draft, so the landing always has a composer that can send.
  const noProjects = !projectsLoading && projects.length === 0;
  useEffect(() => {
    if (projectsLoading || viewingDraft || activeChatId || projects.length === 0) return;
    openDraft(activeProjectId ?? projects[0]!.id);
  }, [projectsLoading, viewingDraft, activeChatId, projects, activeProjectId, openDraft]);

  const landing = noProjects || viewingDraft || (!activeChat && !projectsLoading);
  const placeholder = viewingDraft ? `Describe what you want to build or fix in ${activeProject?.name ?? "this project"}` : "Reply, or describe the next change";
  const composer = (activeChat || viewingDraft) && (
    <CodeComposer
      value={typed}
      onChange={setTyped}
      onSubmit={submit}
      running={isBusy}
      onStop={interrupt}
      textareaRef={textareaRef}
      placeholder={placeholder}
      project={activeProject}
      projects={projects}
      locked={!viewingDraft && !!displayChat}
      context={context}
      onSwitchProject={retargetDraft}
      onNewChatIn={openDraft}
      mode={mode}
      onMode={handleModeChange}
      agentId={viewingDraft ? draft?.agentId : displayChat?.agentId}
      onAgent={pickAgent}
      model={
        viewingDraft
          ? { providerId: draft?.providerId ?? null, modelId: draft?.model ?? null }
          : { providerId: displayChat?.providerId ?? null, modelId: displayChat?.model ?? null }
      }
      onPickModel={pickModel}
      usage={viewingDraft ? null : { used: contextUsed, max: contextMax }}
      onSlashPick={pickSlashResult}
    />
  );

  return (
    <div className="r-chat-col">
      {landing ? (
        // docs/PROVIDERS_PLAN.md Phase P5 — first run routes to the wizard instead of a composer that
        // cannot send. providersLoading guards against flashing it for one frame before the first
        // GET /providers resolves.
        <CodeLanding
          project={activeProject}
          composer={composer}
          noProjects={noProjects}
          needsProvider={!providersLoading && providers.length === 0}
          textareaRef={textareaRef}
        />
      ) : (
        <>
          <div
            className="r-scroller"
            ref={scrollerRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
            }}
          >
            <TranscriptEnvContext.Provider value={env}>
              <div className="r-transcript">
                {visibleTurns.map((turn) => (
                  <TurnView
                    key={turn.key}
                    turn={turn}
                    handlers={handlers}
                    byline={turn.k === "ai" ? bylineFor(turn.provider, turn.model) : ""}
                    onRetry={turn.k === "ai" && !running && !turn.mutated && turn.answers !== undefined ? () => retryTurn(turn.answers) : undefined}
                    working={turn === liveTurn ? workingLine : undefined}
                  />
                ))}
                {/* Between Send and the run's first event. */}
                {awaitingRun && <div className="r-turn-ai">{workingLine}</div>}
                {failed ? (
                  <p className="r-notice r-notice-bad">
                    {errorSentence(errorMessage)}
                    {canRetry && (
                      <button type="button" className="r-mini" onClick={() => retryTurn()}>
                        <Icon name="retry" />
                        <span>Try again</span>
                      </button>
                    )}
                  </p>
                ) : null}
              </div>
            </TranscriptEnvContext.Provider>
          </div>
          {composer && <div className="r-dock">{composer}</div>}
        </>
      )}
    </div>
  );
}
