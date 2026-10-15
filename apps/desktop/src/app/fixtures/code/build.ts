// mockupData.ts → the DTOs the real providers consume (docs/CODE_REDESIGN_PLAN.md CR1).
// Everything the mockup shows must be reachable through the same wire shapes production uses;
// if a mockup element has no wire representation, that gap belongs in plan §9, not here.

import type {
  ArtifactDTO,
  ChangeEntryDTO,
  ChangesDTO,
  ChatBlock,
  ChatDTO,
  MessageDTO,
  ModelInfo,
  ProjectDTO,
  ProviderDTO,
  SessionEvent,
  TerminalDTO,
  TodoItem,
  ToolCallDTO,
} from "@rama/protocol";
import type { FixtureData } from "../mockEngine";
import {
  CHANGE_ORDER,
  CODE_CHATS,
  DIFFS,
  FIXTURE_NOW,
  MODELS,
  PROJECT_FILES,
  PROJECTS,
  SRC,
  TERM,
  WS,
  type FxChat,
} from "./mockupData";

const ESC = "\x1b[";
const ansi = { p: `${ESC}36m`, m: `${ESC}2m`, g: `${ESC}32m` } as const;

/** `{p:…}` marks → ANSI for xterm, with CRLF line ends like a PTY emits. */
export function termToAnsi(text: string): string {
  return text.replace(/\{([pmg]):([^}]*)\}/g, (_, k: keyof typeof ansi, s: string) => `${ansi[k]}${s}${ESC}0m`).replace(/\n/g, "\r\n");
}
/** The same output with the marks removed, for the transcript's output card. */
export function termToPlain(text: string): string {
  return text.replace(/\{[pmg]:([^}]*)\}/g, "$1");
}

type FxModel = { providerId: string; id: string; label: string; ctx: number };

function model(m: FxModel): ModelInfo {
  return {
    id: m.id,
    label: m.label,
    supportsTools: true,
    supportsThinking: true,
    supportsVision: false,
    contextWindow: m.ctx,
    status: "available",
    tier: "workhorse",
    pricing: null,
    deprecated: false,
    supersededBy: null,
    enabled: true,
    pinned: false,
    inCatalog: true,
    addedManually: false,
    firstSeenAt: 0,
    lastError: null,
  };
}

function provider(id: string, label: string, kind: ProviderDTO["kind"], baseUrl: string | null, m: FxModel, requiresKey: boolean): ProviderDTO {
  return {
    id,
    kind,
    label,
    baseUrl,
    requiresKey,
    models: [model(m)],
    lastHealthStatus: "ok",
    lastHealthAt: FIXTURE_NOW,
    isCustom: false,
    enabled: true,
  };
}

const providers: ProviderDTO[] = [
  provider("ollama", "Ollama", "openai-compatible", "http://localhost:11434/v1", MODELS.qwen, false),
  // The mockup's model menu lists a second on-device model (mock:L870); no fixture chat uses it.
  provider("lmstudio", "LM Studio", "openai-compatible", "http://localhost:1234/v1", { providerId: "lmstudio", id: "gemma-3-12b", label: "Gemma 3 12B", ctx: 128_000 }, false),
  provider("together", "Together AI", "openai-compatible", "https://api.together.xyz/v1", MODELS.glm, true),
  provider("anthropic", "Anthropic", "anthropic", null, MODELS.sonnet, true),
];

const projects: ProjectDTO[] = PROJECTS.map((p, i) => ({
  id: p.id,
  name: p.name,
  path: p.path,
  repoUrl: null,
  defaultBranch: p.branch,
  createdAt: FIXTURE_NOW - (40 - i) * 86_400_000,
}));

/** A mockup diff as the unified text the Changes pane's endpoint returns — headers and all. */
function unifiedFor(path: string): string {
  const d = DIFFS[path]!;
  return d.hunks
    .map((h) => {
      const lines = h.body.split("\n");
      const oc = lines.filter((l) => l[0] === " " || l[0] === "-").length;
      const nc = lines.filter((l) => l[0] === " " || l[0] === "+").length;
      const section = h.title.match(/, in (.+)$/)?.[1] ?? "";
      return `@@ -${h.old},${oc} +${h.nu},${nc} @@${section ? ` ${section}` : ""}\n${h.body}`;
    })
    .join("\n");
}

