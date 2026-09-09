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
  // cacheReadTokens/cacheWriteTokens/noCacheTokens: docs/PROMPT_STACK_PLAN.md Phase PS1 — the
  // usage.inputTokenDetails split, optional so any other future emitter of this event doesn't
  // have to invent numbers it doesn't have.
  | {
      type: "usage.update";
      inputTokens: number;
      outputTokens: number;
      contextUsed: number;
      contextMax: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      noCacheTokens?: number;
    }
  | { type: "cost.update"; usd: number }
  | { type: "permission.request"; reqId: string; tool: string; input: unknown; risk: "low" | "high" }
  | { type: "status"; state: SessionStatusState; verb?: string }
  | { type: "run.finished"; runId: string; ts: number; summary?: string }
  | { type: "error"; message: string; detail?: string }
  // docs/PROVIDERS_PLAN.md Phase P2 — auto-titling's only way to tell the sidebar a chat got a
  // real name; there was no chat-update event before this.
  | { type: "chat.renamed"; chatId: string; title: string }
  // docs/TOOL_LAYER_PLAN.md §6.14 (TL6) — fired on every `todo` call so a live Todos view (or the
  // sidebar) can reflect the list without polling; the model itself sees the list via the tool's
  // own `content`, not this event.
  | { type: "todo.updated"; chatId: string; items: TodoItem[] }
  // docs/MISSION_CONTROL_PLAN.md §5.2 — broadcast on the project topic (`project:{id}`), not a
  // chat topic: terminals are project-scoped, not chat-scoped. PTY *output* deliberately does
  // NOT ride this stream — it arrives over Tauri's own event bus straight from Rust (§6); routing
  // tens of kilobytes a second of terminal bytes through the engine and back would add a hop for
  // nothing.
  | { type: "terminal.created"; terminal: TerminalDTO }
  | { type: "terminal.exited"; terminalId: string; exitCode: number }
  | { type: "terminal.renamed"; terminalId: string; title: string }
  // docs/MISSION_CONTROL_PLAN.md §7.3 — the `process kill` tool's counterpart to §7.1's
  // `terminal.created`: the engine (headless Bun) can't call the Tauri `pty_kill` command itself,
  // so it broadcasts the request and a frontend bridge (AgentTerminalBridge.tsx) does the actual
  // kill, then marks the row exited the same way a user-initiated kill does.
  | { type: "terminal.kill_requested"; terminalId: string }
  // docs/MISSION_CONTROL_PLAN.md §8 Phase M6 — the `browser` tool's own version of the same
  // engine-can't-call-Tauri bridge: broadcast on the project topic, picked up by
  // AgentWebBridge.tsx, which performs the actual webview create/eval and POSTs the result back
  // to `POST /browser/:requestId/response` (engine/src/browserBridge.ts resolves the tool's
  // pending promise from there — there is no `browser.response` SessionEvent, since that leg
  // doesn't need to reach every window, only the engine).
  | { type: "browser.request"; request: BrowserRequest };

export type BrowserOp = "open" | "read" | "snapshot" | "console";

export interface BrowserRequest {
  requestId: string;
  op: BrowserOp;
  /** `open` only. */
  url?: string;
  /** `read` / `snapshot` / `console` — omit for "whichever page is active in this window". */
  pageId?: string;
  /** `open` only — tags a newly created page's `originChatId`, the same as `TerminalDTO`'s. */
  chatId?: string;
}

// Client → engine commands sent over the chat WS (docs/IMPLEMENTATION_PLAN.md §3).
// `approvePermission` is typed now but unused until Phase 3.
export type ClientCommand =
  | { type: "subscribeChat"; chatId: string }
  | { type: "unsubscribeChat"; chatId: string }
  | { type: "sendUserTurn"; chatId: string; text: string }
  | { type: "interrupt"; chatId: string }
  | { type: "setModel"; chatId: string; model: string }
  | { type: "setMode"; chatId: string; mode: ChatMode }
  | { type: "setAgent"; chatId: string; agentId: string }
  | { type: "approvePermission"; reqId: string; approve: boolean }
  // docs/MISSION_CONTROL_PLAN.md §5.3 — the project-scoped counterpart to subscribeChat/
  // unsubscribeChat, for the `terminal.*` events above.
  | { type: "subscribeProject"; projectId: string }
  | { type: "unsubscribeProject"; projectId: string };

// Phase 1 — data layer wire types (docs/IMPLEMENTATION_PLAN.md §4, §Phase 1). Shared between
// the engine's DAO/HTTP layer and the desktop frontend's engine client.

export type ChatMode = "agent" | "plan" | "ask";
// docs/REDESIGN_PLAN.md Phase R0 — one whole-palette theme id, not a dark/light × accent pair.
// SETTINGS_PLAN.md Phase S1 — themes are files (bundled + ~/.rama/themes) now, so this can't be a
// compile-time union; a chat row naming a theme whose file was deleted falls back to the default
// at runtime (packages/ui/src/themes.ts's getTheme) rather than failing to compile.
export type ThemeIdDTO = string;

