# Rama — Workspace Panes Implementation Plan (Changes + Files)

Phases here are numbered **W0–W7** so they never collide with the build phases
0–8 in `docs/IMPLEMENTATION_PLAN.md`, the redesign phases R0–R7 in
`docs/REDESIGN_PLAN.md`, the settings phases S0–S5 in `docs/SETTINGS_PLAN.md`,
the provider phases P0–P6 in `docs/PROVIDERS_PLAN.md`, the tool-layer phases
TL0–TL7 in `docs/TOOL_LAYER_PLAN.md`, the Mission Control phases M0–M6 in
`docs/MISSION_CONTROL_PLAN.md`, or the prompt-stack phases PS0–PS7 in
`docs/PROMPT_STACK_PLAN.md`. Cite these as "WORKSPACE_PANES_PLAN.md Phase W4".

**What this changes.** Mission Control ships today with three panes —
Artifacts, Terminal, Web (`apps/desktop/src/app/mission-control/panes.ts`).
This plan replaces the first and adds a fourth:

| Was | Becomes |
|---|---|
| **Artifacts** — flat list of tool outputs, diff preview | **Changes** — the repo's git status, rail as a folder tree, stage as a per-file diff |
| — | **Files** — the project tree, multiple files open as stage tabs, read-only viewer |

Final tabstrip order, top to bottom: **Changes · Terminal · Web · Files**.
Files sits below Web, as asked. `CommandPalette.tsx:70` indexes
`MISSION_CONTROL_PANES` positionally, so `⌥1–⌥4` renumber themselves with no
chord code change — the array order *is* the keyboard map.

**What this deletes.** `panes/ArtifactsRail.tsx`, `panes/ArtifactsStage.tsx`,
`panes/ArtifactsPaneContext.tsx`, and the `artifacts` entry in the registry.
The artifacts *data model* is untouched — `db/artifacts.ts`, the
`artifact.created`/`artifact.updated` events, `ArtifactDTO`, and every
`createArtifact` call in the ten tools that make them all stay exactly as they
are. Only the surface moves.

---

## 0. Locked decisions

Settled before this plan was written. Everything below assumes them.

1. **Files is a viewer, not an editor.** Tree in the rail, opened files as tabs
   in the stage, read-only, with an **open in external editor** button that
   hands the path to the OS. No CodeMirror/Monaco dependency — the desktop app
   has no editor dependency today (`apps/desktop/package.json`) and this plan
   does not add one. The agent is still the thing that edits files.

2. **Changes is review-only.** Branch, ahead/behind, per-file diffs, folder
   tree, counts. No stage/unstage/discard/commit buttons. Every mutation keeps
   going through the agent's `git_write` tool or the user's own terminal —
   which is one keystroke away in the pane below it. This keeps W3/W4 a pure
   read surface with no destructive-action confirm flows, no optimistic
   staging state, and no divergence from what `git status` actually says.

3. **Artifacts move into the chat transcript, not into another pane.** A tool
   card in `ChatColumn.tsx` becomes expandable and renders its artifact inline.
   **The newest tool card is expanded; every card above it is collapsed.** As a
   run progresses, each card collapses when the next one arrives. This is the
   only reason it is safe to delete the Artifacts pane: today the pane is the
   *only* place artifact content is reachable — tool cards carry
   `artifactId` (`packages/protocol/src/index.ts:246`) but never use it.

4. **The rail/stage primitive is not touched.** Both new panes are registry
   entries (`MissionControlPane`), nothing more. `MissionControl.tsx`,
   `Rail.tsx`, `Stage.tsx`, `Splitter.tsx`, and `useMissionControlGeometry.ts`
   take no structural change. If a phase below wants to edit one of those five
   files, that is a signal the phase is wrong, not that the primitive is.

---

## 1. Ordering rationale

**W0 (extract the diff renderer) is first and is a pure refactor.** Three
places want it by the end of this plan: the chat's tool cards (W1), the Changes
stage (W4), and — as a stretch — the Files viewer's "show diff" toggle. It
currently lives as a private function inside the component that gets deleted in
W2 (`panes/ArtifactsStage.tsx:7 parseDiffLines`). Extracting it before the
deletion, rather than during, keeps the deletion a deletion.

**W1 (artifacts into chat) comes before W2 (delete the pane).** There is never
a commit where artifact content is unreachable. W1 ships with the Artifacts
pane still present and working; W2 removes it once the replacement is proven.

