# Rama — Home Redesign Plan

Phases here are **HD0–HD8** ("Home Design"). They don't collide with the build phases 0–8
(`IMPLEMENTATION_PLAN.md`), redesign R0–R7 (`REDESIGN_PLAN.md`), settings S0–S5
(`SETTINGS_PLAN.md`), harness H0–H6 (`HARNESS_DESIGN.md`, which is why this plan doesn't use bare
`H`), tool layer TL0–TL7, providers P0–P6, prompt stack PS0–PS7, Mission Control M0–M6, loop
migration LM0–LM7, loop mending MD0–MD6, workspace panes W0–W7, symbol layer SL0–SL6, agent
browser AB0–AB7, context budget CB0–CB6, web search WS0–WS6, chat view CV0–CV6 or composer context
CC0–CC2. Cite these as "HOME_REDESIGN_PLAN.md Phase HD3". The parallel Code-tab plan should pick a
different prefix (suggested: **CD**).

**What this document owns.** Rebuilding the **Home tab** until it matches
`docs/Rama/home-redesign.html` pixel for pixel. That covers the landing screen, the Home
conversation view, Home's own date-grouped chat history, the composer, the model menu, the theme
seal and its popover, and the backend Home chats need: chats that belong to no project and don't
use a coding prompt.

It also owns the **shared foundation** that Home and Code both stand on: fonts, tokens, the window
shell, the sidebar frame, the top bar, the seal, and the shared component kit. These have to be
built once and in one place, so §3 sets out the ownership contract with the Code-tab plan.

It does **not** own the Code tab's transcript blocks, the workspace panel, the Code composer chips,
the mode menu or the context ring. Those belong to the Code plan, which imports this plan's kit.

**Source of truth.** `docs/Rama/home-redesign.html` (2164 lines, standalone, every theme live).
Every spec in this plan cites the mockup line it came from, as `mock:L123`. When the plan and the
mockup disagree, **the mockup wins**. Fix the plan.

---

## 0. Current state (as of 2026-10-05)

- **Home is a placeholder.** `apps/desktop/src/app/HomePane.tsx` (65 lines) is a "recent
  activity" list of *code* chats across every project. Clicking one flips `AppShell`'s view to
  `"code"`. Home has no composer, no conversation view and no history of its own.
- **Chats always belong to a project.** `chats.project_id TEXT NOT NULL REFERENCES projects(id)`
  (`engine/src/db/schema.ts:17`). The run loop resolves `getProject(chat.projectId)` and uses its
  path as the tool sandbox (`engine/src/agent/run/run.ts:187,268-306,680-728`). There is no
  notion of a chat that isn't about code.
- **The prompt is coding-only.** `KERNEL_PROMPT` (`engine/src/agent/prompt/kernel.ts`) opens with
  "You are Rama, a coding assistant… working in a real project directory". The mode blocks
  (`prompt/mode.ts`) talk about git, check and outline.
- **There is no web search tool.** `engine/src/tools/index.ts` has `browser` but nothing like
  `web_search`. `WEB_SEARCH_PLAN.md` (WS0–WS6) is planned, not shipped.
- **There are no attachments.** No upload route, no attachment field on `MessageDTO`, no image
  parts in the LLM layer.
- **Type is all monospace.** `packages/ui/src/tokens.css:25-29` sets JetBrains Mono for body,
  Martian Mono for display and DM Mono for code, loaded from Google Fonts in
  `apps/desktop/index.html`. The ramp is 9 / 10.5 / 11.5 / 12.5 / 14 / 16px
  (`tokens.css:124-131`). The mockup's ramp is 12 / 13.5 / 15 / 17 / 21 / 28 / 44.
- **The theme engine already matches the mockup's contract.** Each theme supplies four colours
  plus a wallpaper (`packages/ui/src/themes/*.json`). I checked all nine JSON files against the
  mockup's `THEMES` array (`mock:L846-864`) and its `SEMANTIC` table (`mock:L1007-1013`): every
  colour, veil, fit and position matches. What the JSON lacks is the **kanji** for the seal.
- **Token name collisions** (counted with grep across `apps/desktop/src` and `packages/ui/src`):
  - `--ink` is an `"R, G, B"` triplet in the app (233 uses), but a hex colour in the mockup.
  - `--fs-xs/sm/md/lg/xl` exist with different values (130 uses).
  - `--ink-hi`, `--good`, `--warn`, `--bad` and `--accent` mean the same thing in both.
  - Every other mockup token is unused in the app: `--ground`, `--ink-1..4`, `--line(-2)`,
    `--hover`, `--selected`, `--on-accent`, `--ring`, `--sidebar`, `--raised`, `--well`,
    `--bubble`, `--panel`, `--code-bg`, `--shadow(-sm/-pop)`.
- **The wallpaper stack has more layers than the mockup.** `WallpaperStack.tsx` renders a dot
  field, the image, a veil, a vignette, an accent wash and grain, all behind the *whole* frame.
  The mockup has only `.wall` and `.veil`, and only behind `.main`. The sidebar is an opaque
  `--sidebar` fill (`mock:L102,167-169`).
- **Theme is per chat today.** `ProjectsProvider` pushes `chat.themeId` onto the chrome when the
  active chat changes and PATCHes the chat when the user changes theme. The mockup's popover says
  "Applies to Home and Code." (`mock:L1476`). That's one theme for the whole app (see Decision D1).
- **The theme picker lives in the title bar.** `Titlebar.tsx` renders `ThemePicker.tsx` (a brush
  icon with a family-grouped dropdown). The sidebar footer also has a "cycle theme" sun button.
- **The window chrome uses native traffic lights.** `tauri.conf.json` sets
  `"titleBarStyle": "Overlay"` and `"trafficLightPosition": { "x": 16, "y": 25 }`. `drag.rs:78`
  repeats that position for popped-out windows. The window defaults to 1440×900 with a minimum
  width of 860, so the mockup's ≤820px and ≤480px rules can never fire.
- **The app can't run in a plain browser.** `engine/window.ts` calls `getCurrentWindow()` at module
  load, so every visual check has to happen inside the Tauri window (see §5).

---

## 1. Gap summary

| Surface | Mockup | App today | Phase |
|---|---|---|---|
| Fonts | Instrument Sans (UI), Literata (replies, greeting), JetBrains Mono (code only), Shippori Mincho subset (seal) | JetBrains Mono / Martian Mono / DM Mono everywhere | HD0 |
| Tokens | Derived surface ramp: sidebar, raised, well, bubble, panel, code-bg, lines, shadows | `--bg-*`/`--sf-*`/`--border-*` ramp, glow-style shadows | HD0 |
| Wallpaper | `.wall` + `.veil` behind main only | Six layers behind the whole frame | HD0 |
| Sidebar | 272px, fake lights row, Home/Code segment, nav, date groups, avatar footer | 264px, mono, project groups, sun button | HD1, HD4 |
| Top bar | 52px, chat-title menu button, seal top-right | Titlebar with tab readout, ⌘K pill, ThemePicker | HD1 |
| Seal and theme popover | Kanji stamp → 376px popover (9 swatches, text size, reply font) | Brush dropdown | HD2 |
| Home chats | Own history, no project, everyday assistant | Don't exist | HD3 |
| Landing | Fluke, greeting, composer, "Pick up where you left off" | "recent activity" list | HD5 |
| Composer | 20px-radius card, attach, web toggle, model pill with lock/cloud icon, send | Mono `❯` composer with pill rail | HD5 |
| Model menu | 300px, "On this Mac" and "Cloud" groups | `ModelPicker.tsx` | HD5 |
| Conversation | Bubbles, plain-language activity rows, Literata prose, cards, tables, turn actions | Doesn't exist for Home | HD6 |
| Attachments, web search | Paperclip, globe toggle, "Read lease.pdf", "Searched the web" | Don't exist | HD7 |

---

## 2. Decisions to confirm before HD0

Each of these has a recommended default. The plan assumes the default unless Ruchit says
otherwise.

- **D1. One app-wide theme (recommended).** The popover copy says "Applies to Home and Code." Make
  the theme global: stop applying `chat.themeId` on chat switch, and stop PATCHing it. Leave
  `chats.theme_id` in place as a dead column, like `wallpaper`, `accent` and `theme` already are.
  Popped-out windows follow the global theme too. This changes the Code tab's behaviour, so the
  Code plan needs to agree.
- **D2. Three text sizes (recommended).** The popover offers Smaller, Default and Larger at
  0.92, 1 and 1.1 (`mock:L832`). Today's `FONT_SCALES` has four steps (0.9, 1, 1.12, 1.25). Replace
  them with the mockup's three, migrate stored values to the nearest step (0.9 → 0.92, 1.12 → 1.1,
  1.25 → 1.1), and have Settings › Appearance show the same three.
- **D3. Home chats live in a hidden system project (recommended).** Don't make `project_id`
  nullable; that would mean rebuilding the SQLite table and touching every `getProject` call.
  Instead, add a reserved project row (`id = "home"`, `path = ~/.rama/home`, `is_system = 1`) that
  `listProjects` never returns, plus `chats.kind = 'home' | 'code'`. The run loop works unchanged,
  and Home's tools are sandboxed to `~/.rama/home`, which is where attachments will live.
- **D4. Open a chat at the bottom, not the top.** The mockup scrolls a newly opened chat to the
  top (`mock:L1637`). That's a demo convenience, and wrong for long real conversations. The
  pixel-diff fixtures (§5) open at the top so they match the mockup; real chats open at the
  bottom.
- **D5. The seal appears on every main-window view.** The mockup positions it inside `.main`, so
  it shows on Home and Code alike (`mock:L777`). Toolbox and Docs keep it too. Secondary
  (popped-out) windows get it as well, because there's no other theme control left once
  `ThemePicker` is gone.

---

## 3. Ownership contract with the Code-tab plan

Both tabs are ported from the same file and share most of their primitives. If two chats port
`.composer` or `.pop` independently, the result is two diverging copies. So:

**This plan (HD) builds, and the Code plan imports:**

