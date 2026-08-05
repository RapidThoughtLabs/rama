import type { ClientCommand } from "@rama/protocol";
import { interrupt, isRunning, runTurn } from "./agent/loop";
import { resolvePermission } from "./agent/permissions";
import { checkAuth } from "./auth";
import { getArtifactContent, listArtifacts } from "./db/artifacts";
import { createChat, getChat, listAllChats, listChatsByProject, updateChat } from "./db/chats";
import { listMessages } from "./db/messages";
import { createProject, getProject, listProjects } from "./db/projects";
import { listProviders } from "./db/providers";
import { listToolCalls } from "./db/toolCalls";
import { checkProviderHealth } from "./providerHealth";
import { setSecret } from "./secrets";
import { broadcast, setServer, type SocketData } from "./ws";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...(init.headers ?? {}) },
  });
}

const notFound = () => json({ error: "not found" }, { status: 404 });
const unauthorized = () => json({ error: "unauthorized" }, { status: 401 });

export function createServer() {
  const server = Bun.serve<SocketData>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, server) {
      const url = new URL(req.url);
      const { pathname } = url;

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      if (pathname === "/ws") {
        if (!checkAuth(req, url)) return unauthorized();
        if (server.upgrade(req, { data: { subscriptions: new Set() } })) return undefined;
        return json({ error: "expected websocket upgrade" }, { status: 400 });
      }

      if (!checkAuth(req, url)) return unauthorized();

      try {
        if (pathname === "/health" && req.method === "GET") {
          return json({ ok: true });
        }

        if (pathname === "/projects" && req.method === "GET") {
          return json(listProjects());
        }

        if (pathname === "/projects" && req.method === "POST") {
          const body = await req.json().catch(() => null);
          if (!body?.name || !body?.path) {
            return json({ error: "name and path are required" }, { status: 400 });
          }
          return json(createProject({ name: body.name, path: body.path }), { status: 201 });
        }

        if (pathname === "/chats" && req.method === "GET") {
          return json(listAllChats());
        }

        const projectChatsMatch = pathname.match(/^\/projects\/([^/]+)\/chats$/);
        if (projectChatsMatch) {
          const projectId = projectChatsMatch[1];
          if (!getProject(projectId)) return json({ error: "project not found" }, { status: 404 });

          if (req.method === "GET") {
            return json(listChatsByProject(projectId));
          }
          if (req.method === "POST") {
            const body = await req.json().catch(() => ({}));
            return json(createChat(projectId, body ?? {}), { status: 201 });
          }
        }

        const chatMatch = pathname.match(/^\/chats\/([^/]+)$/);
        if (chatMatch && req.method === "PATCH") {
          const body = await req.json().catch(() => ({}));
          const updated = updateChat(chatMatch[1], body ?? {});
          if (!updated) return json({ error: "chat not found" }, { status: 404 });
          return json(updated);
        }

        const chatMessagesMatch = pathname.match(/^\/chats\/([^/]+)\/messages$/);
        if (chatMessagesMatch && req.method === "GET") {
          const chatId = chatMessagesMatch[1];
          if (!getChat(chatId)) return json({ error: "chat not found" }, { status: 404 });
          return json(listMessages(chatId));
        }

        const chatToolCallsMatch = pathname.match(/^\/chats\/([^/]+)\/tool-calls$/);
        if (chatToolCallsMatch && req.method === "GET") {
          const chatId = chatToolCallsMatch[1];
          if (!getChat(chatId)) return json({ error: "chat not found" }, { status: 404 });
          return json(listToolCalls(chatId));
        }

        const chatArtifactsMatch = pathname.match(/^\/chats\/([^/]+)\/artifacts$/);
        if (chatArtifactsMatch && req.method === "GET") {
          const chatId = chatArtifactsMatch[1];
          if (!getChat(chatId)) return json({ error: "chat not found" }, { status: 404 });
          return json(listArtifacts(chatId));
        }

        const artifactContentMatch = pathname.match(/^\/artifacts\/([^/]+)\/content$/);
        if (artifactContentMatch && req.method === "GET") {
          const content = getArtifactContent(artifactContentMatch[1]);
          if (content === null) return json({ error: "artifact not found" }, { status: 404 });
          return json({ content });
        }

        if (pathname === "/providers" && req.method === "GET") {
          return json(listProviders());
        }

        const providerHealthMatch = pathname.match(/^\/providers\/([^/]+)\/health$/);
        if (providerHealthMatch && req.method === "GET") {
          return json(await checkProviderHealth(providerHealthMatch[1]));
        }

        const providerSecretMatch = pathname.match(/^\/providers\/([^/]+)\/secret$/);
        if (providerSecretMatch && req.method === "POST") {
          const body = await req.json().catch(() => null);
          if (typeof body?.apiKey !== "string" || !body.apiKey) {
            return json({ error: "apiKey is required" }, { status: 400 });
          }
          setSecret(providerSecretMatch[1], body.apiKey);
          return json({ ok: true });
        }

        return notFound();
      } catch (err) {
        return json({ error: String(err) }, { status: 500 });
      }
    },
    websocket: {
      message(ws, message) {
        let command: ClientCommand;
        try {
          command = JSON.parse(String(message));
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "invalid message" }));
          return;
        }

        switch (command.type) {
          case "subscribeChat":
            ws.subscribe(command.chatId);
            ws.data.subscriptions.add(command.chatId);
            broadcast(command.chatId, { type: "status", state: isRunning(command.chatId) ? "streaming" : "idle" });
            break;
          case "unsubscribeChat":
            ws.unsubscribe(command.chatId);
            ws.data.subscriptions.delete(command.chatId);
            break;
          case "sendUserTurn":
            void runTurn(command.chatId, command.text);
            break;
          case "interrupt":
            interrupt(command.chatId);
            break;
          case "setModel":
            updateChat(command.chatId, { model: command.model });
            break;
          case "setMode":
            updateChat(command.chatId, { mode: command.mode });
            break;
          case "approvePermission":
            resolvePermission(command.reqId, command.approve);
            break;
          default:
            ws.send(JSON.stringify({ type: "error", message: "unknown command" }));
        }
      },
      close() {},
    },
  });

  setServer(server);
  return server;
}
