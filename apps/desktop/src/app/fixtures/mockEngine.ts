// In-memory stand-in for the Rama engine (docs/CODE_REDESIGN_PLAN.md CR1).
//
// Fixture mode swaps the transport, not the app: `fetch` calls to FIXTURE_ORIGIN are answered
// from a FixtureData snapshot, and a fake WebSocket replays the live events (permission
// requests, todos) a real engine would push. Every provider, adapter and pane then runs its
// production code path against the mockup's content, which is what makes a pixel diff against
// docs/Rama/home-redesign.html mean something.
//
// Anything the router doesn't know answers 404 and logs `[fixture] no route …`, so gaps show up
// in the console instead of as silently empty UI.

import type {
  AgentSummaryDTO,
  ArtifactDTO,
  AttachmentDTO,
  ChangeDiffDTO,
  ChangesDTO,
  ChatDTO,
  ChatSettingsDTO,
  FileContentDTO,
  FileEntryDTO,
  GeneralSettingsDTO,
  HomeChatSummaryDTO,
  MessageDTO,
  ModelRole,
  ModelRoleDTO,
  PermissionSettings,
  ProjectDTO,
  ProviderDTO,
  SessionEvent,
  TerminalDTO,
  ToolCallDTO,
} from "@rama/protocol";

export const FIXTURE_ORIGIN = "http://rama-fixture.test";

export interface FixtureData {
  projects: ProjectDTO[];
  chats: ChatDTO[];
  /** CR8 — chatId → the resume row's one-line snippet (GET /projects/:id/recent-chats). */
  snippets?: Record<string, string>;
  messages: Record<string, MessageDTO[]>;
  toolCalls: Record<string, ToolCallDTO[]>;
  artifacts: Record<string, ArtifactDTO[]>;
  artifactContent: Record<string, string>;
  chatSettings: Record<string, ChatSettingsDTO>;
  changes: Record<string, ChangesDTO>;
  diffs: Record<string, Record<string, string>>; // projectId → path → unified diff text
  files: Record<string, Record<string, string>>; // projectId → path → content
  terminals: Record<string, TerminalDTO[]>;
  scrollback: Record<string, string>;
  runningTerminals: string[];
  providers: ProviderDTO[];
  agents: AgentSummaryDTO[];
  general: GeneralSettingsDTO;
  permissions: PermissionSettings;
  /** Events replayed to a chat's subscriber right after `subscribeChat`. */
  liveEvents: Record<string, SessionEvent[]>;
  /** HOME_REDESIGN_PLAN.md HD4/HD5 — set by fixtures/home/build.ts for the Home fixtures. */
  homeChats?: HomeChatSummaryDTO[];
  modelRoles?: Partial<Record<ModelRole, ModelRoleDTO>>;
}

type Json = unknown;
interface Reply {
  status: number;
  body: Json;
}
const ok = (body: Json): Reply => ({ status: 200, body });
const notFound = (method: string, path: string): Reply => {
  console.warn(`[fixture] no route ${method} ${path}`);
  return { status: 404, body: { error: `fixture: no route ${method} ${path}` } };
};

function childrenOf(paths: string[], dir: string): FileEntryDTO[] {
  const prefix = dir ? `${dir}/` : "";
  const seen = new Map<string, FileEntryDTO>();
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      seen.set(rest, { name: rest, path: p, kind: "file", size: 0, ignored: false });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) seen.set(name, { name, path: prefix + name, kind: "dir", size: null, ignored: false });
    }
  }
  return [...seen.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.kind === "dir" ? -1 : 1));
}

export class MockEngine {
  private chatEmitters = new Set<(chatId: string, event: SessionEvent) => void>();

  constructor(private data: FixtureData) {}

  /** Wired by the fake socket: how an event reaches the app's `onEvent` listeners. */
  addEmitter(fn: (chatId: string, event: SessionEvent) => void): () => void {
    this.chatEmitters.add(fn);
    return () => this.chatEmitters.delete(fn);
  }