| Piece | Where it lives | Mockup |
|---|---|---|
| Self-hosted fonts and `@font-face` | `packages/ui/src/fonts/` | L10-14 |
| Kit tokens (`--ground`, `--ink-1..4`, `--line*`, `--hover`, `--selected`, surfaces, shadows, kit type ramp) | `packages/ui/src/kit/tokens.css` | L20-75 |
| Kit icon set (all 40 `i-*` symbols, exact paths) | `packages/ui/src/kit/Icon.tsx` | L695-737 |
| Fluke symbol (already exists) | `packages/ui/src/components/Fluke.tsx` | L696 |
| Window shell: `.app` flex, `.main`, `.wall`/`.veil`, `.view` | `apps/desktop/src/app/shell/` | L96, 166-169, 199 |
| Sidebar **frame**: top row, Home/Code segment, nav rows, scroll area, footer | `shell/Sidebar.tsx` + `shell/sidebar.css` | L99-163 |
| Top bar frame, sidebar-open button, chat-title button | `shell/Topbar.tsx` | L171-181 |
| Seal and theme popover | `shell/Seal.tsx`, `shell/ThemePopover.tsx` | L185-197, 631-656 |
| Popover primitive (`.pop`, placement, outside-click, Escape) | `kit/Popover.tsx` | L622-629, 1995-2003 |
| Buttons (`.btn`, `-ghost`, `-soft`), `.icon-btn`, `.mini`, `.mini-seg`, `.seg` | `kit/kit.css` | L113-133, 339-341, 363-369, 654-656 |
| Composer shell: card, textarea autosize, `.composer-row`, `.tool-btn`, `.model-pill`, `.send`, privacy line | `kit/Composer.tsx` | L232-279, 1543-1590 |
| Model menu (`.mp-item`, group labels) | `kit/ModelMenu.tsx` | L658-666, 2004-2013 |
| Transcript primitives: `.turn-user`/`.bubble`/`.attach`, `.acts`/`.act-btn`/`.act-body`, `.prose`, `.card`/`.code-card`/`.draft-body`, `.turn-actions`, `.working`, scroller mask, `.transcript`, `.dock`, `.resume-row`, landing arrive animation | `kit/transcript/` | L202-229, 282-360 |

**The Code plan builds, on top of the kit:** the Code-mode sidebar list (project labels, `.flag`
dot, the "+" add button; `mock:L493-498, 1524-1527`), `.crumbs`, `.top-actions` and `.cmd-btn`
(`mock:L381-395`), `.ctx-row` chips, the mode pill and mode menu, the ring (`mock:L397-404`), every
Code transcript block (`mock:L406-463`), diffs and terminal output (`mock:L465-491`), and the whole
workspace (`mock:L505-619`).

**Rules for working in parallel:**

1. The kit's class names carry the prefix **`r-`** (for example `.r-composer`, `.r-pop`,
   `.r-act-btn`), so they never collide with the legacy `rama-*` classes still used by un-migrated
   Code UI. Apart from the prefix, port the mockup CSS **verbatim**. Don't round values or
   "clean up" the CSS. Pixel parity depends on the exact numbers.
2. `Sidebar.tsx` gets split in HD1 into `shell/Sidebar.tsx` (frame), `home/HomeChatList.tsx`
   (HD4) and `code/CodeChatList.tsx`. The Code plan owns `CodeChatList.tsx`, which starts life as
   the current project-grouped list moved verbatim. Neither plan edits the other's list file.
3. Kit components take **slots** for the Code-only extras, so the Code plan never has to fork
   them. `<Composer>` takes `above` (the chip row) and `tools` (the mode pill, in place of the web
   toggle). `<ActRow>` takes an arbitrary `body`. `<TurnActions>` takes a `hidden` flag (Code
   hides it while a permission card is waiting; `mock:L1730`).
4. **The kit lands first.** HD0 and the kit half of HD1 should merge before the Code plan starts
   porting blocks. Until then, Code work should stay on things that don't touch the kit: the
   workspace and the diff and terminal surfaces.
5. Body-level styles (body font, background, scrollbar) move to the kit **only on the `.r-app`
   root** that HD1 introduces. Nothing changes on `body`, so un-migrated `rama-*` UI keeps its old
   type until the Code plan migrates it. The final `body` flip happens in the Code plan's last
   phase.

---

## 4. Phases

Each phase lists its files, the exact specs (cited to the mockup), and its exit criteria. "Diff
clean" means the §5 harness reports ≤0.5% differing pixels outside the masks for that phase's
fixture states.

### HD0 — Foundation: fonts, kit tokens, icons, wallpaper, diff harness

> **Status (2026-10-06): shipped, uncommitted.** Built as specced, with these differences:
> - **Fonts** are the exact woff2 files Google serves for the mockup's `<link>`s (latin and
>   latin-ext, fetched with a Safari UA) rather than `@fontsource` packages, in
>   `packages/ui/src/fonts/`. Same binaries on both sides, so no font drift in diffs.
> - **Buttons, segments, popover and menu-item CSS** live in `kit/kit.css`, not a separate
>   `buttons.css`. `kit/Popover.tsx` (placement, outside click, Escape, one open at a time)
>   landed here too, since HD1 needed it.
> - `texture` (grain/vignette) is still parsed but nothing emits it. `DotFieldBackground`,
>   `WallpaperStack` and `wallpaper.css` are deleted; `kit/MainWall.tsx` replaces them.
> - **Diff harness: not built.** `screencapture -l` needs Screen Recording permission that the
>   agent session doesn't have, and the Code plan's CR1 harness (`apps/desktop/fixture.html`,
>   an in-memory engine, `scripts/`) already renders the real app next to the mockup in one
>   engine. Home fixtures plug into that instead (HD5). Vite now serves the mockup at
>   `/@fs/<repo>/docs/Rama/home-redesign.html` (`fs.allow`).
> - Verified in the browser pane against the mockup at 1440×900 in wakaba and kanagawa: every
>   sidebar, top-bar and seal box matches to the pixel, and every computed colour matches.

**Fonts** (`mock:L10-14, 25-28`)
- Self-host fonts rather than fetching from Google at runtime. This is a desktop app, so it has to
  work offline, and pinned files make pixel diffs reproducible.
  - Add `@fontsource-variable/instrument-sans` (roman and italic, wght 400–700),
    `@fontsource-variable/literata` (opsz 7–72, wght 300–700, roman and italic) and
    `@fontsource/jetbrains-mono` (400 and 500).
  - For **Shippori Mincho 600**, commit a subset `.woff2` containing only the 13 seal glyphs
    `波神奈川墨桜椿朱若葉松緑青`, generated with `pyftsubset` (the same subset as `mock:L14`). Add
    one line to the subset README listing the glyphs. A user theme whose kanji falls outside the
    subset falls back to Hiragino Mincho ProN (`--f-seal` fallback, `mock:L28`), which ships with
    macOS.
- Kit font variables: `--f-ui`, `--f-read`, `--f-code`, `--f-seal`, with the mockup's fallback
  stacks verbatim (`mock:L25-28`).
- Keep the Google Fonts `<link>` for Martian Mono and DM Mono in `index.html` until the Code plan
  retires the legacy UI.

**Kit tokens** (`packages/ui/src/kit/tokens.css`, `mock:L20-75`)
- Port the mockup's `:root` and per-mode blocks, keyed on the app's existing
  **`[data-rmode]`** attribute (the mockup uses `data-mode`), with these renames to avoid the
  collisions listed in §0:
  - The mockup's hex `--ink` becomes `--ink-c`. Have `seedTokens()` emit `"--ink-c": theme.ink`.
    (`--text-1` already holds the same value, but keep a kit-named alias so the kit never reads a
    legacy token.)
  - `--ground` is new. Emit `"--ground": theme.ground` from `seedTokens()`.
  - The kit type ramp is named `--k-xs`, `--k-sm`, `--k-md`, `--k-read`, `--k-lg`, `--k-xl` and
    `--k-hero`: 12, 13.5, 15, 17, 21, 28 and 44px, each multiplied by `var(--font-scale)`
    (`mock:L31-37`). Every `--fs-*` in the ported mockup CSS becomes `--k-*`, and `--scale`
    becomes `--font-scale`.
  - `--ink-1: var(--ink-hi)`, `--ink-2: var(--ink-c)`, `--ink-3` and `--ink-4` are
    `color-mix(in oklab, var(--ink-c) 70%/50%, var(--ground))`. `--line`, `--line-2`, `--hover`,
    `--selected`, `--on-accent` and `--ring` are exactly as in `mock:L39-48`, with `var(--ink)`
    replaced by `var(--ink-c)`.
  - Light block (`mock:L50-62`) and dark block (`mock:L63-75`): `--sidebar`, `--raised`, `--well`,
    `--bubble`, `--panel`, `--code-bg`, `--shadow-sm`, `--shadow` and `--shadow-pop`, verbatim
    (again with `--ink` → `--ink-c`). **Don't** copy the mockup's `--good/--warn/--bad` literals.
    `seedTokens()` already emits identical defaults plus each theme's overrides.
- `D2`: change `FONT_SCALES` to `[{0.92,"Smaller"},{1,"Default"},{1.1,"Larger"}]`, and migrate the
  stored value in `loadPersisted()`.

**Theme schema: kanji**
- Add optional `"kanji"` to `parseTheme()` and `RamaTheme`, and add it to all nine JSON files:
  nami 波, kanagawa 神奈川, sumi 墨, sakura 桜, tsubaki 椿, shu 朱, wakaba 若葉, matsu 松,
  rokusho 緑青 (`mock:L847-863`). A user theme without one falls back to the first character of
  its label. Document the field in the themes README / SETTINGS_PLAN schema note.

**Reply-font preference**
- Add `reading: "serif" | "sans"` to `ThemeState` (global and persisted, never per chat). Write it
  to `document.documentElement.dataset.reading` in both the sync pre-paint IIFE and the effect,
  the same way `fontScale` is handled (`mock:L1501-1506`).

**Wallpaper** (`mock:L167-169`)
- Replace `WallpaperStack`'s six layers with the mockup's two: `.r-wall` (background-image
  `var(--wp)`, size `var(--wp-fit)`, position `var(--wp-position)`, no-repeat, colour
  `var(--ground)`) and `.r-veil` (`var(--ground)` at `opacity: var(--veil)`, with a
  `.35s` transition on background-color and opacity). They mount **inside `.r-main`** (HD1), not
  behind the frame.
- Delete `DotFieldBackground` from the render path, along with the vignette, wash and grain.
  `--grain-op`/`--vig-a` and the `texture` block in the theme JSON go dead; leave the parser
  tolerant of them. This also changes the Code tab, which is the direction its mockup wants too.

**Kit icons** (`packages/ui/src/kit/Icon.tsx`, `mock:L695-737`)
- `<Icon name="plus" />` renders an SVG with `class="r-i"`: 16×16, `fill: none`,
  `stroke: currentColor`, stroke-width 1.5, round caps and joins (`mock:L92`). Copy all 40
  `i-*` paths verbatim. Size variants come from CSS (13px in act dots, 15px in rails, and so on), never from
  extra props.

**Diff harness** (§5)
- Build it now, so every later phase can be diffed as it lands.

**Exit:** with HD1 not yet started, the app still renders, now on the new fonts and a two-layer
wallpaper. The harness can screenshot both the mockup and the app windows and produce a diff PNG.

### HD1 — Shell: frame, sidebar frame, top bar, traffic lights