**W2 registers both new panes as stubs in one commit,** exactly as M1 did with
Terminal and Web. The tabstrip's final geometry, the `⌥`-digit map, and the
`activePaneId` localStorage migration all settle once instead of twice.

**W3/W5 are API-only and verifiable with `curl`.** Git status parsing and
filesystem traversal are where the real bugs live (renames, submodules,
symlinks, path escapes, binary files, 200MB logs). Landing them behind HTTP
with no UI means those bugs get found by a request, not by a blank pane.

**W6 (Files pane) is last because it is the least load-bearing.** Changes is
the pane you look at after every run; Files is the pane you look at when you
are curious. If the plan runs out of road, it should run out here.

---

## 2. Rules that hold across every phase

- **Every path from the client is untrusted.** Every route that takes a `path`
  query param resolves it through `resolveInProject`
  (`engine/src/tools/paths.ts`) and returns **400** when it throws. There is no
  second path-safety implementation in this plan.
- **No route ever streams an unbounded file.** Content routes cap, sniff for
  binary, and say so in the response. A 400MB `.pack` must not be able to
  wedge the engine or the renderer.
- **View state is `localStorage`, keyed by `WINDOW_LABEL`.** Which files are
  open, which tab is active, which tree nodes are expanded — the same rule
  `useMissionControlGeometry.ts` already follows. None of it goes in SQLite.
- **The engine never watches the working tree recursively.** A `fs.watch` over
  a project root is a `node_modules`-sized bill. Freshness comes from explicit
  invalidation, focus, and a manual refresh (§6.4).
- **Nothing in this plan blocks on the agent being idle.** Both panes are
  usable mid-run, and both must render correctly when the agent is writing
  files underneath them.

---

## 3. The registry after this plan

`apps/desktop/src/app/mission-control/panes.ts`:

```ts
export type MissionControlPaneId = "changes" | "terminal" | "web" | "files";

export const MISSION_CONTROL_PANES: MissionControlPane[] = [
  { id: "changes",  label: "changes",  Icon: IconChanges,  scope: "project", … },
  { id: "terminal", label: "terminal", Icon: IconTerminal, scope: "project", … },
  { id: "web",      label: "web",      Icon: IconWeb,      scope: "project", … },
  { id: "files",    label: "files",    Icon: IconFiles,    scope: "project", … },
];
```

**Both new panes are `scope: "project"`, not `"chat"`.** This is the single
most consequential line in the diff. Artifacts was chat-scoped — switching
chats emptied it. Changes and Files describe a *repo*: the same working tree,
the same tree of files, no matter which conversation is in front. Switching
between three chats in one project must not reset a diff you were reading or
close four open files. Switching *projects* is what clears them.

Two new icons in `packages/ui/src/components/Icons.tsx`, matching the existing
1.5px-stroke 16px-box set: **`IconChanges`** (a `±`-flavoured mark, not a
branch glyph — this is a diff view, not a branch switcher) and **`IconFiles`**
(a folder/tree mark, distinct from `IconDocs`, which is already the sidebar's
docs route and must not be confusable in a vertical strip of four).
`IconArtifacts` stays exported — nothing else uses it after W2, but deleting a
public export from `@rama/ui` is a separate cleanup, not this plan's business.

### 3.1 Badges

| Pane | Badge |
|---|---|
| Changes | total changed file count; `attention: true` when the repo has conflicts |
| Files | none (`useNullBadge`) — "how many files exist" is not information |

The Changes badge is the answer to "how many changes have been made to the
repo" at a glance, without opening the pane.

---

## 4. Layout

Both panes obey §4.1 of `MISSION_CONTROL_PLAN.md` without amendment: a 36px
action band where the rail header and the stage toolbar sit as one continuous
strip with a shared bottom border, over a flex body.

### 4.1 Changes, wide

```
│ ‹   [± Changes 12] [▸ Terminal 2 ●] [⊕ Web] [⌸ Files]  │ 40
├────────────────────┬───────────────────────────────────┤
│ main ↑2  12  ⟳     │ ChatColumn.tsx   M   +48 −6  ⧉  ↗ │ 36  ONE band
├────────────────────┤───────────────────────────────────┤
│ ▾ apps/desktop/src │  120   const dot = …               │
│   ▾ app            │  121 + const [open, setOpen] = …   │
│      M ChatColumn  │  122 − return (                    │
│         +48 −6     │  123 + return open ? (             │
│      M app-shell.  │                                    │
│         +31 −0     │                                    │
│   ▾ mission-cont…  │                                    │
│      A ChangesRail │                                    │
│         +210 −0    │                                    │
│ ▾ engine/src       │                                    │
│    M server.ts     │                                    │
│       +64 −1       │                                    │
│ ▾ (untracked)      │                                    │
│    ? scratch.md    │                                    │
└────────────────────┴───────────────────────────────────┘
```

