import type { ClientCommand, GeneralSettingsDTO, PermissionSettings } from "@rama/protocol";
import { interrupt, isRunning, runTurn } from "./agent/loop";
import { resolvePermission } from "./agent/permissions";
import { checkAuth } from "./auth";
import { appendArtifactBody, createArtifact, finalizeArtifact, getArtifactContent, listArtifacts } from "./db/artifacts";
import { createChat, deleteChat, getChat, listAllChats, listChatsByProject, updateChat } from "./db/chats";
import { deleteDoc, listDocs, readDoc, writeDoc } from "./docs/store";
import { listMessages } from "./db/messages";
import {
  createProject,
  deleteProject,
  getProject,
  getProjectPermissions,
  listProjects,
  updateProject,
  updateProjectPermissions,
} from "./db/projects";
import { listProviders } from "./db/providers";
import { getSetting, setSetting } from "./db/settings";
import { listToolCalls } from "./db/toolCalls";
import { checkMcpServerHealth } from "./mcp/health";
import { parseTransport } from "./mcp/client";
import { connectAndRegister, disconnectServer } from "./mcp/registry";
import { deleteMcpServer, insertMcpServer, listMcpServers, setMcpServerEnabled } from "./mcp/store";
import { checkProviderHealth } from "./providerHealth";
import { ensureThemesHome, listUserThemes, resolveThemeAsset, watchThemes } from "./themes/store";
import { ramaSearch, searchDomainStats } from "./search/registry";
import { setSecret } from "./secrets";
import { installSkill, uninstallSkill } from "./skills/installer";
import { listInstalledSkills } from "./skills/store";
import { broadcast, broadcastThemes, setServer, type SocketData } from "./ws";

function skillDTO(row: ReturnType<typeof listInstalledSkills>[number]) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    source: row.source,
    installedAt: row.installed_at,
  };
}

function mcpServerDTO(row: ReturnType<typeof listMcpServers>[number]) {
  return { id: row.id, name: row.name, transport: parseTransport(row), enabled: !!row.enabled };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
};

// docs/REDESIGN_PLAN.md Phase R4 — Settings modal defaults, returned whenever a key hasn't been
// saved yet rather than leaving the UI to invent its own fallback shape.
const DEFAULT_GENERAL_SETTINGS: GeneralSettingsDTO = { defaultProjectDir: "", defaultMode: "agent" };
const DEFAULT_PERMISSIONS: PermissionSettings = { bash: "ask", write: "ask", edit: "allow", web: "allow" };

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...(init.headers ?? {}) },
  });
}

const notFound = () => json({ error: "not found" }, { status: 404 });
const unauthorized = () => json({ error: "unauthorized" }, { status: 401 });