> **Status (2026-10-06): shipped, uncommitted.** Built as specced, with these differences:
> - **`NavigationProvider`** holds `section` (`home`/`code`, the segment) plus a separate `view`
>   (`home`/`code`/`toolbox`/`docs`, what `.r-main` shows), so a page keeps the sidebar on the
>   list you came from. It sits above `ProvidersProvider`, so HD3's session routing can read it.
> - **Traffic lights: `{ x: 17, y: 28 }`**, computed rather than tuned by eye. tao grows the
>   title-bar container to button height + y and AppKit centres the 14pt buttons in it, so the
>   button's top edge is at y − 9 (measured with an offscreen `NSWindow` on macOS 26). That
>   centres the close button on the mockup's first light at (24, 26). Native buttons are 23pt
>   apart, not 20, so only the first light lines up exactly; §5's mask covers all three.
> - **Seal** mounted now (HD2's spec, with the button only). Until HD2's popover lands it opens
>   Settings › Appearance.
> - **⌘N** follows the section already (HD3 listed it). Palette chat jumps switch to Code.
> - Legacy screens render as `.r-view.r-legacy` islands. `.r-legacy` restores the old body type,
>   and the kit's button reset skips it. `CodeChatList.tsx` is the old list moved verbatim into
>   an island. `code/CodeTopbar.tsx` carries the old title bar's behaviour (title, now a
>   Rename / Pop out / Delete menu; pop-out button; provider alert) for the Code plan to replace.
> - `Titlebar.tsx` and `ThemePicker.tsx` are deleted. `HomePane.tsx` stays as the Home view until
>   HD5.

**Frame** (`mock:L96, 166, 199`)
- `AppShell` renders `.r-app` (flex, `height: 100dvh`) → `<Sidebar>` + `.r-main` (flex 1,
  `position: relative`, column, `overflow: hidden`). `.r-main` contains `.r-wall`, `.r-veil`,
  `<Topbar>`, `<Seal>`, and then the active view in `.r-view` (`z-index: 1`, flex 1, `min-height:
  0`).
- `.r-app` carries the kit body styles from `mock:L80-88` (font `--f-ui`, `--k-md`, line-height
  1.5, `color: var(--ink-2)`, background `var(--ground)`, antialiased), plus `button` reset,
  `:focus-visible`, `::selection` and the scrollbar rules from `mock:L89-93`. Scope all of these to
  `.r-app`, per §3 rule 5.
- Introduce a **`NavigationProvider`**, lifting `view` out of `AppShell`'s local state. It holds
  `section: "home" | "code" | "toolbox" | "docs"`, `homeChatId`, `homeView: "landing" | "chat"`,
  `sidebarOpen`, and persists `section` and `sidebarOpen` per window in localStorage. HD3's session
  routing and HD4's sidebar list both need this.

**Sidebar frame** (`mock:L99-163, 740-760`)
- `.r-sidebar`: 272px wide, `flex-shrink: 0`, column, background `var(--sidebar)`, a 1px
  `var(--line)` right border, transitions `background-color .35s, margin-left .25s ease`,
  `z-index: 20`. When closed: `margin-left: -272px` (`mock:L107`), with no width animation.
- **Top row** (`.r-sb-top`, `mock:L108-112`): height 52, gap 4, padding `0 10px 0 18px`. The
  mockup draws three 12px fake traffic lights. In the app they're **native**, so:
  - Replace the lights with an empty spacer 52px wide (3×12 + 2×8) that has `margin-right: auto`.
  - Set `trafficLightPosition` so the native buttons sit where the mockup's dots are: left edge
    x=18, vertically centred in the 52px row. Start from `{ "x": 18, "y": 20 }` in both
    `tauri.conf.json` **and** `drag.rs:78`, then tune it by screenshot until the dots overlay the
    mockup's within 1px. macOS draws its own glyphs, so the dots are masked in the diff (§5).
  - Then the panel button ("Hide sidebar", `i-panel`) and the search button (`i-search`). Both are
    `.r-icon-btn`: 30×30, radius 8, `color: var(--ink-3)`, hover background `var(--hover)` and
    colour `var(--ink-1)` (`mock:L113-119`).
  - The whole row is a `data-tauri-drag-region="deep"`.
- **Segment** (`.r-seg`, `mock:L121-133, 747-750`): a two-column grid, gap 2, margin
  `4px 12px 14px`, padding 3, background `var(--well)`, radius 11. Each button is 32px tall,
  radius 8, `--k-sm` weight 500, `var(--ink-3)`, with a 7px icon gap. `aria-pressed="true"` gets
  `var(--raised)`, `var(--ink-1)` and `var(--shadow-sm)`. Labels: Home (`i-home`) and Code
  (`i-code`). Clicking returns to that section's last chat, or its landing (`mock:L2106-2107`).
- **Nav** (`.r-sb-nav`, `mock:L135-143, 1513-1516`): padding `0 8px`, gap 1. Each row is 34px
  tall, padding `0 10px`, radius 8, gap 10, `--k-md`, `var(--ink-2)`, icon colour `var(--ink-3)`.
  The `kbd` sits right-aligned in `--f-ui` `--k-xs` `var(--ink-4)`. **Home section:** New chat
  `⌘N`, then Toolbox. **Code section:** New chat, Docs, Toolbox. Today's skill/MCP/doc counts in
  the meta slot go away; the mockup shows none.
- **List area** (`.r-sb-list`, `mock:L145`): flex 1, `overflow-y: auto`, padding `6px 8px 12px`.
  It renders `<HomeChatList>` (HD4) or `<CodeChatList>` (Code plan) by section.
- **Footer** (`.r-sb-foot`, `mock:L158-163, 755-759`): gap 10, padding `10px 10px 12px 14px`,
  a 1px `var(--line)` top border.
  - Avatar: 30px circle, background `var(--accent)`, the fluke in `var(--on-accent)` at 17px.
  - `.r-who`: "rama" in `--k-sm` weight 600 `var(--ink-1)`, and "Local account" in `--k-xs`
    `var(--ink-4)`, at line-height 1.25.
  - A settings button (`i-sliders`) opens the existing `SettingsModal`.
  - The old sun ("cycle theme") button is removed; the seal replaces it.

**Top bar** (`mock:L171-181, 767-776`)
- `.r-topbar`: `position: relative`, `z-index: 5`, height 52, flex, align centre, gap 8, padding
  `0 76px 0 14px` (the right padding clears the seal). It's a `data-tauri-drag-region="deep"`.
- **Open-sidebar button** (`.open-sb`, `i-menu`): only shown when the sidebar is closed
  (`mock:L172-173`). **Deviation from the mockup:** with the sidebar closed, the native lights sit
  over the top bar, so the top bar's left padding becomes `14 + 52 + 14 = 80px` in that state. The
  mockup can't show this because its lights live inside the sidebar.
- **Chat title** (`.r-chat-title`, `mock:L174-181`): shown only in a chat view. Padding 5×8,
  radius 8, `--k-md` weight 500 `var(--ink-1)`, ellipsis, then an `i-down` chevron in
  `var(--ink-4)`, with hover `var(--hover)`. It opens a small `.r-pop` menu with **Rename** and
  **Delete chat**. This menu isn't in the mockup; build it from the `.mp-item` look so it matches.
- `Titlebar.tsx`, `ThemePicker.tsx` and the ⌘K pill are deleted from the main window. ⌘K still
  works from the keyboard. The provider-health alert dot from `Titlebar.tsx:84-93` (the only place
  a broken provider shows up today) moves into the model menu (HD5) as a warning row, so it isn't
  lost.

**Exit:** with the sidebar open and closed, both sections render the new frame. The Code section
shows the legacy code chat list inside the new frame until the Code plan restyles it. The diff of
the **sidebar column and top bar** (fixture `landing`, with the view area masked) is clean.

### HD2 — Seal and theme popover

> **Status (2026-10-06): shipped, uncommitted.** Built as specced. At 1440×900 the popover's
> boxes (pop, heading, sub-line, all nine swatches and their mini-seals, divider, both option
> rows and their buttons) match the mockup to the pixel. Differences and fixes found on the way:
> - **Kit fonts were 403ing in dev.** `vite.config.ts`'s `fs.allow: [".."]` resolves against the
>   app root, so it only covered `apps/`. Modules in the import graph get through anyway, but the
>   woff2 files `fonts.css` references didn't, so every dev build (including `tauri dev`) fell back
>   to system fonts. `../../packages` is now listed. Production builds were never affected.
> - **Photo themes lost the mockup's under-gradient.** The mockup layers `url(photo), gradient`
>   for Kanagawa, Tsubaki, Shu and Matsu; ours had the photo only, which shows for Matsu (its
>   `100% auto` fit leaves the gradient visible below the image). The four JSONs now carry the
>   mockup's `css` too, and `wallpaper.css` with `image` layers underneath it (`wallpaperCss()` in
>   `themes.ts`, shared by `seedTokens`, the swatches and Settings › Appearance).
> - `Popover` gained `placement="fixed"`: position comes from CSS, and `anchor` only exempts the
>   trigger from outside-click.
> - **D1:** the chat-theme sync is gone from `ProjectsProvider`, and `applyTheme` from
>   `ThemeProvider` (`cycleTheme` stays; the palette uses it). Other windows follow a change
>   through the `storage` event. `chats.theme_id` is still written on create, as a dead column.
> - The mockup's 480px two-column swatch rule is skipped: the window's `minWidth` is 860.