// A chat's backend. Kept as a union of one (rather than a bare object type) so a future backend
// adapter is an addition, not a protocol rewrite — see docs/MISSION_CONTROL_PLAN.md §5.4, which
// deleted the `{ kind: "cli" }` variant that used to live here (driving an external CLI from a
// chat tab): that's now just a program run in Mission Control's Terminal pane, not a backend.
export type BackendConfig = { kind: "own-loop" };

export interface ProjectDTO {
  id: string;
  name: string;
  path: string;
  repoUrl: string | null;
  defaultBranch: string | null;
  createdAt: number;
}

// docs/PROMPT_STACK_PLAN.md §7.1, Phase PS3 — GET/PUT /projects/:id/instructions and
// GET/PUT /settings/instructions (global) both return this shape. `exists: false` (empty content,
// lines: 0) means no RAMA.md is on disk yet, distinct from an existing-but-empty file.
export interface InstructionsDTO {
  content: string;
  lines: number;
  oversize: boolean;
  exists: boolean;
}

export interface ChatDTO {
  id: string;
  projectId: string;
  title: string;
  backend: BackendConfig;
  providerId: string;
  model: string | null;
  mode: ChatMode;
  agentId: string;
  themeId: ThemeIdDTO;
  status: string;
  costUsd: number;
  utilityCostUsd: number;
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
  agentId?: string;
  themeId?: ThemeIdDTO;
}

export type UpdateChatInput = Partial<CreateChatInput & { status: string }>;

// docs/PROMPT_STACK_PLAN.md §5.3, Phase PS4 — GET /agents. No body/tools-vs-mode-intersection
// here (that's server-side, per-turn, per §5.2) — just enough for a picker: what it's called,
// what it's for, and which tier of the three-tier discovery it came from, so a project-local
// agent overriding a bundled one of the same name is visible as "this one wins".
export interface AgentSummaryDTO {
  name: string;
  description: string;
  /** null = unrestricted (harness ∩ mode only) — see engine/src/agent/agents/effectiveTools.ts. */
  tools: string[] | null;
  mode: ChatMode | null;
  model: ModelRole;
  source: "bundled" | "global" | "project";
}

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

// docs/MISSION_CONTROL_PLAN.md §5.2 — terminal runtime wire types (Phase M2). A terminal is
// project-scoped (§0.2), not chat-scoped — `originChatId` records who *started* an agent-owned
// one, it does not make the terminal belong to that chat.
export type TerminalOwner = "user" | "agent";
export type TerminalStatus = "running" | "exited";

// docs/TOOL_LAYER_PLAN.md §6.14 (TL6) — the `todo` tool's list, one per chat. `set` always
// produces fresh "pending" items (no status field on input); only `update` moves an item to
// "active"/"done", and exactly one item may be "active" at a time (enforced in db/todos.ts, not
// the prompt). Shared with the desktop app for the future Mission Control "Todos" pane
// (apps/desktop/src/app/mission-control/panes.ts's own note anticipates this).
export type TodoStatus = "pending" | "active" | "done";
export interface TodoItem {
  text: string;
  status: TodoStatus;
}

export interface TerminalDTO {
  id: string;
  projectId: string;
  title: string;
  cwd: string;
  shell: string;
  argv: string[];
  owner: TerminalOwner;
  originChatId: string | null;
  status: TerminalStatus;
  exitCode: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateTerminalInput {
  projectId: string;
  cwd?: string; // defaults to project.path
  shell?: string; // defaults to $SHELL
  argv?: string[];
  title?: string;
  owner?: TerminalOwner;
  originChatId?: string;
}

// Phase 4 — multi-provider & model management wire types.

export type ProviderKind = "openai-compatible" | "anthropic";

// docs/PROVIDERS_PLAN.md Phase P0 — derived at read time from engine/src/db/providerModels.ts,
// never stored: "available" means the model was in the provider's most recent successful
// /models fetch; "unverified" means it's catalog-known but no fetch has confirmed it yet (no key,
// no working /models, or the provider account can't reach a tier-gated model); "missing" means a
// prior fetch listed it but the latest one didn't; "erroring" means Phase P1's per-model error
// tracking recorded a durable failure (auth/not-found), which for now can never actually occur
// since nothing writes last_error_kind until that phase.
export type ModelStatus = "available" | "unverified" | "missing" | "erroring";
export type ModelTier = "frontier" | "workhorse" | "small";

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  source: "catalog" | "user" | "openrouter";
}