  onSubscribeChat(chatId: string): void {
    const events = this.data.liveEvents[chatId];
    if (!events) return;
    // After a tick, so the app's own subscription bookkeeping has settled first.
    setTimeout(() => {
      for (const e of events) for (const fn of this.chatEmitters) fn(chatId, e);
    }, 30);
  }

  // HOME_REDESIGN_PLAN.md HD6 — a scripted run for Home chats, so sending and Try again can be
  // watched end to end in fixture mode: the user's message, a moment of thinking, one file read,
  // then a reply streamed in pieces. Code chats keep the "no model attached" error below.
  isHomeChat(chatId: string): boolean {
    return !!this.data.homeChats?.some((c) => c.id === chatId);
  }

  // HD7 — uploads land here until a sendUserTurn carries their ids.
  private uploads = new Map<string, AttachmentDTO>();
  // The fixture clock is frozen, so ids can't come from Date.now() alone: every scripted run would
  // reuse one run id and tool-call id, and a second run's rows would collide with the first's.
  private seqId = 0;

  takeUploads(ids: unknown): AttachmentDTO[] {
    if (!Array.isArray(ids)) return [];
    return ids.flatMap((id) => {
      const a = this.uploads.get(String(id));
      this.uploads.delete(String(id));
      return a ? [a] : [];
    });
  }

  playHomeTurn(chatId: string, text: string, attachments: AttachmentDTO[] = []): void {
    const d = this.data;
    const emit = (event: SessionEvent) => {
      for (const fn of this.chatEmitters) fn(chatId, event);
    };
    const runId = `fixture-${Date.now()}-${++this.seqId}`;
    const list = (d.messages[chatId] ??= []);
    const seq = () => (list[list.length - 1]?.seq ?? 0) + 1;
    list.push({ id: `${runId}-u`, chatId, seq: seq(), role: "user", content: text, thinking: null, createdAt: Date.now(), ...(attachments.length ? { attachments } : {}) });
    // HD7 — an attached document is what the scripted run reads.
    const doc = attachments.find((a) => !a.mime.startsWith("image/"));
    const readPath = `attachments/fixture/${doc?.name ?? "notes.txt"}`;
    const readSummary = doc?.mime === "application/pdf" ? "1-40 of 40 lines · 3 pages" : "1-40 of 40 lines";
    const reply = `This is fixture mode, so there's no model behind it. In Rama, the chat's model would answer ${text ? `**${text.slice(0, 40)}**` : "your message"} right here, in the same type as the rest of the conversation.\n\n- Replies stream in a piece at a time.\n- Anything it read shows as a row above.`;
    const callId = `${runId}-tc`;
    const steps: [number, () => void][] = [
      [0, () => emit({ type: "message.user", id: `${runId}-u`, text, ts: Date.now(), ...(attachments.length ? { attachments } : {}) })],
      [20, () => emit({ type: "run.started", runId, ts: Date.now() })],
      [10, () => emit({ type: "status", state: "thinking", verb: "thinking" })],
      [1200, () => emit({ type: "tool.call", callId, name: "read", input: { path: readPath }, ts: Date.now(), stepIndex: 0, blockIndex: 0 })],
      [10, () => emit({ type: "status", state: "tool", verb: "reading" })],
      [900, () => emit({ type: "tool.result", callId, ok: true, summary: readSummary })],
      [10, () => emit({ type: "status", state: "streaming" })],
      ...reply.match(/[\s\S]{1,24}/g)!.map((piece): [number, () => void] => [60, () => emit({ type: "message.delta", runId, text: piece, stepIndex: 1, blockIndex: 0 })]),
      [20, () => emit({ type: "message.done", runId })],
      [10, () => emit({ type: "run.finished", runId, ts: Date.now(), state: "completed" })],
      [10, () => emit({ type: "status", state: "idle" })],
    ];
    let at = 0;
    for (const [delay, fn] of steps) setTimeout(fn, (at += delay));
    setTimeout(() => {
      (d.toolCalls[chatId] ??= []).push({ id: callId, messageId: `${runId}-a`, chatId, name: "read", input: { path: readPath }, ok: true, resultSummary: readSummary, startedAt: Date.now(), endedAt: Date.now(), artifactId: null });
      list.push({
        id: `${runId}-a`, chatId, seq: seq(), role: "assistant", content: reply, thinking: null, createdAt: Date.now(),
        blocks: [{ kind: "tool", callId, stepIndex: 0, blockIndex: 0 }, { kind: "text", text: reply, stepIndex: 1, blockIndex: 0 }],
      });
    }, at);
  }