**Seal** (`mock:L185-197, 777, 1472-1475`)
- `.r-seal`: `position: absolute`, top 14, right 22, `z-index: 6`. `writing-mode: vertical-rl;
  text-orientation: upright`. Font `--f-seal` 600 at **17px fixed** (it doesn't scale), line-height
  1, letter-spacing 3px. Padding `8px 6px 5px`, radius 3, background `var(--accent)`, colour
  `var(--on-accent)`. `outline: 1.5px solid color-mix(in oklab, var(--on-accent) 55%,
  transparent); outline-offset: -4px`. `transform: rotate(-2.5deg)`. `box-shadow: 0 1px 0
  color-mix(in oklab, var(--accent) 60%, #000)`.
- Hover: `rotate(0deg) translateY(-1px)`, with a `.2s ease` transform transition and `.35s`
  colour transitions.
- Content: the active theme's kanji. `aria-label` is "Theme: {label}. Change appearance", `title`
  is "{label} theme", plus `aria-haspopup="dialog"` and `aria-expanded`.
- Render it in `.r-main`, so it appears on every main-window view (D5).

**Popover** (`#themePop`, `mock:L631-656, 826-837, 1480-1494`)
- `.r-pop` base: `position: fixed`, `z-index: 50`, `var(--raised)`, a 1px `var(--line)` border,
  radius 16, `var(--shadow-pop)`, and the `pop` keyframes (`.16s ease-out`, translateY(-4px)
  scale(.98) → none).
- The theme popover is fixed at top 62, right 18, width 376 (max `100vw - 32px`), padding
  `18px 18px 16px`, max-height `100vh - 80px`, scrolling.
- `h3` "Theme": `--k-sm` 600 `var(--ink-1)`, margin-bottom 12. The sub-line reads "{label},
  {light|dark}. Applies to Home and Code." in `--k-xs` `var(--ink-4)`, margin `-10px 0 12px`.
- **Swatches:** a three-column grid with gaps of 12 (row) and 10 (column), in `sortThemes()`
  order, which already equals the mockup's order. Each swatch is a `role="radio"` button:
  - `.pv`: 66px tall, radius 10, `inset 0 0 0 1px rgb(0 0 0 / .08)`, background the theme ground.
    Inside it:
    - `.wp`: the theme's wallpaper, cover and centre.
    - `.vl`: the theme ground at `opacity: min(veil, .7)`.
    - Two ink lines, 4px tall, radius 2, left 10px: `.a` at bottom 22, width 46%, opacity .8, and
      `.b` at bottom 14, width 30%, opacity .45.
    - `.mini-seal`: top and right 8, vertical text, `--f-seal` 600 at 9px, letter-spacing 1px,
      padding 3×2, radius 2, background the theme accent, colour the theme ground.
  - Hover lifts `.pv` 1px. When checked: `0 0 0 2px var(--raised), 0 0 0 4px var(--accent)`.
  - Under the preview: the name in `--k-sm` 500 `var(--ink-1)` (margin-top 6, line-height 1.2),
    then "Light" or "Dark" in `--k-xs` `var(--ink-4)`.
  - Build swatch previews from each `RamaTheme`'s own values, not from the live tokens, so they
    show the *other* themes correctly.
- **Divider:** 1px `var(--line)`, margin `16px -18px`.
- **Options** (`.opt`, `mock:L652-656`): a space-between row with margin-top 10. The label is
  `--k-sm` `var(--ink-2)`. The control is a `.r-mini-seg`: padding 2, radius 9, `var(--well)`.
  Its buttons are 28px tall, padding `0 11px`, radius 7, `--k-xs` 500 `var(--ink-3)`; when
  pressed, `var(--raised)`, `var(--ink-1)` and `var(--shadow-sm)`.
  - "Text size": Smaller / Default / Larger, writing `setFontScale` (D2).
  - "Reply font": Serif / Sans, writing `reading`.
- Behaviour: clicking the seal toggles the popover. Clicking a swatch applies the theme
  immediately and keeps the popover open (`mock:L2039`). Clicking outside or pressing Escape
  closes it. Opening any other popover closes this one (`mock:L1989-1994`).
- **D1:** remove the chat-theme sync from `ProjectsProvider` (the `lastAppliedTheme` ref, the apply
  on `selectChat`, and the PATCH effect). `useTheme().setThemeId` becomes the only writer.

**Exit:** the diff is clean for `landing` in all 9 themes with the popover open (fixture
`theme-pop`), and for all 3 text sizes.

### HD3 — Engine and data: Home chats

> **Status (2026-10-06): shipped, uncommitted.** Built as specced. Verified end to end against a
> fresh engine with a stand-in OpenAI-compatible model: a Home chat streams a reply through the
> normal run loop, the model is offered exactly `clarify` and `read`, the system prompt opens with
> the Home kernel (no mode block, no RAMA.md), the snippet fills in after the run, and the chat
> never appears in `/chats` or `/projects`. 290/290 engine tests pass, including the new ones.
> Differences:
> - `webSearch` persists in `chats.settings_json` and comes back on `HomeChatSummaryDTO`; HD7
>   wires it into the run.
> - For Home, the bp1 tool inventory is the narrowed set (there's no agent switching to keep it
>   warm across). The complexity classifier and the curator are skipped for Home.
> - `GET /agents` hides the `home` agent; `/projects/home/chats` answers 404 so no Code chat can
>   be created under the system project; deleting it answers 409.
> - A Home chat always resolves the `home` agent (`resolveHomeAgent`), whatever its `agent_id`
>   says. A `~/.rama/agents/home.md` can still restyle the voice; the tool ceiling is
>   `computeEffectiveTools(…, kind)`, which also strips skills and heku tools.
> - `HomeChatsProvider` sits inside `SessionProvider`, so `createFromDraft()` creates the chat,
>   opens it and sends the draft text in one call.
> - Not verified: auto-titling's stage 2 (needs the utility model's key, which only the app's
>   own engine has). The stub title works, and `maybeTitleChat` doesn't look at `kind`.
> - Follow-up for HD7: the `read` tool's description is Code-flavoured ("Do not use `bash cat`").
> - The schema migration runs at engine boot, so a running `tauri dev` needs its engine restarted.

**Schema** (`engine/src/db/schema.ts`, using `addColumnIfMissing` like the existing migrations)
- `projects.is_system INTEGER NOT NULL DEFAULT 0`
- `chats.kind TEXT NOT NULL DEFAULT 'code'` plus `CREATE INDEX idx_chats_kind ON chats(kind)`
- On boot, `ensureHomeProject()` upserts `{ id: "home", name: "Home", path: ~/.rama/home,
  is_system: 1 }` and creates the directory.
  - `listProjects()` filters out `is_system = 1`.
  - `deleteProject("home")` refuses.
  - `GET /chats` and `listChatsByProject` keep returning **code** chats only, so the Code sidebar
    can't pick up Home chats by accident.

**Protocol** (`packages/protocol`)
- `ChatDTO.kind: "home" | "code"`.
- A new `HomeChatSummaryDTO` extends `ChatDTO` with `snippet: string | null`: the first sentence
  of the last assistant text, markdown stripped, at most 140 characters. It's computed in
  `listHomeChats()`, not stored. If a single query turns out too slow, cache it later in a
  `chats.snippet` column written at run end.

**Routes** (`engine/src/server.ts`)
- `GET /home/chats` → `HomeChatSummaryDTO[]`, sorted by `updated_at` descending.
- `POST /home/chats` with `{ providerId?, model?, webSearch? }` creates a `kind='home'` chat under
  the `home` project, with `agent_id='home'` and `mode='agent'` (the tool narrowing comes from the
  agent, see below).
- PATCH and DELETE reuse the existing `/chats/:id` routes. Deleting a Home chat also removes
  `~/.rama/home/attachments/<chatId>/` once HD7 exists.
- Auto-titling (`engine/src/agent/titling.ts`) already runs per chat, so Home rows get real titles
  ("Lease review before Friday") for free. Check that it fires for `kind='home'`.

**Prompt and tools**
- A new bundled agent, `engine/src/agent/agents/bundled/home.md`:
  `tools: [read, clarify]`, plus `web` once WEB_SEARCH_PLAN ships and `browser` if Ruchit wants
  Home to open pages (not in the mockup, so leave it out). The body sets the voice: plain words,
  short answers, tables when comparing, no code unless asked.
