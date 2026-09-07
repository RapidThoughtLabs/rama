# Rama — Phased Implementation Plan

> **Rama** — RapidThought Labs' open-source agentic coding harness (MIT · `rtl-labs/rama`).
> *"The terminal that grew a UI."* A Tauri desktop app that is a **browser / tmux for coding agents**:
> one beautiful shell, many pluggable agent backends, all feeding one bespoke renderer.

This document is the build spec. Implementing through **Phase 3** yields a graphically-rich,
working boilerplate harness — its own agent loop, tools, artifacts, persistence, and full theming —
against a real provider. Everything after Phase 3 is expansion.

Design source of truth: `docs/Rama/` (`Rama.dc.html` prototype, `design-system.html`,
`design-language.html`, wallpapers).

---

## 0. Locked decisions

| Area | Decision |
|---|---|
| Shell / runtime | **Tauri** (Rust core) — cross-platform, small, fast, native chrome |
| Frontend | **React + Vite + TypeScript** in the webview |
| Agent engine | **Bun sidecar daemon** — owns sessions; uses **Vercel AI SDK** |
| First provider | **Together AI** via **OpenAI-compatible adapter** (also serves OpenAI + any OpenAI-spec / local endpoint) |
| Storage | **Single SQLite** (`~/.rama/rama.db`), linked tables; large artifact bodies **content-addressed on disk** (`~/.rama/blobs/`) |
| Primary product | **Our own agent loop** (bespoke UI) for custom / on-device providers |
| Secondary (later) | Driving external agent CLIs (Claude Code, Copilot) via embedded themed PTY — run as a program inside Mission Control's Terminal pane (`docs/MISSION_CONTROL_PLAN.md`), not a chat backend |

---

## 1. Product model (what we're building)

- A **project** is a repo/working directory on disk.
- A **terminal chat** (a "chat"/"session") lives under a project and is bound to:
  a **backend** (own-loop provider now; CLI adapter later), a **model**, a **mode**
  (agent / plan / ask), and **its own theme** — `wallpaper`, `accent`, `mode(light/dark)` —
  persisted with the chat.
- Tabs are **Chrome-like and detachable** into separate OS windows. You can fill your monitor with
  concurrent chats across different projects and providers, replacing "N terminal windows each running
  a separate agent."
- **Sessions outlive windows.** The engine daemon owns them; windows are thin attached views that
  subscribe and render. Detaching a tab just re-attaches its session to a new window.
- The **app chrome re-themes to the active chat**. New chats get project/global default theme.

---

## 2. Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│  Tauri app                                                            │
│                                                                       │
│  ┌───────────────┐   ┌───────────────┐   ┌───────────────┐            │
│  │ WebviewWindow │   │ WebviewWindow │   │ WebviewWindow │  React+Vite │
│  │  (attached to │   │  (attached to │   │  (detached    │  bespoke UI │
│  │   chat A)     │   │   chat B)     │   │   chat C)     │             │
│  └───────┬───────┘   └───────┬───────┘   └───────┬───────┘            │
│          │  subscribe / send (loopback WS + token)  │                 │
│          └──────────────┬────────────┬──────────────┘                 │
│                         ▼            ▼                                 │
│   ┌─────────────────────────────┐   ┌──────────────────────────────┐  │
│   │  Rust core (src-tauri)       │  │  Bun engine (sidecar daemon)  │  │
│   │  • window / tab management   │  │  • agent loop (own inference) │  │
│   │  • OS keychain (API keys)    │◀─┤  • provider adapters (AI SDK) │  │
│   │  • native menus / traffic    │  │  • tool exec (fs, bash, grep) │  │
│   │  • sidecar supervision       │  │  • context / token accounting │  │
│   │  • PTY (Mission Control)     │  │  • SQLite + blob store         │  │
│   └─────────────────────────────┘  │  • normalized event bus (WS)  │  │
│                                     └──────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
                                     │
                    ~/.rama/rama.db  ·  ~/.rama/blobs/<hash>