  // docs/CODE_REDESIGN_PLAN.md CR6 — the same idea for Code chats, so a run can be watched in fixture
  // mode: a moment of thinking (the live "Thinking" row), a bash call whose output streams in (the
  // live row that opens itself), then a reply written a piece at a time. The permission ask is
  // already on screen in the "flash" chat.
  playCodeTurn(chatId: string, text: string): void {
    const d = this.data;
    const emit = (event: SessionEvent) => {
      for (const fn of this.chatEmitters) fn(chatId, event);
    };
    const runId = `fixture-${Date.now()}-${++this.seqId}`;
    const list = (d.messages[chatId] ??= []);
    const seq = () => (list[list.length - 1]?.seq ?? 0) + 1;
    list.push({ id: `${runId}-u`, chatId, seq: seq(), role: "user", content: text, thinking: null, createdAt: Date.now() });
    const callId = `${runId}-tc`;
    const artId = `${runId}-ta`;
    const thought = "The quickest check is to run the tests and see what they say.";
    const out = ["bun test v1.3.2", "", "packages/ui/src/theme.test.ts:", "(pass) cached theme tokens > a saved theme is cached", "", " 12 pass", " 0 fail"];
    const summary = `exit 0 · ${out.filter(Boolean).length} lines · 12 passed`;
    const reply = `The tests pass: 12 of 12. This is fixture mode, so there is no model behind it, but this is how a run reads while it works:\n\n- The thinking row counts the seconds.\n- A running command opens by itself and closes when it finishes.`;
    const steps: [number, () => void][] = [
      [0, () => emit({ type: "message.user", id: `${runId}-u`, text, ts: Date.now() })],
      [20, () => emit({ type: "run.started", runId, ts: Date.now() })],
      [10, () => emit({ type: "status", state: "thinking", verb: "thinking" })],
      ...thought.match(/[\s\S]{1,20}/g)!.map((piece): [number, () => void] => [250, () => emit({ type: "thinking.delta", runId, text: piece, stepIndex: 0, blockIndex: 0 })]),
      [400, () => emit({ type: "thinking.done", runId, durationMs: 2400, stepIndex: 0, blockIndex: 0 })],
      [100, () => emit({ type: "tool.call", callId, name: "bash", input: { command: "bun test packages/ui" }, ts: Date.now(), stepIndex: 0, blockIndex: 1 })],
      [10, () => emit({ type: "status", state: "tool", verb: "running bash" })],
      [10, () => emit({ type: "artifact.created", artifactId: artId, kind: "terminal", name: "bun test packages/ui", meta: {} })],
      ...out.map((line): [number, () => void] => [500, () => emit({ type: "artifact.updated", artifactId: artId, delta: `${line}\n`, status: "streaming" })]),
      [300, () => emit({ type: "artifact.updated", artifactId: artId, status: "done" })],
      [10, () => emit({ type: "tool.result", callId, ok: true, summary, artifactId: artId })],
      [10, () => emit({ type: "status", state: "streaming", verb: "responding" })],
      ...reply.match(/[\s\S]{1,24}/g)!.map((piece): [number, () => void] => [60, () => emit({ type: "message.delta", runId, text: piece, stepIndex: 1, blockIndex: 0 })]),
      [20, () => emit({ type: "message.done", runId })],
      [10, () => emit({ type: "run.finished", runId, ts: Date.now(), state: "completed" })],
      [10, () => emit({ type: "status", state: "idle" })],
    ];
    let at = 0;
    for (const [delay, fn] of steps) setTimeout(fn, (at += delay));
    setTimeout(() => {
      const body = out.join("\n");
      (d.artifactContent[artId] = body);
      (d.artifacts[chatId] ??= []).push({ id: artId, chatId, projectId: d.chats.find((c) => c.id === chatId)?.projectId ?? "", messageId: `${runId}-a`, toolCallId: callId, kind: "terminal", name: "bun test packages/ui", meta: { exitCode: 0 }, size: body.length, status: "done", createdAt: Date.now(), updatedAt: Date.now() });
      (d.toolCalls[chatId] ??= []).push({ id: callId, messageId: `${runId}-a`, chatId, name: "bash", input: { command: "bun test packages/ui" }, ok: true, resultSummary: summary, startedAt: Date.now(), endedAt: Date.now(), artifactId: artId });
      list.push({
        id: `${runId}-a`, chatId, seq: seq(), role: "assistant", content: reply, thinking: thought, createdAt: Date.now(),
        blocks: [{ kind: "thinking", text: thought, durationMs: 2400, stepIndex: 0, blockIndex: 0 }, { kind: "tool", callId, stepIndex: 0, blockIndex: 1 }, { kind: "text", text: reply, stepIndex: 1, blockIndex: 0 }],
      });
    }, at);
  }

