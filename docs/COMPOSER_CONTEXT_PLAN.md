# Rama — Composer Context & Status Plan

Phases here are **CC0–CC2** so they never collide with the build phases 0–8
(`IMPLEMENTATION_PLAN.md`), redesign R0–R7 (`REDESIGN_PLAN.md`), settings
S0–S5 (`SETTINGS_PLAN.md`), harness H0–H6 (`HARNESS_DESIGN.md`), tool layer
TL0–TL7 (`TOOL_LAYER_PLAN.md`), providers P0–P6 (`PROVIDERS_PLAN.md`), prompt
stack PS0–PS7 (`PROMPT_STACK_PLAN.md`), Mission Control M0–M6
(`MISSION_CONTROL_PLAN.md`), loop migration LM0–LM7
(`LOOP_MIGRATION_PLAN.md`), loop mending MD0–MD6 (`LOOP_MENDING_PLAN.md`),
workspace panes W0–W7 (`WORKSPACE_PANES_PLAN.md`), symbol layer SL0–SL6
(`SYMBOL_LAYER_PLAN.md`), agent browser AB0–AB7 (`AGENT_BROWSER_PLAN.md`),
context budget CB0–CB6 (`CONTEXT_BUDGET_PLAN.md`), web search WS0–WS6
(`WEB_SEARCH_PLAN.md`), or chat view CV0–CV6 (`CHAT_VIEW_PLAN.md`). Cite these
as "COMPOSER_CONTEXT_PLAN.md Phase CC1".

**What this document owns.** Two independent changes to the composer/chat
column, bundled here because they were requested together and both touch
`ChatColumn.tsx`'s bottom rail: (1) replacing the composer's mode/status rail
with a row of pills — project folder, branch + worktree toggle, extra
context folders — and moving the busy-status indicator out of the composer
and into the message stream with playful verb text; (2) the backend to make
two of those pills real (extra read-only context roots, and actual
git-worktree isolation per chat). It does not touch Mission Control's panes,
the prompt stack's block layout, or the run loop's decisions beyond what's
needed to thread a chat's effective working directory through.

---

## 0. Current state (as of this writing)

- The composer rail (`apps/desktop/src/app/ChatColumn.tsx:899-933`) is
  mode tile → `ModelPicker` → `AgentPicker` → a status tile that shows
  `✻ {status.verb ?? status.state}…` plus elapsed time while busy
  (`ChatColumn.tsx:922-931`, styled by `.rama-status-verb` in
  `app-shell.css:644`).
- Server-side verbs are literal strings set by the run loop —
  `"thinking"` (`engine/src/agent/run/run.ts:299,389,471,493`), `"compacting"`
  (`run.ts:372,476`), `"responding"` (`engine/src/agent/run/step.ts:190`),
  `"running <tool>"` (`step.ts:269`, `permissions.ts:162`), and
  `"waiting for approval: <tool>"` (`permissions.ts:77`).
- Folder/project management (add, rename, remove, switch, "new chat here")
  lives entirely in `Sidebar.tsx` (`openAddProjectModal`,
  `renderProjectMenu`, the "add project" `Modal`). The composer has no
  project affordance at all today.
- There is no concept of a chat having more than one filesystem root, and no
  concept of git worktrees anywhere in the codebase (confirmed: no
  `worktree` hits outside this plan). `ProjectDTO` (`packages/protocol/src/
  index.ts:162-169`) is `{ id, name, path, repoUrl, defaultBranch,
  createdAt }` — one path, one default branch, nothing per-chat.
- Every tool that touches disk resolves paths through `resolveInProject`
  (`engine/src/tools/paths.ts`), which hard-rejects anything outside
  `projectRoot` — this is the sandbox CC1 has to widen, carefully.
- Current branch is already computed server-side:
  `StatusResult.branch` (`engine/src/tools/gitShared.ts:58,91-95`, parsed
  from `git status --porcelain=v2 --branch`) is already surfaced to the
  client as `ChangesDTO.branch` (`packages/protocol/src/index.ts:589`) via
  `readChanges` (`engine/src/git/status.ts`). No new plumbing needed to show
  a live branch name.
- `chats` (`engine/src/db/schema.ts:15-35`) has a typed `backend_json`
  column (`BackendConfig = { kind: "own-loop" }`,
  `packages/protocol/src/index.ts:160`) — narrow and already pattern-matched
  by a `LIKE` query in `db/chats.ts:31`, so it is **not** a free bag for new
  settings. `projects` already has an unused `settings_json TEXT NOT NULL
  DEFAULT '{}'` column (`schema.ts:11`) — same additive-JSON-column idea we
  want for chats, just not present on that table yet.