**Rail header:** branch · ahead/behind · total changed count · `⟳` refresh.
Detached HEAD renders as `detached @ 3f9a1c`. Mid-merge/mid-rebase renders as
a `⚠ merging` chip — `getRepoState()` in `engine/src/tools/gitShared.ts:37`
already computes exactly this and is reused rather than re-derived.

**Rail body — the folder tree.** Flat paths from git status, grouped into a
directory tree client-side. Rules:

- **Directories with a single child directory collapse into one row**
  (`apps/desktop/src/app/mission-control` as one row, not four levels of
  indent). VS Code calls this compact folders; without it a 384px rail is all
  indentation and no filename.
- **Directory rows carry the aggregate `+N −M`** of everything beneath them,
  and a disclosure triangle. Expanded by default — a change list you have to
  unfold to see defeats the pane. Collapse state is per-path in
  `localStorage`, so a directory you fold stays folded across refreshes.
- **File rows:** status letter (`M` modified · `A` added · `D` deleted ·
  `R` renamed · `?` untracked · `!` conflicted, coloured by
  `var(--good)`/`var(--bad)`/`rgba(var(--ink),0.4)`) · filename · `+N −M` on
  the second line, matching the existing `.rama-artifact-row` two-line
  anatomy so the pane reads as the same family.
- **Renames** render as `newname` with the old path in the row tooltip and a
  `←  oldname` sub-line. `parseStatusPorcelainV2` already joins them as
  `old → new` (`gitShared.ts`); the DTO splits them back into two fields
  (§5.1) rather than making the UI re-parse an arrow out of a filename that
  might legitimately contain one.
- **Untracked files group under a synthetic `(untracked)` root** at the
  bottom, not interleaved with tracked changes. They are noise until they are
  not, and they should be foldable in one click.

**Collapsed rail (44px):** one status-letter glyph per changed file, tooltip =
full path, capped at 12 rows with a `+N` tail row that expands the rail on
click. Same treatment `ArtifactsRail.tsx` gives its rows today.

**Stage:** path · status pill · `+N −M` · `⧉` copy path · `↗` open in external
editor. Body is `DiffView` (W0). A file with *both* staged and unstaged
changes gets a two-segment switch in the toolbar (`unstaged | staged`) — this
is the only place staging appears in the UI, and it is a filter, not an action.

**Empty state:** "working tree clean" plus the branch line. **Non-repo state:**
"not a git repository" plus the project path — the same string
`NOT_A_REPO_MESSAGE` (`gitShared.ts:25`) the `git` tool returns, so the pane
and the agent say the same thing.

### 4.2 Files, wide

```
│ ‹   [± Changes 12] [▸ Terminal] [⊕ Web] [⌸ Files]      │ 40
├────────────────────┬───────────────────────────────────┤
│ files          ⟳   │ panes.ts │ build.ts │ RAMA.md ×  ⧉ ↗│ 36  tabs in the band
├────────────────────┤───────────────────────────────────┤
│ ▾ apps             │   1  import type { FC } from …    │
│   ▾ desktop/src    │   2  import { IconChanges } …     │
│     ▸ app          │   3                               │
│     ▸ engine       │   4  export type MissionCon…      │
│ ▾ engine/src       │   5                               │
│   ▸ agent          │                                   │
│   ▸ tools          │                                   │
│     server.ts      │                                   │
│ ▾ packages         │                                   │
│   ▸ protocol       │                                   │
│   ▸ ui             │                                   │
└────────────────────┴───────────────────────────────────┘
```

**Rail body — the project tree.** Lazily loaded one directory level at a time
(§5.2), directories first then files, both alphabetical, gitignored entries
hidden by default with a `⋯ show ignored` toggle in the rail header's overflow.
Expansion state persisted per project in `localStorage`.

**Stage — the tab strip.** This is the "open multiple files" half of the ask,
and it lives **inside the 36px action band**, horizontally scrollable, with the
file actions (`⧉` copy path, `↗` open externally) pinned right and the tabs
scrolling underneath them. No second row: the band rule from §4.1 of the
Mission Control plan is what makes the whole thing look designed, and a Files
pane that grows a 24px breadcrumb strip breaks the alignment with the rail
header next to it. The full path lives in each tab's tooltip and in the
viewer's empty state.

