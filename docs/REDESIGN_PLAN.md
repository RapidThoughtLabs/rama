# Rama — Redesign Implementation Plan (pass 01)

Phases here are numbered **R0–R7** so they never collide with the build phases
0–8 in `docs/IMPLEMENTATION_PLAN.md`, which existing code comments cite by
number. Cite these as "REDESIGN_PLAN.md Phase R2".

Direction and mockup: https://claude.ai/code/artifact/ebcf955b-60aa-4a37-8c53-90462ea55414

**Ordering rationale.** R0 is first because every later phase writes CSS against
its token names; doing it second means writing the same CSS twice. R1 is cheap
and it is the identity, so it lands early. R2 and R3 are one piece of layout
surgery — both rewrite `.rama-frame`'s grid — and should land together. R4 needs
R2's footer entry point. R5/R6 are content moves. R7 is nearly free once R0 held.

**Rules that hold across every phase.**
- Each phase ships runnable. `main` never boots broken.
- No color outside the theme contract. If a component needs a color, it reads a
  token or it becomes one.
- Anything touching CSS is checked in **kanagawa and foam** before it lands.
  Foam is the light theme; it is the test that catches tokens that only read
  right on a dark ground.

---

## Phase R0 — The theme contract ✅ done

Replaced the `data-theme` (dark|light) × `data-accent` (six hues) cross-product
with a single `data-rtheme`, where one named theme sets the entire palette.

**Q1 resolved:** killed the per-theme custom accent knob entirely — accent is
baked into the theme, no override. Consistent with "themes, not accents."

### Course correction from the original plan: no `--sf-hi`/`--sf-lo` rename

The plan above (as originally written) assumed `--sf-hi`/`--sf-lo` just needed
splitting into a triplet + two theme-level alphas. Reading the actual call
sites in `app-shell.css` and `primitives.css` first showed that was wrong:
every call site already carries its **own** bespoke alpha —
`rgba(var(--sf-hi), 0.52)`, `rgba(var(--sf-hi), 0.96)`, `rgba(var(--sf-lo), 0.32)`
— 13 sites in `app-shell.css`, 2 in `primitives.css`, each alpha chosen per
surface depth (a subtle overlay vs. a near-opaque dropdown), not a hi/lo binary.
Forcing those into two fixed theme-level alpha tokens would have destroyed that
per-site differentiation for no benefit. **`--sf-hi` and `--sf-lo` stayed
exactly what they were** — two rgb triplets, one per glass tier — and every
call site was left untouched. Lower risk, less churn, same result.

While auditing real usage the same pass found four tokens declared in the old
`tokens.css` with **zero consumers anywhere** (`--bg-overlay`, `--border-4`,
`--grid-color`, `--nav-bg`) — dropped from the new contract — and one real bug:
`--a08` was referenced at `app-shell.css:369` but never defined (silently
rendered no hover background). Added it to the ramp.

### The contract that shipped

Every theme sets this set (`packages/ui/src/tokens.css`), and nothing outside
it — ~24 custom properties, formulaic where the old six-accent system was
hand-tuned per hue (`--accent-bright/-hi/-dim/-glow/-tint/-border` are all
`oklch(from var(--accent) …)` derivations, not separately authored colors):

```css
[data-rtheme="kanagawa"] {
  color-scheme: dark;
  --bg-base: #081420; --bg-deep: #061019; --bg-surface: #10283A; --bg-elevated: #15334A;
  --text-1: #dce7ee; --text-3: oklch(from var(--accent) 0.66 0.08 h); --text-4: oklch(from var(--accent) 0.60 0.06 h);
  --border-1/-2/-3: rgba(111,182,230, .06/.11/.20);
  --accent: #6fb6e6;
  --accent-bright/-hi/-dim/-glow/-tint/-border: oklch(from var(--accent) …);  /* derived */
  --page-bg: var(--bg-base);
  --ink: 214,226,232;  --ink-hi: #f3ecdd;
  --sf-hi: 21,51,74;   --sf-lo: 14,35,53;   --rc: 5,14,23;
  --good: #8cc9a0; --warn: #e6c384; --bad: #e8808a; --bad-2: #f0a0a8; --warn-rgb: 230,195,132;
  --grain-op: .28; --vig-a: .58; --dot-field-color: rgba(111,182,230,.34);
  --shadow-menu / --shadow-composer: …;
}
```

