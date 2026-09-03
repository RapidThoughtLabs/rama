// The normalized SessionEvent contract (see docs/IMPLEMENTATION_PLAN.md §3). Every backend —
// the own-loop now, a CLI adapter later — emits this stream; the renderer only ever knows
// about these events. `tool.*`/`artifact.*`/`permission.request` are typed now but unused
// until Phase 3 (tools + artifacts).

export type ArtifactKind = "diff" | "code" | "terminal" | "doc" | "file";

export type SessionStatusState = "idle" | "thinking" | "streaming" | "tool" | "waiting_permission" | "error";

export type SessionEvent =
  | { type: "run.started"; runId: string; ts: number }
  | { type: "message.user"; id: string; text: string; ts: number }
  | { type: "thinking.delta"; runId: string; text: string }
  | { type: "thinking.done"; runId: string; durationMs: number }
  | { type: "message.delta"; runId: string; text: string }
  | { type: "message.done"; runId: string }
  | { type: "tool.call"; callId: string; name: string; input: unknown; ts: number }
  | { type: "tool.result"; callId: string; ok: boolean; summary: string; artifactId?: string }
  | { type: "artifact.created"; artifactId: string; kind: ArtifactKind; name: string; meta: object }
  | { type: "artifact.updated"; artifactId: string; delta?: string; status: "streaming" | "done" }
  | { type: "usage.update"; inputTokens: number; outputTokens: number; contextUsed: number; contextMax: number }
  | { type: "cost.update"; usd: number }
  | { type: "permission.request"; reqId: string; tool: string; input: unknown; risk: "low" | "high" }
  | { type: "status"; state: SessionStatusState; verb?: string }
  | { type: "run.finished"; runId: string; ts: number; summary?: string }
  | { type: "error"; message: string; detail?: string };

// Client → engine commands sent over the chat WS (docs/IMPLEMENTATION_PLAN.md §3).
// `approvePermission` is typed now but unused until Phase 3.
export type ClientCommand =
  | { type: "subscribeChat"; chatId: string }
  | { type: "unsubscribeChat"; chatId: string }
  | { type: "sendUserTurn"; chatId: string; text: string }
  | { type: "interrupt"; chatId: string }
  | { type: "setModel"; chatId: string; model: string }
  | { type: "setMode"; chatId: string; mode: ChatMode }
  | { type: "approvePermission"; reqId: string; approve: boolean };

// Phase 1 — data layer wire types (docs/IMPLEMENTATION_PLAN.md §4, §Phase 1). Shared between
// the engine's DAO/HTTP layer and the desktop frontend's engine client.

export type ChatMode = "agent" | "plan" | "ask";
// docs/REDESIGN_PLAN.md Phase R0 — one whole-palette theme id, not a dark/light × accent pair.
// SETTINGS_PLAN.md Phase S1 — themes are files (bundled + ~/.rama/themes) now, so this can't be a
// compile-time union; a chat row naming a theme whose file was deleted falls back to the default
// at runtime (packages/ui/src/themes.ts's getTheme) rather than failing to compile.
export type ThemeIdDTO = string;

// Phase 8 — a chat's backend: this app's own agent loop, or an external interactive CLI driven
// through an embedded PTY (see docs/IMPLEMENTATION_PLAN.md Phase 8). Every chat has exactly one.
export type BackendConfig =
  | { kind: "own-loop" }
  | { kind: "cli"; command: string; args?: string[]; env?: Record<string, string> };

export interface ProjectDTO {
  id: string;
  name: string;
  path: string;
  repoUrl: string | null;
  defaultBranch: string | null;
  createdAt: number;
}