```

**Responsibilities**
- **Rust core**: OS-privileged surface — windows/tabs, OS keychain for secrets, native menu/traffic
  lights, supervising the Bun sidecar, and PTY for Mission Control's Terminal pane
  (`docs/MISSION_CONTROL_PLAN.md`). Hands each webview the loopback engine URL + auth token.
- **Bun engine (daemon)**: the brain. Runs the agent loop, provider adapters, tool execution,
  context management, and owns the SQLite DB + blob store. Exposes a **loopback WebSocket** (random
  port, per-launch token) so one or many windows can subscribe to a chat's event stream.
- **React webview**: pure renderer + input. Subscribes to a chat's event stream, sends user
  turns/commands, talks to Rust core for window/OS actions.

> Tool execution lives in the Bun engine for the boilerplate (Bun has full fs + subprocess). The
> **permission model** (agent = auto, plan = read-only, ask = confirm each write/exec) is enforced in
> the engine: risky tools emit `permission.request` and block until the UI approves.

---

## 3. The normalized event contract (the spine)

Every backend — the own-loop now, a CLI adapter later — emits this stream. The renderer only ever
knows about these events. Define once in `packages/protocol`.

```ts
type SessionEvent =
  | { type: 'run.started';   runId: string; ts: number }
  | { type: 'message.user';  id: string; text: string; ts: number }
  | { type: 'thinking.delta'; runId: string; text: string }
  | { type: 'thinking.done';  runId: string; durationMs: number }
  | { type: 'message.delta';  runId: string; text: string }
  | { type: 'message.done';   runId: string }
  | { type: 'tool.call';   callId: string; name: string; input: unknown; ts: number }
  | { type: 'tool.result'; callId: string; ok: boolean; summary: string; artifactId?: string }
  | { type: 'artifact.created'; artifactId: string; kind: ArtifactKind; name: string; meta: object }
  | { type: 'artifact.updated'; artifactId: string; delta?: string; status: 'streaming' | 'done' }
  | { type: 'usage.update'; inputTokens: number; outputTokens: number; contextUsed: number; contextMax: number }
  | { type: 'cost.update';  usd: number }
  | { type: 'permission.request'; reqId: string; tool: string; input: unknown; risk: 'low'|'high' }
  | { type: 'status'; state: 'idle'|'thinking'|'streaming'|'tool'|'waiting_permission'|'error'; verb?: string }
  | { type: 'run.finished'; runId: string; ts: number; summary?: string }
  | { type: 'error'; message: string; detail?: string };

type ArtifactKind = 'diff' | 'code' | 'terminal' | 'doc' | 'file';
```

Client → engine commands: `sendUserTurn`, `interrupt`, `approvePermission`, `setModel`, `setMode`,
`subscribeChat`, `unsubscribeChat`.

---

## 4. Data model (SQLite · `~/.rama/rama.db`)

```sql
projects(
  id, name, path, repo_url, default_branch, settings_json, created_at
);

chats(                         -- a "terminal chat" / session
  id, project_id, title,
  backend_json,                -- { kind: 'own-loop' } — a union of one; see MISSION_CONTROL_PLAN.md §5.4
  model, mode,                 -- mode: agent | plan | ask
  wallpaper, accent, theme,    -- per-chat UI, persisted with the chat
  status, cost_usd, context_used, context_max,
  created_at, updated_at
);

messages(
  id, chat_id, seq, role,      -- user | assistant | system
  content, thinking, meta_json, created_at
);

tool_calls(
  id, message_id, chat_id, name, input_json,
  ok, result_summary, started_at, ended_at
);

artifacts(                     -- own store, linked to BOTH chat and project
  id, chat_id, project_id, message_id, tool_call_id,
  kind,                        -- diff | code | terminal | doc | file
  name, meta_json,
  body_hash,                   -- -> ~/.rama/blobs/<hash>  (large bodies on disk)
  body_inline,                 -- small bodies stored inline (nullable)
  size, status, created_at, updated_at
);

