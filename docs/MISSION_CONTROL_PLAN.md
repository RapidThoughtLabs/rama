# Rama — Mission Control Implementation Plan (pass 01)

Phases here are numbered **M0–M6** so they never collide with the build phases
0–8 in `docs/IMPLEMENTATION_PLAN.md`, the redesign phases R0–R7 in
`docs/REDESIGN_PLAN.md`, the settings phases S0–S5 in `docs/SETTINGS_PLAN.md`,
the provider phases P0–P5 in `docs/PROVIDERS_PLAN.md`, or the tool-layer phases
TL0–TL7 in `docs/TOOL_LAYER_PLAN.md`. Cite these as "MISSION_CONTROL_PLAN.md
Phase M2".

**What this replaces.** The right-hand column is `ArtifactsPanel.tsx` today: a
fixed 384px, a flat artifact list stacked on a preview, toggled by a boolean.
This plan turns it into **Mission Control** — a resizable second workspace with
three panes (Artifacts, Terminal, Web), each built from the same rail/stage
primitive.

**What this deletes.** Phase 8's cli-backed chats. Driving `claude` or
`copilot` from inside a *chat tab* was confusing — a tab that looks like a chat
but has no composer, no messages, and no model. Those CLIs are just programs;
they belong in a terminal. `TerminalView.tsx` and the `{ kind: "cli" }` backend
come out entirely, and their xterm knowledge is harvested into the new terminal
runtime.

---

## 0. Locked decisions

These four were settled before this plan was written. Everything below assumes
them.

1. **Agent shells surface only when they are long-running.** A quick `bash`
   call stays exactly as it is today — ephemeral `Bun.spawn`, output captured
   into a `kind: "terminal"` artifact for traceability. Only
   `bash background:true` (a dev server, a test watcher) spawns a *real* PTY
   that appears in the Terminal pane and outlives the run.
   → **Artifacts = what happened. Terminal = what is still happening.**
   This is the line that keeps the two panes from becoming the same pane.

2. **Terminals are project-scoped.** A terminal belongs to a repo/cwd, not a
   conversation. `bun dev` keeps running while you move between three chats in
   the same project. Switch project, you see that project's shells.

3. **The Web pane is stubbed in M1 and built in M5.** The rail/stage/resize
   architecture lands and gets proven on Artifacts + Terminal before we take on
   the child-webview overlay tax.

4. **The agent can read any shell, but only write to shells it created.**
   `process.read` works on every terminal in the project. `process.kill` and
   any write refuse on `owner = 'user'` — returning an `ok: false` the model
   reads and reacts to, per `ToolResult`'s contract, not a thrown error.

---

## 1. Ordering rationale

**M0 (delete cli chats) is first and is pure removal.** Every later phase
touches `ChatColumn.tsx`, `WindowTabsProvider`, `BackendConfig`, and the
`/chats/:id/pty/*` routes. Doing the deletion after the rewrite means writing
the same code twice and then throwing half of it away.

**M1 (the layout primitive) comes before any terminal work** because the rail,
the stage, the splitter and the persisted geometry are shared by all three
panes. Building the terminal pane first means building a bespoke layout for it
and then porting it.

**M2 and M3 split the terminal into runtime and UI** deliberately. M2 is Rust +
engine + a headless hook, verifiable with one hardcoded terminal. M3 is the
rail, the buttons, and the reattach logic. Landing them together makes the
first broken render impossible to diagnose.

**M4 (the agent surface) is last of the terminal phases** because it depends on
M2's terminal identity and M3's ownership badges existing to be visible.

**M5/M6 (Web) are separable and can slip** without blocking anything above.

---

## 2. Rules that hold across every phase

