# Rama: Code Tab Redesign Plan

The phases here are **CR0–CR9**. The prefix keeps them clear of the existing
plans: build 0–8 (`IMPLEMENTATION_PLAN.md`), redesign R0–R7 (`REDESIGN_PLAN.md`),
settings S0–S5, providers P0–P6, Mission Control M0–M6, workspace panes W0–W7,
composer context CC0–CC2, chat view CV0–CV6, and the rest. Cite a phase as
"CODE_REDESIGN_PLAN.md Phase CR4".

**Source of truth.** `docs/Rama/home-redesign.html`, the Code half: open it with
`#code`, or click the **Code** segment. "Pixel-perfect" means the same measurements,
type, colour derivations, radii, shadows and motion as that file's CSS, at the
same window size, in every theme. Where this plan and the mockup disagree, the
mockup wins, except where §9 lists a deliberate deviation. Mockup references below
are `mock:LINE`, for example `mock:513` for `.ws`.

**What this document owns.** Everything the main window shows while the sidebar's
**Code** segment is active, plus all of a popped-out (secondary) window. That is
the sidebar's Code list, the topbar, the Code composer, the transcript, the Code
landing (new chat), and the workspace panel with its four panes. It also covers
the protocol and engine additions those surfaces need.

**What it does not own.** The Home tab is being rebuilt from scratch in a parallel
track, here called "HR". HR owns the Home landing, the Home transcript, the Home
date-grouped history, the theme seal's popover (theme grid, text size, reply font),
and anything theme-engine-behavioural. Both tracks share a foundation layer (§3).
That section is the coordination contract and needs agreement before either track
writes shell code.

---

## 0. Current state (2026-10-05)

- **Fonts and tokens.** The app is all-monospace: JetBrains Mono for the body,
  Martian Mono for display, DM Mono for code, loaded from Google Fonts in
  `apps/desktop/index.html`. Tokens live in `packages/ui/src/tokens.css`.
  `seedTokens()` (`packages/ui/src/themes.ts`) writes `--ink` as an `"R, G, B"`
  triplet that's consumed as `rgba(var(--ink), a)` all over the app. The type ramp
  is `--fs-micro…--fs-xl` (9–16px, used 155 times).
- **Shell.** `AppShell.tsx` renders `WallpaperStack` (dot field, image, veil,
  vignette, accent wash, grain) under the whole window. On top of that sit
  `Sidebar.tsx`, a frosted 46px `Titlebar.tsx`, and the `.rama-body` grid of
  `ChatColumn` plus `MissionControl`.
- **Sidebar.** `Sidebar.tsx` (617 lines) has the header buttons, an inline search,
  the Home/Code view tabs, nav rows with counts (Docs n, Toolbox "n tools · n mcp"),
  collapsible project groups with a branch label and a `⋯` menu, and chat rows with
  a `⋯` menu and an owned-elsewhere `⧉`. The footer has an account button and a
  cycle-theme button.
- **Chat column.** `ChatColumn.tsx` is 1,276 lines and does everything:
  - a header with a `⌂ project › ⑂ branch` crumb and a ctx meter
  - a terminal-style transcript (`❯` user lines, `◆` assistant glyph, `●`/`⎿` tool cards)
  - a `<details>` thinking block
  - an inline permission box (approve/deny)
  - a busy status line (`✻ Verb… (12s · ↓ N tokens)`)
  - the composer: pills row, `❯` textarea, and a rail of mode tile, `ModelPicker`,
    `AgentPicker` and hint
  - the slash-search menu
- **Mission Control.** `mission-control/MissionControl.tsx` has a 40px vertical tile
  strip on the window's right edge that doubles as the open/close control. It has
  the edge splitter, `Stage` + `Rail` (rail resizable, 44px collapsed), and four
  panes (Changes, Terminal, Web, Files), each with its own context provider, Rail,
  Stage and RailActions. The panes' data layers (`*PaneContext.tsx`) are solid and
  stay as they are. Their views get restyled.
- **Data available today.**
  - `ChatBlock` timeline per message: thinking, text, and tool callId.
  - `ToolCallDTO.resultSummary` already speaks a parseable dialect: `+N −M` for
    edit/write, `created · N lines`, `exit N · L lines`, `N of M lines`,
    `opened <url>`, `committed`, `no changes to review`.
  - `todo.updated` events carry the plan list.
  - `approvePermission` is a boolean, and the gate is per request only.
  - Only the active chat is subscribed over WS, so other chats' permission waits
    are invisible to the sidebar.
- **Window.** 1440×900 default, `minWidth: 860`, `titleBarStyle: Overlay`,
  `trafficLightPosition {x:16, y:25}` (kept in sync in `src-tauri/src/drag.rs`).
  The webview is WKWebView, which supports `color-mix(in oklab)`, `:has()`,
  `text-wrap: balance` and `-webkit-mask-image`.

---

## 1. Target, in one paragraph

The window gets a 272px sidebar on an opaque `--sidebar` ground. On the right is a
`.main` region carrying the theme wallpaper and veil, a transparent 52px topbar, and
a tilted kanji **seal** stamped at its top-right. In Code, `.main` holds a chat
column (`min(700px, 100%)` wide, centred) and, across a 12px invisible splitter,
the **workspace**. The workspace is a rounded "paper" panel (radius 16,
`--panel`, 48% wide by default) with text tabs (Changes 4 · Terminal ● · Web ·
Files), a shared 42px band row (stage toolbar and rail header), a `--code-bg` stage
and a 212px rail that collapses to 48px. The transcript reads like the Home tab:
right-aligned tinted user bubbles, Literata 17px replies, and tool calls as
plain-language rows ("Edited **theme.tsx** +14 −1") that expand into an inline diff
or output with an "Open in Changes →" link. Special cards cover the Plan
checklist, "Changed N files", and a warn-tinted permission ask. The composer is a
20px-radius raised card with context chips, a mode pill, a model pill with a
lock/cloud icon, and a round accent send button. Under it, a privacy line and a
context ring. Monospace survives only in diffs, code views, terminal output, and
inline code/path pills.

---

## 2. Principles for this rebuild

1. **Copy the mockup's CSS verbatim wherever possible.** New stylesheets reuse the
   mockup's class vocabulary (`.composer`, `.act-btn`, `.ws-tab`, `.rrow` …) with
   its exact values. Matching names make the parity diff (CR1) a line-by-line
   comparison instead of an archaeology job. React components own markup, and CSS
   lives in plain `.css` files next to them, as in the rest of the app.
2. **Pure view components, thin containers.** Every new block (an act row, the
   plan card, a rail row) takes plain props. Containers adapt `SessionProvider`,
   `ProjectsProvider` and the pane contexts into those props. This is what makes
   the fixture harness (CR1) possible and keeps `ChatColumn`'s 1,276 lines from
   reappearing.
3. **Keep every data layer.** `SessionProvider`, `ProjectsProvider`,
   `WindowTabsProvider`, the four `*PaneContext`s, `useTerminalSession`,
   `useWebviewVisibility`, `AgentTerminalBridge`/`AgentWebBridge`, the draft/
   promote flow, the worktree and extra-roots persistence, and slash search all
   survive unchanged unless a phase says otherwise.
4. **No behaviour regressions hidden behind a restyle.** Every control the current
   Code tab has (delete chat, rename project, reveal in Finder, staged/unstaged
   switch, word wrap, kill terminal, close page, `/undo`, Esc-to-stop, ⌘K actions)
   keeps an entry point. §9 says where each one lands when the mockup has no slot
   for it.

---

## 3. Shared foundation contract (Code ⇄ Home)

> **Resolved 2026-10-05: the Home chat builds the foundation.** `docs/HOME_REDESIGN_PLAN.md` §3 and
> HD0/HD1 own the fonts, tokens, icons, buttons and menus, shell frame, seal and popover,
> composer shell, model menu and transcript primitives. This plan imports them. The table below
> is kept for the reasoning, but where its *Owner* column says "Code" for one of those rows, read
> "Home". Code still owns what Home's §3 leaves to it: the Code sidebar list
> (`app/code/CodeChatList.tsx`), crumbs and top actions, the context chips, the mode pill and
> menu, the ring, every Code transcript block, diffs and terminal output, and the workspace.
>
> **Naming key.** Where this plan names a shared piece, use Home's name:
>
> | This plan says | Use (Home kit) |
> |---|---|
> | `tokens-v2.css` | `packages/ui/src/kit/tokens.css` |
> | `--ink-2: var(--text-1)` (no `--ink`) | `--ink-c` (hex), `--ink-2: var(--ink-c)` |
> | mockup ramp `--fs-xs … --fs-hero` | `--k-xs … --k-hero` (legacy `--fs-*` is **not** renamed) |
> | `.v2` root class, unprefixed mockup classes | `.r-app` root, `r-` prefixed classes |
> | `primitives-v2.css`, `components/Icon.tsx` | `kit/buttons.css`, `kit/Icon.tsx` |
> | `app/composer/ComposerBase.tsx` | `kit/Composer.tsx` (with `above` / `tools` slots) |
> | `app/transcript/*` primitives | `kit/transcript/*` (with `body` / `hidden` slots) |
> | Code owns the `--fs-*` → `--lfs-*` rename (CR0 step 2) | dropped |
>
> Everything from CR2 on that says "port verbatim" still holds. Apply Home's `r-` prefix to the
> class names when porting.

Both tabs render inside one shell. The Home track rebuilds Home "from scratch", but
it can't fork the shell without the two tabs drifting apart within a week. Below is
the proposed split. **Hand this section to the Home chat before either track
starts CR0/CR2-equivalent work.**

| Surface | Files (proposed) | Owner | Other track |
|---|---|---|---|
| Tokens v2, type ramp, fonts | `packages/ui/src/tokens-v2.css`, `apps/desktop/public/fonts/*` | **Code (CR0)** | consumes |
| Icon set (mockup `<symbol>`s) | `packages/ui/src/components/Icon.tsx` | **Code (CR0)** | consumes, may add icons |
| Base primitives (`.btn*`, `.icon-btn`, `.chip`, `.pop`, `.mp-item`, `.mini`, `.mini-seg`, `.card`, `.code-card`) | `packages/ui/src/primitives-v2.css` | **Code (CR0)** | consumes |
| Shell frame: `.app`, sidebar frame (top bar, Home/Code seg, nav, footer), `.main` + wall/veil, topbar frame, seal *button* mount | `apps/desktop/src/app/shell/*` | **Code (CR2)** | fills the Home slots |
| Sidebar *list* content | `shell/SidebarCodeList.tsx` / `SidebarHomeList.tsx` | each track its own | n/a |
| Seal popover (theme grid, Text size, Reply font) and theme scope (global vs per-chat) | `shell/AppearancePopover.tsx`, `packages/ui/src/theme.tsx` | **Home** | Code only mounts the seal |
| Composer base (card, autosize textarea, attach button, model pill and menu, send, privacy line) | `app/composer/ComposerBase.tsx`, `ModelMenu.tsx` | **Code (CR5)** | Home adds the web-search toggle slot |
| Act row primitive (`.acts`, `.act-btn`, `.act-body`), prose, user bubble, turn actions, working row | `app/transcript/*` | **Code (CR6)** | Home reuses it for "Read lease.pdf" / "Searched the web" rows |
| Home landing, Home transcript, resume rows on Home | `app/home/*` | **Home** | n/a |

Rules:

- **Whoever lands a shared file first owns its API.** The other track adapts rather
  than forking. Shared CSS class names are exactly the mockup's.
- Neither track edits the other's list or landing files.
- The legacy `--fs-*` rename (CR0) is a single mechanical commit. Announce it
  before landing, because it touches every legacy CSS file.

---

## 4. Token and type mapping (CR0 detail)

The mockup's `:root` (mock:20–75) can mostly be copied as-is. Only two names
collide with the live system.

