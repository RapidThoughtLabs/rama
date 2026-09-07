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

async function connect(): Promise<WebSocket> {
  const { url, token } = await getEngineConnection();
  const wsUrl = `${url.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error("engine websocket connection failed")));
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
  const ws = await getSocket();
  ws.send(JSON.stringify(command));
}