export function createServer() {
  ensureThemesHome();
  watchThemes(broadcastThemes);

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

        const projectMatch = pathname.match(/^\/projects\/([^/]+)$/);
        if (projectMatch) {
          const projectId = projectMatch[1];
          if (req.method === "PATCH") {
            const body = await req.json().catch(() => ({}));
            const updated = updateProject(projectId, body ?? {});
            if (!updated) return json({ error: "project not found" }, { status: 404 });
            return json(updated);
          }
          if (req.method === "DELETE") {
            const result = deleteProject(projectId);
            if (result === "not-found") return json({ error: "project not found" }, { status: 404 });
            if (result === "has-chats") {
              return json({ error: "project still has chats — move or delete them first" }, { status: 409 });
            }
            return json({ ok: true });
          }
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
        if (chatMatch && req.method === "DELETE") {
          const chatId = chatMatch[1];
          interrupt(chatId); // best-effort — don't let an in-flight turn keep writing to a chat mid-delete
          if (!deleteChat(chatId)) return json({ error: "chat not found" }, { status: 404 });
          return json({ ok: true });
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

        // Phase 8 — cli-backed chats: Rust owns the actual PTY process, the engine only mirrors
        // its output into a "terminal" artifact for persistence/history, the same broadcast
        // shape bash.ts already streams (see engine/src/tools/bash.ts).
        const chatPtyStartMatch = pathname.match(/^\/chats\/([^/]+)\/pty\/start$/);
        if (chatPtyStartMatch && req.method === "POST") {
          const chatId = chatPtyStartMatch[1];
          const chat = getChat(chatId);
          if (!chat) return json({ error: "chat not found" }, { status: 404 });

          const name = chat.backend.kind === "cli" ? chat.backend.command : chat.title;
          const artifact = createArtifact({
            chatId,
            projectId: chat.projectId,
            kind: "terminal",
            name,
            status: "streaming",
            body: "",
          });
          broadcast(chatId, { type: "artifact.created", artifactId: artifact.id, kind: "terminal", name, meta: {} });
          updateChat(chatId, { status: "streaming" });
          return json({ artifactId: artifact.id }, { status: 201 });
        }

        const chatPtyDataMatch = pathname.match(/^\/chats\/([^/]+)\/pty\/data$/);
        if (chatPtyDataMatch && req.method === "POST") {
          const chatId = chatPtyDataMatch[1];
          if (!getChat(chatId)) return json({ error: "chat not found" }, { status: 404 });

          const body = await req.json().catch(() => ({}));
          const { artifactId, delta } = (body ?? {}) as { artifactId?: unknown; delta?: unknown };
          if (typeof artifactId !== "string" || typeof delta !== "string") {
            return json({ error: "artifactId and delta are required" }, { status: 400 });
          }
          appendArtifactBody(artifactId, delta);
          broadcast(chatId, { type: "artifact.updated", artifactId, delta, status: "streaming" });
          return json({ ok: true });
        }

        const chatPtyExitMatch = pathname.match(/^\/chats\/([^/]+)\/pty\/exit$/);
        if (chatPtyExitMatch && req.method === "POST") {
          const chatId = chatPtyExitMatch[1];
          if (!getChat(chatId)) return json({ error: "chat not found" }, { status: 404 });

          const body = await req.json().catch(() => ({}));
          const { artifactId, exitCode } = (body ?? {}) as { artifactId?: unknown; exitCode?: unknown };
          if (typeof artifactId !== "string") return json({ error: "artifactId is required" }, { status: 400 });
          finalizeArtifact(artifactId, typeof exitCode === "number" ? { exitCode } : undefined);
          broadcast(chatId, { type: "artifact.updated", artifactId, status: "done" });
          updateChat(chatId, { status: "idle" });
          return json({ ok: true });
        }

        if (pathname === "/providers" && req.method === "GET") {
          return json(listProviders());
        }

        if (pathname === "/settings/general" && req.method === "GET") {
          return json({ ...DEFAULT_GENERAL_SETTINGS, ...(getSetting<GeneralSettingsDTO>("general") ?? {}) });
        }
        if (pathname === "/settings/general" && req.method === "PUT") {
          const body = await req.json().catch(() => ({}));
          const next = { ...DEFAULT_GENERAL_SETTINGS, ...(getSetting<GeneralSettingsDTO>("general") ?? {}), ...body };
          setSetting("general", next);
          return json(next);
        }

        if (pathname === "/settings/permissions" && req.method === "GET") {
          return json({ ...DEFAULT_PERMISSIONS, ...(getSetting<PermissionSettings>("permissions") ?? {}) });
        }
        if (pathname === "/settings/permissions" && req.method === "PUT") {
          const body = await req.json().catch(() => ({}));
          const next = { ...DEFAULT_PERMISSIONS, ...(getSetting<PermissionSettings>("permissions") ?? {}), ...body };
          setSetting("permissions", next);
          return json(next);
        }

        if (pathname === "/search" && req.method === "GET") {
          const q = url.searchParams.get("q") ?? "";
          const projectId = url.searchParams.get("projectId") ?? undefined;
          return json(await ramaSearch(q, { projectId }));
        }

        if (pathname === "/search/domains" && req.method === "GET") {
          const projectId = url.searchParams.get("projectId") ?? undefined;
          return json(await searchDomainStats({ projectId }));
        }

        if (pathname === "/skills" && req.method === "GET") {
          return json(listInstalledSkills().map(skillDTO));
        }

        if (pathname === "/skills/install" && req.method === "POST") {
          const body = await req.json().catch(() => null);
          if (typeof body?.source !== "string" || !body.source.trim()) {
            return json({ error: "source is required" }, { status: 400 });
          }
          try {
            const row = await installSkill(body.source.trim());
            return json(skillDTO(row), { status: 201 });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
          }
        }

        const skillNameMatch = pathname.match(/^\/skills\/([^/]+)$/);
        if (skillNameMatch && req.method === "DELETE") {
          const deleted = uninstallSkill(decodeURIComponent(skillNameMatch[1]));
          if (!deleted) return json({ error: "skill not found" }, { status: 404 });
          return json({ ok: true });
        }

        if (pathname === "/mcp/servers" && req.method === "GET") {
          return json(listMcpServers().map(mcpServerDTO));
        }

        if (pathname === "/mcp/servers" && req.method === "POST") {
          const body = await req.json().catch(() => null);
          if (typeof body?.name !== "string" || !body.name.trim() || !body?.transport) {
            return json({ error: "name and transport are required" }, { status: 400 });
          }
          const row = insertMcpServer({ name: body.name.trim(), transport: body.transport });
          try {
            await connectAndRegister(row);
          } catch (err) {
            deleteMcpServer(row.id);
            return json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
          }
          return json(mcpServerDTO(row), { status: 201 });
        }

        const mcpServerMatch = pathname.match(/^\/mcp\/servers\/([^/]+)$/);
        if (mcpServerMatch && req.method === "DELETE") {
          await disconnectServer(mcpServerMatch[1]);
          const deleted = deleteMcpServer(mcpServerMatch[1]);
          if (!deleted) return json({ error: "server not found" }, { status: 404 });
          return json({ ok: true });
        }
        if (mcpServerMatch && req.method === "PATCH") {
          const body = await req.json().catch(() => ({}));
          const row = setMcpServerEnabled(mcpServerMatch[1], !!body?.enabled);
          if (!row) return json({ error: "server not found" }, { status: 404 });
          if (body?.enabled) {
            await connectAndRegister(row).catch(() => {});
          } else {
            await disconnectServer(row.id);
          }
          return json(mcpServerDTO(row));
        }

        const mcpServerSecretMatch = pathname.match(/^\/mcp\/servers\/([^/]+)\/secret$/);
        if (mcpServerSecretMatch && req.method === "POST") {
          const body = await req.json().catch(() => null);
          if (typeof body?.token !== "string" || !body.token) {
            return json({ error: "token is required" }, { status: 400 });
          }
          setSecret(`mcp:${mcpServerSecretMatch[1]}`, body.token);
          return json({ ok: true });
        }

        const mcpServerHealthMatch = pathname.match(/^\/mcp\/servers\/([^/]+)\/health$/);
        if (mcpServerHealthMatch && req.method === "GET") {
          return json(await checkMcpServerHealth(mcpServerHealthMatch[1]));
        }

        const projectDocsMatch = pathname.match(/^\/projects\/([^/]+)\/docs$/);
        if (projectDocsMatch) {
          const projectId = projectDocsMatch[1];
          if (!getProject(projectId)) return json({ error: "project not found" }, { status: 404 });

          if (req.method === "GET") {
            return json(listDocs(projectId));
          }
          if (req.method === "POST") {
            const body = await req.json().catch(() => null);
            if (typeof body?.name !== "string" || !body.name.trim() || typeof body?.content !== "string") {
              return json({ error: "name and content are required" }, { status: 400 });
            }
            writeDoc(projectId, body.name.trim(), body.content);
            return json({ name: body.name.trim(), content: body.content }, { status: 201 });
          }
        }

        const projectDocMatch = pathname.match(/^\/projects\/([^/]+)\/docs\/([^/]+)$/);
        if (projectDocMatch) {
          const [, projectId, rawName] = projectDocMatch;
          if (!getProject(projectId)) return json({ error: "project not found" }, { status: 404 });
          const name = decodeURIComponent(rawName);

          if (req.method === "PUT") {
            const body = await req.json().catch(() => null);
            if (typeof body?.content !== "string") return json({ error: "content is required" }, { status: 400 });
            writeDoc(projectId, name, body.content);
            return json({ name, content: body.content });
          }
          if (req.method === "GET") {
            const content = readDoc(projectId, name);
            if (content === null) return json({ error: "doc not found" }, { status: 404 });
            return json({ name, content });
          }
          if (req.method === "DELETE") {
            const deleted = deleteDoc(projectId, name);
            if (!deleted) return json({ error: "doc not found" }, { status: 404 });
            return json({ ok: true });
          }
        }

        const projectPermissionsMatch = pathname.match(/^\/projects\/([^/]+)\/settings\/permissions$/);
        if (projectPermissionsMatch) {
          const projectId = projectPermissionsMatch[1];
          if (!getProject(projectId)) return json({ error: "project not found" }, { status: 404 });

          if (req.method === "GET") {
            return json(getProjectPermissions(projectId) ?? {});
          }
          if (req.method === "PUT") {
            const body = await req.json().catch(() => ({}));
            return json(updateProjectPermissions(projectId, body ?? {}) ?? {});
          }
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

        if (pathname === "/themes" && req.method === "GET") {
          const { themes, errors } = listUserThemes();
          return json({ themes, errors });
        }

        const themeAssetMatch = pathname.match(/^\/themes\/asset\/(.+)$/);
        if (themeAssetMatch && req.method === "GET") {
          const path = resolveThemeAsset(decodeURIComponent(themeAssetMatch[1]));
          if (!path) return notFound();
          return new Response(Bun.file(path));
        }

        return notFound();
      } catch (err) {
        return json({ error: String(err) }, { status: 500 });
      }
    },
    websocket: {
      // Every connection joins the fixed "themes" topic regardless of which chats it
      // subscribes to — see ws.ts's broadcastThemes for why this one isn't per-chat.
      open(ws) {
        ws.subscribe("themes");
      },
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