**`--ink`.** The mockup uses it as a hex colour inside formulas. The app uses it as
an `R, G, B` triplet in about 300 `rgba(var(--ink), …)` calls. *Resolution:*
tokens-v2 never defines `--ink`. It defines `--ground: var(--bg-base)` and
`--ink-2: var(--text-1)` (`--text-1` is already the theme's ink hex), and every
mockup formula that reads `var(--ink)` reads `var(--ink-2)` instead:

```css
--ink-1: var(--ink-hi);               /* already the theme's inkLoud hex */
--ink-2: var(--text-1);
--ink-3: color-mix(in oklab, var(--ink-2) 70%, var(--ground));
--ink-4: color-mix(in oklab, var(--ink-2) 50%, var(--ground));
--line:   color-mix(in oklab, var(--ink-2) 11%, transparent);
--line-2: color-mix(in oklab, var(--ink-2) 19%, transparent);
--hover:  color-mix(in oklab, var(--ink-2) 6%,  transparent);
/* …the rest verbatim from mock:42-48, with var(--ink) → var(--ink-2) */
```

Mode blocks key on the existing `:root[data-rmode="light|dark"]` (the mockup uses
`data-mode`). `--sidebar`, `--raised`, `--well`, `--bubble`, `--panel`,
`--code-bg`, `--shadow-sm`, `--shadow` and `--shadow-pop` are copied verbatim from
mock:50–75. `--good`, `--warn` and `--bad` already come from `seedTokens` with the
same per-theme overrides the mockup's `SEMANTIC` table encodes, so they're not
redefined.

**`--fs-*`.** The values differ: mockup 12/13.5/15/17/21/28/44, legacy 9–16. *Resolution:*
rename the legacy ramp to `--lfs-micro…--lfs-xl` with one mechanical `sed` across
`app-shell.css`, `mission-control.css`, `primitives.css`, and the inline
`var(--fs-…)` strings in `.tsx` (155 sites). The mockup names then become the real
ramp:

```css
--scale: var(--font-scale);
--fs-xs: calc(12px * var(--scale));   --fs-sm: calc(13.5px * var(--scale));
--fs-md: calc(15px * var(--scale));   --fs-read: calc(17px * var(--scale));
--fs-lg: calc(21px * var(--scale));   --fs-xl: calc(28px * var(--scale));
--fs-hero: calc(44px * var(--scale));
```

The Text size steps (mockup: 0.92 / 1 / 1.1, today: 0.9 / 1 / 1.12 / 1.25) are
HR's decision, because they live in the seal popover. Code only reads `--scale`.

**Wallpaper names.** The mockup's `--wp-pos` is the live `--wp-position`. Use the
live name.

**Fonts.**

```css
--f-ui:   "Instrument Sans", ui-sans-serif, system-ui, -apple-system, sans-serif;
--f-read: "Literata", "Shippori Mincho", Georgia, serif;
--f-code: "JetBrains Mono", ui-monospace, "SF Mono", monospace;
--f-seal: "Shippori Mincho", "Hiragino Mincho ProN", serif;
```

**Self-host the fonts** as woff2 files in `apps/desktop/public/fonts/` with
`@font-face`, instead of fetching them from Google. Rama is offline-capable, and the
composer literally promises "Nothing you send leaves it". A font request to Google
on every launch is a bad look next to that. You need:

- Instrument Sans as the variable font (400–700, plus italic)
- Literata as the variable font (opsz 7–72, weight 300–700, plus italic)
- JetBrains Mono 400 and 500
- Shippori Mincho 600, subset to the nine theme kanji: 波神奈川墨桜椿朱若葉松緑青

Drop Martian Mono and DM Mono once nothing legacy references them (CR9).

**Wallpaper layer.** In the mockup, wall and veil are confined to `.main`
(mock:167–169). The sidebar is opaque `--sidebar`, and there's no dot field,
vignette, accent wash or grain. CR0 adds `<MainWall/>` (two divs: `.wall` and
`.veil`) for `.main`. CR2 stops mounting `WallpaperStack` in the redesigned shell.
Retiring the texture layers app-wide is a shared decision (§10, Q2).

---

## 5. Phases

Each phase is shippable on its own and ends with a parity check against the mockup
(CR1's harness). "Acceptance" lists what must visibly match.

### CR0: Shared foundation (superseded: built by Home as HD0/HD1)

Not built by this track. See the resolution at the top of §3. What CR0 would have produced
(tokens, self-hosted fonts, icons, base primitives, wallpaper layers) is HD0, and the shell
frame is HD1. **Code's first dependency is HD0 plus the kit half of HD1.** Until they merge, Code
work stays on things that don't touch the kit: CR1 (done), then the workspace frame, the diff
view and the terminal surface (CR3 and the Changes/Terminal parts of CR4).

### CR1: Parity harness (built 2026-10-06)

**Goal.** Make "pixel-perfect" checkable: the real React components render the mockup's exact
demo content, and screenshots can be diffed.

**What exists** (all dev-only; none of it is in `vite build`):

| File | Role |
|---|---|
| `apps/desktop/fixture.html`, `src/fixtures-entry.tsx` | A second Vite entry. It installs the fakes, then imports `App` dynamically. `index.html` and `main.tsx` are untouched. |
| `src/app/fixtures/install.ts` | Reads the URL, freezes the clock to the mockup's (Mon 5 Oct 2026, 18:30), seeds `localStorage`, installs the fakes. |
| `src/app/fixtures/tauriShim.ts` | Replaces `__TAURI_INTERNALS__.invoke` and the event bus. Works in a plain browser and inside a Tauri window (where it never spawns a PTY or a native webview). |
| `src/app/fixtures/mockEngine.ts` | In-memory engine: answers `fetch` to `http://rama-fixture.test` and replaces `WebSocket` for that origin. Unknown routes return 404 and log `[fixture] no route …`. |
| `src/app/fixtures/code/mockupData.ts` | Verbatim port of the mockup's `PROJECTS`, `SRC`, `DIFFS`, `TERM`, `WS`, `CODE_CHATS`. |
| `src/app/fixtures/code/build.ts` | Turns that into the real DTOs: messages with `blocks`, tool calls with the engine's exact `resultSummary` forms, artifacts, changes, files, terminals, providers. |
| `scripts/parity.ts`, `scripts/parity/*` | Capture and diff (below). |
| `.claude/launch.json` → `desktop-web` | The Vite dev server on 1420. |

**Design decision: fake the engine, not the providers.** The real `ProjectsProvider`,
`SessionProvider` and the four pane contexts all run unchanged against the fake transport, so
the adapters get exercised too. Nothing about the fixtures changes when CR2–CR8 rewrite the
views.

**Open a fixture:** `/fixture.html?fixture=code-<chatId>&theme=wakaba&scale=1&reading=serif&pane=changes`.
Chat ids: `flash`, `ccplan`, `about`, `hello`, `yt`, `pix`, `harness`.

**Run the diff:** `bun scripts/parity.ts [scenario…|all] [--theme a,b|all] [--size 1440x900,1100x800] [--region name] [--app http://localhost:1420] [--check]`.
`--region` scores one area and masks the rest: `sidebar`, `topbar`, `ws` (the workspace panel), `ws-tabs`, `ws-band`, or `x,y,w,h`. Use it to gate a phase while neighbouring phases are still legacy.
Needs the dev server and Google Chrome. It renders the mockup (driven through its own globals,
`openCodeChat()` and `goto()`, so the file is never edited) and the app in the same headless
Chrome, then compares them inside the browser with pixelmatch's YIQ metric at threshold 0.1.
Output goes to `docs/Rama/parity/` (gitignored): `*-mock.png`, `*-app.png`, `*-diff.png`,
`report.md`. Pass is ≤ 0.5% of unmasked pixels differing and no mostly-different 24×24 block,
the same bar as Home's plan §5. Masked: the traffic-light box (x 10–80, y 14–38) and anything
marked `data-pixel-mask`.

**Two harnesses, on purpose.** This one renders both sides in one Chromium, so it catches CSS
that doesn't match without font-smoothing noise, and it runs headless. Home's plan §5 captures
two WKWebView windows with `screencapture`, which catches engine-specific rendering. They don't
conflict; use this one while iterating and Home's at phase exit.

**Known limits (each has a follow-up):**
- ~~Which diff, terminal, web page or file is *selected* inside a pane can't be seeded.~~ Fixed by CR3: `window.__rama.goto("terminal:t2")` (dev builds) selects it, and the fixture page applies `&goto=pane:arg` on load. `scripts/parity.ts` calls it for scenarios with a `goto`.
- The Files pane's open tabs persist under a key that includes the project id, but the provider
  reads it before the project loads, so seeded tabs don't show. Drive it through `goto("files:<path>")`.
- The mockup's `themes.ts` excerpt starts at line 181; the real files API has no such offset, so
  the fixture serves it from line 1. No scenario opens that file.
- The Web pane's page is a native webview in the app and a drawn card in the mockup. Mask the
  page card in `scenarios.ts` when CR4 lands.
- Not yet run inside a Tauri window; the shim is written for it, but only the browser path has
  been exercised.

**Baseline (before any restyle):** `flash × wakaba × 1440×900` differs by 18.12% with 261 bad
blocks. Expected: the old UI against the new design.

### CR2: Shell (sidebar frame, Code list, topbar, seal mount)

> **Status 2026-10-06: done.** Home's HD1 built the frame (`app/shell/*`: sidebar, top bar, seal,
> chat-title menu), so this phase was the Code-owned half. Parity on `flash`, regions scored on
> their own: **sidebar 0.04–0.17%, top bar 0.00%**, in wakaba, kanagawa, sumi and shu.
>
> Built here:
> - `app/code/CodeChatList.tsx`: project labels with hover `+`, `.r-chat-row`s with the selected
>   state, warn flag (`chat.status === "waiting_permission"`, which the engine starts writing
>   with E2) and a pulsing running dot, the owned-elsewhere `pop` icon, right-click `Popover`
>   menus (chat: Pop out, Delete chat; project: New chat here, Rename, Change branch, Reveal in
>   Finder, Remove project), inline rename and branch edit, and no collapse chevrons.
> - `app/code/CodeTopbar.tsx`: project and branch crumbs (chat view only), `Commands ⌘K`, the
>   workspace toggle (`aria-pressed`), pop-out (disabled with one tab), plus the interim provider
>   alert. `useLiveBranch` follows the chat's worktree branch (ChatColumn fires
>   `rama:branch-changed` when the worktree toggle changes it).
> - `app/code/code.css`: `.r-chip`, `.r-cmd-btn` and the list rows, ported with the `r-` prefix.
> - **Added to the sidebar list:** an "Add project" row, because the mockup has no slot and it was
>   the only sidebar entry point. It is marked `data-pixel-mask`. (§9.17)
>
> Home still owns the seal popover (HD2) and the footer avatar.


**Goal.** Replace `Titlebar.tsx`, `Sidebar.tsx`'s chrome and `WallpaperStack` with
the mockup shell. The Code side keeps its current chat column temporarily, inside
the new `.main`.

New files:
- `app/shell/Shell.tsx` (`.app.v2`)
- `Sidebar.tsx` (frame only)
- `SidebarCodeList.tsx`
- `Topbar.tsx`
- `Seal.tsx` (button only; HR supplies the popover)
- `shell.css`

**Sidebar frame** (mock:98–163), 272px, background `--sidebar`, right border
`--line`, 0.25s `margin-left` collapse to −272.

- **`.sb-top`.** 52px tall, padding `0 10px 0 18px`. Draw no fake traffic lights;
  the native overlay lights are used instead. Retune `trafficLightPosition` (and
  its twin in `drag.rs`) so the close button's centre lands at **(24, 26)**, the
  mockup's first light. Push `.icon-btn`s right with an empty spacer `flex:1` of
  the same width the mockup's `.lights` takes (52px plus margin). The buttons are
  Hide sidebar (`panel`) and Search chats (`search`). Mark the whole bar
  `data-tauri-drag-region="deep"`.
- **`.seg`.** Home and Code, 2-column grid, `--well` track, active segment raised
  with `--shadow-sm` (mock:121–133). Clicking either segment returns to that
  section's last open chat, or to its landing if none was open (mock:2106–2107).
- **`.sb-nav`** (mock:135–143). Three rows: "New chat ⌘N" (plus icon), "Docs"
  (docs icon, Code only), "Toolbox" (tool icon). **The counts are gone** (§9).
- **`.sb-list`, Code** (mock:1523–1527). For each project, a `.project-label`
  (folder icon, name 13.5px/600, hover-revealed `+` button `.add` that opens a new
  draft in that project), then its chats as `.chat-row`s with the selected state
  `--selected` and weight 500.
  - Projects keep today's order: the active one first.
  - There are no collapse chevrons. Collapse state is dropped (§9).
  - A chat waiting on approval shows the warn `.flag` dot (mock:495). This needs E2.
  - Right-click a chat row: `.pop` menu with "Pop out" and "Delete chat"
    (delete goes through the existing confirm modal).
  - Right-click a project label: `.pop` menu with "New chat here", "Rename",
    "Change branch", "Reveal in Finder" and "Remove project". The inline rename
    and branch editing survive, restyled as an input in place of the label text.
  - The owned-elsewhere marker becomes a 13px `pop` icon in `--ink-4` at the
    row's end.
  - The search field: when the search icon is toggled, a 34px input styled like a
    `.nav-row` (search icon, placeholder "Search chats") replaces `.sb-nav`, and
    the list filters live. Esc closes it.