- Single-click in the tree opens a **preview tab** (italic label) that is
  *replaced* by the next single-click. Double-click, or any edit-adjacent
  action, **pins** it. This is what keeps browsing a tree from ending in
  nineteen open tabs.
- `×` on hover closes; middle-click closes; closing the active tab activates
  its right neighbour, then its left.
- Open tabs + active tab persist per project per window. Reopening Rama on the
  same project restores what you had open; a path that no longer exists is
  dropped silently on restore, not rendered as an error tab.

**Collapsed rail (44px):** the *open files*, not the tree — an extension glyph
per open tab with the filename as tooltip. A collapsed rail should index what
you are working on, not offer a 4-pixel-wide directory tree.

**Viewer:** line-number gutter + monospace body, reusing the
`.rama-diff-line-num` gutter treatment so the two panes' bodies line up
visually. **No syntax highlighting** — see §9.3. A wrap toggle in the overflow.
Binary and oversize files render a one-line stub with the size and the `↗`
button, never a screen of mojibake.

### 4.3 Narrow (< 600px) and collapsed

Neither pane invents behaviour here. Changes stacks rail-over-stage per §4.2 of
the Mission Control plan; Files does the same, with the stage's tab strip
staying in its band. Both use the existing 44px icon rail when collapsed, per
the per-pane rules above.

---

## 5. Data model

No new SQLite tables. Both panes describe the filesystem and the repo, which
are their own source of truth; a `changes` table would only ever be a cache
that is stale by the time anyone reads it — the same argument
`WebPaneContext.tsx` makes for pages having no DB row.

### 5.1 Protocol additions — `packages/protocol/src/index.ts`

```ts
// WORKSPACE_PANES_PLAN.md §5.1 — the Changes pane's wire shape (Phase W3).
export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface ChangeEntryDTO {
  /** Repo-relative, forward-slashed, never absolute. */
  path: string;
  /** Set only when `status === "renamed"` — the pre-rename path. */
  origPath: string | null;
  status: ChangeStatus;
  /** A path can be both: edited, staged, then edited again. */
  staged: boolean;
  unstaged: boolean;
  /** null for binary files, and for every entry when `countsOmitted` is set. */
  added: number | null;
  removed: number | null;
  binary: boolean;
}

export interface ChangesDTO {
  isRepo: boolean;
  branch: string | null;
  detached: boolean;
  head: string | null;          // short sha, for the detached-HEAD label
  upstream: string | null;
  ahead: number;
  behind: number;
  midMerge: boolean;
  midRebase: boolean;
  entries: ChangeEntryDTO[];
  /** True when the repo was too dirty to price (§6.2) — the UI hides all counts. */
  countsOmitted: boolean;
}

export interface ChangeDiffDTO {
  path: string;
  /** Unified diff text, already stripped of the `diff --git`/`index` preamble. */
  diff: string;
  binary: boolean;
  truncated: boolean;
}

// WORKSPACE_PANES_PLAN.md §5.2 — the Files pane's wire shape (Phase W5).
export interface FileEntryDTO {
  name: string;
  /** Repo-relative path of this entry, forward-slashed. */
  path: string;
  kind: "dir" | "file" | "symlink";
  size: number | null;   // null for dirs
  ignored: boolean;      // gitignored or in EXCLUDE_DIRS — hidden unless asked for
}

export interface FileContentDTO {
  path: string;
  content: string;       // "" when binary or oversize
  size: number;
  lines: number;
  binary: boolean;
  truncated: boolean;
}
```

### 5.2 Engine routes

Added to `engine/src/server.ts` in the same `pathname.match(...)` style as
every route around them, each resolving `projectId` through
`getProject(id)` (`engine/src/db/projects.ts:39`) and 404-ing when it is null.

| Route | Returns | Notes |
|---|---|---|
| `GET /projects/:id/changes` | `ChangesDTO` | the whole status in one round trip |
| `GET /projects/:id/changes/diff?path=&staged=0\|1` | `ChangeDiffDTO` | one file |
| `GET /projects/:id/files?path=<rel>` | `{ entries: FileEntryDTO[] }` | **one level**, not recursive; `path` omitted = project root |
| `GET /projects/:id/files/content?path=<rel>` | `FileContentDTO` | capped, binary-sniffed |

Client wrappers land in `apps/desktop/src/engine/client.ts` next to the
terminal block, following the existing `engineJson` pattern.

### 5.3 WS events

