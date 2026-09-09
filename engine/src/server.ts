import type { AgentSummaryDTO, ClientCommand, CurationProposalDTO, GeneralSettingsDTO, InstructionsDTO, PermissionSettings } from "@rama/protocol";
import {
  applyProjectProposal,
  getGlobalInstructions,
  getProjectInstructions,
  setGlobalInstructions,
  setProjectInstructions,
} from "./agent/instructions";
import { draftProjectInstructions } from "./agent/instructionsInit";
import { runCurator } from "./agent/curator/curator";
import { getPromptPreview, interrupt, isRunning, runTurn } from "./agent/run/run";
import { resolvePermission } from "./agent/permissions";
import { checkAuth } from "./auth";
import { resolveBrowserResponse } from "./browserBridge";
import { undoLastRun } from "./checkpoints";
import { getArtifactContent, listArtifacts } from "./db/artifacts";
import { getProposal, listProposals, resolveProposal, type ProposalStatus } from "./db/curationProposals";
import { createChat, deleteChat, getChat, listAllChats, listChatsByProject, migrateLegacyCliChats, updateChat } from "./db/chats";
import { deleteDoc, listDocs, readDoc, writeDoc } from "./docs/store";
import { listMessages } from "./db/messages";
import {
  appendScrollback,
  createTerminal,
  deleteTerminal,
  getScrollback,
  getTerminal,
  listTerminalsByProject,
  markTerminalExited,
  renameTerminal,
} from "./db/terminals";
import {
  createProject,
  deleteProject,
  getProject,
  getProjectPermissions,
  listProjects,
  updateProject,
  updateProjectPermissions,
} from "./db/projects";
import type { ModelRole } from "@rama/protocol";
import { getCatalog } from "./agent/catalog";
import { getModelRole, setModelRole } from "./db/modelRoles";
import {
  configureCustomProvider,
  configureProvider,
  deleteProviderRow,
  getProviderDTO,
  listProviders,
  migrateLegacyProviderSeeds,
  updateProviderConfig,
} from "./db/providers";
import {
  addManualModel,
  deleteProviderModel,
  enableDefaultModels,
  refreshModelCatalog,
  setModelEnabled,
  switchSupersededModel,
} from "./db/providerModels";
import { DEFAULT_PERMISSIONS, getSetting, setSetting } from "./db/settings";
import { maybeDefaultChatRole, maybeDefaultUtilityRole } from "./agent/utility";
import { maybeDefaultSubagentRole } from "./agent/subagentRole";
import { discoverAgents } from "./agent/agents/discover";
import type { AgentDef } from "./agent/agents/types";
import { listToolCalls } from "./db/toolCalls";
import { indexServer } from "./heku/indexer";
import { deleteToolsForServer } from "./heku/store";
import { checkMcpServerHealth } from "./mcp/health";
import { parseTransport } from "./mcp/client";
import { connectAndRegister, disconnectServer } from "./mcp/registry";
import { deleteMcpServer, insertMcpServer, listMcpServers, setMcpServerEnabled } from "./mcp/store";
import { checkProviderHealth } from "./providerHealth";
import { enrichFromOpenRouter } from "./openrouterOracle";
import { ensureThemesHome, listUserThemes, resolveThemeAsset, watchThemes } from "./themes/store";
import { ramaSearch, searchDomainStats } from "./search/registry";
import { setSecret } from "./secrets";
import { installSkill, uninstallSkill } from "./skills/installer";
import { listInstalledSkills } from "./skills/store";
import { broadcast, broadcastProject, broadcastThemes, setServer, type SocketData } from "./ws";
import { readChanges, readDiff } from "./git/status";
import { isGitRepo, runGit } from "./tools/gitShared";
import { listDirectory, readFileContent } from "./files/browse";

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

function instructionsDTO(doc: { content: string; lines: number; oversize: boolean } | null): InstructionsDTO {
  return doc ? { ...doc, exists: true } : { content: "", lines: 0, oversize: false, exists: false };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
};

