import { invoke } from "@tauri-apps/api/core";
import type {
  ArtifactDTO,
  ChatDTO,
  CreateChatInput,
  CreateProjectInput,
  EngineConnectionInfo,
  MessageDTO,
  ProjectDTO,
  ProviderDTO,
  ProviderHealthDTO,
  ToolCallDTO,
  UpdateChatInput,
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

export function fetchChats(projectId?: string): Promise<ChatDTO[]> {
  return engineJson(projectId ? `/projects/${projectId}/chats` : "/chats");
}

export function createChat(projectId: string, input: CreateChatInput): Promise<ChatDTO> {
  return engineJson(`/projects/${projectId}/chats`, { method: "POST", body: JSON.stringify(input) });
}

export function patchChat(chatId: string, patch: UpdateChatInput): Promise<ChatDTO> {
  return engineJson(`/chats/${chatId}`, { method: "PATCH", body: JSON.stringify(patch) });
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

// OS keychain access lives in the Rust core, not the engine — see apps/desktop/src-tauri/src/secrets.rs.
export function getProviderKey(providerId: string): Promise<string | null> {
  return invoke<string | null>("get_provider_key", { provider: providerId });
}

export function setProviderKey(providerId: string, key: string): Promise<void> {
  return invoke<void>("set_provider_key", { provider: providerId, key });
}
