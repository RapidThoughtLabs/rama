import type { SessionEvent, SessionStatusState } from "@rama/protocol";
import type { Server } from "bun";
import { db } from "./db/index";

export interface SocketData {
  subscriptions: Set<string>;
}

// Set once by createServer() (server.ts). Kept separate from server.ts so agent/loop.ts can
// broadcast without an import cycle on the module that defines createServer.
let serverRef: Server<SocketData> | null = null;

export function setServer(server: Server<SocketData>): void {
  serverRef = server;
}

// Wire envelope: SessionEvent itself carries no chatId (per docs/IMPLEMENTATION_PLAN.md §3,
// it's meant to be scoped by which chat's stream you're subscribed to). Since a single
// physical WS connection can be subscribed to more than one chat's topic at once, the client
// still needs to know which chat an incoming frame belongs to — hence this thin wrapper,
// added only at serialization time so the in-process SessionEvent type stays exactly the spec.
export function broadcast(chatId: string, event: SessionEvent): void {
  serverRef?.publish(chatId, JSON.stringify({ chatId, event }));
  if (event.type === "status") trackChatStatus(chatId, event.state);
}

// CODE_REDESIGN_PLAN.md E2 — what each chat is doing right now, for the sidebar. Every `status`
// event a run broadcasts passes through here, so the run loop and the permission gate don't each
// need to remember to tell the project topic. Memory only: a status that outlived the engine
// would read "working" forever after a crash, and the DB column stays what it always was.
const liveStatus = new Map<string, SessionStatusState>();
const projectOfChat = new Map<string, string>();

/** The chat's live state, or undefined when it is idle (or the engine just started). */
export function liveChatStatus(chatId: string): SessionStatusState | undefined {
  return liveStatus.get(chatId);
}

function trackChatStatus(chatId: string, state: SessionStatusState): void {
  // An error ends the run just as idle does; neither is something the sidebar draws.
  const next: SessionStatusState = state === "error" ? "idle" : state;
  const previous = liveStatus.get(chatId) ?? "idle";
  if (next === "idle") liveStatus.delete(chatId);
  else liveStatus.set(chatId, next);
  // thinking → streaming → tool all draw the same dot; only a change of kind is worth a frame.
  if (sidebarKind(previous) === sidebarKind(next)) return;

  let projectId = projectOfChat.get(chatId);
  if (!projectId) {
    projectId = db.query<{ project_id: string }, [string]>("SELECT project_id FROM chats WHERE id = ?").get(chatId)?.project_id;
    if (!projectId) return;
    projectOfChat.set(chatId, projectId);
  }
  broadcastProject(projectId, { type: "chat.status", chatId, status: next });
}

function sidebarKind(state: SessionStatusState): "idle" | "running" | "waiting_permission" {
  return state === "idle" ? "idle" : state === "waiting_permission" ? "waiting_permission" : "running";
}

// docs/MISSION_CONTROL_PLAN.md §5.3 — terminals are project-scoped, not chat-scoped, so their
// SessionEvents (`terminal.*`) ride a `project:{id}` topic instead of a chat topic. Same thin
// envelope shape as broadcast() above, just keyed by projectId instead of chatId.
export function broadcastProject(projectId: string, event: SessionEvent): void {
  serverRef?.publish(`project:${projectId}`, JSON.stringify({ projectId, event }));
}

// Every connection auto-subscribes to this fixed topic (server.ts's websocket `open` handler) —
// unlike chat events, "the theme folder changed" isn't scoped to whichever chats a client happens
// to be subscribed to. SETTINGS_PLAN.md Phase S1's live-reload: fs.watch(THEMES_HOME) calls this,
// the frontend refetches GET /themes on receipt rather than trying to diff the change itself.
export function broadcastThemes(): void {
  serverRef?.publish("themes", JSON.stringify({ type: "themes.changed" }));
}