- A **Home kernel** in `prompt/kernel.ts`: `HOME_KERNEL_PROMPT` ("You are Rama, a helpful assistant
  in a desktop app. You can read files the user attaches…"). `build.ts` selects it when
  `chat.kind === 'home'`, and for Home it skips the project block (RAMA.md) and the mode block.
  Stack-as-cache-layout still holds; Home simply has its own layer-0/1 prefix.
- The kernel also states the **draft convention** HD6 renders: wrap text the user will copy
  verbatim (an email, a note, a toast) in a fence with the info string `draft <Label>`, for
  example ` ```draft Email draft `.
- `effectiveTools` must reject any attempt to widen a `home` chat past `read` and `clarify`, even
  if the user switches agents. Home has no agent picker anyway.

**Client data**
- `HomeChatsProvider` (`apps/desktop/src/app/data/HomeChatsProvider.tsx`) holds `homeChats`,
  `activeHomeChatId` (mirrors `NavigationProvider.homeChatId`), a single Home `draft`
  (`{ text, providerId, model, webSearch }`), `createFromDraft()`, `rename`, `remove` and
  `refresh`. It re-fetches on the WS `chat.updated` and `run.finished` events so titles and
  snippets stay live.
- **Session routing:** `SessionProvider` currently follows `ProjectsProvider.activeChatId`. Change
  its input to `useActiveSessionChatId()`, which returns `homeChatId` when `section === "home"`
  and the code chat id otherwise. Nothing else in `SessionProvider` changes; one live session at a
  time per window, as today.
- Home chats **never** enter `WindowTabsProvider`: no tabs, no pop-out, main window only.
  `ProjectsProvider.fetchChats` adds a `kind === "code"` guard as a second line of defence.
- `⌘N` follows the section (`mock:L2126`): Home opens the Home landing, Code opens the code draft.
  Update `CommandPalette`'s handler.

**Tests:** engine tests for `ensureHomeProject`, the `listProjects` exclusion, `kind` filtering,
the snippet extraction (markdown, code fences, empty text), Home kernel selection in `build.ts`,
and the `home` agent's tool narrowing.

**Exit:** a Home chat can be created, streams a reply through the normal run loop with only
`read`/`clarify` available, gets an auto-title, and never shows up in the Code sidebar or in
`GET /projects`.

### HD4 — Home sidebar list

> **Status (2026-10-06): shipped, uncommitted.** Built as specced. Against the mockup at 1440×900
> (fixture `landing`), every group label and row box matches, and the computed colours and type
> match in wakaba and matsu. Date words are unit-tested in `home/dates.test.ts` (midnight, month
> rollover, year boundary, a real 23-hour DST day). Differences:
> - The `.r-chat-row` rule is the Code plan's (`code/code.css`, flex with a `.t` span), shared
>   rather than duplicated. It renders identically to the mockup's block row. `.r-group-label` and
>   the in-place rename field (`.r-row-edit`) live in `shell/shell.css`.
> - Rename edits the row in place. Delete goes through a new kit `ConfirmDialog`
>   (`kit/ConfirmDialog.tsx`), owned by `HomeChatsProvider` (`requestRemove`) so the sidebar menu
>   and the top bar's chat-title menu share one dialog.
> - A search with no matches says "No chats match “…”" instead of showing an empty list.
> - **Kit change:** `Popover` now portals its box to the `.r-app` root. The landing's arrival
>   animation leaves a filled transform on the composer, which turns a `position: fixed` child's
>   containing block into the composer and put the model menu off screen. This affects every kit
>   popover, including the Code list's menus and FilesRail's; all still measure correctly.
> - Desktop unit tests run under `bun test` (`apps/desktop/tsconfig.json` excludes `*.test.ts`
>   from the webview type-check).

**`home/HomeChatList.tsx`** (`mock:L146, 149-156, 493-494, 1517-1522`)
- **Date groups.** Compute them on the client from `updatedAt`, in local time:
  - **Today**, **Yesterday**, **Previous 7 days** (2–7 calendar days ago).
  - After that, the month name for the current year ("September"), or "September 2025" for an
    earlier year.
  - Groups are ordered newest first, and rows within a group by `updatedAt` descending.
  - Unit-test the boundaries: midnight, month rollover, the year boundary, a DST day.
- `.r-group-label`: `--k-xs` 500 `var(--ink-4)`, padding `16px 10px 5px`. No uppercase and no
  letter-spacing, unlike the legacy `.t-label`.
- `.r-chat-row`: flex, align centre, gap 8, full width, padding `6px 10px`, radius 8, `--k-sm`
  `var(--ink-2)`. The title sits in `.t`: flex 1, ellipsis. Hover gives `var(--hover)`. The
  current row (`aria-current="true"`, only while that chat is on screen) gets `var(--selected)`,
  `var(--ink-1)` and weight 500.
- A right-click / context menu (an `.r-pop` with `.mp-item` rows) offers Rename and Delete.
  Delete reuses the confirm modal, restyled with kit buttons (`.btn` + `.btn-ghost`), because a
  WKWebView `confirm()` silently returns false (see `Sidebar.tsx`'s comment).
- **Search** (not in the mockup; designed from kit tokens): the `i-search` button reveals a 34px
  field directly under `.r-sb-top`, with margin `0 12px 10px`, radius 9, background
  `var(--well)`, `--k-sm`, no border, and focus `0 0 0 3px var(--ring)`. It filters titles live,
  and empty groups hide. Escape clears and closes it.
- A running Home chat shows no dot. The mockup has none for Home, and the working indicator lives
  in the transcript.

**Exit:** the sidebar list diff is clean against the mockup's ten chats (fixture `landing`).

### HD5 — Landing, composer, model menu, privacy line

> **Status (2026-10-06): shipped, uncommitted.** Built as specced. At 1440×900 every box on the
> landing matches the mockup (fluke, greeting, composer, textarea, tool buttons, model pill, send,
> privacy line, resume rows) and so do 18 elements' computed styles in wakaba and matsu. The open
> model menu matches box for box (`landing-model-pop`), as do `landing-web-on`,
> `landing-cloud-model` and the chat dock. `kit/modelPlace.ts` is unit-tested. Differences:
> - New kit pieces: `kit/Composer.tsx`, `kit/ModelMenu.tsx` and `kit/composer.css`. Composer slots
>   for the Code plan: `above`, `tools` (replaces the web toggle), `trailing` (after the privacy
>   note) and `textareaRef`.
> - "More models…" sits at the right of the menu's first group label, not as a row of its own: a
>   46px row made the menu too tall to fit above the landing composer at 900px, so it flipped
>   below. With no models at all it's the only row.
> - With no model picked, the pill and Send open the menu, or the setup wizard when there's
>   nothing to offer. The privacy line then reads "Choose a model to start. You can run one on
>   this Mac or in the cloud." The wizard opens in a legacy modal, portalled to `body`.
> - Keyless providers are marked "· unavailable" like bad ones.
> - The old Home placeholder (`HomePane.tsx` and its `.rama-home*` CSS) is deleted. `HomeView`
>   switches between the landing and the open chat. `HomeTopbar` puts the chat title in the top
>   bar (planned for HD6, but it was one line).
> - **Interim chat view** (`home/HomeChat.tsx`) so a landing send has somewhere to land: the
>   mockup's scroller, transcript column and dock (which match the mockup's boxes), with user
>   bubbles and replies as plain pre-wrapped text. HD6 replaces the transcript. In the chat, the
>   web toggle is local state until HD7, and picking a model PATCHes the chat (`setModel`).
> - Fixtures: `fixtures/home/build.ts` adds `landing`, `landing-model-pop`, `landing-web-on` and
>   `landing-cloud-model`, plus `&model=` and `&providers=none` (first run). It layers the
>   mockup's ten chats and an LM Studio provider onto the Code fixture data. The Code chat's
>   `mockEngine.ts` gained `homeChats`/`modelRoles` fields, `POST /home/chats` and
>   `DELETE /chats/:id`.

**Landing** (`mock:L202-229, 779-789, 1593-1603, 1859-1869`)
- `#landing` is `.r-view` with `overflow-y: auto`. `.r-landing-inner`: `min-height: 100%`, column,
  centred, padding `11vh 24px 56px`.
- **Fluke:** 40×34, `var(--accent)`.
- **Greeting** (`.r-greet`): `--f-read` 400 at `--k-hero`, line-height 1.1, letter-spacing
  -0.015em, `var(--ink-1)`, margin `14px 0 30px`, centred, `text-wrap: balance`. The text depends
  on the hour: before 5 "Up late, aren't we", before 12 "Good morning", before 17 "Good afternoon",
  otherwise "Good evening". Recompute it on each landing visit.
- **Composer wrapper:** `width: min(680px, 100%)`.
- **Resume** (`.r-resume`): `width: min(680px, 100%)`, margin-top 52.
  - `h2` "Pick up where you left off": `--k-sm` 500 `var(--ink-3)`, margin `0 0 6px 14px`.
  - Up to **3** most recent Home chats. Hide the whole section when there are none (first run).
  - `.r-resume-row`: a grid of `1fr auto`, column gap 20, padding 11×14, radius 12, hover
    `var(--hover)`.
    - Title: `--k-md` 500 `var(--ink-1)`.
    - Snippet `p`: `--k-sm` `var(--ink-3)`, margin-top 1, ellipsis.
    - `time`: `--k-xs` `var(--ink-4)`, tabular numerals, row 1 column 2, vertically centred.
  - **Relative time strings** (they match the mockup's "2 hours ago" / "This morning"):
    - under 1 minute: "Just now"; under 60 minutes: "N minutes ago"
    - same day and under 6 hours: "N hours ago"; same day, earlier: "This morning",
      "This afternoon" or "This evening" by the hour it happened
    - "Yesterday", then the weekday name within 7 days, then "12 Sep"
- **Arrival animation** (`mock:L224-229`): the fluke, greeting and composer `rise` (`.7s`,
  `cubic-bezier(.2,.7,.2,1)`, delays 0, .08s and .16s, translateY 10px → 0 with opacity), and the
  resume block `fade`s (`.8s`, delay .3s). Replay it on every landing visit by re-keying the inner
  element (`mock:L1858`). Under `prefers-reduced-motion`, turn off every animation and transition
  (`mock:L688-690`).
- Focus the textarea 50ms after landing (`mock:L1867`), with `preventScroll`.
- **No provider configured:** the composer still renders, the model pill reads "Choose a model",
  and sending, or clicking the pill, opens the existing `ProviderSetupWizard`. Don't swap the whole
  landing for the wizard the way `ChatColumn` does.

**Composer** (`kit/Composer.tsx`, `mock:L232-279, 1543-1590`)
- `.r-composer`: `var(--raised)`, a 1px `var(--line)` border, radius 20, `var(--shadow)`, padding
  `14px 12px 10px 18px`, transitions `.15s` (border, shadow) and `.35s` (background).
- `:focus-within`: border `color-mix(accent 45%)`, shadow `var(--shadow), 0 0 0 4px
  color-mix(accent 12%)`.
- **Textarea:** `--f-ui` at `calc(16px * var(--font-scale))`, line-height 1.5, `var(--ink-1)`,
  min-height 26, max-height 220, padding-right 6, placeholder `var(--ink-4)`. Autosize on input;
  the send button is disabled while the text is empty after trimming. Enter sends, Shift+Enter
  inserts a newline (`mock:L2121`).
  - Placeholders: "Ask anything, or drop in a file" on the landing, "Reply to Rama" in a chat
    (`mock:L1550`).
- **Row** (`.r-composer-row`): margin-top 12, margin-left -8, gap 2.
  - Attach `.r-tool-btn` (`i-clip`, see HD7).
  - Web search `.r-tool-btn` (`i-globe`), with the label "Web search" shown only when pressed.
    Pressed state: `var(--selected)` and `var(--accent)` (`mock:L248-257`).
  - Model pill, pushed right with `margin-left: auto`.
  - `.r-send`: a 34px circle, margin-left 4, `var(--accent)`/`var(--on-accent)`, `i-up` at
    stroke-width 1.9, `scale(.94)` while pressed. Disabled: `var(--line-2)`/`var(--ink-4)`.
  - While a run is going, `.r-send` becomes a stop button: the same circle and colours with a 10px
    rounded square glyph, calling `interrupt()`. This state isn't in the mockup.
- **Model pill** (`mock:L258-266, 1567`): 32px tall, padding `0 10px 0 11px`, radius 999, gap 7,
  `--k-sm` 500 `var(--ink-2)`, hover `var(--hover)`. Contents: an `i-lock` (local) or `i-cloud`
  icon, the model's display name, then an `i-down` chevron at 14px in `var(--ink-4)`.
- **Privacy line** (`.r-privacy`, `mock:L276-278, 499, 1571`): flex, centred, gap 6, margin-top 10,
  `--k-xs` `var(--ink-4)`, wrapping, with a 13px icon at `vertical-align: -2px` and margin-right 6.
  - Local: "{name} runs on this Mac. Nothing you send leaves it."
  - Cloud: "{name} runs on {via}'s servers. Messages are sent to them." (`mock:L874-876`)
  - The Code plan passes its context ring through a `trailing` slot here.
- **Local or cloud:** a model counts as local when its provider's `baseUrl` host is `localhost`,
  `127.0.0.1`, `[::1]`, `0.0.0.0` or ends in `.local`. `via` is the provider's `label` (for
  example "Ollama", "Together AI"). Put this in `kit/modelPlace.ts` with unit tests; the Code plan
  reuses it.

**Model menu** (`kit/ModelMenu.tsx`, `mock:L658-666, 2004-2013, 1995-2003`)
- `.r-pop`, width 300, padding 8. It's placed **above** the pill, right-aligned to the pill's
  right edge, clamped 12px from the viewport edges, and flips below if there's no room
  (`placeAbove`, `mock:L1995-2003`).
- Groups: "On this Mac" (local), then "Cloud", each with a `.mp-label` (`--k-xs` 500
  `var(--ink-4)`, padding `8px 10px 4px`). Empty groups are omitted.
- `.mp-item`: a grid of `18px 1fr 16px`, gap 10, padding 8×10, radius 10, hover `var(--hover)`.
  Contents: the icon in `var(--ink-3)`; the name `b` in `--k-sm` 500 `var(--ink-1)` at
  line-height 1.3; the `via` line in `small` `--k-xs` `var(--ink-4)`; and an `i-check` tick in
  `var(--accent)`, visible only when checked.
- **Source:** every model on the user's **shortlist** across their enabled providers (see
  PROVIDERS_PLAN P3/P4; the menu shows the shortlist, never the full catalog). The last row is
  "More models…", which opens Settings › Providers.
- A provider whose health is `bad` keeps its models listed, with the `small` line reading
  "{via} · unavailable" in `var(--bad)`. This replaces the deleted title-bar alert dot.