`--a70 … --a06` (plus the newly-added `--a08`) stay derived from `--accent` via
the relative-color syntax already in `tokens.css`. The theme sets one accent;
the ramp follows for free.

### Files (what actually changed)

| File | Change |
|---|---|
| `packages/ui/src/themes.ts` | **NEW.** `ThemeId`, `RamaTheme` interface, `THEMES` registry (id/label/mode/preview swatch only — CSS stays the single source of truth for real values), `getTheme()`. |
| `packages/ui/src/tokens.css` | **Rewritten.** Six `[data-accent]` blocks and both `[data-theme]` blocks gone. Three `[data-rtheme]` blocks (kanagawa/sumi/foam). Kept: font stack, foundations, keyframes, `.t-*`, the `--a*` ramp (now `--a08` too). `--sf-hi`/`--sf-lo` unchanged (see course correction above). |
| `packages/ui/src/primitives.css` | Dropped the dead `[data-theme="dark"] .rama-btn-primary` glow gate — the glow now lives per-theme in `tokens.css` (kanagawa/sumi only; foam has none). |
| `packages/ui/src/theme.tsx` | **Rewritten.** `ThemeState` → `{ themeId, wallpaper, dim }`. Dropped `accent`, `toggleTheme`, `cycleAccent`; added `cycleTheme`. **Kept `applyTheme`.** Effect sets `root.dataset.rtheme` + resolves mode from the registry for the veil floor. |
| `packages/ui/src/DotFieldBackground.tsx` | MutationObserver filter `["data-theme","data-accent"]` → `["data-rtheme"]`. |
| `packages/protocol/src/index.ts` | `ThemeModeDTO` → `ThemeIdDTO` (`"kanagawa"\|"sumi"\|"foam"`); `ChatDTO`/`CreateChatInput`/`UpdateChatInput`'s `.theme`+`.accent` collapsed to `.themeId`. |
| `engine/src/db/schema.ts` | Added `theme_id TEXT NOT NULL DEFAULT 'kanagawa'`. Kept `accent`/`theme` columns for one release (nothing reads them anymore). |
| `engine/src/db/chats.ts` | `ChatRow`/`toDTO`/`CHAT_COLUMNS`/`createChat`/`PATCHABLE_COLUMNS` all moved from `accent`+`theme` to `theme_id`. |
| `engine/src/db/index.ts` | `addColumnIfMissing` now returns whether it actually added the column; on first add of `theme_id` runs the migration `UPDATE` below. |
| `apps/desktop/src/app/data/ProjectsProvider.tsx` | All `{theme, accent, wallpaper}` call sites (lines ~77-81, ~113-122, ~137, ~154, ~162-167) → `{themeId, wallpaper}`. |
| `apps/desktop/src/app/Titlebar.tsx`, `CommandPalette.tsx` | `toggleTheme`+`cycleAccent` (two controls) collapsed into one `cycleTheme` control — interim, moves to Settings › Appearance in R3/R4. |
| `apps/desktop/src/app/TerminalView.tsx` | `useTheme()` now reads `themeId` (was `theme, accent`) as the re-theme effect's dependency — the effect itself still just re-reads CSS custom properties. |

### Migration

Implemented as a one-time SQL backfill in `engine/src/db/index.ts`, gated by
`addColumnIfMissing` so it only runs the first time `theme_id` is added to an
existing DB:

```sql
UPDATE chats SET theme_id = CASE
  WHEN theme = 'light' THEN 'foam'
  WHEN accent = 'frost' THEN 'kanagawa'
  ELSE 'sumi'
END
```

Same conservative mapping as originally planned (dark+frost → kanagawa,
light+* → foam, everything else dark → sumi), just run in SQL against the real
columns rather than as a per-row JS function — the DB layer doesn't import
`@rama/ui`, so the mapping couldn't live in `themes.ts` and be called from
there without a wrong cross-package dependency.

### Ship three themes

**kanagawa** (default, Hokusai wave + whale blues) · **sumi** (near-black ink) ·
**foam** (light). Foam exists to prove the contract survives inversion.

