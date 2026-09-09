import type { ClientCommand, SessionEvent } from "@rama/protocol";
import { getEngineConnection } from "./client";

type Listener = (chatId: string, event: SessionEvent) => void;
// docs/MISSION_CONTROL_PLAN.md §5.3 — the project-topic counterpart to Listener above, for
// `terminal.*` events (engine/src/ws.ts's broadcastProject).
type ProjectListener = (projectId: string, event: SessionEvent) => void;
type ThemesListener = () => void;

interface ChatEnvelope {
  chatId: string;
  event: SessionEvent;
}

interface ProjectEnvelope {
  projectId: string;
  event: SessionEvent;
}

// SETTINGS_PLAN.md Phase S1's live-reload push — engine/src/ws.ts's broadcastThemes sends this to
// every connection's fixed "themes" topic, no chatId envelope since it isn't scoped to a chat.
interface ThemesEnvelope {
  type: "themes.changed";
}

const listeners = new Set<Listener>();
const projectListeners = new Set<ProjectListener>();
const themesListeners = new Set<ThemesListener>();
let socketPromise: Promise<WebSocket> | null = null;

// Everything this window currently wants live updates for, replayed on every (re)connect —
// `subscribeChat`/`subscribeProject` are server-side subscriptions tied to one physical WS
// connection, so a fresh socket after a drop starts with none of them until we resend.
const subscribedChatIds = new Set<string>();
const subscribedProjectIds = new Set<string>();

// A dropped/failed connection used to leave `socketPromise` pointing at a dead socket (or a
// rejected promise) forever — nothing ever cleared it, so every `send()` after the first failure
// (a brief network blip, the engine restarting, the computer sleeping) silently no-opped for the
// rest of the session: `sendUserTurn` etc. are all fire-and-forget (`void send(...)`), so a turn
// the user typed would clear the composer and then just vanish with no visible error. Clearing
// `socketPromise` here on close/error is what makes the next `getSocket()` call actually redial.
function connect(): Promise<WebSocket> {
  const promise = (async () => {
    const { url, token } = await getEngineConnection();
    const wsUrl = `${url.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;

    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.addEventListener("open", () => {
        for (const chatId of subscribedChatIds) ws.send(JSON.stringify({ type: "subscribeChat", chatId }));
        for (const projectId of subscribedProjectIds) ws.send(JSON.stringify({ type: "subscribeProject", projectId }));
        resolve(ws);
      });
      ws.addEventListener("error", () => reject(new Error("engine websocket connection failed")));
      ws.addEventListener("close", () => {
        if (socketPromise === promise) socketPromise = null;
      });
      ws.addEventListener("message", (e) => {
        let envelope: ChatEnvelope | ProjectEnvelope | ThemesEnvelope;
        try {
          envelope = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if ("chatId" in envelope) {
          for (const listener of listeners) listener(envelope.chatId, envelope.event);
        } else if ("projectId" in envelope) {
          for (const listener of projectListeners) listener(envelope.projectId, envelope.event);
        } else if (envelope.type === "themes.changed") {
          for (const listener of themesListeners) listener();
        }
      });
    });
  })();

  promise.catch(() => {
    if (socketPromise === promise) socketPromise = null;
  });
  return promise;
}

function getSocket(): Promise<WebSocket> {
  if (!socketPromise) socketPromise = connect();
  return socketPromise;
}

export function onEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function onProjectEvent(listener: ProjectListener): () => void {
  projectListeners.add(listener);
  return () => projectListeners.delete(listener);
}

export function onThemesChanged(listener: ThemesListener): () => void {
  themesListeners.add(listener);
  // Fire-and-forget: makes sure the socket actually opens (and thus subscribes to "themes") even
  // if nothing else on this window has sent a chat command yet.
  void getSocket();
  return () => themesListeners.delete(listener);
}

export async function send(command: ClientCommand): Promise<void> {
  if (command.type === "subscribeChat") subscribedChatIds.add(command.chatId);
  else if (command.type === "unsubscribeChat") subscribedChatIds.delete(command.chatId);
  else if (command.type === "subscribeProject") subscribedProjectIds.add(command.projectId);
  else if (command.type === "unsubscribeProject") subscribedProjectIds.delete(command.projectId);

  let ws = await getSocket();
  // The socket can still be mid-close when a caller races the "close" listener above (it hasn't
  // run yet, so `socketPromise` hasn't been cleared) — redial once rather than throwing away this
  // command silently like the old no-retry version did.
  if (ws.readyState !== WebSocket.OPEN) {
    socketPromise = null;
    ws = await getSocket();
  }
  ws.send(JSON.stringify(command));
}