One new project-scoped event on the existing `project:{id}` topic
(`engine/src/ws.ts:29 broadcastProject`, already wired, already subscribable
via `ClientCommand.subscribeProject`):

```ts
| { type: "changes.invalidated"; projectId: string }
```

Deliberately a **bare invalidation, not a payload.** Broadcasting a whole
`ChangesDTO` on every file write means computing git status on every edit even
when no window has the pane open. The client refetches on receipt, debounced —
the same shape `broadcastThemes()` already uses for theme reloads.

---

## 6. The engine surface

### 6.1 `GET /projects/:id/changes`

Lives in a new `engine/src/git/status.ts` — **not** in `engine/src/tools/`,
which is the agent's tool surface, not an HTTP module. It imports
`getStatus`, `getRepoState`, `isGitRepo`, and `runGit` from
`engine/src/tools/gitShared.ts` and adds nothing to that file. The porcelain-v2
parser there is already correct about renames, conflicts, and NUL framing;
this plan does not write a second one.

Composition, in one `Promise.all`:

1. `getStatus(projectPath)` — branch, upstream, ahead/behind, the four buckets.
2. `git diff --numstat -z` — unstaged line counts.
3. `git diff --cached --numstat -z` — staged line counts.
4. Untracked files: one `git diff --no-index --numstat -z -- /dev/null <path>`
   per file, **capped at 200 files**, run with a concurrency of 8. Beyond the
   cap, untracked entries come back with `added: null`.

Merged by path into `ChangeEntryDTO[]`. A path appearing in both the staged and
unstaged buckets produces **one** entry with both flags true and both count
sets summed — the rail shows files, not index states.

`status` derives from the porcelain code, with **conflicted winning over
everything** (a `u` record is a conflict first and a modification second).

### 6.2 The dirty-repo escape hatch

A `--numstat` over 4,000 changed files (a fresh `node_modules` commit, a
generated-code repo, a bad `git checkout`) is seconds of work for a sidebar.
When `getStatus` reports more than **500** changed paths, the route skips
steps 2–4 entirely and returns `countsOmitted: true` with every count `null`.
The rail then renders names and status letters only. Slow is a bug; missing
line counts on a 4,000-file diff is a fact.

### 6.3 `GET /projects/:id/changes/diff`

- Tracked, unstaged: `git diff -- <path>`
- Tracked, staged: `git diff --cached -- <path>`
- Untracked: `git diff --no-index -- /dev/null <path>` — **exit code 1 is the
  success case** for `--no-index` when files differ; anything else is an error.
- Deleted: falls out of the tracked case correctly, no special handling.

The `diff --git` / `index` / `---` / `+++` preamble is stripped server-side so
`DiffView` receives hunks only, exactly the shape it already parses. Capped at
**400KB** via `headTailTruncate` (`engine/src/tools/truncate.ts`), which the
`git` tool already uses for the same purpose. Binary files short-circuit to
`{ binary: true, diff: "" }` before any of this.

### 6.4 Freshness — who tells the pane it is stale

Three signals, no filesystem watcher over the working tree:

1. **`changes.invalidated` from the engine**, broadcast from exactly two
   places: `engine/src/tools/mutate.ts` (the single funnel every mutating tool
   already goes through — it has `ctx.projectId` at `tools/types.ts:58`) and
   `engine/src/tools/gitWrite.ts` (stage/commit/checkout/restore/stash change
   status without touching a file through `mutate`). The `/chats/:id/undo`
   route broadcasts too, since a checkpoint restore rewrites the tree wholesale.
2. **Window focus and pane activation** — refetch on both. This is what catches
   edits the user made in their own editor or the Terminal pane.
3. **The `⟳` in the rail header** — the honest fallback, and the thing to point
   at when someone asks why their external `git add` did not show up instantly.

**Optional, and cheap enough to include in W3:** a non-recursive `fs.watch` on
`<project>/.git` alone — not the working tree. It fires on `index`, `HEAD`, and
`ORIG_HEAD` changes, which is every git operation the user runs in a terminal,
for the cost of watching one directory. Debounced 250ms into the same
`changes.invalidated` broadcast. If it proves noisy on any platform, delete it;
signals 1–3 stand on their own.

### 6.5 The Files routes

`engine/src/files/browse.ts`:

- **Listing** is `readdirSync(dir, { withFileTypes: true })` on the resolved
  directory — one level, never recursive. `EXCLUDE_DIRS` and `listIgnoredDirs`
  (`engine/src/tools/projectFiles.ts`) mark entries `ignored: true`; the client
  filters them by default. `listIgnoredDirs` results are memoized per project
  for 30 seconds — it shells out to `git ls-files` and would otherwise run on
  every directory expansion.