---

## 1. CC0 — Pill row + status line relocation (frontend only)

No protocol, DB, or engine changes. Purely `ChatColumn.tsx` +
`app-shell.css`.

1. **Pill row.** Replace the leading portion of `.rama-composer-rail`
   (`ChatColumn.tsx:899-908`) with three elements, left of the existing
   mode/model/agent tiles:
   - **Folder pill** — `activeProject.name` with a folder icon. Click opens
     the same project-switch/add-project affordance `Sidebar.tsx` already
     has; whether that's a shared popover or just dispatching to the
     existing `Modal` state is an implementation call, but it must not fork
     a second "add project" flow — reuse `useProjectsData().addProject`.
   - **Branch + worktree pill** — branch name from `ChangesDTO.branch` (see
     §0), plus a checkbox. The checkbox is rendered and controls local
     component state only in this phase; it does nothing to the filesystem
     until CC2.
   - **"+folder" button** — icon button, opens a folder picker (Tauri
     dialog). In this phase it only holds picks in local state (no
     persistence, no prompt effect) — CC1 wires it to something real.
   - No "Local" pill (explicitly dropped per product decision).
2. **Status line moves to the stream.** Delete `.rama-tile-status`
   (`ChatColumn.tsx:922-931`) from the rail. Add a `StatusLine` component
   rendered as the last child inside `.rama-messages-inner`
   (`ChatColumn.tsx:665-838`), immediately above `.rama-composer-wrap`
   (`:840`) — so it reads as the tail of the conversation, not part of the
   input. It shows the same `isBusy` / `status.verb` / elapsed-seconds data
   already computed at `ChatColumn.tsx:533,647`; only where it renders and
   what it says changes.
3. **Playful verbs, real verbs.** When `status.state === "thinking"` *and*
   the server's verb is the generic literal `"thinking"`, `StatusLine`
   cycles a client-side list of gerunds every ~2s — "Ramaing…",
   "Tinkering…", "Thinking longer…", "Percolating…", "Mulling it over…",
   etc. (Claude.ai's "Clauding…" pattern.) Every other verb —
   `"compacting"`, `"responding"`, `"running <tool>"`,
   `"waiting for approval: <tool>"` — renders verbatim, never replaced,
   since those describe something real and specific. Keep the `⇧⏎ nl` hint
   and esc-to-interrupt affordance working from wherever they end up.

**Done when.** The composer rail has no status text and no "thinking"
language at all; the pill row shows the real project name and real branch;
the message stream's last line while busy shows either a rotating playful
verb (generic thinking) or the real one (tool/compaction/approval), with
elapsed time and esc-to-interrupt intact.

---

## 2. CC1 — Extra context folders (read-only pointers, not chat history)

The point, in the words of the request: *"point the agent at a folder that
might have something useful, without wasting tokens — it's part of the
prompt, not part of the chat data."* So this ships as a **path pointer**,
never folder contents.

1. **Storage.** Add a `settings_json TEXT NOT NULL DEFAULT '{}'` column to
   `chats` (`engine/src/db/schema.ts:15-35`), mirroring `projects`' existing
   unused column — do **not** repurpose `backend_json` (see §0, it's a
   narrow typed discriminant with a `LIKE`-query consumer). Shape:
   `{ extraRoots?: string[] }` (absolute paths). DAO + `UpdateChatInput` +
   a `PATCH /chats/:id` field, following the same add/parse pattern
   `db/chats.ts` already uses for `backend_json`.
2. **Prompt injection.** Extend `ProjectKnowledgeInputs`
   (`engine/src/agent/prompt/project.ts`) with `extraRoots: string[]` and
   format one short section listing each absolute path with a one-line
   "may contain useful context — read/tree/grep into it if relevant"
   instruction. Thread it through `loop.ts`'s call into `buildPrompt`
   (`engine/src/agent/prompt/build.ts:60-88`) alongside the existing
   `projectKnowledge` input. This is pure formatting, no I/O, matching
   `formatProjectKnowledge`'s existing contract.
3. **Sandbox widening.** `resolveInProject` (`engine/src/tools/paths.ts`)
   currently rejects any path resolving outside a single `projectRoot`.
   Add an allow-listed extra-roots check (e.g. a sibling
   `resolveInAllowedRoots(roots: string[], relOrAbsPath)`, or teach
   `resolveInProject` to accept an optional extra-roots array) so `read`,
   `tree`, `grep`, and `glob` (`engine/src/tools/read.ts`, `glob.ts`, and
   whichever tool backs `tree`/`grep`) can resolve an absolute path that
   falls under one of the chat's `extraRoots`. **Writes stay scoped to the
   primary project only** — `edit.ts`, `fileOp.ts`, `gitWrite.ts` do not
   consult `extraRoots` at all. This keeps "look, don't touch" as an
   enforced property, not a convention.
4. **Composer wiring.** The CC0 "+folder" button now calls a real
   add/remove against the chat's `extraRoots` (persisted via the PATCH
   endpoint above); each extra root shows as a small removable chip next to
   the folder/branch pills.

