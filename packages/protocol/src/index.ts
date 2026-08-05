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
export type ThemeModeDTO = "dark" | "light";

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
  providerId: string;
  model: string | null;
  mode: ChatMode;
  wallpaper: string;
  accent: string;
  theme: ThemeModeDTO;
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

export interface CreateChatInput {
  title?: string;
  providerId?: string;
  model?: string;
  mode?: ChatMode;
  wallpaper?: string;
  accent?: string;
  theme?: ThemeModeDTO;
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
