import type { ClientCommand, SessionEvent } from "@rama/protocol";
import { getEngineConnection } from "./client";

type Listener = (chatId: string, event: SessionEvent) => void;

interface WireEnvelope {
  chatId: string;
  event: SessionEvent;
}

const listeners = new Set<Listener>();
let socketPromise: Promise<WebSocket> | null = null;

async function connect(): Promise<WebSocket> {
  const { url, token } = await getEngineConnection();
  const wsUrl = `${url.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error("engine websocket connection failed")));
    ws.addEventListener("message", (e) => {
      let envelope: WireEnvelope;
      try {
        envelope = JSON.parse(String(e.data));
      } catch {
        return;
      }
      for (const listener of listeners) listener(envelope.chatId, envelope.event);
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

export async function send(command: ClientCommand): Promise<void> {
  const ws = await getSocket();
  ws.send(JSON.stringify(command));
}