// docs/REDESIGN_PLAN.md Phase R4 — Settings modal defaults, returned whenever a key hasn't been
// saved yet rather than leaving the UI to invent its own fallback shape.
const DEFAULT_GENERAL_SETTINGS: GeneralSettingsDTO = { defaultProjectDir: "", defaultMode: "agent", autoNameChats: true, enrichFromOpenRouter: false };
const MODEL_ROLES: ModelRole[] = ["chat", "utility", "summarize", "subagent"];

function modelRoleDTO(row: ReturnType<typeof getModelRole>) {
  return row ? { role: row.role, providerId: row.provider_id, modelId: row.model_id, updatedAt: row.updated_at } : null;
}

function agentSummaryDTO(agent: AgentDef): AgentSummaryDTO {
  return { name: agent.name, description: agent.description, tools: agent.tools, mode: agent.mode, model: agent.model, source: agent.source };
}
function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...(init.headers ?? {}) },
  });
}

const notFound = () => json({ error: "not found" }, { status: 404 });
const unauthorized = () => json({ error: "unauthorized" }, { status: 401 });

export function createServer() {
  // docs/MISSION_CONTROL_PLAN.md §5.4 — one-time fixup, run once ever: pre-M0 rows with
  // backend_json `{"kind":"cli"}` no longer parse against BackendConfig's shrunk union and would
  // render as a chat with no messages and no way to type.
  migrateLegacyCliChats();
  ensureThemesHome();
  watchThemes(broadcastThemes);
  // docs/PROVIDERS_PLAN.md Phase P0 — rehydrate provider_models from catalog.json on every boot.
  // Lives here, not db/index.ts, so this module (which imports ../agent/catalog, which imports
  // db/index for RAMA_HOME) can't form an import cycle back through db/index.ts.
  refreshModelCatalog();
  // Phase P3 — the destructive seed-row migration, run once ever (see providers.ts's own comment
  // for why only half its rule can be decided here). Before maybeDefaultUtilityRole so that call
  // sees the post-migration provider set, not stale seed rows about to be deleted.
  migrateLegacyProviderSeeds();
  // Phase P2 — idempotent; only ever assigns `utility` the first time it's genuinely unset, e.g.
  // an existing install upgrading into this phase with a provider already configured.
  maybeDefaultUtilityRole();
  // docs/PROMPT_STACK_PLAN.md §6.1, Phase PS5 — same idempotency, for `subagent`.
  maybeDefaultSubagentRole();
  // Phase P5 — same idempotency, for `chat`. Covers an install that configured a provider via
  // fast-add or the wizard but never visited General settings to name a default explicitly.
  maybeDefaultChatRole();

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

        // WORKSPACE_PANES_PLAN.md §5.2 / §6.1 — GET /projects/:id/changes
        const projectChangesMatch = pathname.match(/^\/projects\/([^/]+)\/changes$/);
        if (projectChangesMatch && req.method === "GET") {
          const project = getProject(projectChangesMatch[1]!);
          if (!project) return json({ error: "project not found" }, { status: 404 });
          try {
            const changes = await readChanges(project.path);
            return json(changes);
          } catch (err) {
            return json({ error: String(err) }, { status: 500 });
          }
        }

        // WORKSPACE_PANES_PLAN.md §5.2 / §6.1 — POST /projects/:id/changes/init: `git init` for a
        // project directory that isn't a repo yet, surfaced as a button in the Changes pane's
        // empty state rather than requiring the user to drop to a terminal.
        const projectChangesInitMatch = pathname.match(/^\/projects\/([^/]+)\/changes\/init$/);
        if (projectChangesInitMatch && req.method === "POST") {
          const project = getProject(projectChangesInitMatch[1]!);
          if (!project) return json({ error: "project not found" }, { status: 404 });
          try {
            const alreadyRepo = await isGitRepo(project.path);
            if (!alreadyRepo) {
              const { output, exitCode } = await runGit(project.path, ["init"]);
              if (exitCode !== 0) return json({ error: output.trim() || "git init failed" }, { status: 500 });
            }
            const changes = await readChanges(project.path);
            broadcastProject(project.id, { type: "changes.invalidated", projectId: project.id });
            return json(changes);
          } catch (err) {
            return json({ error: String(err) }, { status: 500 });
          }
        }

        // WORKSPACE_PANES_PLAN.md §5.2 / §6.3 — GET /projects/:id/changes/diff?path=&staged=0|1
        const projectChangesDiffMatch = pathname.match(/^\/projects\/([^/]+)\/changes\/diff$/);
        if (projectChangesDiffMatch && req.method === "GET") {
          const project = getProject(projectChangesDiffMatch[1]!);
          if (!project) return json({ error: "project not found" }, { status: 404 });
          const relPath = url.searchParams.get("path");
          if (!relPath) return json({ error: "missing path query param" }, { status: 400 });
          const staged = url.searchParams.get("staged") === "1";
          try {
            const diff = await readDiff(project.path, relPath, staged);
            return json(diff);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("escapes the project directory")) {
              return json({ error: msg }, { status: 400 });
            }
            return json({ error: msg }, { status: 500 });
          }
        }

        // WORKSPACE_PANES_PLAN.md §5.2 / §6.5 — GET /projects/:id/files?path=<rel>
        const projectFilesMatch = pathname.match(/^\/projects\/([^/]+)\/files$/);
        if (projectFilesMatch && req.method === "GET") {
          const project = getProject(projectFilesMatch[1]!);
          if (!project) return json({ error: "project not found" }, { status: 404 });
          const relPath = url.searchParams.get("path") ?? "";
          try {
            const files = await listDirectory(project.path, relPath);
            return json(files);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("escapes the project directory")) {
              return json({ error: msg }, { status: 400 });
            }
            return json({ error: msg }, { status: 500 });
          }
        }

        // WORKSPACE_PANES_PLAN.md §5.2 / §6.5 — GET /projects/:id/files/content?path=<rel>
        const projectFilesContentMatch = pathname.match(/^\/projects\/([^/]+)\/files\/content$/);
        if (projectFilesContentMatch && req.method === "GET") {
          const project = getProject(projectFilesContentMatch[1]!);
          if (!project) return json({ error: "project not found" }, { status: 404 });
          const relPath = url.searchParams.get("path");
          if (!relPath) return json({ error: "missing path query param" }, { status: 400 });
          try {
            const content = await readFileContent(project.path, relPath);
            return json(content);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("escapes the project directory") || msg.includes("ENOENT") || msg.includes("no such file")) {
              return json({ error: msg }, { status: 400 });
            }
            return json({ error: msg }, { status: 500 });
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

        // docs/TOOL_LAYER_PLAN.md §5.2 — restores the project's files to the state before the
        // most recently started run, via the shadow checkpoint git repo. One level of undo.
        const chatUndoMatch = pathname.match(/^\/chats\/([^/]+)\/undo$/);
        if (chatUndoMatch && req.method === "POST") {
          const chatId = chatUndoMatch[1];
          const chat = getChat(chatId);
          if (!chat) return json({ error: "chat not found" }, { status: 404 });
          const project = getProject(chat.projectId);
          if (!project) return json({ error: "project not found" }, { status: 404 });
          const res = await undoLastRun(project.path);
          broadcastProject(project.id, { type: "changes.invalidated", projectId: project.id });
          return json(res);
        }

        // docs/MISSION_CONTROL_PLAN.md §8 Phase M2 — the terminal runtime's HTTP surface. PTY
        // spawn/write/resize/kill themselves are Tauri commands (Section 6, apps/desktop/src-
        // tauri/src/pty.rs) — this side only owns the `terminals` row: identity, scrollback
        // persistence, and the project-scoped `terminal.*` broadcast.
        // docs/PROMPT_STACK_PLAN.md Phase PS1 — the assembled prefix exactly as the model would
        // receive it (per-layer content, cache breakpoints marked, approx token counts), for
        // inspecting cache layout without waiting on a live provider round-trip.
        const chatPromptPreviewMatch = pathname.match(/^\/chats\/([^/]+)\/prompt-preview$/);
        if (chatPromptPreviewMatch && req.method === "GET") {
          const preview = await getPromptPreview(chatPromptPreviewMatch[1]);
          if (!preview) return json({ error: "chat not found" }, { status: 404 });
          return json(preview);
        }

        // docs/PROMPT_STACK_PLAN.md §5.3, Phase PS4 — the picker's list. `projectId` is optional
        // (bundled + global agents are always visible; a project's own .rama/agents only shows up
        // once a real project path is known).
        if (pathname === "/agents" && req.method === "GET") {
          const projectId = url.searchParams.get("projectId") ?? undefined;
          const project = projectId ? getProject(projectId) : null;
          const agents = discoverAgents({ projectId, projectPath: project?.path });
          return json(agents.map(agentSummaryDTO));
        }

        const projectTerminalsMatch = pathname.match(/^\/projects\/([^/]+)\/terminals$/);
        if (projectTerminalsMatch && req.method === "GET") {
          const projectId = projectTerminalsMatch[1];
          if (!getProject(projectId)) return json({ error: "project not found" }, { status: 404 });
          return json(listTerminalsByProject(projectId));
        }

        if (pathname === "/terminals" && req.method === "POST") {
          const body = await req.json().catch(() => null);
          if (typeof body?.projectId !== "string" || !body.projectId) {
            return json({ error: "projectId is required" }, { status: 400 });
          }
          const project = getProject(body.projectId);
          if (!project) return json({ error: "project not found" }, { status: 404 });

          const shell = typeof body.shell === "string" && body.shell ? body.shell : (Bun.env.SHELL ?? "/bin/zsh");
          const argv = Array.isArray(body.argv) ? body.argv.filter((a: unknown) => typeof a === "string") : [];
          const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : (argv[0] ?? shell.split("/").pop() ?? "shell");
          const owner = body.owner === "agent" ? "agent" : "user";
          const terminal = createTerminal({
            projectId: project.id,
            title,
            cwd: typeof body.cwd === "string" && body.cwd ? body.cwd : project.path,
            shell,
            argv,
            owner,
            originChatId: owner === "agent" && typeof body.originChatId === "string" ? body.originChatId : null,
          });
          broadcastProject(project.id, { type: "terminal.created", terminal });
          return json(terminal, { status: 201 });
        }

        const terminalMatch = pathname.match(/^\/terminals\/([^/]+)$/);
        if (terminalMatch && req.method === "PATCH") {
          const body = await req.json().catch(() => ({}));
          if (typeof body?.title !== "string" || !body.title.trim()) {
            return json({ error: "title is required" }, { status: 400 });
          }
          const terminal = renameTerminal(terminalMatch[1], body.title.trim());
          if (!terminal) return json({ error: "terminal not found" }, { status: 404 });
          broadcastProject(terminal.projectId, { type: "terminal.renamed", terminalId: terminal.id, title: terminal.title });
          return json(terminal);
        }
        if (terminalMatch && req.method === "DELETE") {
          const terminal = getTerminal(terminalMatch[1]);
          if (!terminal) return json({ error: "terminal not found" }, { status: 404 });
          deleteTerminal(terminal.id);
          return json({ ok: true });
        }

        const terminalDataMatch = pathname.match(/^\/terminals\/([^/]+)\/data$/);
        if (terminalDataMatch && req.method === "POST") {
          const body = await req.json().catch(() => ({}));
          if (typeof body?.delta !== "string") return json({ error: "delta is required" }, { status: 400 });
          if (!getTerminal(terminalDataMatch[1])) return json({ error: "terminal not found" }, { status: 404 });
          appendScrollback(terminalDataMatch[1], body.delta);
          return json({ ok: true });
        }

        const terminalExitMatch = pathname.match(/^\/terminals\/([^/]+)\/exit$/);
        if (terminalExitMatch && req.method === "POST") {
          const body = await req.json().catch(() => ({}));
          const exitCode = typeof body?.exitCode === "number" ? body.exitCode : 1;
          const terminal = markTerminalExited(terminalExitMatch[1], exitCode);
          if (!terminal) return json({ error: "terminal not found" }, { status: 404 });
          broadcastProject(terminal.projectId, { type: "terminal.exited", terminalId: terminal.id, exitCode });
          return json(terminal);
        }

        const terminalScrollbackMatch = pathname.match(/^\/terminals\/([^/]+)\/scrollback$/);
        if (terminalScrollbackMatch && req.method === "GET") {
          const content = getScrollback(terminalScrollbackMatch[1]);
          if (content === null) return json({ error: "terminal not found" }, { status: 404 });
          return json({ content });
        }

        // docs/MISSION_CONTROL_PLAN.md §8 Phase M6 — the `browser` tool's response leg
        // (engine/src/browserBridge.ts). Always 200s: whether this resolves the tool's pending
        // promise or is a late/duplicate from a second window, the poster doesn't need to know.
        const browserResponseMatch = pathname.match(/^\/browser\/([^/]+)\/response$/);
        if (browserResponseMatch && req.method === "POST") {
          const body = await req.json().catch(() => ({}));
          resolveBrowserResponse(browserResponseMatch[1], body);
          return json({ ok: true });
        }

        if (pathname === "/providers" && req.method === "GET") {
          return json(listProviders());
        }

        // docs/PROVIDERS_PLAN.md Phase P4 fast-add — "catalog tiles" for what's addable. A row in
        // `providers` means configured (Phase P3), so the catalog itself is the only source left
        // for "what does Rama know how to add".
        if (pathname === "/catalog/providers" && req.method === "GET") {
          return json(
            getCatalog().providers.map((p) => ({
              id: p.id,
              label: p.label,
              kind: p.kind,
              baseUrl: p.baseUrl,
              requiresKey: p.requiresKey,
              docsUrl: p.docsUrl,
            })),
          );
        }

        // docs/PROVIDERS_PLAN.md Phase P6 — "one settings toggle, because it is an outbound
        // request." The toggle is checked here, not inside enrichFromOpenRouter itself, so that
        // function stays a pure "given permission, run safely" — this is the one place permission
        // is actually granted or withheld. Cheap to call on every app launch: the weekly cache
        // check inside enrichFromOpenRouter makes a no-op call fast and network-free.
        if (pathname === "/catalog/enrich" && req.method === "POST") {
          const general = { ...DEFAULT_GENERAL_SETTINGS, ...(getSetting<GeneralSettingsDTO>("general") ?? {}) };
          if (!general.enrichFromOpenRouter) return json({ ran: false, matched: 0 });
          const result = await enrichFromOpenRouter().catch((err) => {
            console.error(`[catalog/enrich] ${err instanceof Error ? err.message : String(err)}`);
            return { ran: false, matched: 0 };
          });
          return json(result);
        }

        // Creates the `providers` row from the catalog (Phase P3's configureProvider) — the first
        // step of fast-add for a keyless provider, or ahead of a key POST for one that needs it.
        if (pathname === "/providers" && req.method === "POST") {
          const body = await req.json().catch(() => null);
          if (typeof body?.providerId !== "string" || !body.providerId) {
            return json({ error: "providerId is required" }, { status: 400 });
          }
          const result = configureProvider(body.providerId);
          if (!result) return json({ error: `unknown provider "${body.providerId}"` }, { status: 400 });
          // Fast-add's "defaultEnabled models silently ticked" — only on first configure, so
          // re-POSTing an already-configured provider can't resurrect models the user turned off.
          if (result.created) enableDefaultModels(body.providerId);
          maybeDefaultChatRole();
          maybeDefaultUtilityRole();
          maybeDefaultSubagentRole();
          return json(getProviderDTO(body.providerId), { status: result.created ? 201 : 200 });
        }

        // docs/PROVIDERS_PLAN.md Phase P5 — "custom (OpenAI-compatible)": the wizard's own creation
        // path for a provider Rama has never heard of, parallel to the catalog-backed POST /providers
        // above. Always succeeds (configureCustomProvider disambiguates the generated id itself),
        // so the only failures here are validation.
        if (pathname === "/providers/custom" && req.method === "POST") {
          const body = await req.json().catch(() => null);
          if (typeof body?.label !== "string" || !body.label.trim()) {
            return json({ error: "label is required" }, { status: 400 });
          }
          if (typeof body?.baseUrl !== "string" || !/^https?:\/\//.test(body.baseUrl.trim())) {
            return json({ error: "a base URL starting with http:// or https:// is required" }, { status: 400 });
          }
          const authStyle = body?.authStyle === "header" ? "header" : "bearer";
          const authHeader = typeof body?.authHeader === "string" && body.authHeader.trim() ? body.authHeader.trim() : null;
          if (authStyle === "header" && !authHeader) {
            return json({ error: "authHeader is required when authStyle is \"header\"" }, { status: 400 });
          }
          const row = configureCustomProvider({
            label: body.label.trim(),
            baseUrl: body.baseUrl.trim(),
            requiresKey: body?.requiresKey !== false,
            authStyle,
            authHeader,
          });
          maybeDefaultChatRole();
          maybeDefaultUtilityRole();
          maybeDefaultSubagentRole();
          return json(getProviderDTO(row.id), { status: 201 });
        }

        const providerMatch = pathname.match(/^\/providers\/([^/]+)$/);
        if (providerMatch && req.method === "PATCH") {
          const providerId = providerMatch[1];
          const body = await req.json().catch(() => ({}));
          const updated = updateProviderConfig(providerId, { baseUrl: body?.baseUrl, label: body?.label });
          if (!updated) return json({ error: "provider not found" }, { status: 404 });
          return json(updated);
        }
        // docs/PROVIDERS_PLAN.md Phase P3 — "chats pointing at a removed provider are not
        // migrated and not deleted"; deleteProviderRow only touches provider_models/model_roles.
        if (providerMatch && req.method === "DELETE") {
          const deleted = deleteProviderRow(providerMatch[1]);
          if (!deleted) return json({ error: "provider not found" }, { status: 404 });
          return json({ ok: true });
        }

        // docs/PROVIDERS_PLAN.md Phase P4 — "+ add model manually", for fine-tunes and private
        // deployments neither the catalog nor a fetch has ever seen.
        const providerModelsMatch = pathname.match(/^\/providers\/([^/]+)\/models$/);
        if (providerModelsMatch && req.method === "POST") {
          const providerId = providerModelsMatch[1];
          if (!getProviderDTO(providerId)) return json({ error: "provider not found" }, { status: 404 });
          const body = await req.json().catch(() => null);
          if (typeof body?.modelId !== "string" || !body.modelId.trim()) {
            return json({ error: "modelId is required" }, { status: 400 });
          }
          addManualModel(providerId, body.modelId.trim(), typeof body?.label === "string" ? body.label : undefined, Date.now());
          return json(getProviderDTO(providerId), { status: 201 });
        }

        // Tick state (composer picker, role pickers) and "no longer offered — remove?" for a
        // model that's `missing`; distinct from PATCH, which only ever flips `enabled`.
        const providerModelMatch = pathname.match(/^\/providers\/([^/]+)\/models\/([^/]+)$/);
        if (providerModelMatch && req.method === "PATCH") {
          const [, providerId, modelId] = providerModelMatch;
          const body = await req.json().catch(() => ({}));
          if (typeof body?.enabled !== "boolean") return json({ error: "enabled is required" }, { status: 400 });
          setModelEnabled(providerId, decodeURIComponent(modelId), body.enabled);
          return json(getProviderDTO(providerId));
        }
        if (providerModelMatch && req.method === "DELETE") {
          const [, providerId, modelId] = providerModelMatch;
          const deleted = deleteProviderModel(providerId, decodeURIComponent(modelId));
          if (!deleted) return json({ error: "model not found" }, { status: 404 });
          return json({ ok: true });
        }

        // "where `superseded_by` is set, `→ {newer model} available` with a one-click switch."
        const providerModelSwitchMatch = pathname.match(/^\/providers\/([^/]+)\/models\/([^/]+)\/switch$/);
        if (providerModelSwitchMatch && req.method === "POST") {
          const [, providerId, modelId] = providerModelSwitchMatch;
          const body = await req.json().catch(() => null);
          if (typeof body?.toModelId !== "string" || !body.toModelId) {
            return json({ error: "toModelId is required" }, { status: 400 });
          }
          switchSupersededModel(providerId, decodeURIComponent(modelId), body.toModelId);
          return json(getProviderDTO(providerId));
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

        if (pathname === "/settings/instructions" && req.method === "GET") {
          return json(instructionsDTO(getGlobalInstructions()));
        }
        if (pathname === "/settings/instructions" && req.method === "PUT") {
          const body = await req.json().catch(() => null);
          if (typeof body?.content !== "string") return json({ error: "content is required" }, { status: 400 });
          return json(instructionsDTO(setGlobalInstructions(body.content)));
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
          // docs/TOOL_LAYER_PLAN.md §7.4 (TL7) — index right after the validating connect above so
          // the new server's tools are in heku_find/the "mcp" search domain immediately, not only
          // after the next engine restart's indexAll(). Best-effort: an index failure here doesn't
          // undo the just-created server, it just leaves indexing to the next call/restart.
          await indexServer(row).catch(() => {});
          return json(mcpServerDTO(row), { status: 201 });
        }

        const mcpServerMatch = pathname.match(/^\/mcp\/servers\/([^/]+)$/);
        if (mcpServerMatch && req.method === "DELETE") {
          await disconnectServer(mcpServerMatch[1]);
          deleteToolsForServer(mcpServerMatch[1]);
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
            await indexServer(row).catch(() => {});
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

        const projectInstructionsInitMatch = pathname.match(/^\/projects\/([^/]+)\/instructions\/init$/);
        if (projectInstructionsInitMatch && req.method === "POST") {
          const project = getProject(projectInstructionsInitMatch[1]);
          if (!project) return json({ error: "project not found" }, { status: 404 });
          const result = await draftProjectInstructions(project.path);
          if (!result.ok) return json({ error: result.error }, { status: 502 });
          return json({ content: result.content });
        }

        const projectInstructionsMatch = pathname.match(/^\/projects\/([^/]+)\/instructions$/);
        if (projectInstructionsMatch) {
          const project = getProject(projectInstructionsMatch[1]);
          if (!project) return json({ error: "project not found" }, { status: 404 });

          if (req.method === "GET") {
            return json(instructionsDTO(getProjectInstructions(project.path)));
          }
          if (req.method === "PUT") {
            const body = await req.json().catch(() => null);
            if (typeof body?.content !== "string") return json({ error: "content is required" }, { status: 400 });
            return json(instructionsDTO(setProjectInstructions(project.path, body.content)));
          }
        }

        // docs/PROMPT_STACK_PLAN.md §7.2, Phase PS7 — the curator's accept/reject surface. Listing
        // and resolving never touch the filesystem; only accept does, via applyProjectProposal,
        // and only after the row itself is marked accepted (decision 6 — nothing is written until
        // a human says so).
        const projectCurationRunMatch = pathname.match(/^\/projects\/([^/]+)\/curation\/run$/);
        if (projectCurationRunMatch && req.method === "POST") {
          const project = getProject(projectCurationRunMatch[1]);
          if (!project) return json({ error: "project not found" }, { status: 404 });
          await runCurator(null, project.id, project.path);
          return json({ ok: true });
        }

        const projectCurationMatch = pathname.match(/^\/projects\/([^/]+)\/curation\/proposals$/);
        if (projectCurationMatch && req.method === "GET") {
          const project = getProject(projectCurationMatch[1]);
          if (!project) return json({ error: "project not found" }, { status: 404 });
          const status = url.searchParams.get("status") as ProposalStatus | null;
          return json(listProposals(project.id, status ?? undefined) satisfies CurationProposalDTO[]);
        }

        const proposalResolveMatch = pathname.match(/^\/projects\/([^/]+)\/curation\/proposals\/([^/]+)\/(accept|reject)$/);
        if (proposalResolveMatch && req.method === "POST") {
          const [, projectId, proposalId, action] = proposalResolveMatch;
          const project = getProject(projectId);
          if (!project) return json({ error: "project not found" }, { status: 404 });
          const existing = getProposal(proposalId);
          if (!existing || existing.projectId !== projectId) return json({ error: "proposal not found" }, { status: 404 });
          if (existing.status !== "pending") return json({ error: `proposal already ${existing.status}` }, { status: 409 });

          if (action === "accept") {
            applyProjectProposal(project.path, { kind: existing.kind, section: existing.section, content: existing.content });
          }
          const resolved = resolveProposal(proposalId, action === "accept" ? "accepted" : "rejected");
          return json(resolved satisfies CurationProposalDTO | null);
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
          const providerId = providerSecretMatch[1];
          const body = await req.json().catch(() => null);
          if (typeof body?.apiKey !== "string" || !body.apiKey) {
            return json({ error: "apiKey is required" }, { status: 400 });
          }
          // docs/PROVIDERS_PLAN.md Phase P3 — pasting a key IS the configure action for a catalog
          // provider with no row yet (fast-add's one field); a no-op if the row already exists.
          const configured = configureProvider(providerId);
          if (!configured) return json({ error: `unknown provider "${providerId}"` }, { status: 400 });
          setSecret(providerId, body.apiKey);
          if (configured.created) enableDefaultModels(providerId);
          // Phase P2 — "on configuring a provider, if utility is unset, assign..."; a no-op once
          // a role already exists, so this is safe to call on every key save.
          maybeDefaultUtilityRole();
          maybeDefaultSubagentRole();
          maybeDefaultChatRole();
          return json({ ok: true });
        }

        if (pathname === "/model-roles" && req.method === "GET") {
          return json(Object.fromEntries(MODEL_ROLES.map((role) => [role, modelRoleDTO(getModelRole(role))])));
        }

        const modelRoleMatch = pathname.match(/^\/model-roles\/([^/]+)$/);
        if (modelRoleMatch && req.method === "PUT") {
          const role = modelRoleMatch[1] as ModelRole;
          if (!MODEL_ROLES.includes(role)) return json({ error: "unknown role" }, { status: 400 });
          const body = await req.json().catch(() => null);
          if (typeof body?.providerId !== "string" || typeof body?.modelId !== "string") {
            return json({ error: "providerId and modelId are required" }, { status: 400 });
          }
          return json(modelRoleDTO(setModelRole(role, body.providerId, body.modelId)));
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
          case "setAgent":
            updateChat(command.chatId, { agentId: command.agentId });
            break;
          case "approvePermission":
            resolvePermission(command.reqId, command.approve);
            break;
          // docs/MISSION_CONTROL_PLAN.md §5.3 — the project-scoped counterpart to
          // subscribeChat/unsubscribeChat above, for `terminal.*` events.
          case "subscribeProject":
            ws.subscribe(`project:${command.projectId}`);
            ws.data.subscriptions.add(`project:${command.projectId}`);
            break;
          case "unsubscribeProject":
            ws.unsubscribe(`project:${command.projectId}`);
            ws.data.subscriptions.delete(`project:${command.projectId}`);
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