  /** `invoke("…")` commands that aren't plugin calls. */
  tauri(cmd: string, args: Record<string, unknown>): unknown {
    switch (cmd) {
      case "get_engine_connection":
        return { url: FIXTURE_ORIGIN, token: "fixture" };
      case "get_window_tabs":
      case "initialize_window_tabs":
        return this.data.chats.map((c) => c.id);
      case "list_all_window_tabs":
        return { main: this.data.chats.map((c) => c.id) };
      case "add_chat_to_window":
      case "get_provider_key": // legacy keychain → engine migration: nothing to migrate
        return null;
      case "pty_is_running":
        return this.data.runningTerminals.includes(String(args.terminalId));
      case "pty_list_running":
        return this.data.runningTerminals;
      case "pty_spawn":
      case "pty_write":
      case "pty_resize":
      case "pty_kill":
      case "remove_chat_from_windows":
      case "pop_out_chat":
        return undefined;
      default:
        // webview_* and anything new: harmless no-ops. Fixture mode never creates a native webview.
        if (cmd.startsWith("webview_")) return cmd === "webview_eval" || cmd === "webview_read" || cmd === "webview_snapshot" ? "{}" : undefined;
        console.warn(`[fixture] unhandled tauri command ${cmd}`);
        return undefined;
    }
  }