- **Symlinks** report `kind: "symlink"` and are **never followed** for
  listing. A symlink to `/` inside a project would otherwise make the tree
  infinite; a symlink out of the project would make `resolveInProject`'s
  guarantee a lie. Clicking one opens its *target's* content only if the
  resolved real path is still inside the project, and errors 400 otherwise.
- **Content** caps at **2MB** and sniffs the first 8KB for a NUL byte to set
  `binary`. Both cases return `content: ""` with the flags set; the renderer
  shows the stub from §4.2. Over the cap, `truncated: true` with the first 2MB
  — a 40MB log should be *previewable*, not an error.
- Directory-traversal defence is `resolveInProject` and nothing else. A path
  that escapes throws, and the route maps the throw to **400**, never to a 500
  with a stack.

### 6.6 Open in external editor

`@tauri-apps/plugin-opener` is already a dependency and already used
(`Sidebar.tsx:5` imports `revealItemInDir`). The `↗` button calls `openPath`
with `join(project.path, relPath)`, handing the file to the OS default handler
for its type. No `$EDITOR` resolution, no config surface, no per-user editor
preference — the OS already owns that mapping, and adding a second one is a
settings screen nobody asked for. `revealItemInDir` on the same path goes in
the overflow as "reveal in Finder".

---

## 7. The chat surface (where artifacts go)

`apps/desktop/src/app/ChatColumn.tsx:122 ToolCallCard` gains a body.

**Expansion is derived, with a manual override.** The rule:

- The **last tool call in the transcript** is expanded.
- Every card above it is collapsed.
- A user click on any card's header writes `{ [callId]: boolean }` into a
  `Record` in `ChatColumn` state. That override wins over the derived rule
  forever after, for that card. Auto-collapse must never fight a card the user
  deliberately opened — that is the whole difference between this behaving like
  a live log and behaving like a fidget toy.

**What the body renders**, given `toolCall.artifactId`:

| Case | Source |
|---|---|
| artifact still streaming | `artifactBuffers[artifactId]` from `SessionProvider` — already in memory, already live, no fetch |
| artifact done | `fetchArtifactContent(artifactId)`, fetched **on first expand**, memoized per card |
| `kind: "diff"` | `DiffView` (W0) |
| everything else | the same `<pre>` treatment `ArtifactsStage` uses today |
| `artifactId === null` | header only — no body, no chevron, no empty expander |

Capped at ~320px with internal scroll. Beyond that, the chat column becomes a
file viewer, and there is now a Files pane for that.

**`ClarifyCard` is untouched.** It already renders its own body
(`ChatColumn.tsx:78`) and is not an artifact.

---

## 8. Phases

### Phase W0 — Extract the diff renderer

Pure refactor. Nothing visible changes.

| File | Change |
|---|---|
| `apps/desktop/src/app/diff/DiffView.tsx` | **new** — `parseDiffLines` + the row markup, lifted verbatim from `panes/ArtifactsStage.tsx:7–90` |
| `apps/desktop/src/app/mission-control/panes/ArtifactsStage.tsx` | imports `DiffView`, drops its local copy |
| `app-shell.css` / `mission-control.css` | `.rama-diff-*` rules stay where they are; only the comment moves |

`DiffView` takes `{ diff: string }` and nothing else. It does not fetch, does
not know about artifacts, and does not know about git.

### Phase W1 — Artifacts into the chat transcript

The Artifacts pane still exists and still works after this phase.

- `ChatColumn.tsx`: `ToolCallCard` gains the expand/collapse body per §7,
  including the derived-latest rule and the override map.
- `app-shell.css`: `.rama-tool-call-body`, the chevron, the 320px cap.
- No protocol change, no engine change. `ToolCallDTO.artifactId` and
  `SessionProvider`'s `artifactBuffers` are both already there.

**Done when:** a `grep` run mid-stream shows its matches inline in the newest
card, and the card above it has collapsed on its own.

### Phase W2 — Delete the Artifacts pane, register both stubs