- **`.sb-foot`** (mock:158–163). A 30px accent avatar holding the fluke, "rama" /
  "Local account", and a `sliders` icon that opens Settings. The cycle-theme button
  is removed (the seal replaces it).

**`.main`** (mock:166–169) is `position: relative`, with `<MainWall/>`, then the
topbar, the seal, and the view.

**Topbar** (mock:171–181, 381–395), 52px, padding `0 76px 0 14px` (the right padding
reserves the seal). Transparent, no frost, no border. Drag region. Contents in Code:

- `open-sb` (`menu` icon), only while the sidebar is collapsed.
- **Chat title** button: `chat-title` with the title and a `down` chevron. It opens a
  `.pop` with "Rename", "Pop out" and "Delete". It only shows in a chat, not on
  the landing.
- **Crumbs**: `.chip` for the project (folder icon) and `.chip` for the branch
  (branch icon). They show the live branch, which is the worktree branch when
  that's on. They're static spans, chat view only.
- **`.top-actions`**: `cmd-btn` "Commands ⌘K" (fires `rama:toggle-palette`),
  `icon-btn` workspace toggle (`panel-r`, `aria-pressed`, wired in CR6), and
  `icon-btn` pop-out (`pop`, enabled when the window holds more than one tab or
  the chat can move to a new window).
- **Provider alert.** The titlebar's bad-provider dot moves to the model pill (§9).

**Seal** (mock:185–197): absolute, `top:14 right:22 z:6`, vertical-rl Shippori
Mincho 600 17px, letter-spacing 3, padding `8px 6px 5px`, accent fill, inset
outline at −4px, rotated −2.5° (0° and −1px on hover). The kanji come from a
`kanji` field added to each theme JSON (wakaba 若葉, nami 波, kanagawa 神奈川, sumi
墨, sakura 桜, tsubaki 椿, shu 朱, matsu 松, rokusho 緑青). User themes without one
fall back to the first character of their label. Clicking it calls HR's
`openAppearance()`. Until HR lands, it opens the legacy `ThemePicker` menu.

**Secondary windows** have no sidebar. The topbar's left padding becomes 84px to
clear the native lights. Everything else is identical.

**`AppShell.tsx`** becomes a thin host:

```
<Shell section={view}>{home ? <HomeView/> : <CodeView/>}</Shell>
```

Toolbox and Docs keep routing through `view` and render inside `.main` with their
legacy look until restyled (§11).

**Acceptance.** Parity diffs on the sidebar and topbar regions are clean in four
themes. The native lights line up with the mockup's dot positions to within 1px.
Collapse animation runs at 0.25s.

### CR3: Workspace frame

> **Status 2026-10-06: done, with the pane bands still legacy.** Parity on `flash`: **tab row
> 0.00%** in four themes and all four panes; workspace position and width match (48%). The band
> row (`ws-band`) is 8.6% because the stage toolbar is still each pane's own legacy markup; CR4
> replaces it.
>
> Built, in `app/code/workspace/`:
> - `useWorkspaceGeometry.ts` + `WorkspaceContext.tsx`: state `{open, widthPx|null, railCollapsed,
>   pane}` under `rama:workspace:${WINDOW_LABEL}` (one-time migration from `rama:mission-control:*`),
>   owned by `WorkspaceProvider` so the top bar and the palette can drive it.
> - `CodeBody.tsx` (the flex row), `Workspace.tsx` (frame, generic rail head), `WorkspaceTabs.tsx`
>   (Changes badge from `useChangesBadge`, Terminal live dot), `WorkspaceSplitter.tsx`,
>   `workspace.css`.
> - **`goto(pane:arg)`**: `useWorkspace().goto("changes:<path>" | "terminal:<id>" | "web:<id>" |
>   "files:<path>")` selects the pane, opens the workspace and applies the arg through
>   `gotoBridge.ts` (`useGotoArg` in the Changes, Terminal and Web providers; Files keeps
>   `openFileBridge`). `rama:open-file`, `rama:mc-select-pane` and `rama:mc-expand-rail` still work
>   as aliases. In dev builds it is exposed as `window.__rama.goto`.
> - Splitter: clamps to 360 and chat − 380, rAF-batched `--ws-w`, double-click flips narrow and
>   wide (420 / 720). Below 1100px the workspace is a sheet (closed on first open, no splitter).
> - Deleted: `MissionControl.tsx`, `Rail.tsx`, `Stage.tsx`, `Splitter.tsx`,
>   `useMissionControlGeometry.ts`. `mission-control.css` stays for the pane internals until CR4.
>
> Deviations: the panel has `max-width: calc(100% − 392px)` so a saved width can't crush the chat
> after the window shrinks. The legacy stage toolbars are stretched from 36px to the 42px band in
> `workspace.css` until CR4.


**Goal.** Mission Control's chrome becomes the mockup's paper panel. The pane
*contents* still render with their current internals until CR4.

New files: `app/code/workspace/Workspace.tsx`, `WorkspaceTabs.tsx`,
`useWorkspaceGeometry.ts` (replaces `useMissionControlGeometry.ts`),
`workspace.css`. Delete the vertical `.rama-mc-tabstrip`, `Rail.tsx` and `Stage.tsx`.

- **`.code-body`** (mock:375) is a flex row: `.code-chat` (flex 1), `.splitter`, `.ws`.
- **`.ws`** (mock:513–521):
  - width `var(--ws-w, 48%)`, `min-width: 360px`, `margin: 0 12px 12px 0`,
    radius 16, `--panel` background, `--line` border, `--shadow-sm`
  - grid columns `minmax(0,1fr) var(--rail-w, 212px)`; rows `50px 42px minmax(0,1fr)`
  - `[data-rail="collapsed"]` sets `--rail-w: 48px`