  handle(method: string, rawPath: string, body: unknown): Reply {
    const url = new URL(rawPath, FIXTURE_ORIGIN);
    const path = url.pathname;
    const q = url.searchParams;
    const d = this.data;
    const seg = path.split("/").filter(Boolean);
    const b = (body ?? {}) as Record<string, unknown>;

    if (method === "GET") {
      if (path === "/projects") return ok(d.projects);
      if (path === "/chats") return ok(d.chats);
      // HOME_REDESIGN_PLAN.md HD4 — the Home fixtures fill this (fixtures/home/build.ts).
      if (path === "/home/chats") return ok(d.homeChats ?? []);
      if (path === "/providers") return ok(d.providers);
      if (path === "/catalog/providers") return ok([]);
      if (path === "/model-roles") return ok({ chat: null, utility: null, summarize: null, subagent: null, ...d.modelRoles });
      if (path === "/settings/general") return ok(d.general);
      if (path === "/settings/permissions") return ok(d.permissions);
      if (path === "/settings/instructions") return ok({ content: "", lines: 0, oversize: false, exists: false });
      if (path === "/agents") return ok(d.agents);
      if (path === "/skills" || path === "/mcp/servers" || path === "/search/domains") return ok([]);
      // The composer's `/` menu: a few tools and commands, filtered by the typed term.
      if (path === "/search") {
        const term = (q.get("q") ?? "").toLowerCase();
        const all = [
          { id: "tool:read_file", domain: "tools", title: "read_file", subtitle: "Read a file from the project", score: 1 },
          { id: "tool:bash", domain: "tools", title: "bash", subtitle: "Run a shell command", score: 1 },
          { id: "cmd:mode:plan", domain: "commands", title: "plan", subtitle: "Switch to Plan mode", score: 1 },
          { id: "cmd:clear", domain: "commands", title: "clear", subtitle: "Clear the message box", score: 1 },
        ];
        return ok(all.filter((r) => r.title.includes(term)));
      }
      if (path === "/themes") return ok({ themes: [], errors: [] });

      if (seg[0] === "providers" && seg[2] === "health") {
        return ok({ providerId: seg[1], status: "ok", latencyMs: 12, error: null, checkedAt: 0 });
      }

      if (seg[0] === "projects") {
        const projectId = seg[1]!;
        const tail = seg.slice(2).join("/");
        if (tail === "chats") return ok(d.chats.filter((c) => c.projectId === projectId));
        if (tail === "recent-chats") {
          const limit = Number(q.get("limit")) || 3;
          return ok(
            d.chats
              .filter((c) => c.projectId === projectId)
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .slice(0, limit)
              .map((c) => ({ ...c, snippet: d.snippets?.[c.id] ?? null })),
          );
        }
        if (tail === "changes") return ok(d.changes[projectId] ?? { isRepo: false, branch: null, detached: false, head: null, upstream: null, ahead: 0, behind: 0, midMerge: false, midRebase: false, entries: [], countsOmitted: false });
        if (tail === "changes/diff") {
          const diff = d.diffs[projectId]?.[q.get("path") ?? ""];
          return ok({ path: q.get("path") ?? "", diff: diff ?? "", binary: false, truncated: false } satisfies ChangeDiffDTO);
        }
        if (tail === "files") {
          const paths = Object.keys(d.files[projectId] ?? {});
          const entries = childrenOf(paths, q.get("path") ?? "").map((e) => (e.kind === "file" ? { ...e, size: d.files[projectId]![e.path]!.length } : e));
          return ok({ entries });
        }
        if (tail === "files/content") {
          const path2 = q.get("path") ?? "";
          const content = d.files[projectId]?.[path2];
          if (content == null) return { status: 404, body: { error: "no such file" } };
          return ok({ path: path2, content, size: content.length, lines: content.split("\n").length, binary: false, truncated: false } satisfies FileContentDTO);
        }
        if (tail === "terminals") return ok(d.terminals[projectId] ?? []);
        if (tail === "settings/permissions") return ok({});
        if (tail === "instructions") return ok({ content: "", lines: 0, oversize: false, exists: false });
        if (tail === "docs") return ok([]);
        if (tail === "curation/proposals") return ok([]);
      }

      if (seg[0] === "chats") {
        const chatId = seg[1]!;
        const tail = seg[2];
        if (tail === "messages") return ok(d.messages[chatId] ?? []);
        if (tail === "tool-calls") return ok(d.toolCalls[chatId] ?? []);
        if (tail === "artifacts") return ok(d.artifacts[chatId] ?? []);
        if (tail === "settings") return ok(d.chatSettings[chatId] ?? { extraRoots: [], permissionAllow: [], worktreeEnabled: false, worktreePath: null, worktreeBranch: null });
        if (tail === "changes") {
          const projectId = d.chats.find((c) => c.id === chatId)?.projectId ?? "";
          return ok(d.changes[projectId] ?? { isRepo: false, branch: null, detached: false, head: null, upstream: null, ahead: 0, behind: 0, midMerge: false, midRebase: false, entries: [], countsOmitted: false });
        }
      }

      if (seg[0] === "artifacts" && seg[2] === "content") return ok({ content: d.artifactContent[seg[1]!] ?? "" });
      if (seg[0] === "terminals" && seg[2] === "scrollback") return ok({ content: d.scrollback[seg[1]!] ?? "" });
    }

    if (method === "PATCH" && seg[0] === "chats" && seg.length === 2) {
      const chat = d.chats.find((c) => c.id === seg[1]) ?? d.homeChats?.find((c) => c.id === seg[1]);
      if (!chat) return notFound(method, path);
      Object.assign(chat, b);
      return ok(chat);
    }
    // HOME_REDESIGN_PLAN.md HD4/HD5 — so the Home sidebar's delete and the landing's send can be
    // exercised in fixture mode.
    if (method === "DELETE" && seg[0] === "chats" && seg.length === 2) {
      d.chats = d.chats.filter((c) => c.id !== seg[1]);
      if (d.homeChats) d.homeChats = d.homeChats.filter((c) => c.id !== seg[1]);
      return ok({ ok: true });
    }
    if (method === "POST" && seg[0] === "chats" && seg[2] === "retry" && this.isHomeChat(seg[1]!)) {
      const list = d.messages[seg[1]!] ?? [];
      const users = list.flatMap((m, i) => (m.role === "user" ? [i] : []));
      const cut = typeof b.userTurn === "number" ? users[b.userTurn] : users[users.length - 1];
      if (cut === undefined) return { status: 409, body: { error: "nothing to try again" } };
      const text = list[cut]!.content ?? "";
      d.messages[seg[1]!] = list.slice(0, cut);
      this.playHomeTurn(seg[1]!, text, list[cut]!.attachments);
      return { status: 202, body: { ok: true } };
    }
    // HD7 — the composer's uploads; the engine would extract a PDF's page count here.
    if (method === "POST" && seg[0] === "home" && seg[3] === "attachments" && body instanceof FormData) {
      const file = body.get("file");
      if (!(file instanceof File)) return { status: 400, body: { error: "a file is required" } };
      const a: AttachmentDTO = { id: `upload-${++this.seqId}`, name: file.name, mime: file.type || "application/octet-stream", size: file.size };
      this.uploads.set(a.id, a);
      return { status: 201, body: a };
    }
    if (method === "POST" && path === "/home/chats") {
      const now = Date.now();
      const chat: HomeChatSummaryDTO = {
        id: `home-${now}`,
        projectId: "home",
        kind: "home",
        title: "New chat",
        backend: { kind: "own-loop" },
        providerId: String(b.providerId ?? "ollama"),
        model: String(b.model ?? "qwen3:14b"),
        mode: "agent",
        agentId: "home",
        themeId: "wakaba",
        status: "idle",
        costUsd: 0,
        utilityCostUsd: 0,
        contextUsed: 0,
        contextMax: 0,
        createdAt: now,
        updatedAt: now,
        snippet: null,
        webSearch: Boolean(b.webSearch),
      };
      (d.homeChats ??= []).unshift(chat);
      return { status: 201, body: chat };
    }
    if (method === "PUT" && seg[0] === "chats" && seg[2] === "settings") {
      const cur = (d.chatSettings[seg[1]!] ??= { extraRoots: [], permissionAllow: [], worktreeEnabled: false, worktreePath: null, worktreeBranch: null });
      if (Array.isArray(b.extraRoots)) cur.extraRoots = b.extraRoots as string[];
      return ok(cur);
    }
    if (method === "POST" && seg[0] === "chats" && seg[2] === "worktree") {
      const cur = (d.chatSettings[seg[1]!] ??= { extraRoots: [], permissionAllow: [], worktreeEnabled: false, worktreePath: null, worktreeBranch: null });
      cur.worktreeEnabled = Boolean(b.enabled);
      return ok(cur);
    }
    if (method === "POST" && seg[0] === "chats" && seg[2] === "undo") return ok({ ok: true, message: "fixture: nothing to undo" });
    if (method === "POST" && path === "/catalog/enrich") return ok({ ran: false, matched: 0 });
    if (method === "POST" && seg[0] === "browser") return ok({ ok: true });
    if (method === "POST" && seg[0] === "terminals" && seg[2] === "data") return ok({ ok: true });
    if ((method === "PUT" || method === "PATCH") && path.startsWith("/settings/")) return ok(b);

    return notFound(method, path);
  }
}

