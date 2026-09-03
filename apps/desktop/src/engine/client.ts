import { invoke } from "@tauri-apps/api/core";
import type {
  ArtifactDTO,
  ChatDTO,
  CreateChatInput,
  CreateProjectInput,
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
  ProviderHealthDTO,
  SearchDomainDTO,
  SearchResultDTO,
  SkillDTO,
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

export function fetchProviders(): Promise<ProviderDTO[]> {
  return engineJson("/providers");
}

export function fetchProviderHealth(providerId: string): Promise<ProviderHealthDTO> {
  return engineJson(`/providers/${providerId}/health`);
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

// Phase 8 — engine-side mirror of a chat's PTY output (persistence/history only; the actual
// process is owned by Rust, see apps/desktop/src-tauri/src/pty.rs and TerminalView.tsx).
export function startPty(chatId: string): Promise<{ artifactId: string }> {
  return engineJson(`/chats/${chatId}/pty/start`, { method: "POST" });
}

export function sendPtyData(chatId: string, artifactId: string, delta: string): Promise<{ ok: true }> {
  return engineJson(`/chats/${chatId}/pty/data`, { method: "POST", body: JSON.stringify({ artifactId, delta }) });
}

export function exitPty(chatId: string, artifactId: string, exitCode: number): Promise<{ ok: true }> {
  return engineJson(`/chats/${chatId}/pty/exit`, { method: "POST", body: JSON.stringify({ artifactId, exitCode }) });
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