**Exit test — passed.**
- `grep -r "data-accent" apps packages` returns nothing.
- `bun x tsc --noEmit` clean on both `apps/desktop` and `engine` (this also
  type-checks `packages/ui`/`packages/protocol` transitively, since both are
  consumed as source, not a prebuilt `dist`).
- Rendered `tokens.css`/`primitives.css` standalone (real files, not a
  reimplementation) with `[data-rtheme]` swapped across all three values —
  every surface (ground, glass tiers, recessed wells, text ramp, badges,
  buttons, modal) changes, all three stay legible, foam confirms the contract
  survives inversion to a light ground.

---

## Phase R1 — The mark ✅ done

**Q7 resolved: bare fluke only, no water-line treatment.** Ship is just
`packages/ui/src/components/Fluke.tsx` — one component, the single `<path>`
from `docs/Rama/logo-exports/rama-fluke.svg` (`fill="currentColor"` already on
the source SVG). The originally planned `<FlukeWater/>` + `useId()`-guarded
`<clipPath>` wasn't built — with no water treatment there's no second shape and
no duplicate-id risk to guard against.

- **Deleted** `apps/desktop/src/app/Mascot.tsx` (413 lines, "heku" the pixel
  octopus) and its `.rama-heku*` CSS block + keyframes in `app-shell.css`.
- `ChatColumn.tsx`: `<Mascot toolCount={toolCount} />` → `<Fluke className="rama-welcome-fluke" />`
  on the welcome screen. Everything else in that block (wordmark, tagline,
  status card, suggestion chips) is untouched — R5 is what trims those.
- `Sidebar.tsx`'s `.rama-wordmark` is now a fluke-icon + "rama" text lockup,
  not fluke alone — a bare icon read poorly as a persistent nav-header brand
  mark at that size.
- Icon set regenerated from `docs/Rama/logo-exports/74525.png` (square,
  512×512) via `bun run --cwd apps/desktop tauri icon <path>` — updates the
  full `src-tauri/icons/` matrix (icns/ico/PNG/iOS/Android).

---

## Phase R2 — Sidebar ✅ done

Split into two passes once implementation surfaced that the project `⋯` menu
needed backend CRUD that didn't exist yet (no update/delete-project route
anywhere — only `createProject`/`fetchProjects`).

### R2a — frame grid + sidebar structural rewrite

**The frame change.** `.rama-frame` went from a `grid-template-rows` stack of
`[Titlebar, .rama-body, StatusBar]` to a flex **row**: `[<Sidebar/>, .rama-main]`,
with `.rama-main` (new) holding the old titlebar/body/status column stack.
`.rama-body` dropped its sidebar grid column entirely (now just chat +
artifacts) — this also deleted `.rama-body-no-sidebar` outright, since "no
sidebar" is now just "that flex sibling isn't rendered" rather than a second
grid-column-count variant to keep in sync.