providers( id, kind, base_url, label, created_at );   -- secrets in OS keychain, keyed by id
settings( key, value_json );                          -- global defaults incl. default theme
```

Blobs are content-addressed (`sha256`) under `~/.rama/blobs/`; identical bodies dedupe for free.

---

## 5. Repository layout (monorepo)

```
rama/
  apps/desktop/
    src-tauri/          # Rust core: windows, keychain, sidecar supervisor, (later) PTY
    src/                # React + Vite webview — the bespoke UI
  engine/               # Bun sidecar daemon: agent loop, providers, tools, DB, event bus
  packages/
    protocol/           # shared TS types: SessionEvent contract + command DTOs
    ui/                 # design system: tokens.css, primitives, DotFieldBackground
  docs/                 # design + this plan
```

---

## 6. Phases

Each phase has a concrete **exit criterion** you can demo. Phases 0–3 = the boilerplate.

### Phase 0 — Scaffolding & the design system
**Goal:** the shell renders and themes live; no agent yet.
- Tauri + React + Vite + TS project; monorepo wiring; fonts (JetBrains Mono, Martian Mono, DM Mono).
- **Reconcile the two token sets into one canonical `packages/ui/tokens.css`** (OKLCH accents from
  `design-system.html` + the app prototype). Theme engine: `data-theme` / `data-accent` + wallpaper
  stack (image → veil → vignette → accent wash → grain), runtime switch, persisted.
- Core primitives: Button, Badge, Input, Tabs, SegmentedControl, Toggle, Card, Modal, Toast.
- `DotFieldBackground` canvas component + grain overlay + wallpaper layers.
- App shell: titlebar (traffic lights, tab strip, ⌘K/wallpaper/accent/theme/panel controls),
  3-column grid (sidebar / chat / artifacts), status bar — wired to mock data.
- **Exit:** app opens looking like the prototype; theme + accent + wallpaper switch live and persist.

### Phase 1 — Data layer & persistence
**Goal:** real projects/chats persist; per-chat theme drives the chrome.
- SQLite in the Bun engine (`bun:sqlite`) with schema + migrations; blob store on disk; DAO layer.
- Engine loopback WS/HTTP server (token-authed); Rust core spawns/supervises it and passes url+token
  to the webview.
- CRUD for projects & chats over the protocol; sidebar reads real data; create/select chats.
- Session record carries `{ wallpaper, accent, theme, model, mode, backend }`; selecting a chat
  re-themes the whole window; new chats inherit default theme.
- **Exit:** create projects/chats, restart the app, everything restores; switching chats re-skins the UI.

### Phase 2 — Own agent loop + streaming (single provider)
**Goal:** type a prompt → streamed bespoke response, persisted.
- Vercel AI SDK with **`@ai-sdk/openai-compatible`** pointed at **Together AI** (`base_url` +
  keychain-stored key); model configurable (pick a strong tool-use model).
- Agent loop: system-prompt assembly, history from DB, streaming text + reasoning, token/context
  accounting, cost — all emitted as the **normalized event stream**.
- Render the bespoke chat: `❯` user turns, `✻ thought for Ns` collapsible thinking, `◆` responses,
  live verb + elapsed + interrupt affordance, blinking caret; context meter + cost in the header.
- Composer: model menu (provider/model), mode toggle, ⇧⏎ newline, ⏎ send / queue while running.
- **Exit:** real multi-turn streamed conversation against Together AI, saved and reloadable.

### Phase 3 — Tools + artifacts pipeline  ★ BOILERPLATE MILESTONE
**Goal:** the agent reads/edits/writes/runs; the artifacts DB + panel come alive.
- Tool system: `read`, `write`, `edit`, `grep`, `ls`, `bash` executed in the engine, scoped to the
  project cwd. Permission model: agent / plan / ask → `permission.request` + GUI approval.
- Tool-call rendering: the `● read src/... ⎿ 214 lines` cards, collapsible results, inline diff minis.
- **Artifacts engine:** each meaningful tool output becomes an `artifacts` row (+ disk blob), linked to
  chat & project. Artifacts panel reads the DB and renders **diff / code / terminal / doc** previews
  with live "streaming/writing" badges.
- **Exit:** an end-to-end run edits files, runs a test, and populates the artifacts panel from the DB —
  a graphically-rich, self-contained harness on one provider. **This is the deliverable boilerplate.**

### Phase 4 — Multi-provider & model management
- More adapters behind the OpenAI-compatible one (OpenAI, Ollama/local `/v1`, OpenRouter, Groq…) and a
  native Anthropic adapter for Claude API. Capability flags per model (tools? thinking?).
- Provider health in the status bar; secure credential management (OS keychain); per-chat model select.
- **Exit:** switch providers/models per chat; status bar reflects live provider health.

### Phase 5 — Multi-tab & detachable windows (the tmux/Chrome experience)
- Formalize the daemon: sessions run independent of any window; windows subscribe/unsubscribe.
- Tab strip = open sessions; **tear-off a tab → new `WebviewWindow`** bound to that session; sessions
  survive window close; re-attach. Per-window theme follows its active chat.
- **Exit:** several concurrent chats across tabs and detached windows, each its own project/provider/theme.

### Phase 6 — heku (tool-finder subsystem + mascot)
- Real subsystem: embed & index tools/skills → semantic `heku find`, powering `/` command and `@file`
  discovery in the composer. Warm-index metrics.
- Personality layer: the pixel-octopus on the welcome screen — bob/hop/spin/ink, cursor-tracking eyes,
  idle chatter, poke-to-interrupt (port from the prototype).
- **Exit:** heku indexes tools/skills and drives command/tool search; mascot lives on the welcome screen.

### Phase 7 — Skills · MCP · docs · command palette
- Skills (install/list/run); **MCP client** (connect servers → their tools flow into the loop + heku
  index); local gitignored docs; ⌘K command palette; `/commands`.
- **Exit:** extensibility — skills & MCP servers add tools; palette + commands work.

### Phase 8 — CLI shell embedding (SECONDARY, superseded)
**Rewritten by `docs/MISSION_CONTROL_PLAN.md`.** The original plan was a `{ kind: "cli" }` chat
backend — a chat tab with no composer, no messages, and no model, its whole column a live
terminal. That was confusing: those CLIs are just programs, not a second kind of chat. There is no
cli-backed chat anymore; `BackendConfig` is a union of one (`{ kind: "own-loop" }`).

PTY (`portable-pty`) in Rust core + **xterm.js** in the webview still land, themed the same way
(transparent bg over wallpaper, accent ANSI palette) — just as **Mission Control's Terminal pane**
(`MISSION_CONTROL_PLAN.md` phases M2/M3), a project-scoped live-shell multiplexer independent of
any chat. Running `claude` or `copilot` there is no different from running `bun dev`: open a
terminal, type the command. The agent surface (`MISSION_CONTROL_PLAN.md` §7) is what makes shells
agent-driven instead — `bash background:true` spawns one, `process` reads/lists/kills them.
- **Exit:** see `MISSION_CONTROL_PLAN.md` phases M2–M4 for the real exit criteria.

---

## 7. Cross-cutting (ongoing)
- Design QA against the prototype; the halogen-glow signature; traffic-light semantics never re-theme.
- Keyboard shortcuts / keybindings; settings screen; toast + error system.
- Packaging & signing (macOS / Windows / Linux); auto-update; telemetry **off by default**.
- Tests: engine loop + tool contracts (unit), protocol round-trips, a couple of e2e smoke flows.
- Security: API keys only in OS keychain; tool exec scoped to project cwd; loopback WS token-authed.

## 8. Open questions / decisions log
- Together AI default model (needs solid function-calling support) — TBD.
- Do sessions persist across full app restart (true daemon), or only across window close? (Leaning: across window close for v1; full daemon later.)
- Should Rust core mediate tool execution for stronger sandboxing, or keep it in the engine? (v1: engine.)
- Canonical `tokens.css` — resolve OKLCH (app/design-system) vs HSL (design-language) once, in Phase 0.
```