- Each phase ships runnable. `main` never boots broken.
- No color outside the theme contract. A component needing a color reads a
  token or becomes one. (R0's rule.)
- Anything touching CSS is checked in **kanagawa and foam** before it lands.
- **One layout primitive, not two.** Narrow and wide are the same component
  with a flipped axis. If a phase introduces a second layout component for
  the same job, it is wrong.
- **Nothing in Mission Control is chat-scoped except Artifacts.** If a phase
  finds itself keying a terminal or a page by `chatId`, stop.

---

## 3. The model

### 3.1 Vocabulary

Every pane is `(rail, stage)`:

| Pane | Rail (A) — the index | Stage (B) — the content |
|---|---|---|
| **Artifacts** | artifacts produced by this chat | diff / file / transcript view |
| **Terminal** | live shells in this project | the attached xterm |
| **Web** | open pages | the webview |

`rail` and `stage` are the names used in code and CSS. Not "sidebar" — the
window already has one of those and the collision will cost an hour every time
someone reads a stack trace.

### 3.2 The pane registry

Three hardcoded branches would make the fourth pane (Preview, Git, Todos, heku)
a rewrite. The panes are a registry from day one:

```ts
// apps/desktop/src/app/mission-control/panes.ts
export interface MissionControlPane {
  id: "artifacts" | "terminal" | "web";
  label: string;
  Icon: FC<SVGProps<SVGSVGElement>>;
  /** What the pane's contents belong to — drives what a chat switch clears. */
  scope: "chat" | "project";
  /** Live count + attention dot for the tab chip. */
  useBadge: () => { count: number; attention: boolean } | null;
  Rail: FC<{ collapsed: boolean }>;
  Stage: FC;
  /** Rendered right-aligned in the rail header (e.g. Terminal's `+`). */
  RailActions?: FC;
}
```

`⌥1 / ⌥2 / ⌥3` map to registry index, so adding a pane adds a chord for free.

### 3.3 Scope table — what survives what

| Event | Artifacts | Terminals | Web pages |
|---|---|---|---|
| Switch chat, same project | reloads | **untouched** | **untouched** |
| Switch project | reloads | swaps to that project's | swaps |
| Collapse Mission Control | — | **keep running** | webview hidden, not destroyed |
| Close window | — | **keep running** (see Risk 3) | destroyed |
| Quit app | persisted | **killed** (see Open Question 1) | destroyed |

---

## 4. Layout and alignment

### 4.1 The band grid

Three horizontal bands, and the alignment rule that makes the whole thing read
as one object:

| Band | Height | Contents |
|---|---|---|
| **MC header** | 40px | rail toggle · pane tabs · overflow |
| **Action band** | 36px | rail header *and* stage toolbar — **same band, always aligned** |
| **Body** | flex | rail body · splitter · stage body |

40px matches today's `.rama-artifacts-header`. 36px is close enough to today's
`.rama-artifact-preview-toolbar` (9px padding + line-height) that no diff view
shifts vertically.

**The alignment rule:** in side mode the rail header and the stage toolbar sit
in one continuous 36px band split by the splitter, with a single shared bottom
border. They never have different heights. This is the single detail that makes
the pane look designed rather than assembled.

### 4.2 Narrow / stacked (panel width < 600px)

```
├──────────────── mission control ─────────────────┤
│ ‹   [◈ 3] [▸ 2 ●] [⊕]                          ⋯ │ 40  MC header
├──────────────────────────────────────────────────┤
│ artifacts                        all · files · tools │ 36  rail header
│  ±  AppShell.tsx                        +12 −4   │
│  ◇  tokens.css                       142 lines   │     rail body
│  ▸  bun test                                ok   │
├══════════════════ drag ══════════════════════════┤  6  splitter (horizontal)
│ AppShell.tsx      diff                    ⧉   ↗  │ 36  stage toolbar
│  1   import { useState } from "react"            │
│  2 + const [w, setW] = useState(384)             │     stage body
```

Rail body height is drag-resizable between 88px and 60% of the panel; persisted
separately from the wide-mode rail width.

### 4.3 Narrow / rail collapsed

The rail becomes a single breadcrumb row. Clicking it opens the list as an
**overlay sheet over the stage** — it does not push the stage down. This is the
fix for the current panel's real problem: at 384px the permanent list eats the
preview.

```
│ ›   [◈ 3] [▸ 2 ●] [⊕]                          ⋯ │ 40
├──────────────────────────────────────────────────┤
│ ›  ± AppShell.tsx  ·  3 artifacts              ▾ │ 32  collapsed rail
├──────────────────────────────────────────────────┤
│ AppShell.tsx      diff                    ⧉   ↗  │ 36
│  … full-height stage …                           │
```

### 4.4 Wide / side-by-side (panel width ≥ 600px)

```
│ ‹   [◈ Artifacts] [▸ Terminal 2 ●] [⊕ Web]     ⋯ │ 40  spans full width
├────────────────┬──┬──────────────────────────────┤
│ artifacts    ⌄ │  │ AppShell.tsx  diff     ⧉  ↗  │ 36  ONE band, split
├────────────────┤  ├──────────────────────────────┤
│ ▾ src/app      │  │  1   import { useState }     │
│    ± AppShell  │dr│  2 + const [w, setW] = …     │
│    ◇ tokens    │ag│                              │
│ ▾ engine/src   │  │                              │
│    ± server.ts │  │                              │
└────────────────┴──┴──────────────────────────────┘
     220–360px     6
```

### 4.5 Wide / rail collapsed

**Collapses to a 44px icon rail, not to zero.** A fully hidden list makes the
terminal switcher invisible, which defeats the multiplexer. Rows become their
glyph with a tooltip; the active row keeps its accent border.

```
│ ›   [◈ Artifacts] [▸ Terminal 2 ●] [⊕ Web]     ⋯ │
├────┬─────────────────────────────────────────────┤
│ ±  │ AppShell.tsx  diff                   ⧉   ↗  │
│ ◇  │                                             │
│ ▸  │                                             │
└────┴─────────────────────────────────────────────┘
  44
```

### 4.6 Terminal pane, wide

```
│ ›   [◈ Artifacts] [▸ Terminal 2 ●] [⊕ Web]     ⋯ │
├────────────────┬─────────────────────────────────┤
│ terminals    + │ ~/rama  ·  bun dev    ⌫    ⏹    │ 36
├────────────────┤─────────────────────────────────┤
│ ● 1  bun dev   │ $ bun dev                       │
│      ~/rama  ⌁ │ ready in 340ms                  │
│ ○ 2  zsh       │ ➜  http://localhost:1420        │
│      ~/rama    │ █                               │
│ ✓ 3  bun test  │                                 │
│      exit 0    │                                 │
└────────────────┴─────────────────────────────────┘
```

Rail row anatomy: **status dot** (`●` running / `○` idle / `✓ ` exited 0 /
`✗ ` exited non-zero) · **index** (drives `⌘1–9` within the pane) · **title**
(command, or shell name) · **cwd**, relative to project root · **`⌁`** iff
`owner = 'agent'`, tooltip "started by *chat title*".

Stage toolbar: cwd breadcrumb · command · **`⌫` clear** · **`⏹` kill** (disabled
once exited). New terminal is the `+` in the rail header, `⌘⇧\``  globally.

### 4.7 Resize behaviour

- Panel width lives in **one CSS custom property** — `--mc-w` on `.rama-body` —
  not in `grid-template-columns` literals. `.rama-body` becomes
  `grid-template-columns: minmax(0, 1fr) var(--mc-w)`.
- **`transition: grid-template-columns` is killed during drag** via a
  `data-dragging` attribute on `.rama-body`. The existing 0.28s transition
  (`app-shell.css:161`) stays for the collapse toggle only — dragging against it
  rubber-bands a third of a second behind the cursor.
- Pointer capture on the handle; write `--mc-w` **directly from a ref** on every
  pointermove, rAF-batched. React state is committed once, on pointerup. Never
  re-render the tree per mousemove — the xterm and a long diff will visibly chug.
- Clamp: `[320, windowWidth − 480]`. The chat column can never be crushed.
- **Magnetic snaps** at `384` (today's width), `600` (the axis flip), and 50%,
  with ±16px pull. Double-click the handle toggles last-narrow ↔ last-wide.
- Axis flips at 600px with a manual override in the `⋯` menu ("rail on top" /
  "rail on left") persisted per window.
- **xterm `fit()` is not called per frame.** Throttle to rAF during drag and
  fire the authoritative `pty_resize` on pointerup only.

### 4.8 Where the toggle lives

Unchanged: the `IconPanel` button in `Titlebar.tsx:85` and the `act:panel`
command-palette entry (`CommandPalette.tsx:153`) both toggle Mission Control.
Their strings change from "artifacts panel" to "mission control"; there is no
second close button inside the panel. One job, one control.

### 4.9 Chords

| Chord | Action |
|---|---|
| existing panel toggle | show/hide Mission Control |
| `⌥1 / ⌥2 / ⌥3` | Artifacts / Terminal / Web |
| `⌥\`` | collapse/expand the rail |
| `⌘⇧\`` | new terminal (switches to the Terminal pane) |
| `⌘1–9` *(pane-local, when the rail has focus)* | select rail row *n* |

---

## 5. Data model

### 5.1 New table

```sql
CREATE TABLE IF NOT EXISTS terminals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  cwd TEXT NOT NULL,
  shell TEXT NOT NULL,
  argv_json TEXT NOT NULL DEFAULT '[]',
  owner TEXT NOT NULL DEFAULT 'user',          -- 'user' | 'agent'
  origin_chat_id TEXT REFERENCES chats(id),    -- set iff owner='agent'
  status TEXT NOT NULL DEFAULT 'running',      -- 'running' | 'exited'
  exit_code INTEGER,
  scrollback_hash TEXT,                        -- ~/.rama/blobs, same as artifacts
  scrollback_inline TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_terminals_project ON terminals(project_id);
```

Scrollback reuses `db/artifacts.ts`'s exact storage strategy — inline under
4096 bytes, blob above — **and its `MAX_TERMINAL_BODY_BYTES = 200_000` trailing
cap.** That cap already exists for the same reason and is the thing that keeps
remount replay from taking seconds after a long build.

### 5.2 Protocol additions — `packages/protocol/src/index.ts`

```ts
export type TerminalOwner = "user" | "agent";
export type TerminalStatus = "running" | "exited";

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
  cwd?: string;          // defaults to project.path
  shell?: string;        // defaults to $SHELL
  argv?: string[];
  owner?: TerminalOwner;
  originChatId?: string;
}
```

New `SessionEvent` members, broadcast on a **project topic** (see 5.3):

```ts
| { type: "terminal.created"; terminal: TerminalDTO }
| { type: "terminal.exited"; terminalId: string; exitCode: number }
| { type: "terminal.renamed"; terminalId: string; title: string }
```

PTY *output* is deliberately **not** a `SessionEvent`. It arrives over Tauri's
own event bus straight from Rust (Section 6) — routing tens of kilobytes a
second of terminal bytes through the Bun engine and back would add a hop for
nothing.

### 5.3 A project WS topic

`engine/src/ws.ts` has per-chat topics plus one global themes topic. Terminals
are project-scoped, so add `project:{id}`. `subscribeProject` /
`unsubscribeProject` join `ClientCommand`.

### 5.4 `BackendConfig` shrinks

```ts
// was: { kind: "own-loop" } | { kind: "cli"; command; args?; env? }
export type BackendConfig = { kind: "own-loop" };
```

Kept as a union of one so a future backend adapter is an addition, not a
protocol rewrite.

**Migration:** rows in `chats` with `backend_json` of `{"kind":"cli"}` would
render as a chat with no messages and no way to type. One-time fixup at engine
boot rewrites them to `{"kind":"own-loop"}` and prefixes the title with the old
command so they are identifiable. This is a prototype DB; do not build a
migration framework for it.

---

## 6. The PTY re-key (Rust)

`apps/desktop/src-tauri/src/pty.rs` keys everything by `chat_id`:
`PtyState(Mutex<HashMap<String, PtySession>>)`, `pty-data:{chat_id}`,
`pty-exit:{chat_id}`. One PTY per chat is exactly the assumption this plan
breaks.

| Before | After |
|---|---|
| `HashMap<chat_id, PtySession>` | `HashMap<terminal_id, PtySession>` |
| `pty-data:{chat_id}` | `pty-data:{terminal_id}` |
| `pty_spawn(chat_id, …)` | `pty_spawn(terminal_id, …)` |
| — | `pty_list_running() -> Vec<String>` |

`pty_list_running` is new and is what lets a freshly opened window reattach to
shells started by a window that has since closed.

Everything else in `pty.rs` — the reader thread, `drop(pair.slave)`, the
killer, resize — is unchanged. This is a ~30 line change today and an ugly
migration in three months.

---

## 7. The agent surface

### 7.1 `bash` gains `background`

`engine/src/tools/bash.ts` keeps its entire current path for foreground calls.
`background: true` takes a different one:

```ts
inputSchema: z.object({
  command: z.string(),
  timeoutMs: z.number().optional(),
  background: z.boolean().optional()
    .describe("Run as a persistent shell the user can see and interact with. Use for dev servers, watchers, and anything that does not exit on its own. Returns a terminalId; read it later with `process`."),
})
```

Background path: create a `terminals` row with `owner: 'agent'` and
`origin_chat_id: ctx.chatId` → `pty_spawn` → return immediately with the
`terminalId` and the first ~2s of output. It does **not** wait for exit and is
**not** killed on run end.

Permission is unchanged in shape — `bash` is already
`gate(ctx, { name: "bash", risk: "high" })` — but the gate's prompt copy must
say the process outlives the turn, because that is materially different from
what a user approving `bash` today is agreeing to.

### 7.2 The artifact ↔ terminal bridge

A background spawn also writes a normal `kind: "terminal"` artifact with
`meta.terminalId` set and a one-line body ("started `bun dev` → terminal 1").
The chat transcript stays complete, the Artifacts rail shows the event, and
clicking that row **jumps to the Terminal pane with that shell selected.**
This is the seam that keeps the two panes feeling like one workspace instead of
two lists that happen to share a border.

### 7.3 `process` — TL3's tool, respecting ownership

```ts
inputSchema: z.discriminatedUnion("op", [
  z.object({ op: z.literal("list") }),
  z.object({ op: z.literal("read"), id: z.string(), since: z.number().optional() }),
  z.object({ op: z.literal("kill"), id: z.string() }),
])
```

- `list` — every terminal in the project, with `owner`, `status`, `cwd`,
  `title`, `exitCode`. This is how the agent answers "what happened in your
  terminal?".
- `read` — tail of scrollback for **any** terminal, user-owned included.
  Head+tail truncated to `MODEL_OUTPUT_CHARS`, reusing `bash.ts`'s existing
  `headTailTruncate`.
- `kill` — **refuses on `owner: 'user'`** with
  `{ ok: false, content: "Terminal 2 is user-owned; ask the user to stop it." }`.
  A result the model reads, not a thrown error.

### 7.4 `docs/TOOL_LAYER_PLAN.md` needs an amendment

§5.5 specs a run-scoped `ShellSession` disposed on run end; §6.10 says "all
background processes are killed on run end and on abort." **Both are now
false** for background shells — a dev server that dies when the turn ends is
useless. Amend those two sections in M4, in the same commit, or the next person
to read that plan builds the wrong thing.

---

## 8. Phases

### Phase M0 — Delete cli-backed chats

Pure removal. Ships runnable on its own.

| File | Change |
|---|---|
| `packages/protocol/src/index.ts:56` | drop the `cli` variant from `BackendConfig` |
| `apps/desktop/src/app/TerminalView.tsx` | **delete** (xterm setup is harvested into M2's `XtermSurface` — read it before deleting) |
| `apps/desktop/src/app/NewTerminalChatModal.tsx` | **delete** — verified orphaned, never mounted anywhere |
| `apps/desktop/src/app/ChatColumn.tsx:296–302` | drop the `backend.kind === "cli"` branch |
| `apps/desktop/src/app/data/WindowTabsProvider.tsx:133–143` | drop `openNewTerminalTab` (and from the context type + memo deps) |
| `engine/src/server.ts:223–272` | `/chats/:id/pty/{start,data,exit}` — deleted, replaced in M2 |
| `apps/desktop/src/engine/client.ts` | drop `startPty` / `sendPtyData` / `exitPty` |
| `engine/src/db/chats.ts` | boot fixup: `{"kind":"cli"}` → `{"kind":"own-loop"}` |
| `app-shell.css:1178–1190` | keep `.rama-terminal-surface` (M2 reuses it), retitle the section comment |
| `docs/IMPLEMENTATION_PLAN.md` Phase 8 | rewrite: CLI embedding is now "run it in Mission Control's Terminal", not a chat backend |

`pty.rs` is untouched in this phase — it gets re-keyed in M2.

### Phase M1 — The rail/stage primitive

The whole layout, with Artifacts as the only real pane.

- New `apps/desktop/src/app/mission-control/` — `MissionControl.tsx`,
  `panes.ts`, `Rail.tsx`, `Stage.tsx`, `Splitter.tsx`,
  `useMissionControlGeometry.ts`, `mission-control.css`.
- `ArtifactsPanel.tsx` splits into `panes/ArtifactsRail.tsx` +
  `panes/ArtifactsStage.tsx`. The diff renderer and `fetchArtifactContent`
  wiring move over unchanged.
- `AppShell.tsx`: `panelOpen` becomes the geometry hook; `<ArtifactsPanel />`
  becomes `<MissionControl />`.
- `app-shell.css:156–163`: `--mc-w`, `data-dragging`, the collapse transition.
- Terminal and Web register as panes rendering a one-line "coming in M3 / M5".
  They ship visible and disabled — the tab bar's alignment is settled once,
  not twice.
- Geometry persisted per window (width, rail size, collapsed, active pane,
  axis override) in `localStorage` keyed by `WINDOW_LABEL`. It is view state,
  not user data; it does not belong in SQLite.
- **Density (can slip without blocking anything):** at ≥600px the artifacts
  rail groups into a directory tree with per-file `+/−` counts, and the stage
  renders side-by-side diff instead of unified. This is what makes dragging it
  wider a reward rather than bigger fonts.
- Delete the fake `all · files · tools` chips (`ArtifactsPanel.tsx:77–79`) —
  they are decorative today. They come back in M3 with real counts.

### Phase M2 — Terminal runtime

No visible UI beyond one hardcoded terminal to prove the pipe.

- `pty.rs` re-keyed per Section 6; `pty_list_running` added.
- `engine/src/db/terminals.ts` DAO + `schema.ts` table.
- Engine routes: `POST /terminals`, `GET /projects/:id/terminals`,
  `POST /terminals/:id/data`, `POST /terminals/:id/exit`,
  `GET /terminals/:id/scrollback`, `DELETE /terminals/:id`.
- `engine/src/ws.ts`: `project:{id}` topic.
- `apps/desktop/src/app/mission-control/useTerminalSession.ts` — headless:
  attach/detach, scrollback replay, the 1s flush interval lifted from
  `TerminalView.tsx`.
- `XtermSurface.tsx` — dumb, themed, takes a session. Keeps
  `readThemeColors()`, `attachCustomKeyEventHandler`, `BASE_TERMINAL_FONT_SIZE`
  and the `fontScale` effect verbatim from `TerminalView.tsx`.

### Phase M3 — Terminal pane

- `panes/TerminalRail.tsx` + `panes/TerminalStage.tsx` per Section 4.6.
- `+` new terminal, `⏹` kill, `⌫` clear, inline rename.
- Ownership badge `⌁`, status dots, exit codes, cwd.
- Reattach on window open via `pty_list_running` ∩ `GET /projects/:id/terminals`.
  A row that is `status: 'running'` in the DB but absent from Rust renders as
  **"ended — app restarted"**, not as running.
- Real artifact filter chips restored, with counts.

### Phase M4 — The agent surface

- `bash` gains `background` (7.1).
- `process` tool added to `createTools` (7.3).
- Artifact ↔ terminal bridge + click-through (7.2).
- Permission copy updated for outliving processes.
- `docs/TOOL_LAYER_PLAN.md` §5.5 / §6.10 amended (7.4).

### Phase M5 — Web pane

- `tauri = { version = "2", features = ["unstable"] }`; child webview via
  `WebviewBuilder` + `add_child`.
- `webview_create / _set_bounds / _navigate / _destroy` Tauri commands.
- Bounds sync: one `ResizeObserver` on the stage node → throttled
  `webview_set_bounds`.
- **The rule that keeps it survivable:** the child webview is hidden whenever
  the Web pane is not active, Mission Control is collapsed, or any modal is
  open. One hook, `useWebviewVisibility`, subscribed to `SettingsLinkContext`
  and the palette's open state. Without this it renders *on top of*
  `SettingsModal` and `CommandPalette`, because a native webview always paints
  above the DOM.
- Stage toolbar: back / forward / reload / omnibox. Rail: open pages, `+`.

### Phase M6 — Agent-readable web

The reason the Web pane exists. A `browser` tool:

```ts
z.discriminatedUnion("op", [
  z.object({ op: z.literal("open"), url: z.string() }),
  z.object({ op: z.literal("read"), id: z.string().optional() }),      // extracted text
  z.object({ op: z.literal("snapshot"), id: z.string().optional() }),  // screenshot → artifact
  z.object({ op: z.literal("console"), id: z.string().optional() }),
])
```

`read` is text extraction via injected JS — cheap, no vision model required,
and covers the actual use case (the agent starts a dev server, opens
`localhost:1420`, reads what rendered). `snapshot` lands a `kind: "file"`
artifact and needs a vision-capable model, so it degrades to "not supported by
this model" rather than failing.

Gated by the existing `web` `PermissionTool`, which is already in the protocol
and settings UI and has had no corresponding tool until now.

**Amended 2026-09-14 — `docs/AGENT_BROWSER_PLAN.md` (AB0–AB7) supersedes this
phase's tool surface.** M6 shipped `browser` read-only, and the paragraph above
describing `snapshot` as a screenshot is now wrong: `snapshot` is renamed to mean
the accessibility/ref tree (AB2) and screenshots move to `screenshot` (AB6). The
`web` permission rule stated here still governs read ops, but action ops
(`click`/`type`/`press`/`scroll`, AB4) split off it — loopback auto-allows,
everything else asks. §9 Risk 1 (`unstable` API churn) and §9 Risk 3's
"first response wins" rule both grow in that document's §9.

---

## 9. Risk register

1. **`unstable` API churn (M5).** Tauri's multiwebview API is explicitly
   unstable; a minor bump can break the build. Mitigation: pin the Tauri patch
   version in `Cargo.toml` when M5 lands, and keep every child-webview call
   behind `src-tauri/src/webview.rs` so the blast radius is one file.

2. **Scrollback replay cost.** Reuse `MAX_TERMINAL_BODY_BYTES = 200_000`. A
   200KB `term.write` on mount is ~1 frame; unbounded is seconds.

3. **The same terminal attached in two windows.** Tauri's `app.emit` broadcasts
   to every window, so two `XtermSurface`s both receive `pty-data:{id}` and
   both can type — which is correct and desirable. The wart is resize: two
   windows at different widths fight over `pty_resize`. **Only the focused
   window's `ResizeObserver` issues `pty_resize`.** Document it; do not try to
   solve it properly in M3.

4. **Terminal count creep.** Nothing stops the agent spawning ten dev servers
   across ten runs. M4 adds a soft cap (8 agent-owned per project) and a
   "3 agent shells running" affordance in the pane badge.

5. **Drag performance with a live xterm in the stage.** Covered in 4.7 — rAF
   throttle, authoritative resize on pointerup only. If it still chugs, hide
   the xterm behind a static snapshot during drag.

---

## 10. Open questions

1. **PTYs die when the app quits.** Rust owns them (`pty.rs`), and Rust lives
   inside the Tauri app, not the Bun daemon — and Bun cannot do PTYs at all,
   which is why `pty.rs` exists in the first place. So "sessions survive
   windows" holds, but "sessions survive quit" does not. Is that acceptable for
   v1 (scrollback persists, rows show "ended — app restarted"), or does the PTY
   host need to become a separate long-lived process? **My call: acceptable for
   v1.** A separate PTY host is a real daemon with real lifecycle problems and
   it should not be on this plan's critical path.

2. **Default shell.** `$SHELL` as a login shell (`-l`) picks up the user's full
   profile — nvm, mise, direnv — which is almost always what they want and is
   noticeably slower to spawn. Recommend `-l` and revisit if startup drags.

3. **Does the Terminal pane need splits?** No, for v1. The rail is the
   multiplexer. Revisit only if the rail starts feeling like a workaround.

4. **Full-bleed mode** — drag past ~80% and the chat collapses to a rail. Not
   in this plan. Worth adding once M3 lands and there is something worth going
   full-bleed for.