// ── transport wiring ─────────────────────────────────────────────────────────────────────

class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  private off: () => void;
  private subscribed = new Set<string>();

  constructor(
    readonly url: string,
    private engine: MockEngine,
  ) {
    super();
    this.off = engine.addEmitter((chatId, event) => {
      if (!this.subscribed.has(chatId)) return;
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ chatId, event }) }));
    });
    setTimeout(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }, 0);
  }

  send(raw: string): void {
    let cmd: { type: string; chatId?: string };
    try {
      cmd = JSON.parse(raw);
    } catch {
      return;
    }
    // The fixture has no model to answer an approval, so it keeps the commands for a test to read.
    ((window as unknown as { __fixtureCommands?: unknown[] }).__fixtureCommands ??= []).push(cmd);
    if (cmd.type === "subscribeChat" && cmd.chatId) {
      this.subscribed.add(cmd.chatId);
      this.engine.onSubscribeChat(cmd.chatId);
    } else if (cmd.type === "unsubscribeChat" && cmd.chatId) {
      this.subscribed.delete(cmd.chatId);
    } else if (cmd.type === "sendUserTurn" && cmd.chatId && this.engine.isHomeChat(cmd.chatId)) {
      const c = cmd as { text?: unknown; attachmentIds?: unknown };
      this.engine.playHomeTurn(cmd.chatId, String(c.text ?? ""), this.engine.takeUploads(c.attachmentIds));
    } else if (cmd.type === "sendUserTurn" && cmd.chatId) {
      this.engine.playCodeTurn(cmd.chatId, String((cmd as { text?: unknown }).text ?? ""));
    }
  }

  close(): void {
    this.readyState = 3;
    this.off();
    this.dispatchEvent(new Event("close"));
  }
}