| File | Change |
|---|---|
| `mission-control/panes/ArtifactsRail.tsx` | **delete** |
| `mission-control/panes/ArtifactsStage.tsx` | **delete** (after W0 harvested `DiffView`) |
| `mission-control/panes/ArtifactsPaneContext.tsx` | **delete** |
| `mission-control/panes.ts` | `artifacts` → `changes`; append `files`; `useArtifactsBadge` → `useChangesBadge` (stubbed to `null` until W4) |
| `mission-control/panes/ChangesStage.tsx`, `FilesStage.tsx` | **new** — one-line "coming in W4 / W6", `rama-mc-coming-soon` |
| `mission-control/panes/ChangesRail.tsx`, `FilesRail.tsx` | **new** — empty stubs |
| `packages/ui/src/components/Icons.tsx` | `IconChanges`, `IconFiles` |
| `useMissionControlGeometry.ts` | `MissionControlPaneId` union; **migration**: a persisted `activePaneId: "artifacts"` maps to `"changes"` on load |
| `mission-control.css` | `.rama-artifact-row` / `.rama-artifact-preview-*` retitled and kept — W4 reuses the row anatomy |

**The migration is not optional, and its failure mode is nasty.** `load()`
merges persisted JSON over `DEFAULTS`, so an existing window's `"artifacts"`
survives the union change untouched. `MissionControl.tsx` then falls back to
`MISSION_CONTROL_PANES[0]` — which is Changes, so the panel *renders* fine and
even highlights the Changes tile. But `geometry.activePaneId` is still
`"artifacts"`, so `handleTabClick("changes")` takes the
`paneId === activePane.id` branch and **collapses the whole panel** instead of
selecting the pane: clicking Changes closes Mission Control, and there is no
tile that reopens it on Changes. Map `"artifacts"` → `"changes"` in `load()`.

### Phase W3 — Git read API

No UI. Verifiable with `curl`.

- `engine/src/git/status.ts` — `readChanges(projectPath)`, `readDiff(...)` per
  §6.1/§6.3.
- `engine/src/server.ts` — the two `/projects/:id/changes*` routes.
- `packages/protocol/src/index.ts` — `ChangeStatus`, `ChangeEntryDTO`,
  `ChangesDTO`, `ChangeDiffDTO`, `changes.invalidated`.
- `engine/src/tools/mutate.ts` + `gitWrite.ts` + the undo route —
  `broadcastProject(projectId, { type: "changes.invalidated", projectId })`.
- `apps/desktop/src/engine/client.ts` — `fetchChanges`, `fetchChangeDiff`.
- Optional: the `.git`-only `fs.watch` from §6.4.
- **Tests** (`engine/src/git/status.test.ts`, the pattern
  `tools/patch.test.ts` uses): a temp repo exercising modified, added,
  deleted, renamed, untracked, staged-and-unstaged-same-file, a file with a
  space and one with `→` in its name, binary, and not-a-repo.

### Phase W4 — Changes pane

- `panes/ChangesPaneContext.tsx` — fetch + refresh policy (§6.4), selected
  path, staged/unstaged view flag, the flat-to-tree transform with compact
  folders, per-path fold state in `localStorage`.
- `panes/ChangesRail.tsx` — header (branch, ahead/behind, count, `⟳`), the
  tree, the collapsed 44px strip, empty/non-repo/conflict states.
- `panes/ChangesStage.tsx` — toolbar + `DiffView` + the staged/unstaged switch.
- `panes.ts` — real `useChangesBadge` (count + `attention` on conflicts).
- `mission-control.css` — `.rama-changes-*` rows, tree indentation, status
  letter colours.

**Done when:** a run that edits four files across three directories leaves the
tab badge reading `4`, the rail showing three folded directories with
aggregate counts, and clicking any file rendering its diff — with no manual
refresh.

### Phase W5 — Files API

- `engine/src/files/browse.ts` — `listDirectory`, `readFileContent` per §6.5,
  including the symlink and memoization rules.
- `engine/src/server.ts` — `/projects/:id/files` and `/files/content`.
- `packages/protocol/src/index.ts` — `FileEntryDTO`, `FileContentDTO`.
- `apps/desktop/src/engine/client.ts` — `fetchProjectFiles`,
  `fetchProjectFileContent`.
- **Tests**: path escape (`../../etc/passwd`, an absolute path, a symlink out
  of the project), a binary file, a 3MB file, an ignored directory, a
  directory with 5,000 entries.

### Phase W6 — Files pane

- `panes/FilesPaneContext.tsx` — lazy tree state, expansion set, open tabs,
  preview-vs-pinned, active tab, all persisted per project per window.
- `panes/FilesRail.tsx` — the tree, the ignored toggle, the collapsed strip of
  open files.
