import type { SessionEvent } from "@rama/protocol";
import type { Server } from "bun";

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
