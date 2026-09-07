import { invoke } from "@tauri-apps/api/core";
import type {
  ArtifactDTO,
  CatalogProviderSummaryDTO,
  ChatDTO,
  CreateChatInput,
  CreateProjectInput,
  CustomProviderInput,
  DocContentDTO,
  DocDTO,
  EngineConnectionInfo,
  GeneralSettingsDTO,
  MessageDTO,
  PermissionSettings,
  ProjectDTO,
  ProjectPermissionPatch,
  ProviderDTO,
  McpHealthDTO,
  McpServerDTO,
  McpTransportDTO,
  ModelRole,
  ModelRoleDTO,
  ProviderHealthDTO,
  SearchDomainDTO,
  SearchResultDTO,
  SkillDTO,
  CreateTerminalInput,
  TerminalDTO,
  ThemesResponseDTO,
  ToolCallDTO,
  UpdateChatInput,
  UpdateProjectInput,
} from "@rama/protocol";

let connectionPromise: Promise<EngineConnectionInfo> | null = null;

export function getEngineConnection(): Promise<EngineConnectionInfo> {
  if (!connectionPromise) {
    connectionPromise = invoke<EngineConnectionInfo>("get_engine_connection");
  }
  return connectionPromise;
}

async function engineFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { url, token } = await getEngineConnection();
  return fetch(`${url}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

async function engineJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await engineFetch(path, init);
  if (!res.ok) {
    throw new Error(`engine request failed: ${init?.method ?? "GET"} ${path} -> ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function fetchProjects(): Promise<ProjectDTO[]> {
  return engineJson("/projects");
}

export function createProject(input: CreateProjectInput): Promise<ProjectDTO> {
  return engineJson("/projects", { method: "POST", body: JSON.stringify(input) });
}

export function updateProject(projectId: string, patch: UpdateProjectInput): Promise<ProjectDTO> {
  return engineJson(`/projects/${projectId}`, { method: "PATCH", body: JSON.stringify(patch) });
}

// Not routed through engineJson: a blocked delete (409, project still has chats) carries a
// message worth surfacing to the user rather than engineJson's generic "request failed" text.
export async function deleteProject(projectId: string): Promise<{ ok: true }> {
  const res = await engineFetch(`/projects/${projectId}`, { method: "DELETE" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `failed to delete project (${res.status})`);
  return body;
}

export function fetchChats(projectId?: string): Promise<ChatDTO[]> {
  return engineJson(projectId ? `/projects/${projectId}/chats` : "/chats");
}

export function createChat(projectId: string, input: CreateChatInput): Promise<ChatDTO> {
  return engineJson(`/projects/${projectId}/chats`, { method: "POST", body: JSON.stringify(input) });
}

export function patchChat(chatId: string, patch: UpdateChatInput): Promise<ChatDTO> {
  return engineJson(`/chats/${chatId}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteChat(chatId: string): Promise<{ ok: true }> {
  return engineJson(`/chats/${chatId}`, { method: "DELETE" });
}

// docs/TOOL_LAYER_PLAN.md §5.2 — restores the project's files to the state before the last run.
export function undoLastRun(chatId: string): Promise<{ ok: boolean; message: string }> {
  return engineJson(`/chats/${chatId}/undo`, { method: "POST" });
}

export function fetchMessages(chatId: string): Promise<MessageDTO[]> {
  return engineJson(`/chats/${chatId}/messages`);
}

export function pushProviderSecret(providerId: string, apiKey: string): Promise<{ ok: true }> {
  return engineJson(`/providers/${providerId}/secret`, { method: "POST", body: JSON.stringify({ apiKey }) });
}

export function fetchToolCalls(chatId: string): Promise<ToolCallDTO[]> {
  return engineJson(`/chats/${chatId}/tool-calls`);
}

export function fetchArtifacts(chatId: string): Promise<ArtifactDTO[]> {
  return engineJson(`/chats/${chatId}/artifacts`);
}

export function fetchArtifactContent(artifactId: string): Promise<{ content: string }> {
  return engineJson(`/artifacts/${artifactId}/content`);
}

// docs/MISSION_CONTROL_PLAN.md §8 Phase M2 — the terminal runtime's HTTP surface. The actual PTY
// (spawn/write/resize/kill/list) is a set of Tauri commands, not engine routes — see
// mission-control/useTerminalSession.ts, which calls both this file and `@tauri-apps/api/core`
// directly.
export function fetchProjectTerminals(projectId: string): Promise<TerminalDTO[]> {
  return engineJson(`/projects/${projectId}/terminals`);
}

export function createTerminal(input: CreateTerminalInput): Promise<TerminalDTO> {
  return engineJson("/terminals", { method: "POST", body: JSON.stringify(input) });
}

export function renameTerminal(terminalId: string, title: string): Promise<TerminalDTO> {
  return engineJson(`/terminals/${terminalId}`, { method: "PATCH", body: JSON.stringify({ title }) });
}

export function deleteTerminal(terminalId: string): Promise<{ ok: true }> {
  return engineJson(`/terminals/${terminalId}`, { method: "DELETE" });
}

export function postTerminalData(terminalId: string, delta: string): Promise<{ ok: true }> {
  return engineJson(`/terminals/${terminalId}/data`, { method: "POST", body: JSON.stringify({ delta }) });
}

export function exitTerminal(terminalId: string, exitCode: number): Promise<TerminalDTO> {
  return engineJson(`/terminals/${terminalId}/exit`, { method: "POST", body: JSON.stringify({ exitCode }) });
}

export function fetchTerminalScrollback(terminalId: string): Promise<{ content: string }> {
  return engineJson(`/terminals/${terminalId}/scrollback`);
}

// docs/MISSION_CONTROL_PLAN.md §6 — the Rust-owned PTY itself, keyed by `terminal_id`.
export function ptySpawn(input: {
  terminalId: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}): Promise<void> {
  return invoke<void>("pty_spawn", {
    terminalId: input.terminalId,
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    env: input.env,
    cols: input.cols,
    rows: input.rows,
  });
}

export function ptyWrite(terminalId: string, data: string): Promise<void> {
  return invoke<void>("pty_write", { terminalId, data });
}

export function ptyResize(terminalId: string, cols: number, rows: number): Promise<void> {
  return invoke<void>("pty_resize", { terminalId, cols, rows });
}

export function ptyKill(terminalId: string): Promise<void> {
  return invoke<void>("pty_kill", { terminalId });
}

export function ptyIsRunning(terminalId: string): Promise<boolean> {
  return invoke<boolean>("pty_is_running", { terminalId });
}

export function ptyListRunning(): Promise<string[]> {
  return invoke<string[]>("pty_list_running");
}

// docs/MISSION_CONTROL_PLAN.md §8 Phase M5 — the Web pane's child webviews, keyed by `page_id`
// (no DB row; see webview.rs's module doc for why). Every call is a Tauri command, not an engine
// route — the engine can't see or touch these at all except through the M6 browser-bridge request/
// response relay (mission-control/AgentWebBridge.tsx).
export function webviewCreate(windowLabel: string, pageId: string, url: string): Promise<void> {
  return invoke<void>("webview_create", { windowLabel, pageId, url });
}

export function webviewNavigate(pageId: string, url: string): Promise<void> {
  return invoke<void>("webview_navigate", { pageId, url });
}

export function webviewSetBounds(pageId: string, x: number, y: number, width: number, height: number): Promise<void> {
  return invoke<void>("webview_set_bounds", { pageId, x, y, width, height });
}

export function webviewSetVisible(pageId: string, visible: boolean): Promise<void> {
  return invoke<void>("webview_set_visible", { pageId, visible });
}

export function webviewDestroy(pageId: string): Promise<void> {
  return invoke<void>("webview_destroy", { pageId });
}

// `expr` is a JS expression's *body* (evaluated as `(function(){ ${expr} })()`) — always one of a
// small set of hardcoded strings this app supplies (see WebPaneContext.tsx), never agent- or
// page-controlled text.
export function webviewEval(pageId: string, expr: string): Promise<string> {
  return invoke<string>("webview_eval", { pageId, expr });
}

// docs/MISSION_CONTROL_PLAN.md §8 Phase M6 — the `browser` tool's response leg
// (engine/src/browserBridge.ts). Always resolves even for a duplicate/late response from a
// second window — see that file's own comment on why.
export function postBrowserResponse(
  requestId: string,
  body: { ok: boolean; pageId?: string; title?: string; url?: string; text?: string; consoleLogs?: string[]; error?: string },
): Promise<{ ok: true }> {
  return engineJson(`/browser/${requestId}/response`, { method: "POST", body: JSON.stringify(body) });
}

export function fetchProviders(): Promise<ProviderDTO[]> {
  return engineJson("/providers");
}

export function fetchProviderHealth(providerId: string): Promise<ProviderHealthDTO> {
  return engineJson(`/providers/${providerId}/health`);
}

// docs/PROVIDERS_PLAN.md Phase P4 fast-add — catalog tiles for providers Rama knows about that
// have no `providers` row yet (Phase P3: a row means configured).
export function fetchCatalogProviders(): Promise<CatalogProviderSummaryDTO[]> {
  return engineJson("/catalog/providers");
}

// Creates the `providers` row from the catalog. Idempotent — safe to call even if the provider
// is already configured (returns it unchanged, 200 instead of 201).
export function createProvider(providerId: string): Promise<ProviderDTO> {
  return engineJson("/providers", { method: "POST", body: JSON.stringify({ providerId }) });
}

export function updateProviderConfig(providerId: string, patch: { baseUrl?: string; label?: string }): Promise<ProviderDTO> {
  return engineJson(`/providers/${providerId}`, { method: "PATCH", body: JSON.stringify(patch) });
}

// docs/PROVIDERS_PLAN.md Phase P5 — the wizard's "custom (OpenAI-compatible)" path; parallel to
// createProvider above but for a provider id Rama's catalog has never heard of.
export function createCustomProvider(input: CustomProviderInput): Promise<ProviderDTO> {
  return engineJson("/providers/custom", { method: "POST", body: JSON.stringify(input) });
}

// docs/PROVIDERS_PLAN.md Phase P3 — engine-side half only (provider_models + model_roles
// cascade); the OS keychain entry is a separate deletion, see deleteProviderKey below.
export function removeProvider(providerId: string): Promise<{ ok: true }> {
  return engineJson(`/providers/${providerId}`, { method: "DELETE" });
}

export function setProviderModelEnabled(providerId: string, modelId: string, enabled: boolean): Promise<ProviderDTO> {
  return engineJson(`/providers/${providerId}/models/${encodeURIComponent(modelId)}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export function addProviderModel(providerId: string, modelId: string, label?: string): Promise<ProviderDTO> {
  return engineJson(`/providers/${providerId}/models`, { method: "POST", body: JSON.stringify({ modelId, label }) });
}

export function removeProviderModel(providerId: string, modelId: string): Promise<{ ok: true }> {
  return engineJson(`/providers/${providerId}/models/${encodeURIComponent(modelId)}`, { method: "DELETE" });
}

export function switchProviderModel(providerId: string, fromModelId: string, toModelId: string): Promise<ProviderDTO> {
  return engineJson(`/providers/${providerId}/models/${encodeURIComponent(fromModelId)}/switch`, {
    method: "POST",
    body: JSON.stringify({ toModelId }),
  });
}

// docs/PROVIDERS_PLAN.md Phase P2 — one row per role ('chat' | 'utility' | 'summarize'), null
// until a human (or maybeDefaultUtilityRole's one-time default) sets it.
export function fetchModelRoles(): Promise<Record<ModelRole, ModelRoleDTO | null>> {
  return engineJson("/model-roles");
}

export function saveModelRole(role: ModelRole, providerId: string, modelId: string): Promise<ModelRoleDTO> {
  return engineJson(`/model-roles/${role}`, { method: "PUT", body: JSON.stringify({ providerId, modelId }) });
}

export function ramaSearch(query: string, projectId?: string): Promise<SearchResultDTO[]> {
  const params = new URLSearchParams({ q: query });
  if (projectId) params.set("projectId", projectId);
  return engineJson(`/search?${params.toString()}`);
}

export function fetchSearchDomains(projectId?: string): Promise<SearchDomainDTO[]> {
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  const qs = params.toString();
  return engineJson(`/search/domains${qs ? `?${qs}` : ""}`);
}

export function fetchSkills(): Promise<SkillDTO[]> {
  return engineJson("/skills");
}

export function installSkill(source: string): Promise<SkillDTO> {
  return engineJson("/skills/install", { method: "POST", body: JSON.stringify({ source }) });
}

export function uninstallSkill(name: string): Promise<{ ok: true }> {
  return engineJson(`/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export function fetchMcpServers(): Promise<McpServerDTO[]> {
  return engineJson("/mcp/servers");
}

export function addMcpServer(name: string, transport: McpTransportDTO): Promise<McpServerDTO> {
  return engineJson("/mcp/servers", { method: "POST", body: JSON.stringify({ name, transport }) });
}

export function removeMcpServer(id: string): Promise<{ ok: true }> {
  return engineJson(`/mcp/servers/${id}`, { method: "DELETE" });
}

export function setMcpServerEnabled(id: string, enabled: boolean): Promise<McpServerDTO> {
  return engineJson(`/mcp/servers/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
}

export function pushMcpServerSecret(id: string, token: string): Promise<{ ok: true }> {
  return engineJson(`/mcp/servers/${id}/secret`, { method: "POST", body: JSON.stringify({ token }) });
}

export function fetchMcpServerHealth(id: string): Promise<McpHealthDTO> {
  return engineJson(`/mcp/servers/${id}/health`);
}

export function fetchDocs(projectId: string): Promise<DocDTO[]> {
  return engineJson(`/projects/${projectId}/docs`);
}

export function fetchDocContent(projectId: string, name: string): Promise<DocContentDTO> {
  return engineJson(`/projects/${projectId}/docs/${encodeURIComponent(name)}`);
}

export function createDoc(projectId: string, name: string, content: string): Promise<DocContentDTO> {
  return engineJson(`/projects/${projectId}/docs`, { method: "POST", body: JSON.stringify({ name, content }) });
}

export function saveDoc(projectId: string, name: string, content: string): Promise<DocContentDTO> {
  return engineJson(`/projects/${projectId}/docs/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
}

export function deleteDoc(projectId: string, name: string): Promise<{ ok: true }> {
  return engineJson(`/projects/${projectId}/docs/${encodeURIComponent(name)}`, { method: "DELETE" });
}

// SETTINGS_PLAN.md Phase S1 — themes from ~/.rama/themes. `getEngineConnection` (already exported
// above) is what ThemesProvider uses to build the `?token=` asset URL a <div
// style={{backgroundImage}}> needs — a CSS url() request can't carry the Authorization header
// engineFetch normally injects.
export function fetchThemes(): Promise<ThemesResponseDTO> {
  return engineJson("/themes");
}

// docs/REDESIGN_PLAN.md Phase R4 — the unified Settings modal.
export function fetchGeneralSettings(): Promise<GeneralSettingsDTO> {
  return engineJson("/settings/general");
}

export function saveGeneralSettings(patch: Partial<GeneralSettingsDTO>): Promise<GeneralSettingsDTO> {
  return engineJson("/settings/general", { method: "PUT", body: JSON.stringify(patch) });
}

// docs/PROVIDERS_PLAN.md Phase P6 — best-effort, gated server-side by the settings toggle and a
// weekly cache; safe to call on every launch (see ProvidersProvider.tsx's one-shot effect).
export function triggerCatalogEnrichment(): Promise<{ ran: boolean; matched: number }> {
  return engineJson("/catalog/enrich", { method: "POST" });
}

export function fetchGlobalPermissions(): Promise<PermissionSettings> {
  return engineJson("/settings/permissions");
}

export function saveGlobalPermissions(patch: PermissionSettings): Promise<PermissionSettings> {
  return engineJson("/settings/permissions", { method: "PUT", body: JSON.stringify(patch) });
}

export function fetchProjectPermissions(projectId: string): Promise<PermissionSettings> {
  return engineJson(`/projects/${projectId}/settings/permissions`);
}

export function saveProjectPermissions(projectId: string, patch: ProjectPermissionPatch): Promise<PermissionSettings> {
  return engineJson(`/projects/${projectId}/settings/permissions`, { method: "PUT", body: JSON.stringify(patch) });
}

// OS keychain access lives in the Rust core, not the engine — see apps/desktop/src-tauri/src/secrets.rs.
export function getProviderKey(providerId: string): Promise<string | null> {
  return invoke<string | null>("get_provider_key", { provider: providerId });
}

export function setProviderKey(providerId: string, key: string): Promise<void> {
  return invoke<void>("set_provider_key", { provider: providerId, key });
}

export function deleteProviderKey(providerId: string): Promise<void> {
  return invoke<void>("delete_provider_key", { provider: providerId });
}