**Done when.** Adding a folder via "+folder" persists across reload, shows
up as a pointer-only section in the assembled prompt (verify via the
existing prompt-preview route / `build.test.ts`-style test), the agent can
`read`/`grep` into it without a sandbox error, and it cannot `edit` or
`git`-touch anything under it.

---

## 3. CC2 — Real git-worktree isolation

The highest-risk phase — it changes what "the project's working directory"
means for a chat, and that value is threaded through nearly every tool.

1. **Worktree lifecycle.** New `engine/src/git/worktree.ts`:
   `ensureWorktree(project, chat)` / `removeWorktree(project, chat)`
   wrapping `git worktree add` / `git worktree remove`, using the existing
   `runGit`/timeout plumbing in `engine/src/tools/gitShared.ts`. Worktrees
   live in a per-project hidden directory outside the primary checkout
   (exact location and branch-naming strategy — shared branch vs. a
   per-chat working branch off `defaultBranch` — is an open decision to
   make at implementation time, not guessed here).
2. **Persistence.** Store `{ worktreeEnabled: boolean, worktreePath?:
   string, worktreeBranch?: string }` in the same `chats.settings_json`
   column CC1 added. Toggling the CC0 checkbox on calls `ensureWorktree`
   and flips the flag; toggling off calls `removeWorktree` (or leaves the
   worktree and just stops using it — decide alongside the cleanup
   question below).
3. **Threading the effective root.** Every tool that resolves paths or sets
   a shell `cwd` off `ctx.projectPath` — `edit.ts:66`, `fileOp.ts:42-94`,
   `glob.ts:25`, `gitWrite.ts` (all its `runXxx` helpers), `git.ts:52`,
   and `bash.ts`'s shell `cwd` (`:97-141`) — needs to see the chat's
   worktree path instead of the project's path when `worktreeEnabled` is
   set. Land this as one `effectiveProjectPath(chat, project)` computed
   once where `ToolContext` is constructed for a run, not as N edits inside
   individual tool files.
4. **Branch pill goes live.** With a worktree active, the CC0 branch pill
   reads the worktree's own branch (still via `getStatus`/`ChangesDTO`,
   just pointed at the worktree path) instead of the primary checkout's.

**Open questions to resolve before writing code here** (flagged, not
answered, so CC0/CC1 aren't blocked on them):
- Worktree cleanup on chat delete and on project removal — always remove,
  leave orphaned, or ask?
- Two chats wanting a worktree off the same branch — block the second, or
  let git's own "already checked out" error surface as-is?
- Does enabling worktree mid-chat (after tool calls already ran against the
  primary path) need any reconciliation, or is it only offered before the
  first turn?

**Done when.** Checking the worktree box creates an isolated checkout, every
tool call in that chat from then on reads/writes only inside it, the branch
pill reflects the worktree's branch, and unchecking it (or deleting the
chat) leaves the primary project untouched and doesn't leak worktrees.

---

## 4. Deliberately out of scope

- **Mission Control's panes and the Files/Changes pane's own project
  picker** — untouched; CC0's folder pill is composer-local.
- **Multi-root *chat history*** — extra roots (CC1) are prompt pointers
  the agent can read into on demand, never attached documents or part of
  the persisted transcript.
- **Remote/sandboxed execution** — the "Local" pill from the original
  concept screenshot is dropped entirely; nothing here introduces an
  execution-environment picker.
- **Prompt block/cache-breakpoint layout changes** — CC1's new section is
  additive content inside the existing `agent+mode+project+env` block
  (`build.ts:65-72`), not a new breakpoint.

## 5. Sequencing

CC0 first and alone — it's pure frontend, independently shippable, and
gives immediate visual/UX payoff (pill row + relocated status line) with
zero backend risk. CC1 next: it needs CC0's "+folder" button to have
somewhere to write to, but is otherwise independent of CC2. CC2 last and is
the only phase that changes runtime behavior for existing tools — start it
only after the open questions in §3 have answers.