function mdOf(blocks: FxChat["turns"][number]): string {
  return blocks.role === "ai" ? blocks.blocks.flatMap((b) => (b.k === "text" ? [b.md] : [])).join("\n\n") : blocks.text;
}

export function buildCodeFixture(): FixtureData {
  const chats: ChatDTO[] = [];
  const messages: FixtureData["messages"] = {};
  const toolCalls: FixtureData["toolCalls"] = {};
  const artifacts: FixtureData["artifacts"] = {};
  const artifactContent: FixtureData["artifactContent"] = {};
  const chatSettings: FixtureData["chatSettings"] = {};
  const liveEvents: FixtureData["liveEvents"] = {};

  for (const c of CODE_CHATS) {
    const m = MODELS[c.model];
    const updatedAt = FIXTURE_NOW - c.ago;
    chats.push({
      id: c.id,
      projectId: c.project,
      kind: "code",
      title: c.title,
      backend: { kind: "own-loop" },
      providerId: m.providerId,
      model: m.id,
      mode: c.mode,
      agentId: "default",
      themeId: "wakaba",
      // The sidebar flag keys on this; the engine starts writing it with E2 (plan §8).
      status: c.flag === "waiting" ? "waiting_permission" : "idle",
      costUsd: 0,
      utilityCostUsd: 0,
      contextUsed: c.ctx[0] * 1000,
      contextMax: c.ctx[1] * 1000,
      createdAt: updatedAt - 20 * 60_000,
      updatedAt,
    });
    chatSettings[c.id] = { extraRoots: [], permissionAllow: [], worktreeEnabled: false, worktreePath: null, worktreeBranch: null };

    const msgs: MessageDTO[] = [];
    const calls: ToolCallDTO[] = [];
    const arts: ArtifactDTO[] = [];
    let t = updatedAt - 15 * 60_000;
    let callN = 0;
    let artN = 0;

    c.turns.forEach((turn, i) => {
      const id = `${c.id}-m${i + 1}`;
      t += 45_000;
      if (turn.role === "user") {
        msgs.push({ id, chatId: c.id, seq: i + 1, role: "user", content: turn.text, thinking: null, createdAt: t });
        return;
      }
      const blocks: ChatBlock[] = [];
      let thinking: string | null = null;
      let step = 0;
      for (const b of turn.blocks) {
        if (b.k === "think") {
          blocks.push({ kind: "thinking", text: b.text, durationMs: b.seconds * 1000, stepIndex: step, blockIndex: blocks.length });
          thinking = b.text;
        } else if (b.k === "text") {
          blocks.push({ kind: "text", text: b.md, stepIndex: step, blockIndex: blocks.length });
          step++;
        } else {
          const callId = `${c.id}-c${++callN}`;
          let artifactId: string | null = null;
          if (b.artifact) {
            artifactId = `${c.id}-a${++artN}`;
            // The transcript's diff card reads the same hunks (with their sentences) the Changes pane does.
            const body = b.artifact.kind === "terminal" && !b.artifact.body ? termToPlain(TERM.test) : b.artifact.kind === "diff" && DIFFS[b.artifact.name] ? unifiedFor(b.artifact.name) : b.artifact.body;
            artifactContent[artifactId] = body;
            arts.push({
              id: artifactId,
              chatId: c.id,
              projectId: c.project,
              messageId: id,
              toolCallId: callId,
              kind: b.artifact.kind,
              name: b.artifact.name,
              meta: b.artifact.meta ?? {},
              size: body.length,
              status: "done",
              createdAt: t,
              updatedAt: t,
            });
          }
          const pending = b.ok === null;
          calls.push({
            id: callId,
            messageId: id,
            chatId: c.id,
            name: b.name,
            input: b.input,
            ok: pending ? null : (b.ok ?? true),
            resultSummary: pending ? null : b.summary,
            startedAt: t,
            endedAt: pending ? null : t + 800,
            artifactId,
          });
          blocks.push({ kind: "tool", callId, stepIndex: step, blockIndex: blocks.length });
          t += 1_000;
        }
      }
      msgs.push({ id, chatId: c.id, seq: i + 1, role: "assistant", content: mdOf(turn), thinking, createdAt: t, blocks });
    });

    messages[c.id] = msgs;
    toolCalls[c.id] = calls;
    artifacts[c.id] = arts;

    // Live events: the usage meter, the plan, and (for the waiting chat) the pending permission.
    const events: SessionEvent[] = [{ type: "usage.update", inputTokens: c.ctx[0] * 1000, outputTokens: 0, contextUsed: c.ctx[0] * 1000, contextMax: c.ctx[1] * 1000 }];
    const planItems: TodoItem[] | null = calls.some((x) => x.name === "todo")
      ? ["Cache the resolved tokens whenever a theme is applied", "Paint the cached tokens in main.tsx before React mounts", "Clear the cache when a theme file in ~/.rama/themes changes", "Add tests and run the UI suite"].map((text) => ({ text, status: "done" as const }))
      : null;
    if (planItems) events.push({ type: "todo.updated", chatId: c.id, items: planItems });
    if (c.flag === "waiting") {
      const pendingCall = calls.find((x) => x.ok === null)!;
      events.push({ type: "status", state: "waiting_permission" });
      events.push({ type: "permission.request", reqId: "req-flash-commit", tool: pendingCall.name, input: pendingCall.input, risk: "high" });
    }
    liveEvents[c.id] = events;
  }

  // Changes pane — Rama has four uncommitted files; the demo project is clean.
  const entry = (path: string): ChangeEntryDTO => {
    const d = DIFFS[path]!;
    return { path, origPath: null, status: d.isNew ? "untracked" : "modified", staged: false, unstaged: true, added: d.add, removed: d.del, binary: false };
  };
  const changes: FixtureData["changes"] = {
    rama: { isRepo: true, branch: "main", detached: false, head: null, upstream: "origin/main", ahead: 0, behind: 0, midMerge: false, midRebase: false, entries: CHANGE_ORDER.map(entry), countsOmitted: false },
    demo: { isRepo: true, branch: "main", detached: false, head: null, upstream: null, ahead: 0, behind: 0, midMerge: false, midRebase: false, entries: [], countsOmitted: false } satisfies ChangesDTO,
  };

  const diffs: FixtureData["diffs"] = { rama: {}, demo: {} };
  for (const path of Object.keys(DIFFS)) diffs.rama![path] = unifiedFor(path);

  const files: FixtureData["files"] = { rama: {}, demo: {} };
  for (const [projectId, paths] of Object.entries(PROJECT_FILES)) for (const p of paths) files[projectId]![p] = SRC[p]!.text;

  const terminals: FixtureData["terminals"] = { rama: [], demo: [] };
  const scrollback: FixtureData["scrollback"] = {};
  const runningTerminals: string[] = [];
  WS.rama!.terms.forEach((x, i) => {
    const exited = x.status === "done";
    const dto: TerminalDTO = {
      id: x.id,
      projectId: "rama",
      title: x.title,
      cwd: "/Users/demo/rama",
      shell: "/bin/zsh",
      argv: exited ? ["-lc", x.title] : [],
      owner: x.owner,
      originChatId: x.owner === "agent" ? "flash" : null,
      status: exited ? "exited" : "running",
      exitCode: exited ? 0 : null,
      createdAt: FIXTURE_NOW - (30 - i) * 60_000,
      // "Idle" is the app's quiet-for-a-while heuristic; an old updatedAt is what it will key on.
      updatedAt: x.status === "idle" ? FIXTURE_NOW - 12 * 60_000 : FIXTURE_NOW - 20_000,
    };
    terminals.rama!.push(dto);
    scrollback[x.id] = termToAnsi(x.out);
    if (!exited) runningTerminals.push(x.id);
  });

  return {
    projects,
    chats,
    messages,
    toolCalls,
    artifacts,
    artifactContent,
    chatSettings,
    changes,
    snippets: Object.fromEntries(CODE_CHATS.map((c) => [c.id, c.snippet])),
    diffs,
    files,
    terminals,
    scrollback,
    runningTerminals,
    providers,
    // New drafts start on the mockup's default model (state.model, mock:L1437).
    modelRoles: { chat: { role: "chat", providerId: MODELS.qwen.providerId, modelId: MODELS.qwen.id, updatedAt: 0 } },
    agents: [{ name: "default", description: "General-purpose coding agent", tools: null, mode: null, model: "chat", source: "bundled" }],
    general: { defaultProjectDir: "/Users/demo", defaultMode: "agent", autoNameChats: true, enrichFromOpenRouter: false, pruneOldToolOutputs: false },
    permissions: {},
    liveEvents,
  };
}