export interface ChatDTO {
  id: string;
  projectId: string;
  title: string;
  backend: BackendConfig;
  providerId: string;
  model: string | null;
  mode: ChatMode;
  themeId: ThemeIdDTO;
  status: string;
  costUsd: number;
  contextUsed: number;
  contextMax: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateProjectInput {
  name: string;
  path: string;
}

// docs/REDESIGN_PLAN.md Phase R2b — the sidebar's project `⋯` menu (rename / change branch).
export interface UpdateProjectInput {
  name?: string;
  defaultBranch?: string;
}

export interface CreateChatInput {
  title?: string;
  backend?: BackendConfig;
  providerId?: string;
  model?: string;
  mode?: ChatMode;
  themeId?: ThemeIdDTO;
}

export type UpdateChatInput = Partial<CreateChatInput & { status: string }>;

export interface EngineConnectionInfo {
  url: string;
  token: string;
}

// Phase 2 — agent loop wire types.

export type MessageRole = "user" | "assistant" | "system";

export interface MessageDTO {
  id: string;
  chatId: string;
  seq: number;
  role: MessageRole;
  content: string | null;
  thinking: string | null;
  createdAt: number;
}

// Phase 3 — tools + artifacts wire types.

export interface ArtifactDTO {
  id: string;
  chatId: string;
  projectId: string;
  messageId: string | null;
  toolCallId: string | null;
  kind: ArtifactKind;
  name: string;
  meta: Record<string, unknown>;
  size: number;
  status: "streaming" | "done";
  createdAt: number;
  updatedAt: number;
}

export interface ToolCallDTO {
  id: string;
  messageId: string;
  chatId: string;
  name: string;
  input: unknown;
  ok: boolean | null;
  resultSummary: string | null;
  startedAt: number | null;
  endedAt: number | null;
  artifactId: string | null;
}

// Phase 4 — multi-provider & model management wire types.

export type ProviderKind = "openai-compatible" | "anthropic";

export interface ModelInfo {
  id: string;
  label: string;
  supportsTools: boolean;
  supportsThinking: boolean;
  contextWindow: number;
}

export interface ProviderDTO {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string | null;
  requiresKey: boolean;
  models: ModelInfo[];
}

export type ProviderHealthStatus = "ok" | "bad" | "no-key" | "checking";

export interface ProviderHealthDTO {
  providerId: string;
  status: ProviderHealthStatus;
  latencyMs: number | null;
  error: string | null;
  checkedAt: number;
}

// Phase 6 — rama search. A native harness-level search seam (not heku, which is its own
// standalone MCP server scoped to config search — see Phase 7). Meant to eventually span tools,
// skills, memories, chats, docs, and files; only the "tools" domain is registered today.

export interface SearchResultDTO {
  id: string;
  domain: string;
  title: string;
  subtitle?: string;
  score: number;
}

export interface SearchDomainDTO {
  domain: string;
  label: string;
  count: number;
}

// Phase 7 — skills, MCP client, local docs. Three new rama search domains registered as pure
// additions on top of the Phase 6 registry, plus a fourth ("commands") — see engine/src/search/providers.

export interface SkillDTO {
  id: string;
  name: string;
  description: string | null;
  source: string;
  installedAt: number;
}

export type McpTransportDTO =
  | { kind: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { kind: "sse" | "http"; url: string; headers?: Record<string, string> };

export interface McpServerDTO {
  id: string;
  name: string;
  transport: McpTransportDTO;
  enabled: boolean;
}

export type McpHealthStatus = "ok" | "bad" | "disabled";

export interface McpHealthDTO {
  serverId: string;
  status: McpHealthStatus;
  latencyMs: number | null;
  error: string | null;
  checkedAt: number;
}

export interface DocDTO {
  name: string;
  subtitle: string;
  updatedAt: number;
}

export interface DocContentDTO {
  name: string;
  content: string;
}

// docs/REDESIGN_PLAN.md Phase R4 — the unified Settings modal. General/Permissions defaults live
// in the engine's key/value `settings` table (engine/src/db/settings.ts); a project can override
// individual permission rules via its own `settings_json`, merged over the global defaults rather
// than replacing them (see engine/src/db/projects.ts's getProjectPermissions/updateProjectPermissions).
// Rules are persisted and surfaced in the UI but not yet enforced by the agent loop's permission
// gate (engine/src/agent/permissions.ts) — that gate is keyed on chat mode today, and "web" has no
// corresponding tool yet, so wiring real enforcement is follow-up work, not this phase's.
export type PermissionRule = "allow" | "ask" | "deny";
export type PermissionTool = "bash" | "write" | "edit" | "web";
export type PermissionSettings = Partial<Record<PermissionTool, PermissionRule>>;
// A project override patch additionally allows `null` per tool, meaning "clear this override,
// go back to inheriting the global default" — distinct from omitting the key (leave unchanged),
// and (unlike `undefined`) a value JSON.stringify actually preserves over the wire.
export type ProjectPermissionPatch = Partial<Record<PermissionTool, PermissionRule | null>>;

export interface GeneralSettingsDTO {
  defaultProjectDir: string;
  defaultMode: ChatMode;
}

// SETTINGS_PLAN.md Phase S1 — GET /themes. `themes` is raw, unvalidated theme JSON (the engine
// can't import packages/ui/src/themes.ts's parseTheme — that file uses Vite's import.meta.glob,
// a build-time-only construct — so it does light structural validation and hands back whatever
// parsed as an object; the frontend re-validates with the real parser). `errors` covers both a
// file that failed JSON.parse and one that failed that structural check.
export interface ThemeFileErrorDTO {
  file: string;
  message: string;
}

export interface ThemesResponseDTO {
  themes: unknown[];
  errors: ThemeFileErrorDTO[];
}