Traffic lights are OS-native overlay (`titleBarStyle: "Overlay"`, confirmed in
`tauri.conf.json`; no `trafficLightPosition` override needed), always drawn at
the window's top-left corner regardless of DOM — so "moving them into the
sidebar" is really "whichever DOM occupies the top-left corner reserves the
gap." `Titlebar.tsx` takes a `reserveTrafficGap: boolean` prop
(`!IS_MAIN_WINDOW || !sidebarOpen` — computed in `AppShell.tsx`) so it only
renders `.rama-titlebar-traffic-gap` when nothing else is reserving that inset;
`Sidebar.tsx`'s own header always renders `.rama-sidebar-traffic-gap` (62px),
clipped away for free when the sidebar collapses to width 0
(`.rama-sidebar-collapsed`, animated, content survives via a fixed-width
`.rama-sidebar-inner` wrapper so it doesn't visibly reflow mid-transition).

**Cross-window drag fix, found by reading `drag.rs` before shipping the CSS
(the plan flagged this as something to verify, not something to guess):**
`hit_test_tab_strip`'s hover hit-test assumed the tab strip spans the full
window width. For the main window it no longer does — it's `.rama-main`'s
width, offset by the sidebar. Added a hand-kept `SIDEBAR_WIDTH_LOGICAL = 264.0`
constant (mirrors `.rama-sidebar`'s CSS width, same pattern as the existing
`TAB_STRIP_HEIGHT_LOGICAL`) and excluded that offset only for `label == "main"`.
Known gap, left as a comment rather than plumbed further: doesn't account for
main's sidebar being collapsed mid-drag.

**Sidebar rewrite** (`Sidebar.tsx`, `.rama-sidebar*` in `app-shell.css`) — header
(traffic gap + fluke/wordmark lockup + collapse toggle) → search (unwired,
placeholder as before) → nav rows (new chat · new terminal chat · docs ·
toolbox — "toolbox" opens the existing `SkillsModal` for now, the real
Skills+MCP merge is R6) → collapsible project groups (new: local
`collapsedProjectIds` state, tracks the *collapsed* set so new projects default
open with no sync effect needed) → chat rows as the tab list, reusing
`handleChatClick` unchanged, plus a new ownership glyph (⧉) on rows that are a
tab in a different window → footer (settings only — there's no account
concept anywhere in the app yet to put a name next to, so that part of the
original spec was dropped rather than faked).

**Cross-window ownership, for the glyph.** `WindowTabsProvider` deliberately
only mirrors *this* window's own tabs (see its own header comment) — no second
source of truth. Added instead of extending it: `list_all_window_tabs` Tauri
command (`window_registry.rs`, returns the whole registry) plus a
`registry-changed` broadcast (`emit_registry_changed`, not window-scoped like
`tabs-changed`) fired from every mutation site — `initialize_window_tabs`,
`add_chat_to_window`, and `drag.rs`'s `run_drag`/`finish_drag` (tear-off/dock
also change ownership and need to reach the sidebar's glyph). `Sidebar.tsx`
calls it on mount and on that broadcast, builds a chatId→windowLabel map,
display-only — click routing still goes through `adoptChat` unchanged.

Home stays a placeholder route, per plan. All four existing modals kept wired.

### R2b — project actions (the `⋯` menu backend)

No update/delete-project route existed anywhere. Added, following the
`updateChat`/`PATCHABLE_COLUMNS` pattern already established in
`engine/src/db/chats.ts`:

- Protocol: `UpdateProjectInput { name?; defaultBranch? }`.
- `engine/src/db/projects.ts`: `updateProject` (same patch-column pattern) and
  `deleteProject`, which **rejects rather than cascades** if the project still
  has chats (`chats.project_id` has no `ON DELETE CASCADE`) — surfaced as a 409
  with a message, since silently cascading a project's chats/messages/artifacts
  was a bigger destructive surface than "remove project" asked for.
- `engine/src/server.ts`: `PATCH`/`DELETE /projects/:id`.
- `apps/desktop/src/engine/client.ts`: `updateProject`/`deleteProject` — the
  latter bypasses the shared `engineJson` helper so a blocked delete's 409
  message reaches the user instead of a generic "request failed" string.
- **Reveal in Finder** needed no backend at all — `@tauri-apps/plugin-opener`
  / `tauri-plugin-opener` were already installed and initialized
  (`lib.rs:27`); `revealItemInDir(project.path)` is called straight from the
  menu handler.
- Menu UI: a small absolute-positioned `.rama-project-menu` (rename / change
  branch / reveal in Finder / new chat here / remove), rename and
  change-branch as inline `<input>` swaps in place of the row's text (Enter
  commits, Escape/blur cancels), remove behind a native `window.confirm`.

---

## Phase R3 — Titlebar, tabs, footer ✅ done

### Tab strip out, pop out in

`Titlebar.tsx` no longer renders a tab strip at all — the sidebar's chat rows
are the tab list now (since R2), so the strip was showing the same information
twice. What's left is window chrome: the traffic-light gap, a compact readout
of the window's active tab (`.rama-titlebar-title` — a window can still hold
more than one tab, just with no visible strip, hence the `2/3`-style position
counter), the ⌘K pill, an explicit pop-out button (replacing the tear-off drag,
shown only when the window has more than one tab), the artifacts toggle, and a
settings gear. The whole `DragSession` pointer-capture state machine (reorder
preview, tear-off threshold, window-level pointerup/blur fallback listeners)
was deleted along with it — nothing in the new titlebar needs pointer capture.

The wallpaper/theme-cycle buttons that used to live in the titlebar controls
moved into Settings › Appearance (R4) rather than staying as duplicate
controls; `useTheme().cycleTheme/cycleWallpaper` are still exposed as ⌘K
palette actions for a quick cycle without opening Settings.