- `panes/FilesStage.tsx` — the in-band tab strip, the viewer, `⧉`/`↗`, the
  binary/oversize stub, the wrap toggle.
- `mission-control.css` — `.rama-files-*`, `.rama-file-tab*`.

**Done when:** four files are open as tabs, closing the active one activates
its neighbour, `↗` opens the file in the OS editor, and a restart restores all
four.

### Phase W7 — Polish (can slip, blocks nothing)

- Non-git projects: Changes falls back to `checkpointer.diffSince(run-start)`
  (`engine/src/checkpoints/index.ts:99`) so the pane still answers "what did
  this run change" in a directory with no `.git`. Labelled **"since this run
  started"**, never as git status — the two must not be confusable.
- A base selector in the Changes header: `working tree` · `staged` ·
  `since run start` · `vs <branch>`.
- Cross-pane links: a changed file in the Files tree gets its status letter;
  its toolbar grows a `diff` toggle that swaps the viewer for `DiffView`.
  Clicking a path in a chat tool card opens it in Files.
- Palette entries: "show changes", "open file…" (fuzzy over
  `listProjectFiles`), "refresh changes".

---

## 9. Risk register

1. **The `activePaneId` migration (W2).** Described in full in the phase — the
   failure mode is silent and looks like a cosmetic bug (no active tile) rather
   than a state bug. Write the migration in the same commit as the union change.

2. **`--numstat` on a huge working tree (W3).** Mitigated by the 500-file cap
   in §6.2. The number is a guess; measure once on a real repo before treating
   it as tuned.

3. **Refresh storms during a run (W4).** A run that edits forty files fires
   forty `changes.invalidated` events, each triggering a `git status` +
   `--numstat` pass. Debounce the client refetch at **250ms trailing**, and
   skip it entirely while the Changes pane is not the active pane — refetch on
   activation instead. Without this, an active run makes the whole app
   stutter to keep a sidebar honest.

4. **Files tree on a monorepo root.** `apps/`, `engine/`, `packages/`,
   `node_modules/`, `target/` — lazy per-level loading keeps this fine, but a
   user expanding `node_modules` still gets a 5,000-entry `readdirSync`. Cap
   the listing at 1,000 entries with a "+N more" tail row; `node_modules` is
   `ignored: true` and hidden by default anyway.

5. **Deleting the pane deletes the only artifact surface (W1/W2).** The
   ordering is the mitigation — W1 must ship and be used before W2 lands. If
   W1 slips, W2 slips with it; they are not independent.

6. **Two panes, one scope switch.** Both new panes are project-scoped, and
   nothing in Mission Control currently clears project-scoped state on project
   switch (`MISSION_CONTROL_PLAN.md` §3.3's scope table is declared but "not
   yet enforced anywhere", per `panes.ts`'s own comment). W4 and W6 each need
   their context to key state by `activeProjectId` and reset on change, or a
   project switch leaves you reading the previous repo's diff. This is the
   first time that unenforced scope column actually costs something.

### On syntax highlighting

Deliberately out of scope, twice over: the desktop app has no highlighter
dependency, and a highlighter is a *theme* decision in an app whose entire
identity is nine hand-built palettes (`packages/ui/src/themes`). Shipping
Prism's default light theme inside a Rama theme would look worse than plain
monospace, not better. If it lands later it wants its own small plan: a
tokenizer choice, a token→CSS-variable map per theme, and a decision about
whether `DiffView` highlights too. Not W6's business.

---

## 10. Open questions

1. **Does Changes show *only* the working tree, or also unpushed commits?**
   The header says `↑2` today, which raises the question and does not answer
   it. A "2 unpushed commits" section above the file tree, each expandable to
   its own diff, is a natural W7 addition — and is also how this pane stops
   being "git status" and starts being "review". Left out of W4 on purpose.

2. **Should a file open from the Changes tree land in the Files pane's tabs?**
   Argument for: one set of open files, one mental model. Argument against:
   Changes' stage *is* the diff view, and bouncing to another pane to read a
   file you just clicked is worse. Currently planned as: they stay separate,
   with the W7 cross-links as the bridge.

3. **Preview tabs — right call?** They keep tree-browsing from ending in
   nineteen tabs, but they also surprise people who do not know the
   convention. Worth watching once W6 is in hand.

4. **Should the Files viewer be reachable at all when the Changes pane could
   show the same file?** If the answer turns out to be "rarely", Files is
   better as a *picker* (fuzzy-find, open in editor) than as a viewer, and W6
   should shrink accordingly. Do not answer this before W4 has been used for a
   week.