- **Tabs row** (mock:522–531) spans both columns, padding `0 64px 0 8px` (clears
  the seal's tail), with a bottom border. Each `.ws-tab` is 34px tall, radius 9,
  icon plus label.
  - Selected tab: background `--well`.
  - **Changes** shows a `.badge` with the count from today's `useChangesBadge`. An
    attention state (conflicts) tints the badge `--bad`; the mockup has no
    conflict design, so this is an addition (§9).
  - **Terminal** shows a `.live` dot when any terminal is running.
- **Band row** (mock:532–547). The pane-owned **stage bar** (`padding 0 8px 0 14px`)
  and **rail head** (`padding 0 6px 0 14px`, left border) share one 42px row and
  one bottom border. This is MISSION_CONTROL_PLAN §4.1's band rule, kept.
  - Every rail head ends with a `rail-toggle` `icon-btn` (`panel-r`).
  - Collapsed rail head shows only the toggle, centred.
- **Stage** (`--code-bg`, `overflow:auto`) and **rail** (left border, padding 6,
  `overflow-y:auto`).
- **Splitter** (mock:509–512, 2139–2150), 12px. Its grip pill is 4px wide and
  40–60% tall, `--line-2`, visible on `.code-body:hover`, and `--accent` while
  dragging. Rules:
  - The chat keeps at least 380px.
  - Dragging writes `--ws-w` in px straight to the DOM, rAF-batched, the same as
    today's §4.7 trick.
  - Double-click toggles between the last narrow and last wide width (behaviour
    carried over from today).
  - Before the first drag, the width is the mockup's 48%.
- **Geometry persisted per window**, key `rama:workspace:${WINDOW_LABEL}`, as
  `{ open, widthPx|null, railCollapsed, pane }`. Migrate the old
  `rama:mission-control:*` key once. **There's no rail-width drag any more**: the
  rail is a fixed 212 or 48 (§9).
- **Open/close.** The topbar `wsToggle` controls it, with no edge strip. Closed
  means `.code-body[data-ws="closed"]` hides `.ws` and `.splitter` (mock:520).
  ⌘K "Toggle workspace" stays.
- **Below 1100px** (mock:605–608), the workspace becomes a sheet over the chat:
  absolute, `width: min(600px, 100% - 24px)`, `--shadow-pop`, z 8, no splitter. It
  defaults to closed on first open at that width (mock:2157).
- **`goto(pane:arg)` bridge** (mock:1830–1840). One function used by every "Open
  in …" link, path pill and changes-card row. It selects the pane, applies the arg
  (`changes:<path>`, `terminal:<id>`, `web:<pageId>`, `files:<path>`), opens the
  workspace, and expands the sheet below 1100px. It replaces the
  `rama:mc-select-pane` and `rama:open-file` events internally, and keeps them as
  aliases for existing dispatchers.
- **Workspace on the landing.** It's visible on the Code landing too (mock:1892).

**Acceptance.** Frame, tabs and band row match the mockup in the Changes, Terminal,
Web and Files tabs, with the rail open and collapsed, the workspace open and
closed, and at 1100px as a sheet.

### CR4: Pane restyles

> **Status 2026-10-06: done.** Parity (`--region ws`, 1440×900) passes for all four panes in wakaba,
> kanagawa, sumi and shu: Changes 0.25–0.29%, Terminal 0.09–0.11%, Web 0.02–0.03%, Files
> 0.43–0.47%, 0 bad blocks. The other scenarios (`ccplan`, `about`, `hello`, `yt`, `pix`, `harness`)
> pass in wakaba (0.02–0.29%). The band row (`ws-band`) went from 8.6% to **0.00%**, and the sidebar,
> top bar and tab row are unchanged at 0.04% / 0.00% / 0.00%. The whole page is 13.6% (was ~16.5%),
> all of it the chat column (CR5–CR7).
>
> **Contract change.** A pane is now `{ RailHead, Rail, StageBar, Stage, Provider }`
> (`mission-control/panes.ts`); `RailActions` is gone. `Workspace.tsx` places the four cells in the
> grid, so the band row is one 42px line across the stage bar and the rail head, and it appends the
> collapse toggle. Shared pieces live in `code/workspace/parts.tsx` (`Delta`, `Empty`, `PressRow`,
> `useNow`, `tildePath`), the mockup CSS in `code/workspace/panes.css`.
>
> **Changes.** Flat list grouped by directory (`.rdir` + `.rrow`), a branch head with "N files" /
> "Up to date" / "N to push" and red "Merging" / "Rebasing" / "Detached at …", the stage bar with the
> Unstaged | Staged switch, and a new `code/workspace/Diff.tsx` (grid rows, hunk headers as sentences,
> "New file"). The folder tree and its collapse state are removed from `ChangesPaneContext`.
> **Terminal.** `.sdot` states, "Running, started by you" sub lines, hover `x` to close, Clear and
> Stop in the bar. `XtermSurface` now passes a real font stack, resolves theme colours through a probe
> element plus a 1×1 canvas (so `color-mix()` tokens work), uses `lineHeight 1.27` (xterm multiplies the
> font's own line box, so that is the mockup's 21px rows) and pads `.xterm` to `14px 18px 20px`.
> **Web.** Back/forward/reload, the address pill (an input, with a spinner), open in your browser, and
> the `.page` card the native webview is laid over. **Files.** `.ftabs` in the band, the tree with
> single-child chains drawn as one row, the codeview, and the oversize and binary states.
>
> **Deviations and additions** (also folded into §9):
> - The legacy `app/diff/DiffView` stays for the chat's artifact card until CR6/CR7; the workspace
>   uses the new `Diff`. The hunk sentence's line range comes from the parsed rows, not the header's
>   counts.
> - Syntax: built-in types (`string`, `void`) and function names stay **plain** in diffs and the file
>   view, because the mockup draws them plain; the plan listed both as accent. Function colour is
>   kept as `.r-code.fn` for the transcript's code fences (the mockup's `.tok-fn`).
> - Terminal rows omit the `⌘N` hint: ⌘1–9 is already the window-tab chord. Idle is "no output for
>   60s" (not 10s), read from the PTY listener, with the engine's `updatedAt` as the floor.
> - An untracked file reads "New file" like an added one (the mockup's wording); "Not tracked yet" is
>   unused.
> - Files: the git letter beside changed files and the wrap toggle in the band are kept, and show up
>   as small diffs against the mockup. The ignored-files toggle moved into a right-click menu.
> - New `wrap` icon in the kit (`Icon.tsx`, Home's file; one line).
> - Parity masks: the app's `.r-page` and xterm surface, and the mockup's `.page` and `#stage .term`
>   (xterm lays text on a cell grid and wraps by column; the mockup flows it). Fonts and colours of
>   the xterm text were checked by eye instead.
> - Web pages have no engine row, so the fixture seeds them (`seedWebPages`, from `fixtures-entry`).
>
> **Fixed on the way.** (1) The Files pane read its saved tabs and expanded folders once, before the
> project had loaded, so a cold start with Files as the saved pane came up empty. (2) A single click
> in the tree now previews in the one italic tab and double-click pins; before, every tab was pinned.
> (3) xterm threw `reading 'dimensions'` whenever a terminal unmounted; disposal now waits two
> frames. (4) `mission-control.css` is deleted (its only live part, the highlight.js colours for the
> chat's code fences, moved to `mission-control/panes/syntax.css`).
>
> **Popovers.** Kit popovers announce themselves on `rama:overlay-visibility` (`{ id, open }`), and
> `useWebviewVisibility` hides the native webview while any is open, as it does for the palette and
> settings. It also hides the webview when the workspace is closed.
>
> **Not done.** The optional R1 (rounded corners on the native webview), and a pass over the dead
> `.rama-*` rules left in `app-shell.css` (sidebar, title bar, artifact rows; that is CR9's sweep).
> Untested in a real Tauri window: the native webview over `.r-page`, real PTY output, and
> `openUrl` / `openPath`.


Keep each `*PaneContext`, and rewrite each pane's Rail, Stage and head to mockup
markup. The row primitive is `.rrow` (mock:549–555): a grid
`16px minmax(0,1fr) auto`, padding `6px 8px`, radius 8, the selected state
`--selected`, a `.sub` line spanning columns 2 to the end, and an `.end` meta cell.
Collapsed mode is a single centred icon column (mock:562–564).

**Changes** (mock:1760–1775):

- **Rail head.** Branch icon, **branch** in bold, and a grow text with "N files",
  or "Up to date" / "N to push" when clean (from `ahead`). Then refresh and the
  rail toggle. Detached, mid-merge and mid-rebase states render in the grow text
  in `--bad` ("Merging", "Rebasing", "Detached at a1b2c3d").
- **Rail.** Group by directory: `.rdir` label (12px/500, `--ink-4`, RTL ellipsis
  so the *end* of a long path stays visible), then `.rrow`s.
  - Icon: `pencil` for modified, `file-plus` for added or untracked, `x` for
    deleted, `branch` for renamed. Only pencil and file-plus are in the mockup;
    the other two are additions (§9).
  - Title is the base name, `.end` is the delta (`.plus` / `.minus`, tabular
    numbers), and `.sub` is "Edited", "New file", "Deleted", "Renamed from
    old.ts", "Not tracked yet" or "Conflict".
  - The current nested tree view and per-folder collapse are replaced by the flat
    grouped list. That's simpler, and it's what the mockup shows.
- **Stage bar.** `.stage-title` with the **base name** and a small dir, then grow,
  the delta, copy path (`copy`) and open in editor (`pop`). When an entry is both
  staged and unstaged, a `.mini-seg` (Unstaged | Staged) sits before the delta
  (§9).
- **Stage.** `DiffView` is rewritten to the mockup's `.diff`
  (mock:466–477): grid rows `38px 38px 16px auto`, 12.5px JetBrains Mono at
  line-height 1.7.
  - Add rows: `--good` 13% background. Delete rows: `--bad` 11%. The sign column
    takes the matching colour. Numbers are `--ink-4` at 0.8 opacity.
  - **Hunk headers become sentences**: `@@ -21,7 +21,9 @@ function ThemeProvider`
    renders as "Lines 21 to 29, in ThemeProvider" in UI type, 12px, `--ink-4`,
    padding `10px 16px 6px`. A new file renders "New file".
  - Syntax colouring per line via the shared `hl()` adapter (CR4 syntax note).
- **Empty states** (`.empty`, mock:587):
  - Clean: "**Nothing to commit**" / "The working tree is clean.", or "main is N
    commits ahead of origin. Push when you're ready."
  - Not a repo: "**Not a git repository**" / "This project has no .git folder." plus
    a `.btn.btn-soft` "Initialize repository".
  - Rail when empty: "No changed files".

**Terminal** (mock:1776–1787):

- **Rail head.** **Terminals** (grow), `+` (new terminal), and the toggle.
- **Rows.** A `.sdot` with a state:
  - `run`: `--good` with a 3px halo
  - `idle`: hollow ring
  - `done`: `--ink-4` fill

  Then the title, `⌘N` in `.end`, and a `.sub` such as "Running, started by you",
  "Finished, started by Rama", "Exited with code 1, started by Rama", or "Ended
  when the app restarted". The protocol only knows running or exited, so `idle` is
  shown for user-owned running shells whose last output is more than 10s old
  (tracked client-side in `useTerminalSession`), and `run` otherwise. A close `x`
  `icon-btn` appears on row hover (§9).
- **Stage bar.** **Title** plus a small cwd (`~/rama`), then grow, `.mini` "Clear",
  and `.mini` "Stop" (disabled at 0.4 opacity when not running). An exit badge, if
  any, sits in the stage title as small text, "exit 1", in `--bad`.
- **Stage.** `XtermSurface` gets a transparent background over `--code-bg`, padding
  `14px 18px 20px`, `fontSize 12.5 * scale` and `lineHeight 1.7`.
  - **Fix the font:** today it passes the literal string `"var(--font-mono)"`,
    which xterm can't resolve. Pass `'"JetBrains Mono", ui-monospace, monospace'`.
  - Theme map: foreground `--ink-1`, prompt and cursor `--accent`, dim `--ink-4`,
    green `--good`. Read them via `getComputedStyle`, resolved through a probe
    element, because xterm's canvas can't take `color-mix()` strings.

**Web** (mock:1788–1796):

- **Rail head.** **Pages** (grow), `+`, and the toggle. The `+` isn't in the
  mockup; it's kept for symmetry with Terminal (§9).
- **Rows.** `globe` icon, title, and `.sub` "{url}, opened by Rama" or "{url},
  opened by you". A hover `x` closes the page.
- **Stage bar.** Back (`left`), forward (`right`) and reload (`retry`) `icon-btn`s,
  then the `.urlbar` pill (28px tall, 999px radius, `--code-bg` with an inset
  `--line` ring, `globe` icon). The pill *is* the omnibox: an input with the same
  look, submitting on Enter, with the loading spinner inside the pill's right
  edge. Last comes open in system browser (`pop`).
- **Stage.** The mockup's `.page` card (mock:591): 18px margin, radius 12,
  `--shadow`. The native child webview is positioned to the card's *inner* rect by
  `useWebviewVisibility` (measure the card element, not the stage). A native
  webview can't be clipped by CSS radius, so the corners stay square unless the
  optional R1 (rounded webview layer, §8) is done. The mockup's sketch drawings
  (`.ps`, `.pm`, `.vids`) are demo content, not built.
- **Popovers.** Add the seal popover and the composer's model and mode menus to the
  "hide webview while open" set wherever they could overlap the stage (the seal's
  popover always does). Generalize `rama:palette-visibility` into
  `rama:overlay-visibility` with a ref-count.

**Files** (mock:1797–1806):

- **Rail head.** **Files** (grow), refresh, and the toggle. The ignored-files
  toggle moves into a right-click menu on the rail (§9).
- **Tree** (mock:566–573). `.tree-row`, 4px 8px padding, radius 7, 13.5px. A
  twisty (`right`, rotated 90° when open) plus `folder` for directories; leaves
  get `doc` and indent 26 + 18 × depth. The selected leaf is `--selected` at
  weight 500.
  - **Compact single-child directory chains** ("apps/desktop/src") the way the
    mockup shows them, once a directory's children are loaded and it has exactly
    one subdirectory and no files.
  - When the rail is collapsed, the tree hides and the open tabs show as `doc`
    icon rows (mock:1806).
- **Stage bar.** `.ftabs` (mock:575–583) sits flush to the band's left edge
  (`margin-left: -14px`). Each `.ftab` has a right border; the selected one gets a
  `--code-bg` background and a 1px `::after` that erases the band border under
  it. Preview tabs are italic. The close `x` is 18px.
  - Single click opens a preview tab and double-click pins it, the same semantics
    as today.
  - After the tabs: grow, then a **wrap** toggle as an `icon-btn` with a new
    `wrap` icon (§9), copy path, and open in editor.
- **Stage.** `.codeview` (mock:478–480): grid `46px auto`, numbers in `--ink-4`
  at 0.75 opacity, padding `12px 0 28px`, the same mono spec as diffs. The
  oversize and binary banners restyle to `.empty` / `.btn-soft`.

**Syntax colouring (shared).** `mission-control/panes/syntax.ts` keeps highlight.js,
but a CSS map collapses hljs classes to the mockup's four roles:

- `.hljs-keyword`, `.hljs-built_in`, `.hljs-literal`, `.hljs-meta` → `--accent` (`.t-k`)
- `.hljs-string`, `.hljs-regexp` → `color-mix(--good 75%, --ink-1)` (`.t-s`)
- `.hljs-comment` → `--ink-4` italic (`.t-c`)
- `.hljs-number` → `--warn` (`.t-n`)
- `.hljs-title.function_` → `--accent` at weight 500 (`.tok-fn`)
- everything else → `--ink-1`

The diff, file view and transcript code cards all use this.

**Acceptance.** The four panes match the mockup's `#code` workspace screenshots in
the "flash" fixture. Changes with theme.tsx selected; Terminal on t2; Web on w1;
Files with the theme.tsx tab, and the demo project for the clean and preview-tab
states.

### CR5: Composer (Code variant)

> **Status 2026-10-06: done.** Parity (`--region dock`) is **0.00%** for the dock (card, chip row,
> mode and model pills, send, privacy line, context ring) in all four themes, in `flash`, `ccplan`,
> `about`, `hello`, `yt`, `pix` and `harness`, at 1440×900, 1100×800 and 900×800. With each menu
> open (`menu-mode`, `menu-model`, scored on the menu's own rect): mode menu 0.05–0.20%, model menu
> 0.31–0.53% (the kit's "More models…" link, see below). Sidebar, top bar, tab row, band row and the
> four panes are unchanged. The whole page is 9.4% (was 13.6%), all of it the legacy transcript
> (CR6–CR7).
>
> **Built on Home's kit, not forked.** Home landed the composer first (HD5), so per the ownership
> rule the Code composer fills its slots: `CodeComposer` renders the kit `Composer` with `above`
> (the chip row), `tools` (the mode pill, in the web toggle's place) and `trailing` (the context
> ring). The planned `app/composer/*`, `ModelMenu.tsx` and `modelVisibility.ts` are not created;
> models come from Home's `useModelChoices` (the shortlist: enabled models that are not missing or
> erroring; a provider whose health is bad stays listed and reads "· unavailable"). Files:
> `code/composer/{CodeComposer,ContextChips,ModeMenu}.tsx`, `useComposerContext.ts`, `composer.css`.
>
> **What moved.** `ChatColumn.tsx` lost its composer block, the chip-row state (now
> `useComposerContext`: branch, worktree, extra folders, the draft carry-over and the
> settings-fetch race guard, unchanged), the `/` search state, the autosize effect and the rail's
> key handling. It keeps the text, `submit()`, mode state and the palette bridges
> (`rama:composer-insert`, `rama:run-command`, `/undo`). The legacy `.rama-chat-header` (crumbs and
> ctx meter) is gone: the top bar has the crumbs and the privacy line has the ring.
> `AgentPicker.tsx`, `ModelPicker.tsx` and their ~170 lines of `.rama-composer/pill/tile` CSS are
> deleted.
>
> **Deviations and additions** (also folded into §9):
> - **Pill status.** The kit pill has no slot for the 7px bad dot or the "Fix in Settings" row. A
>   down provider reads "· unavailable" in the menu, and "More models…" (the kit's, at the right of
>   the first group label) opens Settings → Providers. With no providers, the pill and Send open the
>   same place; the legacy wizard still shows in the empty chat until CR8.
> - **Project chip** always opens a menu. On a draft it re-targets the draft (new
>   `retargetDraft` in `ProjectsProvider`, which also resets the agent to Default); on an existing
>   chat it says "This chat stays in {project}" and offers "New chat in …".
> - **Attach** opens a "find a file" popover that completes a path one folder at a time from the
>   project's file listing and types `@relative/path` at the caret. There is no native picker:
>   `@tauri-apps/plugin-dialog` is not installed, and Code has no binary attachments anyway.
> - **Keys.** ↑ ↓ ⏎ drive the `/` menu and Esc closes it, then stops a run. The old rail's
>   arrow-key roving between tiles is gone with the rail; Tab order is natural. (`⌃M` never existed
>   in the code, so there was nothing to keep; `cmd:mode:*` palette commands still work.)
> - **While running** the mode pill is disabled and Send becomes Stop. The model pill stays live (the
>   kit has no `disabled` prop); a switch applies from the next turn.
> - **Legacy island.** `CodeBody` no longer wraps the whole chat column in `r-legacy`; only the
>   message list carries it, so the dock gets the kit's button reset and fonts.
>
> **Harness and fixtures.** `--region dock`; `menu-mode` and `menu-model` scenarios (a new
> `app` field next to `mock` lets each side click its own pill); the app starts with the workspace
> closed at ≤1100px, as the mockup does. The code fixture gained LM Studio's Gemma, a `/search`
> response for the `/` menu, and a default chat model (Qwen3, the mockup's) so drafts have one.
>
> **Not verified.** The running state (Stop button, disabled mode pill, Esc to stop) against a live
> run, and the whole composer in a real Tauri window. The landing position (placeholder, no ring) is
> built but is judged in CR8, with the landing it sits in.

**Goal.** Replace the composer block of `ChatColumn.tsx` with `ComposerBase`, a
shared component, plus `CodeComposer`.

New files: `app/composer/ComposerBase.tsx`, `ModelMenu.tsx`, `modelVisibility.ts`
(health filtering logic extracted from `ModelPicker.tsx`), `composer.css`,
`app/code/composer/CodeComposer.tsx`, `ModeMenu.tsx`, `ContextChips.tsx`.

**Card** (mock:232–247):
- `--raised`, 1px `--line` border, radius 20, `--shadow`, padding `14px 12px 10px 18px`.
- Focus ring: 45% accent border plus a 4px 12% accent halo.
- Textarea: Instrument Sans 16px × scale, line-height 1.5, autosize from 26px to
  220px, placeholder `--ink-4`.
  - Landing placeholder: "Describe what you want to build or fix in {project}".
  - Chat placeholder: "Reply, or describe the next change".
- Dock (mock:285, 379): `min(700px,100%)` wide, padding `0 24px 16px`.

**Context chips** (`.ctx-row`, margin `-4px 0 12px -6px`, gap 6). In order:

1. **Project chip**: `folder` + name + `down`, opening a `.pop` menu with every
   project ("✓" on the current one), a divider, and "Add a project…" (opens the
   existing add-project modal through `rama:open-add-project`). Switching projects
   on a draft re-targets the draft. On an existing chat the chip is static, and
   the menu shows "This chat stays in {project}" plus "New chat in…" items.
2. **Branch chip**: `branch` + the live branch (static span). This is the same
   fetch logic as today (`fetchChatChanges` / `fetchChanges`).
3. **Separate worktree** toggle chip, `aria-pressed`. The icon is `copy` when off
   and `check` when on. Its title is the mockup's sentence. It's wired to today's
   `toggleWorktree`, including the draft carry-over and `skipNextSettingsFetchRef`.
4. **Extra folders**, one chip per added root: `folder` + base name, title showing
   the full path, and an `x` that appears on hover. This is not in the mockup
   (§9).
5. **Add folder** chip: `plus` + "Add folder". It opens a small `.pop` anchored
   above it, with one input ("Folder path") and Enter to add. A native folder
   picker is a later improvement (`@tauri-apps/plugin-dialog`).

**Row** (`.composer-row`, margin-top 12, margin-left −8):

- `tool-btn` attach (`clip`). In Code it opens a native file picker and inserts
  `@relative/path` mentions into the text. There are no binary attachments in Code
  (§9).
- **Mode pill** (`.model-pill.mode-pill`, `margin-left:auto`): the mode icon
  (`agent` / `list` / `ask`) plus the label. It opens **ModeMenu** (mock:2014–2021),
  a 300px `.pop` placed *above* the pill (the mockup's `placeAbove`):
  - "Mode" section: three `.mp-item`s with descriptions ("Reads, edits and runs
    commands" / "Proposes a plan, changes nothing" / "Answers questions about the
    code").
  - "Agent" section: every agent from `fetchAgents(projectId)`, with "Default"
    first, described as "Uses this project's RAMA.md and tools". Other agents use
    their own `description`.

  This folds `AgentPicker` in. The ⌃M shortcut and the `cmd:mode:*` palette
  commands keep working.
- **Model pill**: a `lock` or `cloud` icon, the model's display `label`
  (`ModelInfo.label`), and a `down` chevron. It opens **ModelMenu** (mock:2004–2013),
  grouped under "On this Mac" and "Cloud". Each row shows `b` the model label,
  `small` the provider label, and a tick on the current one.
  - **Local vs cloud** comes from a new `isLocalProvider(p)`: the `baseUrl` host is
    loopback, `*.local`, or an RFC 1918 or link-local address. Otherwise, or for
    `kind: "anthropic"`, it's cloud.
  - Hidden-not-demoted filtering (PROVIDERS_PLAN P1) is preserved through
    `modelVisibility.ts`.
  - A provider with bad health shows a 7px `--bad` dot on the pill and a menu row
    "{Provider} isn't responding — Fix in Settings" that deep-links (§9).
- **Send** (mock:267–275): a 34px accent circle with the `up` icon at stroke 1.9.
  It's disabled (`--line-2` / `--ink-4`) when the text is empty.
  - **While busy it becomes Stop**: the same circle with a filled 10px rounded
    square (§9). Esc still interrupts.

**Privacy line** (`.privacy`, mock:276–278, 499–500), centred, 12px, `--ink-4`, wraps:

- `lock` or `cloud` icon, then "{Model} runs on this Mac. Nothing you send leaves
  it." or "{Model} runs on {Provider}'s servers. Messages are sent to them."
- `.ctx`: the 14px **context ring** (mock:401–404, 1539–1542, stroke 2.4, minimum
  3% arc) plus "18k of 200k context used". The numbers come from today's
  `contextUsed` / `contextMax`, rounded to whole k.
- This replaces the header ctx meter.

**Slash search menu**: same behaviour, restyled as a `.pop` anchored above the card
at the card's width. Group labels are `.mp-label`. Items are `.mp-item` (title in
`b`, subtitle in `small`) with keyboard selection in `--hover`.

The "⇧⏎ nl" / "esc to stop" hint is removed. ⇧⏎ and Esc are documented in the
⌘K help (§9).

**Acceptance.** The composer matches the mockup in the landing and chat positions,
with worktree on and off, both menus open, and local and cloud models. Every
existing composer behaviour still works: draft text persistence, mode
persistence, worktree, extra roots, `/undo`, slash commands, and the
`rama:composer-insert` event.

### CR6: Transcript (rows, prose, turns)

**Goal.** Replace the message rendering in `ChatColumn.tsx` with a pure view-model
plus components. After this phase `ChatColumn.tsx` is deleted. Its remaining
container logic moves to `app/code/CodeChat.tsx`.

**View-model**: `app/code/transcript/buildTranscript.ts`, with `bun test` coverage.
Input is `messages`, `toolCalls`, `artifacts`, `todos`, `pendingPermission`,
`status` and the last run id. Output is turns of typed blocks:

```ts
type Block =
  | { k: "prose"; markdown: string }
  | { k: "row"; row: ActRowModel }          // grouped into .acts runs by the renderer
  | { k: "plan"; items: TodoItem[] }
  | { k: "changes"; files: ChangedFile[]; undoable: boolean }
  | { k: "ask"; request: PendingPermission }
  | { k: "clarify"; questions: ClarifyQuestion[] }
  | { k: "notice"; text: string; tone?: "bad" };
```

**Tool to row mapping.** These are the plain-language labels; they're the heart of
the redesign.

| Tool calls (consecutive, same message) | Row | Icon | Meta | Body |
|---|---|---|---|---|
| thinking block | "Thought for N seconds" ("for a moment" if under 1s) | `clock` | n/a | thinking text, `pre-wrap` |
| a run of read / grep / glob / tree / outline / git (read-only) | 1 read: "Read **name**". Otherwise: "Looked through N files" | `search` | "212 lines" (from `N of M lines`), or "and searched once/N times" | `.files` list: "Read" + path pill, or "Searched" + "for `pattern`, N matches in M files" (mock:1346–1349) |
| edit, or write that modified a file | "Edited **name**" | `pencil` | `+N −M` | diff card (artifact) + "Open in Changes →" |
| write with `created · N lines` | "Created **name**" | `file-plus` | `+N` | diff card (all adds) + link |
| file_op | "Moved **a** to **b**" / "Deleted **name**" | `pencil` / `x` | n/a | n/a |
| bash (foreground) | "Ran **command**" (truncated to 48 characters, full text in the title) | `term` | `ok`: "done", or **"N passed"** when the output matches a test summary (E5). `fail`: "exit N" | output card (`.term`, max-height 260) + "Open in Terminal →" when a terminal id exists |
| bash `background: terminal N` | "Started **command** in the Terminal pane" | `term` | "running" in `--good` | link to the terminal |
| process (kill) | "Stopped **title**" | `term` | n/a | n/a |
| browser open | "Opened **host** in the Web pane" | `globe` | n/a | sentence + "Open in Web →" |
| browser read / snapshot / click / type / press / scroll | "Checked **host** in the Web pane" / "Clicked …" / "Typed into …" (same grouping rule as explore) | `globe` | n/a | list of steps + link |
| review (sub-agent) | "A reviewer read the diff" | `eye` | the summary label: "no changes needed" or "N notes" | review text |
| explore (sub-agent) | "A helper explored: *question*" | `search` | n/a | answer text |
| test (sub-agent) | "A helper wrote tests" | `file-plus` | n/a | diff + output |
| git_write commit | "Committed to **branch**" | `commit` | short sha (E5) | commit output card |
| git_write other | "Staged 3 files" / "Switched to **ref**" / "Stashed changes" … | `commit` / `branch` | n/a | n/a |
| check | "Checked types and lint" | `check` | "clean" / "N problems" | output |
| todo | not a row. It feeds the **plan** block, rendered once at the first todo call's position and updated live from `todo.updated` | n/a | n/a | n/a |
| clarify | not a row: a **clarify** card | n/a | n/a | n/a |
| failed call (`ok:false`) | the same row with its verb in past tense, meta in `.fail` ("refused", "failed") | same | n/a | error text |
| running call (`ok:null`) | the row's verb in the present ("Reading **name**…") with meta in `--accent` | same | n/a | live buffer |

Grouping rule: consecutive rows render inside one `.acts` (mock:1715–1732). Prose,
plan, changes and ask blocks flush the group.

**Components** (`app/code/transcript/`; the shared pieces move to `app/transcript/`
per §3):

- **`UserTurn`** (mock:287–293): a right-aligned bubble, `max-width min(82%, 580px)`,
  `--bubble`, radius `18 18 6 18`, 15.5px, line-height 1.55. Text is preserved as
  plain text with `pre-wrap`.
- **`ActRow`** (mock:304–319):
  - `.act-btn` with a 22px `--well` `.dot` icon tile, the label (bold parts in
    `b` at 500, `--ink-2`), `.meta`, and a `right` chevron that rotates 90° on
    expand.
  - `.act-body` (left rule 1.5px `--line-2`, indent `16px + 18px`, max 60ch).
  - Rows default to collapsed, *except* the currently running row, which
    auto-opens and auto-closes when it finishes. That's today's "latest tool card
    expanded" behaviour, kept.
  - Body content loads lazily from `fetchArtifactContent` on first expand (today's
    logic).
  - Inline diff cards are `.card.code-card` with `max-height: 300px`
    (mock:476).
- **`Prose`** wraps `Markdown`, restyled to `.prose` (mock:321–335):
  - Literata 17px × scale, line-height 1.65, `--ink-2`, max 66ch.
  - `:root[data-reading="sans"]` switches it to Instrument Sans 16px, set by HR's
    popover.
  - Lists use an accent marker. Tables are 13.5px UI type.
  - Inline `code` is `--well` with radius 5 and 0.82em.
  - **Path-shaped inline code renders as `.path` pills** (mock:422–428), clickable
    into `goto("files:…")`. `PathLink`'s detection is kept and the visuals swapped.
  - **Code fences** become `.card.code-card` with a `.card-head` (language name in
    sentence case, or "Code") and a `.mini` Copy button. The label flips to
    "Copied" for 1.4s (mock:2095–2101). Body: JetBrains Mono 13.5px at
    line-height 1.6, with hljs mapped as in CR4. Mermaid stays, inside the same
    card.
- **`TurnActions`** (mock:352–356): 28px `copy` and `retry` icon buttons plus a
  byline. The byline is "{Model} on this Mac" for local models or "{Model} via
  {Provider}" for cloud ones. It's hidden until hover, except on the last turn,
  and hidden on a turn that ends in an ask. **Retry** needs E4. Until then it's
  rendered disabled with a "Coming soon" title (§10, Q4).
- **`Working`** (mock:358–360, 1618): the 22×19 fluke bobbing at 1.4s, plus
  "{verb}…" in 13.5px `--ink-3`. Replaces the `✻` status line.
  - Verbs: generic thinking uses the mockup's whale verbs ("Diving in",
    "Surfacing") in rotation with the existing playful list.
  - Specific verbs become sentence case ("Running bun test", "Waiting for your
    OK", "Compacting the conversation").
  - The elapsed time, token and "thought for" counters move to the element's
    `title` tooltip (§9).
- **`Notice`** (`.notice`, mock:463): system and compaction messages, centred 12px
  `--ink-4`, dismissible on hover with a 16px `x`. Errors use the same style in
  `--bad`.
- **Scroller** (mock:283): `-webkit-mask-image` fades the top 18px and bottom 28px.
  Transcript `min(700px,100%)`, padding `40px 24px`, gap 30px. Keep scroll pinned
  to the bottom while streaming, unless the user has scrolled up more than 80px.

**Acceptance.** The "flash", "ccplan", "about", "pix" and "yt" fixtures match the
mockup turn by turn, collapsed and with each row expanded. Live runs against a
real model render without the legacy look leaking through (no `●`, `⎿`, `◆` or
`❯` anywhere).

> **Status 2026-10-06: done, with the plan, changes, ask and clarify cards built early.** Parity
> (whole page, 1440×900) passes for all 15 scenarios in wakaba: `flash` 0.29%, `ccplan` 0.12%,
> `about` 0.13%, `hello` 0.12%, `yt` 0.02%, `pix` 0.12%, `harness` 0.01%, plus the four pane
> scenarios and both composer menus (0.21–0.36%). With **every act row expanded** from the top of
> the chat (`rows-flash`, `rows-flash-700`, `rows-about`): 0.12%, 0.12%, 0.17%. The transcript
> region (`--region chat`) of every chat except `flash` is 0.00–0.05%. The seven transcript
> scenarios also pass in kanagawa, sumi and shu (0.01–0.28%) and at 1100×800 and 900×800
> (0.01–0.44%). The whole page was 9.41% before this phase. Engine: 311 tests pass; desktop: 93 pass,
> `tsc` clean.
>
> **What was built.**
> - **`code/transcript/rows.ts`** maps tool calls to rows (the table above, all of it), pure and
>   tested (`rows.test.ts`, 32 cases). `buildTranscript.ts` turns messages, calls, artifacts and the
>   pending permission into turns of typed blocks (`buildTranscript.test.ts`, 19 cases).
> - **Components** (`code/transcript/`): `TurnView` (turns), `RowView` (`CodeActRow`, bodies, path
>   pill), `Cards` (plan, changes, ask, clarify), `MermaidCard`, `transcript.css`. `code/CodeChat.tsx`
>   is `ChatColumn.tsx` moved with `git mv`: it keeps the composer's state, `submit()`, the run
>   state and the scroller, and draws nothing itself. **`ChatColumn.tsx` is gone.**
> - **Built on Home's kit.** The frame, bubble, `Acts`, prose, cards, `TurnActions`, `Working` and
>   notice are `@rama/ui`'s (`kit/transcript`). Prose is Home's `HomeMarkdown`, which gained an
>   optional `hooks` prop (inline code → path pill, a fence → a Mermaid card). Home passes nothing,
>   so its output is unchanged. `ActRow` is not used: its open state is internal, and Code's live
>   row has to open and close itself, so `CodeActRow` draws the same markup with the state held
>   here. Bodies mount only while open.
> - **The live run.** The running call is a row in the present tense with its meta in the accent,
>   open until it finishes, then it closes (unless the reader took over). Thinking is the same
>   ("Thinking · 3 seconds"). The working line says the engine's verb in plain words ("Diving in",
>   "Running bun test packages/ui", "Waiting for your OK", "Writing"), rotating the whale verbs and
>   the old playful list while it is only thinking, with elapsed time, tokens and thinking time in
>   its tooltip. It is hidden while prose is streaming.
> - **E5 (engine).** `engine/src/tools/testSummary.ts` (tested: bun, jest, vitest, pytest, cargo)
>   appends `· 31 passed` / `· 2 failed` to a bash summary, and a commit's summary is now
>   `committed · main 4c1e9a2`. Older chats keep their old summaries and read "done" / "Committed".
> - **Plan card from the calls.** The plan is folded from the `todo` tool's own calls (`set` makes a
>   fresh list, `update` moves one item), so it renders live and after a reload with no
>   `todo.updated` subscription. **E6 and a `todos` field on `SessionProvider` are therefore not
>   needed** for the card; CR7 can drop them.
> - **Diff cards.** The engine's edit artifact is the whole file as `+`, `-` and space lines, with no
>   hunk headers. `artifactDiff.ts` (tested) cuts it into hunks with three lines of context and the
>   `@@` headers the Changes pane's `Diff` reads, so the card shows what changed, not the file.
> - **Permission copy** (`permissionCopy.ts`, tested) is the CR7 table: a question, the literal
>   action, a sentence. A commit reads the file count from `fetchChatChanges`.
> - **Also changed.** `app-shell.css` lost 59 dead `.rama-msg/md/tool-call/code-fence/…` rules.
>   `chat/Markdown.tsx`, `CodeFence.tsx`, `PathLink.tsx` and `diff/DiffView.tsx` are deleted
>   (`splitMarkdownBlocks` moved to `markdown/splitBlocks.ts`, `isPathShape` to
>   `transcript/pathShape.ts`). The sidebar no longer floats the active project to the top: the
>   mockup keeps the order, and this was a CR2 mismatch on every demo-project chat.
> - **Harness.** `--region chat` (the mockup's `#codeScroller`); the mockup is scrolled to the bottom
>   by default because the app opens there (scenario `scroll: "top"` overrides); `rows-*` scenarios
>   expand every row. The fixture engine plays a scripted run for Code chats (thinking, a streamed
>   `bun test`, a streamed reply), as it already did for Home.
>
> **Not built yet (CR7).** The ask card has Allow once and Deny; "Always allow in this chat" needs
> E3. E2 (the sidebar flag for a waiting chat on a non-active chat) is untouched.
>
> **Not verified.** A live run against a real model, and a real Tauri window (everything above is
> headless Chrome against the fixture). E5's regexes are tested on sample output only. The landing
> screen is still the legacy welcome (CR8).

> **CR7 status (2026-10-06): built, uncommitted.** The cards were built in CR6; this phase is the
> engine half and what it unlocks.
>
> - **E3, "Always allow in this chat".** The ask card has the mockup's three buttons. `approvePermission`
>   carries `scope`; an *approval* with scope `chat` writes the tool to the chat's `permissionAllow`,
>   a Deny never does. `gate()` skips its **prompt** for a listed tool, but `deny` rules and plan
>   mode are checked first and still win. The list holds a tool's settings bucket (`bash`, `edit`,
>   `write`, `web`), a browser action's own bucket (`browser_action`, so approving a click never
>   approves opening a page), or the tool's name when it has no bucket (`git_write`, `file_op`).
>   It is per chat: another chat still asks.
> - **E2, the sidebar flag.** `ws.ts` watches every `status` event a run or the gate broadcasts and
>   repeats a change of kind (idle / working / waiting) as `chat.status` on the project topic. The
>   main window (`ProjectsProvider`) subscribes to every project and patches `chat.status`, so the
>   warn flag and the running dot work on chats that aren't open. A fetched `ChatDTO` carries the live
>   state too, so a window that starts mid-run is right from the first paint.
> - **Subscribing to a waiting chat shows its card.** The engine replays unanswered asks to a socket
>   that subscribes late (`subscribeChat`), and says `waiting_permission` rather than "streaming".
>   Without this the flag would lead to a chat with nothing to click. (The old handler broadcast
>   "streaming" to everyone; that now goes to the subscriber only, since it would otherwise reset
>   the sidebar's state.)
> - **Parity.** Every scenario still passes; `flash` went 0.29% → 0.19% because the third button
>   matches. What remains is the Undo button (§9.27).
> - **Tests.** Engine 319 (+8: allow keys, scope once/chat, per chat, Deny never remembers, plan mode
>   still blocks, revoke, live status, pending replay), desktop 93. The permission tests run
>   against the real `~/.rama/rama.db` like `home.test.ts` and delete what they make.
> - **Fixture.** The fake socket keeps every command in `window.__fixtureCommands` and exposes
>   `window.__fixtureEmitProject(projectId, event)`, so a test can click a button and read what was
>   sent, or play a `chat.status` frame.
> - **Not verified.** A real model asking for a real permission. The fixture shows the card and
>   proves the command sent; the engine side is covered by unit tests.

### CR7: Transcript cards (plan, changes, permission, clarify) and their engine bits

- **Plan card** (mock:430–440, 1695–1700):
  - `.plan` (`--raised`, radius 14, padding `14px 16px 10px`, max 66ch).
  - Head: **Plan** and "N of M done". A 4px `--well` bar with an accent fill.
  - Items: an 18px `.tick-circle` (done fills with the accent and a check; done
    text goes `--ink-3`), 15px text.
  - **Active item**, which the mockup doesn't show: the circle gets an accent ring
    and a 6px accent dot, and the text is `--ink-1` (§9).
  - Data comes from `todo.updated`, plus the todo tool's input and result on
    reload. Add `todos` to `SessionProvider`: subscribe to `todo.updated` and seed
    from `GET /chats/:id/todos` (E6).
- **Changes card** (mock:442–449, 1701–1707): it appears at the end of any
  assistant turn whose run mutated files.
  - Files are taken from that message's edit, write, file_op and test tool calls,
    de-duplicated, with summed `+N −M`.
  - Head: **Changed N files** plus the summed delta.
  - Rows: `.cf-row` with a pencil or file-plus icon, the name, the dir in `small`,
    and the delta. Clicking one runs `goto("changes:path")`.
  - Foot: `.btn.btn-soft` "Review in Changes" (`changes` icon) and `.btn.btn-ghost`
    "Undo these changes" (`undo` icon). Undo is shown only on the last run's card
    and calls the existing `restoreLastRun()`. After an undo the card dims and its
    foot reads "Undone".
- **Permission ask** (mock:451–461, 1709–1714) replaces the inline approve/deny box.
  - Card: warn-tinted `.ask` with an `h4` (shield icon plus a **question
    sentence**), a `code` line for the literal action, a `p` explanation, and three
    buttons: **Allow once** (`.btn`), **Always allow in this chat**
    (`.btn-ghost`), **Deny** (`.btn-ghost`).
  - Copy table (`permissionCopy.ts`, tested):
    - **bash**: "Run this command?" / the command / "It runs in {cwd} on this Mac."
      Background bash adds "It keeps running after you say yes, until you stop it."
    - **edit / write**: "Edit {name}?" / the path / "{+N −M} in your working tree.
      You can undo it afterwards." When the file doesn't exist: "Create {name}?".
    - **git_write commit**: "Commit these changes to {branch}?" /
      `git commit -m "…"` / "This records the N changed files on your local
      **{branch}** branch. Nothing leaves this Mac until you push."
    - **git_write** other ops: a sentence per op.
    - **browser open**: "Open {host} in the Web pane?" / the url / "The page stays
      open after this turn ends. Rama can read it, but can't sign in for you."
    - **browser actions**: "Click "{label}" on {host}?" and similar.
    - **process kill**: "Stop {title}?".
  - "Always allow in this chat" needs **E3**.
  - While an ask is pending, the turn's `TurnActions` are hidden (mock:1730) and the
    sidebar row shows the warn flag (E2).
- **Clarify card** (not in the mockup): a neutral `.ask` variant with a `--raised`
  background and `--line` border, an `ask` icon, the heading "A few questions
  first", and the questions as an `ol` with "(default: …)" in `--ink-4` (§9).

**Engine and protocol work landing in CR7:**

- **E3 — permission scope.**
  - Protocol: `approvePermission` gains `scope?: "once" | "chat"`.
  - Engine: `resolvePermission(reqId, approve, scope)`. A `chat` scope writes
    `chatPermissionAllow: string[]` (tool buckets from `permissionToolFor`) into
    the chat's `settings_json`.
  - `requestPermission` checks that list before broadcasting, and auto-allows.
  - `ChatSettingsDTO` exposes the list so a later UI can show and revoke it.
  - Tests in `permissions.test.ts`.
- **E2 — attention state across chats.**
  - While a request is pending, the engine sets `chats.status = 'waiting'`, and
    back to `'running'` / `'idle'` after.
  - It broadcasts `{ type: "chat.status"; chatId; status }` on the chat's
    **project** topic.
  - The main window subscribes to every project's topic (not just the active one)
    so `SidebarCodeList` can show `.flag` for any chat, and a running dot for
    running chats (§9).
- **E6 — `GET /chats/:id/todos`**, so a reloaded chat's plan card renders before
  the next `todo.updated`.

**Acceptance.** The "flash" fixture's last two turns match the mockup pixel for
pixel. On a real project, an edit-heavy run ends with a correct Changes card,
"Always allow" really suppresses the next ask for that tool in that chat (and only
that chat), and the sidebar flag appears on a non-active chat that's waiting.

### CR8: Code landing (new chat / draft) and empty states

> **CR8 status (2026-10-06): built, uncommitted.**
>
> - **`CodeLanding`** replaces the legacy welcome: fluke, the project's name, the composer, and up to
>   three "Recent in {project}" rows. Its frame (`.r-landing-inner`, greeting, `.r-resume*`, `.arrive`)
>   is Home's, imported from `home/home.css`, since the mockup draws one `.landing-inner` for both tabs.
>   The arrival timing was read back from the running app: fluke 0s, greeting 80ms, composer 160ms,
>   resume fade 300ms; the composer takes focus at 50ms.
> - **A landing always has a composer.** If no chat is on screen (none yet, or the last one was
>   deleted) `CodeChat` opens the active project's draft, so there is something to send into.
> - **Resume rows** open a chat through `useOpenChat`, which the sidebar now uses too (select it if it's
>   a tab here, adopt it if no window has it, otherwise focus the window that does).
> - **Empty states** are as planned: no project → "Code", and a card with "Add a project…" (it fires the
>   sidebar's `rama:open-add-project`); no provider → the setup wizard in a card; a project with no chats
>   hides the resume section. Fixture params `&empty=projects` and `&empty=providers` show them.
> - **Parity:** two new scenarios, `landing-rama` and `landing-demo`, pass at 0.04–0.14% across wakaba,
>   kanagawa, sumi and shu at 1440×900, 1100×800 and 900×800 (24 runs); the other 15 scenarios are
>   unchanged. Not checked: a real Tauri window, and the two empty states against a drawing (the
>   mockup has none).

`app/code/CodeLanding.tsx` replaces the legacy `.rama-welcome` (mock:799–809,
1881–1896).

- `landing-inner`: flex column, centred, padding `11vh 24px 56px`.
- Contents:
  - 40×34 accent fluke
  - `h1.greet` with the **project name** in Literata 44px × scale, line-height 1.1,
    tracking −0.015em, `text-wrap: balance`, margin `14px 0 30px`
  - the composer (landing variant, `min(680px,100%)` wide)
  - `.resume`: "Recent in {project}", then up to three `.resume-row`s with title,
    relative time, and a one-line snippet. Clicking one opens the chat.
- **Arrive animation** (mock:224–229): the fluke, greeting and composer `rise` in
  over 0.7s with 0, 80 and 160ms delays, and the resume list fades in after 300ms.
  It replays each time the landing is entered, and respects reduced motion.
- **Relative time** (`relativeWhen.ts`, tested): "Just now" under 2 minutes, "N
  minutes ago", "Earlier today", "Yesterday", "N days ago" under 14, then "D Mon".
- **E1 — chat snippet.** Add a `snippet` column to `chats`, set at run end to the
  first sentence of the final assistant text with markdown stripped, at most 120
  characters. Expose it on `ChatDTO.snippet: string | null`, and backfill lazily on
  read for old chats. An ask-pending chat's snippet is "Waiting for your OK to
  {verb}." (mock:1341).
- **Empty states** (not in the mockup; same landing layout, §9):
  - *No projects:* greeting "Code", the composer replaced by a `.card` with "Add a
    project to start" and a `.btn` "Add a project…".
  - *No providers:* the greeting stays and the composer is replaced by today's
    `ProviderSetupWizard`, restyled minimally into a `.card`. A full wizard
    redesign is out of scope.
  - *New project with no chats:* the resume section is hidden.
- ⌘N and sidebar "New chat" open the active project's draft (today's `openDraft`).
  The project label's `+` opens that project's draft.

**Acceptance.** The landing matches mock `#code` → **New chat** for Rama and for
demo-project, including the arrive timing (checked with a 0, 200 and 900ms frame
capture).

### CR9: Parity sweep and legacy removal

> **CR9 status (2026-10-06): built, uncommitted. Sweep clean; two items deliberately left open (below).**
>
> - **Sweep: 306 / 306 pass.** All 17 scenarios × {wakaba, nami, kanagawa, sumi, shu, matsu} ×
>   {1440×900, 1100×800, 900×800}, typically 0.02–0.3% differing pixels, 0 bad blocks. Two cases
>   failed in the first serial pass (`rows-flash-700` kanagawa 1440×900 at 3.74%, `rows-about` matsu
>   1440×900 at 2.93%); both passed on a rerun with the tree untouched, so they were HMR reloads from
>   an edit made mid-run, not diffs. The first run stalled at case 257 (a hung Chrome), so the last 47
>   cases were rerun by id.
> - **Legacy CSS removed** from `app-shell.css` (565 → ~403 lines): the `--measure*` tokens, body grid,
>   `.rama-messages`, the old model menu, artifact rows, terminal/web surfaces, omnibox spinner and
>   the unused diff selectors; plus one dead rule in `transcript.css`. Each selector was checked for
>   zero users first. `.rama-model-menu-badge` stays (ProvidersSettingsPane). Comments that named
>   deleted files (ChatColumn, ModelPicker, StatusBar, AgentPicker) now name CodeChat, CodeComposer
>   and the composer's model menu.
> - **Item 4 (delete legacy code):** the legacy TSX files were already gone by CR2–CR8 (see the staged
>   deletions); CR9 only finished the CSS. The Google Fonts `<link>` **stays**, see §9.38.
> - **Accessibility.** The workspace splitter is focusable (`tabIndex 0`); ←/→ resize by 24px
>   (`useWorkspaceGeometry.nudgeWidth`, clamped, persisted like a drag), Enter resets, and the grip
>   takes the ring on `:focus-visible`. `aria-valuemin/now` are set. Esc on a popover now returns focus
>   to its trigger when focus was inside the box (or nowhere): a change to the shared kit `Popover`,
>   which Home also uses (§9.39). Tab order checked live: sidebar, topbar, transcript, composer,
>   splitter, workspace. Matsu and Rokushō were looked at by eye.
> - **Performance: not measured.** Row and diff bodies already mount only when open, and workspace
>   drag is DOM-only. But `CodeChat` rebuilds every turn through `buildTranscript` on each stream tick
>   and `TurnView` isn't memoised, so a 300+ block transcript re-renders in full per tick. If it shows
>   up as slow, the fix is to cache each finished turn by message id in `buildTranscript` (a plain
>   `React.memo` won't help while the turn objects are fresh).
> - **Not done:** moving `mission-control/panes/*Context` into `code/workspace/`; roving tabindex and
>   arrow keys on the workspace tablist.
> - **Not verified:** a real Tauri window, hover states in the dark themes other than Matsu and
>   Rokushō, and Esc/focus return on every popover (checked on the model menu).
>
> Sweep hygiene, if you rerun it: never run shards in parallel (the app renders blank), don't edit app
> or fixture files while it runs (HMR reloads show up as diffs), and after killing `parity.ts` clear its
> orphaned Chromes with `pkill -f "user-data-dir=/var/folders/.*/rama-parity-"`.

1. Run `scripts/parity.ts` across every fixture chat × {wakaba, nami, kanagawa,
   sumi, shu, matsu} × {1440×900, 1100×800, 900×800}. The target is ≤0.5% differing
   pixels per screenshot, excluding text-antialiasing noise (pixelmatch threshold
   0.1). Every remaining diff is either fixed or listed in §9.
2. **Dark-mode walk.** Check every hover and selected state in a dark theme. The
   mockup's dark derivations (mock:63–75) were tuned against Kanagawa, so verify
   Matsu (veil 0.8, image) and Rokushō (custom warn) by eye too.
3. **Accessibility.**
   - Tab order: sidebar, topbar, transcript, composer, workspace.
   - `aria-expanded` on act rows, `aria-pressed` on toggles, `role="tablist"` on
     workspace tabs, `role="separator"` on the splitter with arrow-key resize
     (±24px).
   - Focus rings use the mockup's `--ring`.
   - Popovers trap Esc and return focus to their trigger.
4. **Delete legacy code:**
   - `Titlebar.tsx` and `ThemePicker.tsx` (once HR's popover lands)
   - `HomePane.tsx` (HR)
   - `ChatColumn.tsx`, `AgentPicker.tsx` and `ModelPicker.tsx` (logic now in
     `ModelMenu` / `ModeMenu`)
   - `MissionControl.tsx`, `Rail.tsx`, `Stage.tsx` and `Splitter.tsx` (replaced by
     the workspace splitter)
   - `useMissionControlGeometry.ts`
   - the matching `app-shell.css` blocks (titlebar, sidebar, body grid,
     chat-column, messages, tool-call, thinking, status-line, composer, pills,
     tiles, welcome, home) and most of `mission-control.css`
   - the Google Fonts `<link>`s
   - `WallpaperStack`'s dot field, vignette, wash and grain, *if Q2 says retire*
5. **Performance.**
   - Long transcripts (more than 300 blocks) must scroll at 60fps. Memoize turns by
     message id. Diff bodies mount only when expanded.
   - Workspace drag stays DOM-only, never through React state.

---

## 6. File map

```
packages/ui/src/
  tokens-v2.css            CR0   new token layer (§4)
  primitives-v2.css        CR0   shared classes (§3)
  components/Icon.tsx      CR0   mockup icon set
  themes/*.json            CR2   + "kanji" field
apps/desktop/public/fonts/ CR0   self-hosted woff2
apps/desktop/src/app/
  shell/                   CR2   Shell, Sidebar (frame), SidebarCodeList, Topbar, Seal, MainWall, shell.css
  composer/                CR5   ComposerBase, ModelMenu, modelVisibility, composer.css   (shared)
  transcript/              CR6   ActRow, Prose, UserTurn, TurnActions, Working, Notice  (shared)
  code/
    CodeView.tsx           CR3   .code-body: CodeChat | splitter | Workspace
    CodeChat.tsx           CR6   container (the surviving ChatColumn logic)
    CodeLanding.tsx        CR8
    composer/              CR5   CodeComposer, ModeMenu, ContextChips
    transcript/            CR6-7 buildTranscript(+test), permissionCopy(+test), toolRows,
                                 PlanCard, ChangesCard, AskCard, ClarifyCard
    workspace/             CR3-4 Workspace, WorkspaceTabs, useWorkspaceGeometry, goto,
                                 panes/{Changes,Terminal,Web,Files}{Head,Rail,Stage}.tsx
    code.css, transcript.css, workspace.css
  fixtures/                CR1   codeFixture + fixture providers (dev only)
scripts/parity.ts          CR1
engine/src/…               CR7-8 E1 snippet, E2 chat.status, E3 permission scope, E5 summaries, E6 todos route
```

The pane *contexts* stay where they are, in `mission-control/panes/*PaneContext.tsx`.
Move the folder to `code/workspace/` only in CR9, to keep diffs readable.

---

## 7. Mockup selector → component index

| Mockup (CSS / JS lines) | Component | Phase |
|---|---|---|
| `.sidebar`, `.sb-top`, `.seg`, `.sb-nav`, `.sb-foot` (98–163) | `shell/Sidebar` | CR2 |
| `.project-label`, `.chat-row`, `.flag` (147–156, 493–498) | `shell/SidebarCodeList` | CR2 |
| `.main`, `.wall`, `.veil`, `.topbar`, `.chat-title` (166–181) | `shell/Shell`, `MainWall`, `Topbar` | CR2 |
| `.crumbs`, `.chip`, `.top-actions`, `.cmd-btn` (381–395) | `Topbar` (Code slots) | CR2 |
| `.seal` (185–197) | `shell/Seal` | CR2 |
| `.code-body`, `.splitter`, `.ws`, `.ws-tabs`, `.ws-tab` (375, 509–531) | `Workspace`, `WorkspaceTabs` | CR3 |
| `.stage-bar`, `.rail-head`, `.stage`, `.rail` (532–547) | `Workspace` grid + pane heads | CR3/CR4 |
| `.rrow`, `.rdir`, `.sdot` (549–564) | pane rails | CR4 |
| `.tree-row` (566–573) | `FilesRail` | CR4 |
| `.ftabs`, `.ftab` (575–583) | `FilesStageBar` | CR4 |
| `.urlbar`, `.page` (585, 591) | `WebStageBar`, `WebStage` | CR4 |
| `.diff`, `.dl`, `.hunk`, `.codeview`, `.cl`, `.term`, `.t-*` (466–491) | `DiffView`, file view, xterm theme | CR4 |
| `.composer`, `.composer-row`, `.tool-btn`, `.model-pill`, `.send`, `.privacy` (232–279) | `ComposerBase` | CR5 |
| `.ctx-row`, `.mode-pill`, `.ring` (398–404) | `CodeComposer`, `ContextChips` | CR5 |
| `#modelPop`, `#modePop`, `.mp-*` (658–666, 2004–2021) | `ModelMenu`, `ModeMenu` | CR5 |
| `.transcript`, `.scroller`, `.dock` (283–285, 379) | `CodeChat` | CR6 |
| `.turn-user`, `.bubble` (287–293) | `UserTurn` | CR6 |
| `.acts`, `.act-btn`, `.act-body`, `.files`, `.link` (304–319, 409–420) | `ActRow` + `toolRows` | CR6 |
| `.prose`, `.path`, `.card.code-card` (321–348, 422–428) | `Prose` (Markdown) | CR6 |
| `.turn-actions`, `.working` (352–360) | `TurnActions`, `Working` | CR6 |
| `.plan`, `.tick-circle` (430–440) | `PlanCard` | CR7 |
| `.changes-card`, `.cf-row`, `.card-foot` (442–449) | `ChangesCard` | CR7 |
| `.ask` (451–461) | `AskCard`, `ClarifyCard` | CR7 |
| `.landing-inner`, `.greet`, `.resume*`, `.arrive` (203–229) | `CodeLanding` | CR8 |

---

## 8. Engine and protocol additions (summary)

| Id | Change | Needed by |
|---|---|---|
| E1 | **Built (CR8), differently.** No column: `GET /projects/:id/recent-chats?limit=3` returns the newest Code chats as `RecentChatDTO` (`ChatDTO` + `snippet`), the snippet computed on read from the last assistant reply (Home's `snippetFromText`), or "Waiting for your OK to {verb}." while the chat has an unanswered ask (§9.36) | CR8 resume rows |
| E2 | **Built (CR7).** Each chat's live state (`SessionStatusState`, so `waiting_permission`, `thinking`, `tool`…) is kept in memory in `ws.ts` and broadcast as `chat.status` on the project topic; `ChatDTO.status` reads it; the main window subscribes to every project topic. Not persisted, so a crash can't leave a chat "working" forever | CR2 flag, CR7 |
| E3 | **Built (CR7).** `approvePermission.scope: "once" \| "chat"`; per-chat allow list in `chats.settings_json` (`permissionAllow`, on `ChatSettingsDTO`, replaceable by `PUT /chats/:id/settings`) | CR7 ask card |
| E4 | *(optional)* `regenerate` command: undo the last run's file changes, drop the last assistant message, re-run the last user turn | CR6 Retry |
| E5 | Richer summaries: git_write commit → `committed · {branch} {sha7}`; bash → append `· N passed` / `· N failed` when the output tail matches a bun, jest, vitest, pytest or cargo test summary (regexes in `engine/src/tools/testSummary.ts`, tested) | CR6 rows |
| E6 | ~~`GET /chats/:id/todos`~~ **Dropped** — the plan card is folded from the `todo` calls (CR6) | — |
| R1 | *(optional, Rust)* round the native child webview's corners (macOS: `CALayer.cornerRadius = 12` with `masksToBounds` on the webview's NSView) so the Web stage matches `.page` | CR4 parity |

---

## 9. Deliberate deviations and design gaps

These are things the mockup doesn't show but the real app needs. Each gets the
minimal treatment noted here, built from mockup primitives. Review them; any of
them can become a design ask.

1. **Sidebar nav counts** (Docs n, Toolbox "n tools · n mcp") are removed to match
   the mockup.
2. **Project groups no longer collapse.** The project `⋯` menu moves to a right-click
   on the label. Rename and branch editing happen inline.
3. **Chat search** reuses the `.nav-row` look as an input.
4. **Running chats** in the sidebar: a 7px accent dot with a soft pulse, in the same
   slot as the warn `.flag`. The mockup only has the warn flag.
5. **Extra-folder chips** in the composer, and **Add folder** opens a one-field
   popover.
6. **Send becomes Stop** while busy. The busy counters (elapsed time, tokens,
   thinking time) move to the Working row's tooltip, and the "⇧⏎ / esc" hint is
   dropped.
7. **Bad provider** shows as a red dot on the model pill plus a fix row in the
   model menu (it was a titlebar dot).
8. **Changes pane extras**: icons and sub-labels for deleted, renamed, untracked and
   conflicted files; the staged/unstaged switch as a `.mini-seg` in the stage bar;
   merge and rebase state in the rail head; and a flat grouped list instead of a
   nested tree.
9. **Close affordances** (`x`) on terminal and page rows appear on hover. The Web
   rail keeps its `+`. The Files wrap toggle becomes an icon button, and the
   ignored-files toggle moves to a right-click menu.
10. **Rail width is fixed** at 212 or 48. Rail resizing is dropped.
11. **Plan card active item** gets a ring and a dot. The **clarify card** is a
    neutral `.ask`.
12. **Attach in Code** inserts `@path` mentions, with no binary upload.
13. **Retry** — see 28.
14. **Empty states**: no projects, no providers, and a not-a-repo Changes pane.
15. **The native webview's corners** stay square without R1.
16. **Terminal idle** is a client-side heuristic: no output for 60s on a running shell (CR4 raised it
    from 10s; a dev server that is quiet for 20s is still running).
17. **Add project** stays in the sidebar list as a quiet row after the last project. The mockup has
    no slot for it, and the composer's folder pill only exists inside a chat.
18. **Terminal rows have no `⌘N` hint.** ⌘1–9 already selects a window tab.
19. **Files keeps the git letter and a wrap toggle** that the mockup does not draw.
20. **Diffs and file views draw function names plain**, like the mockup; only transcript code fences
    colour them.
21. **The Code composer is the kit's** with Code's slots; models are Home's shortlist, and a down
    provider is marked in the menu rather than hidden or shown as a pill dot.
22. **The project chip is a menu on existing chats too** ("New chat in …"), and re-targets a draft.
23. **Attach completes a project path** and types `@path`; no native picker, no upload.
24. **The model pill stays live during a run** and applies from the next turn; the mode pill locks.
25. **Rows are built from what the engine records**, so the mockup's richer sample text isn't
    reproduced word for word. Where the mockup invented prose for a row ("Checked a cold start in
    the Web pane · no flash", the reviewer's sentence), the app says what the call says ("Opened
    localhost:1420 in the Web pane", the review's one-line result). "Looked through 9 files" in the
    `about` chat is 10 (a glob's matches count as files looked through). These are the only words
    that differ in the `flash` and `about` rows.
26. **Output cards are plain text.** The engine stores a command's output without the mockup's accent
    prompt, check marks and muted timings, and a foreground command has no terminal id, so there is
    no "Open in Terminal →" under it (a background command has one).
27. **Undo these changes** shows only on the card of the last run. The shadow checkpoint is taken
    when a run starts, so after a later run (the pending commit in `flash`) it would restore to
    where things already are. The mockup draws it on that card anyway.
28. **Try again** is enabled on turns that changed no files (it uses Home's `/chats/:id/retry`,
    which drops the turn and re-runs it on the current tree). On a turn that edited, the button is
    not drawn, because a re-run would apply on top of the earlier edits. E4 stays optional. This
    replaces §9.13.
29. **Path pills are for file names only.** `packages/ui/src/theme.tsx` is a pill; `apps/desktop`,
    `~/.rama/themes` and globs stay code, as the mockup draws them.
30. **Project order in the sidebar is fixed** (the old list floated the active project to the top).
31. **Notices can be dismissed** (a 16px `x` on hover), and a failed run's notice is in `--bad` with
    Try again when the last turn changed nothing.
32. **A failed call reads "Couldn't edit theme.tsx"** with the reason in the bad colour ("refused",
    "exit 2", "timed out"), rather than the completed verb with a failure meta.
33. **Mermaid** is drawn with `securityLevel: "strict"` inside the same card as other fences.
34. **"Always allow in this chat" is by tool, not by command.** Approving one `git commit` allows
    every `git_write` call in that chat, and approving one `bash` call allows every bash call
    (including `process` kills, which ride on `bash`'s bucket). The mockup's button doesn't say
    which; a narrower rule ("this exact command") would turn into a prompt every time the model
    varies a flag. `deny` rules and plan mode still win. There is no UI to see or revoke the list
    yet; `PUT /chats/:id/settings {permissionAllow}` does it.
35. **The waiting and running state is not stored.** `chat.status` is live memory in the engine, so
    after an engine restart every chat reads idle (a pending ask dies with the run anyway).
36. **E1 is computed, not stored, and "N days ago" runs to 60.** The plan asked for a `chats.snippet`
    column set at run end. The landing needs three snippets, and Home already computes its own on read
    (HD3), so Code does the same through `recent-chats`: no migration, no backfill, no way for a stored
    snippet to go stale. If it ever shows up as slow, the column is still the fix. The plan also said
    "N days ago" under 14; the mockup's demo project reads "19 days ago" and "25 days ago", so it runs
    to 60, then a date (`relativeWhen.ts`). A waiting chat's row names what a yes would do with a short
    verb table (`waitingVerb` in `db/snippet.ts`), kept in step with `permissionCopy.ts` by hand.
37. **The landing's CSS is Home's.** `CodeLanding` imports `home/home.css` for the landing frame, so a
    rename of those classes on Home's side breaks Code's landing. Both landings have a parity run
    (`landing-*` here, Home's own sweep there), which is how it would be caught.
38. **The Google Fonts `<link>` stays (CR9).** `index.html` and `fixture.html` still load JetBrains Mono,
    Martian Mono and DM Mono. The settings modal, Toolbox and Docs headers and the provider wizard use
    `--font-display` and `--font-code` (`packages/ui/src/tokens.css`), so dropping the link would change
    those screens. Removing it needs those screens moved to the kit's fonts first.
39. **CR9 touched the kit.** `packages/ui/src/kit/Popover.tsx` returns focus to the anchor on Esc, only
    when focus is in the box or on nothing. It is additive and Home is unaffected unless it opened a
    popover by keyboard, where it now behaves better; Home's sweep should be rerun before committing.
40. **A pre-existing engine type error.** `engine/src/agent/run/hooks.test.ts` lacks `blocks` on its
    `StepResult` literals (six `tsc` errors). The file is unmodified in this working tree and the tests
    pass under `bun test` (326). Not caused by the redesign.

---

## 10. Open questions for Ruchit

1. **Theme scope.** Today a chat carries its own theme, and switching chats
   re-themes the app (`ProjectsProvider.selectChat` → `applyTheme`). The mockup's
   popover says "Applies to Home and Code", which reads as one global theme. If it
   goes global, CR2 removes the per-chat `applyTheme` calls; HR owns the engine
   change. *Recommendation: global.*
2. **Retire the texture layers** (dot field, vignette, accent wash, grain)? The
   mockup has none of them. *Recommendation: retire them app-wide in CR9. They're
   the "terminal look" the redesign is moving away from.*
3. **Shared-foundation ownership (§3).** Is it OK for the Code track to land CR0
   (tokens, fonts, icons, primitives) and the CR2 shell frame first, with Home
   consuming them? If the Home chat is already building its own shell, decide
   which one survives before CR2.
4. **Retry.** Build E4 (regenerate) as part of this redesign, or ship Retry
   disabled?
5. **Busy counters.** Is a tooltip enough for elapsed time, tokens and thinking
   time, or do you want a quiet inline "· 12s" after the verb?

---

## 11. Out of scope

- The Home tab, and the seal popover's contents (HR).
- Restyling the Settings modal, Toolbox page, Docs page and ⌘K palette. They'll pick
  up tokens-v2 fonts through inheritance, but keep their legacy layout and classes
  until their own pass. *Suggested next plan:* "Pages & modals v2", reusing
  `.pop`, `.mp-item` and `.card`.
- `ProviderSetupWizard` redesign (CR8 only wraps it in a card).
- Below-860px layouts. The window's `minWidth` is 860, so the mockup's 820px and
  560px rules are not built, except the 1100px sheet.