**Rust side kept its value, trimmed to size.** `drag.rs` is now ~90 lines: one
`#[tauri::command] pop_out_chat(chat_id, from_label)` that removes the chat
from the source window's registry entry (closing that window if it's now
empty and isn't `main`, same as before) and builds a new standalone window —
the same chrome-matching/registry-preseed/`tabs-changed`-emit steps the old
tear-off drag used, minus the cursor-follow poll loop (a button has no cursor
position to track, so the new window just cascades a fixed +40/+40 offset from
the source window instead). **Deleted entirely, as recommended**:
`begin_tab_drag`, `spawn_drag_poll_thread`, `hit_test_tab_strip` (including its
R2-era `SIDEBAR_WIDTH_LOGICAL` fix — moot once the function itself is gone),
`DragState`, `cancel_active_drag`, and the whole `mouse_button.rs` module
(its `left_button_down()` had no other caller). `reorder_window_tabs` and its
frontend `reorderTabs`/`WindowTabsProvider` counterpart were also removed —
reordering only ever existed to drive the strip's live drag preview, which no
longer exists, so the command had no remaining caller. Same for `isDropTarget`
and the `drag-hover` event: that was the strip's "another window's tab is
hovering over you" highlight, and there's no strip left to highlight.

Keyboard replaces the strip, centralized in `CommandPalette.tsx`'s single
global keydown listener rather than spread across components: ⌃⇥ / ⌃⇧⇥ cycle
this window's tabs, ⌘1-9 jump to tab N, ⌘⇧O pops out the active tab, ⌘, opens
Settings, ⌘N starts a new chat. (⌘, and ⌘N were already shown as hints in the
UI — sidebar footer, tab-strip tooltip — but were never actually wired to
anything; wiring them was in scope once the Keyboard pane needed to list real,
working shortcuts rather than repeat stale claims.)

### Footer

`StatusBar.tsx` now shows only branch, diff, running, version. The provider
pill map and `useProvidersData` import moved into Settings › Providers (live
health, same data); `◇ rtl-labs/rama` / `★ 12.4k` / `MIT` — static marketing
chrome, not live app state — moved into Settings › About instead of being
deleted outright.

---

## Phase R4 — One settings modal ✅ done

Centered modal (`SettingsModal.tsx`, `.rama-modal-wide` — a new `className`
prop on the shared `Modal`), left nav, eight panes. Absorbed and deleted:
`ProviderSettingsModal.tsx` (its body became the Providers pane verbatim),
the settings `<Modal>` that used to live inline in `Sidebar.tsx` (which also
had its own hand-rolled, Together-AI-only key input, bypassing
`ProvidersProvider` entirely — replaced by the Providers pane's real
multi-provider flow, not preserved), and `McpServersModal.tsx`'s standalone
mount (its content, already a bare content div with no modal wrapper of its
own, now renders directly as the MCP servers pane). Opening the modal is a
single `settingsOpen` boolean lifted to `AppShell.tsx` — both the sidebar
footer row (main window only) and the titlebar gear (every window) call the
same `onOpenSettings` prop, since a detached window has no sidebar to put a
settings entry in otherwise.