export interface ModelInfo {
  id: string;
  label: string;
  supportsTools: boolean;
  supportsThinking: boolean;
  supportsVision: boolean;
  contextWindow: number;
  status: ModelStatus;
  tier: ModelTier | null;
  pricing: ModelPricing | null;
  deprecated: boolean;
  supersededBy: string | null;
  // docs/PROVIDERS_PLAN.md Phase P4 — the providers pane's tick state ("enabled" is the only field
  // the composer picker and the role pickers actually filter on), "new since you last looked"
  // (derived client-side from firstSeenAt against a per-provider bookmark), the catalog-known-only
  // default view (inCatalog), manually-added rows, and the erroring chip's recorded error text.
  enabled: boolean;
  pinned: boolean;
  inCatalog: boolean;
  addedManually: boolean;
  firstSeenAt: number;
  lastError: string | null;
}

export type ProviderHealthStatus = "ok" | "bad" | "no-key" | "checking";

export interface ProviderDTO {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string | null;
  requiresKey: boolean;
  models: ModelInfo[];
  // docs/PROVIDERS_PLAN.md Phase P1 — the health probe's last persisted result, so a fresh
  // ProvidersProvider mount can seed `health` from "was fine yesterday" instead of `checking`.
  lastHealthStatus: ProviderHealthStatus | null;
  lastHealthAt: number | null;
  // docs/PROVIDERS_PLAN.md Phase P3 — a row now means "the user configured this"; `isCustom` is
  // always false until Phase P5's wizard can create a catalog-less provider, but the field ships
  // now so that phase is a UI-only change, not another protocol edit (see the plan's Risk #6).
  isCustom: boolean;
  enabled: boolean;
}

export interface ProviderHealthDTO {
  providerId: string;
  status: ProviderHealthStatus;
  latencyMs: number | null;
  error: string | null;
  checkedAt: number;
}

// docs/PROVIDERS_PLAN.md Phase P4 fast-add — "catalog tiles" for providers Rama knows about but
// the user hasn't configured yet (no `providers` row exists for them post-P3, so GET /providers
// can't answer "what's addable"). Deliberately thin: just enough to render a tile and drive the
// one-field fast-add flow, not the full CatalogProvider shape engine-internal code uses.
export interface CatalogProviderSummaryDTO {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string | null;
  requiresKey: boolean;
  docsUrl: string | null;
}

// docs/PROVIDERS_PLAN.md Phase P5 — "custom (OpenAI-compatible)": the wizard's credentials step
// for a provider Rama has never heard of. Always openai-compatible (see db/providers.ts's
// configureCustomProvider for why Anthropic-shaped custom providers aren't a real case).
export interface CustomProviderInput {
  label: string;
  baseUrl: string;
  requiresKey: boolean;
  authStyle: "bearer" | "header";
  authHeader?: string | null;
}

// Phase 6 — rama search. A native harness-level search seam. heku (docs/TOOL_LAYER_PLAN.md §7,
// TL7) is one of its providers, not a separate thing — the in-process external-tool broker
// registers as the "mcp" domain here, so the palette and the model share one index. Meant to
// eventually span tools, skills, memories, chats, docs, and files; only "tools", "skills", "mcp",
// "docs", and "commands" are registered today.

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

// docs/PROMPT_STACK_PLAN.md §7.2, Phase PS7 — one curator-generated candidate change to RAMA.md.
// `kind: "remove"` is the verification hook (§7.2's second hard rule): an entry whose referent
// (a script, a path) no longer checks out is proposed for deletion here, not silently served to
// the model. Never applied until accept/{proposalId} — decision 6.
export interface CurationProposalDTO {
  id: string;
  projectId: string;
  kind: "add" | "remove";
  section: string;
  content: string;
  signal: string;
  evidence: { why: string; toolCallIds?: string[]; messageIds?: string[] };
  status: "pending" | "accepted" | "rejected";
  createdAt: number;
  resolvedAt: number | null;
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
  // docs/PROVIDERS_PLAN.md Phase P2 — gates auto-titling entirely: off means no chat content
  // leaves the machine for this purpose at all, not just "don't show the result".
  autoNameChats: boolean;
  // docs/PROVIDERS_PLAN.md Phase P6 — gates the OpenRouter enrichment GET entirely: off means the
  // engine never makes that outbound request, not just "don't show the result". Off by default.
  enrichFromOpenRouter: boolean;
}

// docs/PROVIDERS_PLAN.md Phase P2 — a role names *why* a call happens ('chat', 'utility'), not a
// "cheap model" setting. 'summarize' is reserved for compaction; no UI row until that exists.
// docs/PROMPT_STACK_PLAN.md §6.1, Phase PS5 — 'subagent' backs explore/review/test's nested
// streamText calls, defaulted from the catalog the same way 'utility' is (small/workhorse tier).
export type ModelRole = "chat" | "utility" | "summarize" | "subagent";

export interface ModelRoleDTO {
  role: ModelRole;
  providerId: string;
  modelId: string;
  updatedAt: number;
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