export function installEngineTransport(engine: MockEngine): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(FIXTURE_ORIGIN)) return realFetch(input, init);
    let body: unknown;
    if (init?.body instanceof FormData) body = init.body; // HD7 uploads
    else if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = undefined;
      }
    }
    const { status, body: out } = engine.handle((init?.method ?? "GET").toUpperCase(), url.slice(FIXTURE_ORIGIN.length), body);
    return new Response(JSON.stringify(out), { status, headers: { "Content-Type": "application/json" } });
  };

  // A test's way to play a project-topic frame (`chat.status`, …) at every open socket, as the real
  // engine does for a chat the window never subscribed to.
  (window as unknown as { __fixtureEmitProject?: unknown }).__fixtureEmitProject = (projectId: string, event: unknown) => {
    for (const socket of sockets) socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ projectId, event }) }));
  };
  const sockets = new Set<FakeSocket>();

  const RealWS = window.WebSocket;
  window.WebSocket = new Proxy(RealWS, {
    construct(target, args: [string | URL, (string | string[])?]) {
      const url = String(args[0]);
      if (url.startsWith(FIXTURE_ORIGIN.replace(/^http/, "ws"))) {
        const socket = new FakeSocket(url, engine);
        sockets.add(socket);
        socket.addEventListener("close", () => sockets.delete(socket));
        return socket as unknown as WebSocket;
      }
      return new target(...args);
    },
  });
}