| Pane | Shipped as |
|---|---|
| General | Default project directory (prefills the "add project" path field), default chat mode (applied to chats created via `addChat`), a static telemetry statement (no toggle — rama collects none, so a toggle would control nothing real) |
| Appearance | Theme gallery (click a swatch), wallpaper segmented control, dim slider — all direct `useTheme()` calls, the same state the old titlebar cycle-buttons drove. Themes already persist per-chat via `ProjectsProvider`'s existing patch-on-change effect, so no separate "override" toggle was needed — the copy just says so |
| Providers & models | Key entry + health per provider, moved from `ProviderSettingsModal` as-is. **Cut from the original plan:** "default model per mode" — models are already chosen per-chat via the composer's `ModelPicker`, so a global default was judged a minor convenience not worth the added settings-key plumbing in this pass |
| MCP servers | `McpServersModal`'s existing content, as a pane instead of a nested modal |
| Permissions | Global allow/ask/deny per tool (bash/write/edit/web) plus a per-project override section (scoped to the sidebar's active project) that can explicitly reset a tool back to "inherit". **Persisted, not yet enforced** — see below |
| Keyboard | The real shortcut list from R3, read-only |
| Account | A "local only" badge + one honest paragraph, no fake name field (same call as R2's footer: don't build UI for an account system that doesn't exist) |
| About | Fluke, v0.1.0, MIT, `rtl-labs/rama` — static, matches what `StatusBar` used to show live |

**Permissions backend (resolves Q4 → global defaults with per-project
override):** global rules live in the `settings` key/value table, which has
existed since the Phase 1 schema but had no reader/writer until now
(`engine/src/db/settings.ts`, `getSetting`/`setSetting`). Per-project overrides
reuse `projects.settings_json` — also present since Phase 1, also never
written to before this — via `getProjectPermissions`/`updateProjectPermissions`
in `engine/src/db/projects.ts`, merged over the global defaults rather than
replacing them. Clearing an override back to "inherit" needed a real `null`
sentinel in the patch type (`ProjectPermissionPatch`, protocol) — plain
`undefined` doesn't survive `JSON.stringify` over the wire, so it can't
distinguish "clear this key" from "didn't mention this key."

**Enforcement is explicitly out of scope for this pass** and the Permissions
pane says so in its own copy: `engine/src/agent/permissions.ts`'s `gate()` is
keyed on chat mode (agent/plan/ask) today, not per-tool rules, and there is no
`web` tool in `engine/src/tools/` yet for a `web` rule to apply to — wiring
real enforcement is follow-up work once those pieces exist, not something R4
(a UI-consolidation phase) should reach into the runtime to half-build.

Docs and Toolbox stayed out, as planned — still sidebar nav rows opening
`DocsModal`/`SkillsModal` unchanged, pending R6.

---

## Phase R5 — New chat screen + Home ✅ done

**Course correction from the original plan text:** `<Mascot/>` was already gone
(R1 replaced it with `<Fluke/>`), and `<FlukeWater/>` was never built — Q7
resolved bare-fluke-only back in R1, so there was no water-line component to
"remain." The real remaining work was deleting everything *around* the mark:
`.rama-welcome-wordmark`/`-wordmark-m`/`-caret`, `.rama-welcome-tagline`,
`.rama-welcome-card`/`-card-row` (the "rama search warm" status card), and
`.rama-welcome-chips`/`-chip` (`WELCOME_SUGGESTIONS`) — all deleted from
`ChatColumn.tsx` and `app-shell.css`. What's left of `.rama-welcome` is
exactly the bare `<Fluke/>`, centered. Also dropped: the `toolCount` state and
its `fetchSearchDomains` fetch, which existed only to feed the now-deleted
status card (`fetchSearchDomains` itself stays in `engine/client.ts` — it's
generic search infra, not welcome-screen-specific).

**Home route, built as a real view rather than a stub placeholder.** A new
`MainView = "home" | "code" | "toolbox" | "docs"` union, state lifted to
`AppShell.tsx`, with a Home/Code pill-tab switcher in `Titlebar.tsx`
(`showViewTabs`, main window only — secondary/detached windows have no
sidebar and no Home concept, so they never leave `"code"`). `HomePane.tsx`
lists every chat across every project (`ProjectsProvider`'s already-sorted
`allChats`), each row showing its project name and a running-status dot;
clicking one reuses `Sidebar.tsx`'s exact adopt-or-focus-other-window logic
(a chat is a tab in at most one window — see `WindowTabsProvider`) rather
than a second copy of that resolution logic, then flips the view back to
`"code"`.

---

## Phase R6 — Toolbox and Docs as pages ✅ done

**Q2 resolved: kept Docs project-scoped**, matching today's behavior — docs
already live on disk under a project's own directory (`engine/src/docs`), and
this phase is a content move (modal → page), not a data-model change; going
global would mean real cross-project aggregation backend work the plan never
scoped. `DocsPage.tsx` replaces the deleted `DocsModal.tsx` — same
list/editor content, now full-bleed instead of swapping inside a modal.

`ToolboxPage.tsx` replaces the deleted `SkillsModal.tsx`, reusing
`SettingsModal.tsx`'s nav+content two-pane layout classes (`.rama-settings`,
with a new `.rama-settings-page` modifier dropping the modal's height cap)
rather than inventing new CSS for the same shape. **MCP placement,
reconciled:** R4 had already moved `McpServersModal`'s bare content into
Settings' "mcp servers" pane; that exact component now also renders as
Toolbox's "mcp servers" section — one component, two entry points, not a
fork. Both pages are reached from `Sidebar.tsx`'s existing "docs"/"toolbox"
nav rows (now `onNavigate` calls instead of modal-open calls), which
highlight via a new `.rama-sidebar-nav-row-active` state; their nav-row
counts (`skillCount`/`docCount`) re-sync on navigating *away* from the page
now that there's no modal `onChanged` callback to hook.

---

## Iconography (docs/Rama R5/R6 pass)

A small stroke-icon set, `packages/ui/src/components/Icons.tsx` — 16x16,
1.6px stroke, `currentColor` — replacing the ascii/unicode glyphs (`+`, `>`,
`▤`, `✦`, `⚙`, `◫`, `⇱`, `▾`) that had been standing in since R2/R3:
`IconHome`, `IconCode`, `IconPlus`, `IconTerminal`, `IconDocs`,
`IconToolbox`, `IconChevronDown`, `IconGear`, `IconPanel`, `IconPopOut`,
`IconSearch` (built, not yet wired — the search input stayed unicode-only,
out of scope). Applied to the sidebar nav rows, the project disclosure
chevron, the titlebar's pop-out/panel/settings controls, and the new
Home/Code tabs and Toolbox/Docs page headers.

**Deliberately not matched from the reference mockup:** the mockup's sidebar
footer shows an avatar circle + account name + a theme toggle. Kept the
footer as a plain "settings" row instead — R2 and R4 both already made the
call not to build UI for an account system that doesn't exist (see R2's
write-up and R4's Account pane), and copying the mockup's footer here would
have contradicted that same-session decision for no functional gain.

---

## Phase R7 — Second wave of themes

Once the contract has survived three themes including a light one, a new theme
is a ~20-line record in `themes.ts`. Add a high-contrast theme for
accessibility, then whatever hues you want.

---

## Risk register

1. **The frame grid change (R2) — done.** Detached windows keep their own
   compact header: `Titlebar.tsx`'s `reserveTrafficGap` prop makes it
   self-reserve the traffic-light gap whenever it isn't rendered next to a
   sidebar. Also required a fix in `drag.rs`'s `hit_test_tab_strip` (see R2's
   write-up) since the main window's tab strip no longer spans the full
   window width once the sidebar sits to its left.
2. **Deleting tab drag (R3) — done.** `pop_out_chat` reached parity by reusing
   the tear-off drag's own window-build/registry-preseed code, not
   reimplementing it: theme still travels with the chat (it's per-chat state in
   SQLite, untouched by which window shows it), the registry stays consistent
   (same remove-then-insert-then-emit ordering as before), and a window that
   pops its last tab out still closes instead of becoming a husk (same
   `remaining.is_empty() && from_label != "main"` check as the old code).
3. **The chats migration (R0) — done.** A wrong mapping silently reskins existing
   chats. Shipped conservative (see R0 § Migration): dark+frost → kanagawa,
   light+* → foam, everything else → sumi.
4. **`oklch(from …)` relative color** is already in `tokens.css`, so it is
   already proven in WKWebView. Keep it — do not switch to `color-mix` without
   a reason.

## Blocking questions

| # | Question | Gates |
|---|---|---|
| ~~1~~ | ~~Kill the per-theme custom accent knob entirely, or keep an override?~~ **Resolved: killed.** | ~~R0~~ |
| ~~2~~ | ~~Is Docs project-scoped (as today) or global?~~ **Resolved: kept project-scoped.** | ~~R6~~ |
| ~~4~~ | ~~Permissions: global defaults with per-project override, or per-project only?~~ **Resolved: global + per-project override.** | ~~R4~~ |
| ~~7~~ | ~~Keep the water lines, or is the bare fluke the whole mark?~~ **Resolved: bare fluke, no water.** | ~~R1~~ |

Q3 (fluke-only vs full whale), Q5 (dot row for open chats) and Q6 (account model)
are cosmetic and can be answered mid-phase.