- Picking a model sets it on the draft (landing) or PATCHes the active Home chat (`mock:L2050-2055`),
  then closes the menu and re-renders the pill and the privacy line.

**Exit:** the diff is clean for fixtures `landing` (wakaba, 18:30 frozen clock),
`landing-model-pop`, `landing-web-on` and `landing-cloud-model`, in all 9 themes.

### HD6 — Conversation view

> **Status (2026-10-06): shipped, uncommitted.** Built as specced. At 1440×900, comparing every
> element's box and 18 computed styles against the mockup, the transcript has zero differences for
> `chat-lease` (serif, sans, and all 3 text sizes), `chat-lisbon` (web act expanded; wakaba,
> kanagawa, sumi, matsu), `chat-bill` and `chat-working`, and the dock matches. Behaviour checked
> through a scripted run in the mock engine: send, working line, act rows, streaming, byline,
> Try again, copy, scroll rules, error notice, landing send. Differences:
> - The transcript pieces are in `kit/transcript/` (`Transcript.tsx`, `transcript.css`): `TurnUser`,
>   `Acts`, `ActRow`, `TranscriptCard` (named so it doesn't clash with the legacy `Card`),
>   `TurnActions`, `Working`, `useCopied`. The frame (`.r-scroller`, `.r-transcript`, `.r-dock`)
>   moved there from `home/home.css`. `.r-mini` is now in `kit.css`.
> - The mockup's L407-408 (`.acts + .prose` 6px, `.prose` 4px bottom margin) sit in its Code section
>   but apply to Home too, so the kit has them. Its inline-`code` rule also hits the code card's
>   `<code>` (an .82em chip inside the `pre`); kept for parity, though a multi-line block shows the
>   chip background line by line. HD8 should decide.
> - Prose is `home/HomeMarkdown.tsx`, not a `variant` prop on `Markdown.tsx`: it reuses the block
>   splitter (now exported) with its own renderer, and blocks render as fragments so margins
>   collapse like the mockup's. Drafts render with `breaks: true` (a letter's "Best,\nSam").
>   Spreadsheet fences use a small hand tokenizer, since highlight.js splits `$E$1`.
> - Thinking `durationMs` was already persisted in `meta_json.blocks`, so reloads keep "Thought for
>   N seconds". "Thought it through" only shows for old rows without it.
> - The byline's model rides `messages.meta_json` (`providerId`, `model`), not new columns, written
>   when each step's row is created. `MessageDTO` exposes both.
> - **Try again** is a new engine route, `POST /chats/:id/retry { userTurn? }`
>   (`rewindToUserTurn`): it drops that user message and everything after it (rows, tool calls,
>   artifacts, later compactions) and runs the text again. `restoreLastRun` restores files, which
>   Home doesn't write, and a plain resend would duplicate the question. Every reply has the button,
>   as in the mockup; an earlier one drops the later turns.
> - A running tool shows in the working line ("Reading lease.pdf…"), not as a past-tense row, until
>   it finishes.
> - Protocol additions for HD7: `MessageDTO.attachments` (`AttachmentDTO`) and
>   `ToolCallDTO.resultMeta` (the web act's `sources`). The transcript draws both; the engine fills
>   them in HD7.
> - Fixtures: `chat-<id>` for all ten chats and `chat-working`, from `fixtures/home/transcripts.ts`
>   (the mockup's conversations as stored markdown and blocks). The mock engine plays a scripted
>   reply for Home chats on send and on `retry`.
> - The engine's new code needs a restart of a running `tauri dev` engine.

**Layout** (`mock:L282-285, 791-794`)
- `#chat` is a column. `.r-scroller` (flex 1, `overflow-y: auto`) carries the 18px top and 28px
  bottom mask: `linear-gradient(to bottom, transparent, #000 18px, #000 calc(100% - 28px),
  transparent)` on both `-webkit-mask-image` and `mask-image`.
- `.r-transcript`: `width: min(720px, 100%)`, centred, padding `40px 24px`, column, **gap 30**.
- `.r-dock`: same width, padding `0 24px 16px`, `flex-shrink: 0`. It holds the composer and the
  privacy line.
- Scroll: open at the bottom (D4; fixtures open at the top). On send, scroll to the bottom. While
  streaming, stick to the bottom unless the user has scrolled up more than 80px.

**User turn** (`mock:L287-301, 1607-1610`)
- `.r-turn-user`: `align-self: flex-end`, `max-width: min(82%, 580px)`, column, right-aligned,
  gap 8.
- `.r-bubble`: `var(--bubble)`/`var(--ink-1)`, padding 10×16, radius `18px 18px 6px 18px`, at
  `calc(15.5px * var(--font-scale))`, line-height 1.55. It's plain text with newlines preserved
  (`white-space: pre-wrap`), not markdown.
- `.r-attach` (HD7) sits above the bubble: padding `7px 14px 7px 7px`, radius 12, `var(--raised)`,
  a 1px `var(--line)` border. Inside: a 34px `.attach-icon` (radius 8, `var(--selected)`,
  `var(--accent)`), the name in `--k-sm` 500 at line-height 1.3, and the meta in `small` `--k-xs`
  `var(--ink-4)`.

**AI turn** (`mock:L303-356, 1611-1630`)
- `.r-turn-ai`: a column built from the message's `ChatBlock[]` **in stream order**:
  - Each run of consecutive *activity* blocks (thinking, tool calls) becomes one `.r-acts` group:
    column, items start-aligned, gap 2, margin `-4px 0 12px -6px`.
  - Each `text` block becomes a `.r-prose`.
  - The mockup's Home chats show all activity first and then prose; that falls out of the rule
    above whenever the model works before it writes.
- **Activity row** (`kit/transcript/ActRow.tsx`):
  - `.r-act-btn`: inline-flex, gap 8, padding `4px 8px 4px 5px`, radius 8, `--k-sm`
    `var(--ink-3)`, hover `var(--hover)`/`var(--ink-1)`. Contents:
    - `.dot`: 22×22, radius 6, `var(--well)`, with a 13px icon in `var(--ink-3)`.
    - The label.
    - An optional `.meta` in `var(--ink-4)`.
    - A 13px `i-right` chevron in `var(--ink-4)` that rotates 90° (`.2s`) when
      `aria-expanded="true"`.
  - `.r-act-body` (hidden until expanded): margin `4px 0 8px 16px`, padding `2px 0 2px 18px`,
    left border `1.5px solid var(--line-2)`, `--k-sm` `var(--ink-3)`, max-width 60ch. Its `ol`
    has padding-left 1.2em, `li` margins are 3px, and `li span` is `var(--ink-4)`.
- **Plain-language mapping** (`home/actLabels.ts`, unit-tested):

  | Block | Icon | Label | Meta | Body |
  |---|---|---|---|---|
  | `thinking` (done) | `clock` | "Thought for N seconds" ("for a moment" under 1s) | none | the thinking text, in `p` |
  | `thinking` (after reload) | `clock` | "Thought for N seconds" | none | as above. `ChatBlock`'s thinking variant has an optional `durationMs`, but `engine/src/db/messages.ts` never writes it, so it's lost on reload. Persist it at `thinking.done`. Until then a reloaded chat shows "Thought it through" |
  | `thinking` (live) | `clock` | "Thinking" | live seconds | the streaming text |
  | `read` on an attachment | `doc` (or `image` for images) | "Read {file}", or "Looked at {file}" for images | "N pages", or "N lines" for text | one line saying what was read |
  | `web` search (HD7) | `globe` | "Searched the web" | "N sources" | an `ol` of `title <span>source</span>` |
  | `web` fetch (HD7) | `globe` | "Read {host}" | none | the page title and URL |
  | `clarify` | `ask` | "Asked you a question" | none | the questions as an `ol` |
  | failed tool | its usual icon | its usual label | "didn't work" in `var(--bad)` | the error text |

  Tool names never appear in Home's UI.
- **Prose** (`.r-prose`, `mock:L321-335`): `--f-read` at `--k-read`, line-height 1.65,
  `var(--ink-2)`, max-width 66ch.
  - With `[data-reading="sans"]`: `--f-ui` at `calc(16px * var(--font-scale))`, line-height 1.6.
  - Element styles:
    - `p`: margin `0 0 .8em`. `strong`: 600 `var(--ink-1)`.
    - `ul`: margin `.2em 0 .9em`, padding-left 1.25em. `li`: margin `.4em 0`, padding-left
      .2em, marker `var(--accent)`.
    - Inline `code`: `--f-code` at .82em, `var(--well)`, padding `.12em .4em`, radius 5,
      `var(--ink-1)`.
    - Tables: `--f-ui` `--k-sm`, line-height 1.45, full width, collapsed borders, margin
      `.4em 0 1.1em`. `th`: 500 `var(--ink-3)`, padding `0 14px 8px 0`, a 1px `var(--line-2)`
      bottom border. `td`: padding `9px 14px 9px 0`, a 1px `var(--line)` bottom border except on
      the last row, `vertical-align: top`. Markdown right-aligned columns (`---:`) get `.num`:
      right-aligned, tabular numerals.
  - Render it with the existing streaming `Markdown.tsx` (block splitting stays), passing a
    `variant="home"` renderer map, so `rama-*` classes are never emitted inside `.r-prose`.
  - Path links (`PathLink`) are off in Home.
- **Cards** (`mock:L337-350, 880, 947`)
  - `.r-card`: margin `.3em 0 1em`, radius 14, `var(--raised)`, a 1px `var(--line)` border,
    `overflow: hidden`.
  - `.card-head`: space-between, padding `7px 8px 7px 16px`, a 1px `var(--line)` bottom border,
    `--f-ui` `--k-xs` 500 `var(--ink-3)`. On the right sits a `.r-mini` Copy button (26px tall,
    padding `0 9px`, radius 7, a 13px `i-copy`) that reads "Copied" for 1.4s after a click.
  - **Draft card:** a fence whose info string is `draft <Label>`. The head shows `<Label>`. The body
    is `.draft-body` (padding `14px 18px 4px`, .94em, `p` margin `0 0 .7em`), rendered **as
    markdown in prose type**. A first line `Subject: X` renders as `.subj` (`--f-ui` `--k-sm`
    `var(--ink-3)`, with `b` in `var(--ink-1)` 500). Copy copies the plain text of the body.
  - **Code card** (any other fence): `var(--well)`, transparent border. The head label is the
    language's display name ("Python", "Spreadsheet formula" for `excel`/`formula`/`sheets`,
    "Code" when there's no language). `pre`: margin 0, padding `14px 16px 16px`, horizontal scroll,
    `--f-code` at `calc(13.5px * var(--font-scale))`, line-height 1.6, `var(--ink-1)`.
  - **Highlighting:** keep highlight.js, but restyle its classes to the mockup's palette:
    - `hljs-keyword` → accent
    - `hljs-title.function_` / `hljs-built_in` → accent 500 (`.tok-fn`)
    - `hljs-string` → `color-mix(good 75%, ink-1)`
    - `hljs-comment` → `var(--ink-4)` italic
    - `hljs-number` → `var(--warn)`
    - variables and refs → `var(--ink-3)` (`mock:L349-350, 481-484`)
  - This replaces `CodeFence.tsx` *for Home only*. The Code plan decides whether it adopts the
    same card.
- **Turn actions** (`mock:L352-356, 1619-1623`): `.r-turn-actions` is flex, gap 2, margin
  `2px 0 0 -7px`, at opacity 0. It becomes visible on `.r-turn-ai:hover`, on the last AI turn, or
  on `:focus-within`.
  - Copy (`i-copy`) copies the turn's prose text and swaps to `i-check` for 1.4s.
  - Try again (`i-retry`) re-runs the last user turn. Reuse `restoreLastRun` plus a resend.
  - Both are 28px `.r-icon-btn` in `var(--ink-4)`, hover `var(--ink-1)`.
  - The `.by` byline sits at margin-left 8, `--k-xs` `var(--ink-4)`: "{model} on this Mac" or
    "{model} via {provider}" (`mock:L877`), taken from the model **that produced that turn**.
    `MessageDTO` (`packages/protocol/src/index.ts:262`) has neither field today, so add
    `providerId`/`model` columns to `messages`, write them at run end, and expose them on the DTO.
    Old messages without them fall back to the chat's current model.
- **Working indicator** (`mock:L358-360, 1618`): while the run hasn't emitted a visible block yet,
  render `.r-working` (inline-flex, gap 10, `--k-sm` `var(--ink-3)`). It shows a 22×19 fluke in
  `var(--accent)` with the `bob` animation (`1.4s ease-in-out infinite`, translateY 1 → -2px,
  rotate ±4°), then "{verb}…".
  - Verbs: while the engine reports `thinking`, cycle a short whale set every 2s: "Diving in",
    "Surfacing", "Swimming through it", "Taking a breath", "Charting a course". While a tool is
    running, use the act label in the present tense ("Reading lease.pdf", "Searching the web").
  - Once activity rows appear, the indicator moves below the last row and stays until the first
    text block streams.
- **Errors:** a failed run renders a `.r-notice` (centred, `--k-xs` `var(--ink-4)`, padding
  `0 12px`; borrowed from `mock:L463`) with a plain sentence and a "Try again" `.r-mini`. No raw
  stack text.

**Exit:** the diff is clean (top of the transcript, frozen clock, wakaba, serif) for fixtures
`chat-lease` (bubble, attachment, two acts, prose list, draft card), `chat-lisbon` (expanded web
act, table), `chat-bill` (numeric table, code card) and `chat-working` (indicator). Also check
`chat-lease` in sans and at all 3 text sizes, and `chat-lisbon` in kanagawa, sumi and matsu.

### HD7 — Attachments and web search wiring

> **Status (2026-10-06): attachments shipped, uncommitted. Web search is still blocked:**
> WEB_SEARCH_PLAN WS0–WS2 hasn't started (there's no `web` tool), so the globe got the interim
> behaviour below. Verified against a real engine (an isolated `HOME`, with a stand-in
> OpenAI-compatible model):
> - A PDF attaches with its page count and turns into a `read` of the attachment ("1-5 of 5 lines ·
>   2 pages", shown as "Read lease-2026-draft.pdf · 2 pages") and an answer grounded in the page
>   text.
> - A photo goes out as an image part only while the model is marked `supportsVision`. Otherwise
>   the turn says the model can't see it.
> - Try again keeps the turn's files for the re-run and removes later turns' files. Deleting the
>   chat removes its folder, and the globe toggle persists.
>
> In the fixture: drop, paste, chips with ✕, the vision warning, the limit notices, a send of files
> alone from the landing, a reply with a file, and Try again. The mockup diffs still have zero
> differences (`chat-lease` serif and sans, `chat-lisbon`, `chat-recipe` with its attachment chip,
> `chat-working`). 300/300 engine tests pass. Differences:
> - The upload route is `POST /home/chats/:id/attachments`, one file per request (field `file`).
>   It stores `attachments/<chatId>/<id>/<name>` under the home project (a folder per upload, so
>   names never collide and the model sees the real name). The row in `message_attachments` stays
>   unlinked until a `sendUserTurn { attachmentIds }` links it in `runTurn`. `message.user` carries
>   the files, so the bubble shows them at once. Uploads happen on Send: from the landing, after
>   the chat is created; a failed upload deletes that new chat again and keeps the draft.
> - The model learns about each file from a line added to its user turn at projection time
>   (`attachmentPointer`): `Attached: lease.pdf (PDF, 14 pages). Read it with read path "…"`. Not
>   stored in `content`, so the bubble stays clean and the text is the same on every run.
> - PDFs are extracted with `unpdf` (a new engine dependency) into a `<name>.pdf.txt` sidecar with a
>   `--- Page N ---` line before each page. `read` on any `.pdf` reads the sidecar, or extracts on
>   the spot outside Home, and its summary gains " · N pages". Home's `read` has its own
>   description now (the HD3 follow-up). The Home kernel says how attachments arrive.
> - Images: HEIC, and photos over 3.5 MB, get a JPEG copy for the model via macOS `sips` (scaled to
>   2048px), since providers cap images at about 5 MB and don't take HEIC. Vision comes from
>   `provider_models.supports_vision`; the composer warns "{model} can't see images. Pick a model
>   that can." when a waiting photo meets a model without it.
> - The paperclip uses a hidden `<input type="file">` (the macOS open panel inside the webview),
>   not `@tauri-apps/plugin-dialog`, which would mean a new Rust plugin and permissions for no
>   gain. Drop and paste go through the kit composer (`onDropFiles`). This needed
>   `dragDropEnabled: false` on the main window, or Tauri swallows file drops.
> - A turn can be files alone: Send works with no text, the bubble is left out, and the stub
>   title and auto-title use the file names.
> - The web toggle is persisted per chat (`PATCH /chats/:id { webSearch }`, `setWebSearch` in
>   `HomeChatsProvider`). While it's on, the privacy line adds " · Web search isn't set up yet",
>   a link that opens Settings. That note is the only new dock difference against the mockup
>   (`chat-lisbon`, `landing-web-on`). The rest of the web half is written into WEB_SEARCH_PLAN
>   WS2.
> - Limits: 20 MB per file (also enforced by the engine, 413) and 5 per message, checked in the
>   composer with a note when something is left out (`home/attachments.ts`, unit-tested).
> - Fixtures: the mock engine accepts uploads, carries them on `message.user`, and reads an
>   attached document in its scripted run. Its run and tool-call ids now include a counter. The
>   fixture clock is frozen, so a second scripted run used to collide with the first, and its row
>   lost its meta.
> - The schema adds a table, and the engine has new routes and code, so a running `tauri dev`
>   needs its engine restarted.

These two features carry most of the backend risk, so they ship after the visual work. Until they
land, the paperclip and globe buttons still render (parity), but behave as described under
"Interim".

**Attachments**
- `POST /home/chats/:id/attachments` (multipart) stores the file under
  `~/.rama/home/attachments/<chatId>/` and returns `{ id, name, mime, size, pages? }`.
  - The landing composer uploads after `createFromDraft()` returns the chat id.
  - Limits: 20 MB, at most 5 files per turn.
- `MessageDTO.attachments?: AttachmentDTO[]`, persisted in a new `message_attachments` table.
  Don't put them in the content.
- **Text and code files:** the `read` tool handles them already, since they sit inside the `home`
  sandbox. The user message gets a one-line pointer ("Attached: lease.pdf (14 pages) at
  attachments/…") so the model knows to read it.
- **PDF:** extract text in the engine (for example with `unpdf`) into a sidecar `.txt` that `read`
  can page through. `pages` comes from the PDF.
- **Images:** add image parts to the in-house LLM layer for providers and models that advertise
  vision (`ModelInfo` capability). For a non-vision model, the composer shows a one-line warning
  in the privacy row: "{model} can't see images. Pick a model that can."
- **Composer UI:**
  - Clicking the paperclip opens the native file dialog (`@tauri-apps/plugin-dialog`), and the
    composer also accepts files dropped on it.
  - Pending files show as `.r-attach` chips above the textarea, each with a remove ✕. This state
    isn't in the mockup; reuse `.attach` styling at the same size.
- **Interim** (before attachments ship): the paperclip shows a toast, "Attachments are coming
  soon." It must not look disabled.

**Web search**
- Depends on WEB_SEARCH_PLAN WS0–WS2 (the provider seam and the `web` tool).
- The globe toggle is a per-chat boolean in `chats.settings_json.webSearch`, and on the Home draft
  before the chat exists. When it's on, the `home` agent's tool list includes `web`; when it's
  off, it doesn't. Toggling mid-chat is allowed: the next turn's tool set changes, and so does the
  cache prefix. Note that in WEB_SEARCH_PLAN.
- `web` results feed the "Searched the web · N sources" row: titles plus the source site name
  from the result's host, mapped to a friendly name where known, otherwise the bare host.
- **Interim** (before WS ships): the toggle works visually and persists, and the privacy line
  gains " · Web search isn't set up yet" with a link that opens Settings.

**Exit:** a PDF lease round-trip works ("Read lease-2026-draft.pdf · 14 pages" plus a grounded
answer), an image round-trip works on a vision model, and a web-search round-trip renders
"Searched the web · N sources" with the expandable list.

### HD8 — Pixel sweep and polish

> **Status (2026-10-06): shipped, uncommitted. HD0–HD8 are all built; only HD7's web half is still
> waiting, on WEB_SEARCH_PLAN WS0–WS2.**
> - **Sweep.** All 17 fixtures (§5's 12 plus `chat-school`, `-index`, `-plant`, `-toast`, `-phone`)
>   × 9 themes × 2 reply fonts × 3 text sizes = 918 combinations, at 1440×900. Each region
>   (sidebar, top bar, seal, wall, veil, landing, transcript, dock, theme popover, model menu) was
>   compared with the mockup element by element: box to 0.5px and 22 computed styles (font, colour,
>   background and wallpaper image, padding, border, radius, shadow, opacity). Elements are
>   aligned by tag and class, so an app-only wrapper that draws nothing doesn't count. Every
>   combination matches except the §6 deviations. The theme switches through the same `storage`
>   event a second window would send.
> - **Fixed during the sweep:**
>   - The Code fixture now lists LM Studio itself, so Home's fixture listed Gemma twice. That made
>     the model menu too tall to open above the landing composer, so it flipped below.
>     `fixtures/home/build.ts` now adds LM Studio only if it's missing. This was fixture-only.
>   - HD6's open question, the inline-`code` rule inside the code card: kept for parity, but a
>     multi-line block indented its first line 0.4em past the rest (side padding lands only on
>     the first line fragment). `box-decoration-break: clone` aligns every line; one-line cards
>     render exactly as before (`chat-bill` still matches in all 54 variants).
> - **Transitions** match the mockup's durations and easing line for line: colours `.35s`,
>   sidebar `margin-left .25s ease`, popover `r-pop .16s`, the landing's `rise`/`fade` arrival,
>   the act chevron `.2s`, turn actions `.15s`, the seal `transform .2s`. There's also a
>   `prefers-reduced-motion` kill switch. There was no screen-recording pass by eye: the agent
>   session has no Screen Recording permission, so this is a source comparison only.
> - **Accessibility**, checked in the running fixture:
>   - The seal has `aria-haspopup="dialog"` and `aria-expanded`.
>   - The theme popover has `role="dialog"`. Swatches are a `radiogroup` of `radio`s with
>     `aria-checked`, and the size and font segments use `aria-pressed`.
>   - The model menu has `role="menu"` with `menuitemradio` items, and the pill has
>     `aria-haspopup="menu"` and `aria-expanded`.
>   - Act rows toggle `aria-expanded`, and the working line has `role="status"`.
>   - A keyboard-focused button draws `2px solid var(--ring)`.
>   - Nothing uses a positive `tabindex`.
> - **Keyboard:**
>   - Tab order runs sidebar → top bar → seal → main.
>   - Escape closes the theme popover, the model menu and the chat-title menu, and focus goes back
>     to the button that opened each one.
>   - ⌘N leaves an open chat for the landing, with the composer focused.
> - **Dead code:** `HomePane.tsx`, `ThemePicker.tsx` and `Titlebar.tsx` were already gone.
>   `app-shell.css` lost the old shell frame (`.rama-root/-frame/-main`), the title bar
>   (`.rama-titlebar-*`, `.rama-tab-dot*`, `.rama-cmdk-pill`), the theme picker and the old
>   sidebar (`.rama-sidebar-*`, `.rama-project*`, `.rama-chat-row*`, `.rama-new-chat-btn`), going
>   from 1195 to 668 lines. `.rama-btn-danger` stays (CodeChatList's delete dialog).
> - **Left for the Code plan:** 53 other `app-shell.css` classes are unreferenced now that
>   the old chat column is gone (`.rama-chat-column`, `.rama-msg-*`, `.rama-tool-call-*`,
>   `.rama-model-menu-*`, `.rama-status-*`, `.rama-clarify-*`, `.rama-thinking-block`,
>   `.rama-artifact-*`, …). They're the Code tab's legacy, so CR's sweep should delete them.

- Run every fixture in §5 across **all 9 themes**, both reply fonts and all 3 text sizes. Fix
  every region over the threshold, or record it as an accepted deviation in §6.
- Check transitions against the mockup by eye in a screen recording: the theme switch (`.35s`
  colours), the sidebar slide (`.25s`), the popover (`.16s`), the landing arrival, the act
  chevron and the turn-action fade.
- Check accessibility, matching the mockup's ARIA:
  - the seal: `aria-haspopup`, `aria-expanded`
  - swatches: `role="radiogroup"`/`"radio"` with `aria-checked`
  - menu items: `role="menuitemradio"`
  - act rows: `aria-expanded`
  - the working indicator: `role="status"`
  - `:focus-visible` rings use `var(--ring)`
- Check keyboard behaviour: Tab order runs sidebar → top bar → seal → main. Escape closes
  popovers. ⌘N works.
- Remove the dead code: `HomePane.tsx`, `ThemePicker.tsx`, `Titlebar.tsx` (main window) and the
  `rama-home-*`/`rama-sidebar-*`/`rama-titlebar-*` CSS blocks in `app-shell.css` that nothing
  references any more. **Leave** anything the Code plan still uses; check with grep before
  deleting.
- Update memory and docs: mark HD0–HD8 shipped in this file, and record the accepted deviations.

---

## 5. Verification: the pixel-diff harness

> **As built (HD0, HD8):** the screenshot harness below was never built, because the agent session
> has no Screen Recording permission. Instead, the app runs in fixture mode (the Code plan's
> `apps/desktop/fixture.html`, an in-memory engine) next to the mockup in one browser engine. Each
> region is compared element by element: box to 0.5px plus 22 computed styles. Being in the same
> engine at the same size gives what the "same WKWebView" requirement was for, without the
> rasterisation noise. The steps below are kept as the original design.

Comparing a Chromium screenshot of the mockup with a WKWebView screenshot of the app would show
font-rasterisation noise everywhere. So **render both in WKWebView, in the same Tauri process, at
the same size**:

1. **Mockup window (dev only).**
   - Add `server.fs.allow: ["../../docs/Rama"]` to `vite.config.ts`.
   - Add a dev-only command-palette action, "Open design mockup", that creates a
     `WebviewWindow({ label: "mockup", url: "/@fs/<abs>/docs/Rama/home-redesign.html", width:
     1440, height: 900, titleBarStyle: "Overlay", trafficLightPosition: same as main })`.
   - Point the mockup's `<link>` fonts at the same self-hosted files: a dev-only query flag,
     `?localfonts`, injects an `@font-face` override so both windows rasterise identical font
     binaries.
2. **Fixture mode (dev only).**
   - `?fixture=<name>` in the main window, gated on `import.meta.env.DEV`, swaps
     `HomeChatsProvider`'s data source for `home/fixtures/mockupChats.ts`: the mockup's ten
     `CHATS` (`mock:L882-1004`), converted to `MessageDTO`/`ChatBlock[]` with markdown text, and
     the four `MODELS` (`mock:L868-873`) as fake providers.
   - It also freezes `Date.now()` to **2026-10-05 18:30 local** (so the greeting is "Good evening"
     and the groups match), pins the theme, the scale and the reading font from the query, and
     sets `homeView`/`homeChatId`.
   - The mockup gets the same state through its own URL hash: add a tiny dev shim to the mockup
     (`#fixture=chat-lease&theme=matsu&t=1830`) that calls `openChat()`/`applyTheme()` and fakes
     the clock. This is the **only** edit to the mockup file, and it lives in a clearly fenced
     `/* dev fixture shim */` block.
3. **Capture.** `scripts/pixel/capture.ts` (bun) finds both windows' ids
   (`osascript`/`CGWindowList`), runs `screencapture -l <id> -o -x` on each, at 2× (Retina), for
   every `fixture × theme` pair in `scripts/pixel/matrix.json`.
4. **Diff.** `scripts/pixel/diff.ts` uses `pixelmatch` (threshold 0.1, antialiasing ignored) to
   write `out/<fixture>-<theme>.diff.png` plus a summary table. It applies these masks:
   - the traffic-light box (x 10–80, y 14–38)
   - the textarea caret
   - any element marked `data-pixel-mask` (used for live timers)
   **Pass:** ≤0.5% of unmasked pixels differ, and no differing cluster is larger than 24×24px.
5. **Run it.** It's a manual script in this plan; CI can't drive macOS windows. Each phase's exit
   criterion names the fixtures it must pass. The summary table is attached to the phase's commit
   message.

Fixture list: `landing`, `landing-model-pop`, `landing-web-on`, `landing-cloud-model`,
`theme-pop`, `chat-lease`, `chat-lisbon` (with the web act expanded), `chat-bill`,
`chat-sourdough` (prose only), `chat-recipe` (image attachment), `chat-working`,
`sidebar-closed`.

---

## 6. Accepted deviations from the mockup

These are differences the real app needs. They're masked or excluded from the diff:

1. **Native traffic lights** instead of drawn ones: positioned to overlay, then masked.
2. **Top-bar left padding of 80px when the sidebar is closed**, to clear the native lights
   (HD1).
3. **The chat-title menu, sidebar search, row context menu, stop button, pending attachment
   chips (with ✕) in the composer, the privacy-line notes (vision warning, attach limits, "Web
   search isn't set up yet"), notices and "More models…" row** aren't in the mockup. They're
   designed from kit tokens and kept out of the parity fixtures. In the sweep this shows as:
   - the web note shifting the privacy line in `landing-web-on`;
   - `chat-lisbon`'s dock with the globe on, since that chat used the web;
   - "More models…" in the model menu's first label;
   - the stop square in `chat-working`'s dock.
4. **Open-at-bottom** for real chats (D4). Fixtures open at the top.
5. **The working line's verb rotates** through Rama's playful verbs ("Surfacing…", "Swimming
   through it…") where the mockup always says "Diving in…". Same box, only the width of the word
   changes.
6. **The ≤820px and ≤480px rules** (`mock:L669-687`) aren't ported, because the window's minimum
   width is 860. Port them only if `minWidth` drops.

---

## 7. Out of scope

- Restyling the Code tab, Toolbox, Docs or the Settings modal. Settings › Appearance gets only the
  D2 scale change; its theme gallery stays until someone decides whether to remove it.
- Per-chat themes (retired by D1) and user-authored kanji fonts.
- Voice input, image generation, chat sharing and export.
- Moving a Home chat into a project, or a code chat into Home. The data model allows it later
  (`kind` and `project_id` are independent columns), but there's no UI for it.

---

## 8. Sequencing

```
HD0 foundation ──► HD1 shell ──► HD2 seal/popover
        │              │
        │              └──► (Code plan may start blocks/workspace on the kit)
        │
        └──► HD3 engine + data ──► HD4 sidebar list ──► HD5 landing/composer/menu ──► HD6 conversation ──► HD7 attachments + web ──► HD8 sweep
```

- HD3 has no visual dependency and can run alongside HD1 and HD2.
- HD5 needs HD3 for real sends, but its visuals can be diffed earlier with fixtures alone.
- HD7's web half is blocked on WEB_SEARCH_PLAN WS0–WS2. Its attachment half isn't blocked.
- Suggested commit grain is one phase per commit. HD1 and HD6 may split into a kit commit and a
  view commit.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Both plans edit `AppShell.tsx`, `Sidebar.tsx`, `ProjectsProvider.tsx` and `tokens.css` at once | §3 contract: HD0/HD1 merge first, the sidebar is split into per-section files, and Code edits `ProjectsProvider` only for code-list logic |
| `color-mix(in oklab)` or relative colour gaps in WKWebView | Darwin 25 WebKit supports both; check once in HD0 with a token swatch page in the mockup window |
| Font metric drift between Google-served and self-hosted files | Both windows load the same local files (§5 step 1) |
| The Home kernel changes the prompt-cache layout | Home chats have their own prefix by design; code chats are untouched. Add a `build.test.ts` case for each kind |
| A model doesn't follow the `draft` fence convention | It degrades to a normal code card or prose. Nothing breaks, and the card is a nicety |
| Snippet query cost on large histories | Compute only for the ≤3 resume rows plus visible rows, or cache at run end |
| The global theme (D1) surprises users with per-chat themes saved | One-time migration: adopt the active chat's theme as the global theme on first launch |
