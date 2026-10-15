# Rama — Settings Implementation Plan (pass 01)

Phases here are numbered **S0–S5** so they never collide with the build phases
0–8 in `docs/IMPLEMENTATION_PLAN.md` or the redesign phases R0–R7 in
`docs/REDESIGN_PLAN.md`. Cite these as "SETTINGS_PLAN.md Phase S2".

This plan follows the redesign (R0–R6, shipped). The redesign settled *where*
settings live — one modal, `apps/desktop/src/app/SettingsModal.tsx`, eight nav
panes. This plan is about *what is inside them*. The modal's chrome, nav, and
CSS are not up for change here.

**The framing that drives every decision below.** Rama is not a coding app with
some LLM plumbing bolted on. It is a general enterprise LLM interaction layer
that happens to be *built for* coding. Settings that only make sense to someone
editing a repo (a default project directory, a chat mode) are fine, but they
are not the spine. The spine is: **which models can I reach, where does my
material live on disk, and what does it look like.** That is Providers,
General/Folders, and Appearance — the three panes this plan rewrites.

**Ordering rationale.** S0 (wallpaper moves into the theme) comes first because
it changes the theme contract itself: `--wp` and `--veil` stop being user state
and become theme-authored fields, and a mode-dependent floor calculation is
deleted. Designing the JSON schema in S1 before that lands means designing it
around a shape that is about to change. S1 (theme file format) then encodes a
contract that is already settled. S2 (nine themes) is nearly free once S1 holds — that
is the whole point of S1. S3 (font scale) is independent and can land any time
after S0. S4 and S5 touch the engine and the DB and are independent of the
theme work; S5 is the largest single piece in this plan.

**Rules that hold across every phase.**
- Each phase ships runnable. `main` never boots broken.
- Anything touching CSS is checked in a **dark and a light** theme before it
  lands. (R0's rule; still the rule that catches tokens which only read right
  on a dark ground.)
- No settings UI for a subsystem that does not exist. R2, R4 and R6 all made
  this call about the account system; it still holds. Where this plan bends it
  (the agents folder in S4) it says so explicitly and says what makes it honest.

---

## Phase S0 — Wallpaper stops being a setting, becomes part of the theme

**Ask (revised):** "remove the wallpaper selection and the dimming from the
appearance section, lets just keep themes and fontsize" — *and* — "i wanna keep
wallpapers but they aren't part of the customisibility, they will be part of
themes, so we can give different experiences with themes."

### This finishes a decision R0 already made half of

R0's own words, still at the top of `tokens.css`: *"A theme is not an accent hue
on a shared ground — it's the whole palette."* That call was made for colour and
never made for the wallpaper, which stayed outside as a second axis. What
shipped is a cross product the user has to assemble by hand — theme × wallpaper
× dim — where most of the 12 combinations are worse than the three someone
would have chosen deliberately. Kanagawa under the rose nebula is not a
feature, it is a way to make Kanagawa look wrong.

So the wallpaper moves *inside* the theme record. Picking Matsu gets you the
pine ground, the leaf-green accent, **and** its wallpaper and veil strength, as
one authored environment. The Appearance pane still loses both controls, which
is what the ask wanted; the wallpapers themselves stay, and get better, because
now someone is choosing them per palette instead of the user pairing them blind.

**Consequence for the plan:** `WallpaperStack.tsx` keeps its name. The earlier
draft renamed it to `Ground.tsx` on the premise that the wallpaper layers were
going away — they are not, so the rename is gone with it. Fewer files move.

### The other four layers are not the wallpaper

Worth keeping in view even though nothing is being deleted wholesale.
`WallpaperStack` renders:

```
DotFieldBackground → image → veil → vignette → accent wash → grain
```

Only **image** and **veil** are the wallpaper. Dot field, vignette, accent wash
and grain are the app's *texture* — pure token math off `--a10`, `--rc`,
`--vig-a`, `--grain-op`, and a large part of why the app does not read as a flat
webview. Nothing in this phase touches them.

### What changes: who writes `--wp` and `--veil`

Both tokens survive. What dies is their *source*. Today `theme.tsx` computes:

```ts
const floor = isLight ? 0.93 : state.wallpaper === "none" ? 0.96 : 0;
root.style.setProperty("--veil", String(Math.max(state.dim / 100, floor)));
```

That floor exists to stop the user's dim slider from producing something
illegible — it is a guard rail around a control that is being removed. With the
veil authored per theme by the person who also picked the image, the guard rail
has nothing to guard. **The theme states its veil outright and the calc is
deleted.**

### The wallpaper block on a theme

Lands in S0 as a TypeScript field on `RamaTheme`; becomes JSON verbatim in S1.

```ts
interface ThemeWallpaper {
  /** File resolved against the theme's own directory. */
  image?: string;
  /** Raw CSS background-image value — a gradient, used as-is. Wins over `image`. */
  css?: string;
  /** 0 = image at full strength, 1 = fully covered by --page-bg. */
  veil: number;
  /** Optional mix-blend-mode on the image layer. Default "normal". */
  blend?: string;
  /** background-size / background-position. Default "cover" / "center". */
  fit?: string;
  position?: string;
}
```

`fit`/`position` are not speculative: the green reference is a handscroll at
**2.76:1**, and `cover` on a 16:10 window crops away both the top mist and the
bottom water — the two things that make it read as a landscape. It needs
`background-size: 100% auto` with a chosen anchor, and no other wallpaper
wants that, so it has to be per-theme data.

Two fields for the image slot rather than one clever string that gets sniffed
for a `(`. A theme author reading the folder's README should not have to guess
which branch their value hits.

**Absent `wallpaper` means no image**, and both the image and veil divs skip
rendering — not `--wp: none` with a veil at 1.0 painting an invisible full-page
layer for nothing. Sumi is the theme that will use this: ink-wash wants bare
ground, and it proves the optional path on day one.

`--veil` keeps its `:root` default (`1`) purely as a fallback for a theme that
sets an image and forgets the veil. Fully covered is the safe failure, not a
photo at full strength behind body text.

### Which theme gets which wallpaper

The repo had three wallpaper assets — `nebula-indigo.jpg`,
`nebula-inferno.jpg`, `nebula-rose.jpg`, all blue and red. The green family now
has one too: the blue-green landscape handscroll supplied as its reference,
staged at `apps/desktop/public/wallpapers/sansui-green.jpg` (964×349, silk mount
cropped off, 103KB). Everything else is a gradient:

| theme | wallpaper |
|---|---|
| Kanagawa (blue dark) | `nebula-indigo.jpg`, veil ≈ 0.62 — today's default pairing, now the authored one |
| Sumi (blue deep) | none — bare ink ground |
| Nami (blue light) | gradient |
| Sakura (red light) | gradient |
| Tsubaki (red dark) | `nebula-rose.jpg` |
| Shu (red deep) | `nebula-inferno.jpg` |
| Matsu (green dark) | `sansui-green.jpg` — the reference handscroll (see S2) |
| Wakaba / Rokushō (green) | gradients measured from that painting |

**CSS gradients are the default mechanism, image files the escape hatch.** A
hand-tuned multi-stop radial or conic gradient costs zero bytes, ships inside
the theme JSON with no asset pipeline, restyles live when the file is edited,
and — behind a 0.5–0.7 veil, under grain and a vignette — is genuinely hard to
tell from a photo. It is also the only way the green family gets a wallpaper
without someone sourcing art. If real Kanō-school scans turn up later they drop
into the same `image` field and replace the gradient with a one-line edit.

### Changes

| File | Change |
|---|---|
| `packages/ui/src/themes.ts` | `RamaTheme` gains `wallpaper?: ThemeWallpaper`. The three existing themes get their assignment from the table above. |
| `packages/ui/src/theme.tsx` | Delete `Wallpaper`, `WALLPAPERS`, `setWallpaper`, `setDim`, `cycleWallpaper`, `dim`, `resolveWallpaperUrl`, and the floor calc. `ThemeState` becomes `{ themeId }` (plus S3's `fontScale`). The apply effect writes `--wp`/`--veil`/`--wp-blend` **from the theme record**. |
| `packages/ui/src/WallpaperStack.tsx` | Keeps its name. Image + veil divs render only when the active theme has a wallpaper. Comment updated: these are theme-authored, not user-set. |
| `packages/ui/src/wallpaper.css` | Add `mix-blend-mode: var(--wp-blend, normal)` to `.rama-wallpaper-image`. Otherwise unchanged. |
| `packages/ui/src/tokens.css` | `:root { --wp: none; --veil: 1; }` stays as a fallback; comment rewritten — set from the theme, not from a user control. |
| `apps/desktop/src/app/SettingsModal.tsx` | Delete the wallpaper `SegmentedControl` and the dim `<input type=range>` from `AppearancePane`. |
| `apps/desktop/src/app/CommandPalette.tsx` | Delete the `act:wallpaper` "cycle wallpaper" command (line 153) and its `useTheme` destructure + dep. `cycleTheme` already cycles the wallpaper now. |
| `apps/desktop/src/app/data/ProjectsProvider.tsx` | Drop `wallpaper` from the per-chat apply/persist path (`lastAppliedTheme`, `applyTheme`, `createChatApi`). It becomes `{ themeId }` only — the wallpaper travels with the theme id for free. |
| `engine/src/db/chats.ts` | Drop `wallpaper` from `CHAT_COLUMNS`, `ChatRow`, the DTO mapper, `createChat`, the patch-key map. |
| `packages/protocol/src/index.ts` | Drop `wallpaper` from `ChatDTO` / create + patch inputs. |
| `apps/desktop/public/wallpapers/` | **Keep.** These are now theme assets. |

**`chats.wallpaper` (SQLite column): leave it in place.** `NOT NULL DEFAULT
'indigo'`, so inserts that stop naming it still succeed. Dropping a column is a
table rebuild for zero benefit on a column nothing reads. Mark it dead in
`schema.ts`; remove it next time the schema is rebuilt anyway.

### Watch for

- **Per-chat wallpaper silently changes meaning.** Today two chats on the same
  theme can carry different wallpapers. After this they cannot, by design. No
  migration — the column is simply no longer read.
- **Light themes and the veil.** Foam's floor was `0.93`; a light theme's
  authored veil should start near there and be tuned down carefully. A photo at
  0.62 under a light palette is not the same picture it is under a dark one.
- **The asset lives in `apps/desktop/public`, but the theme record lives in
  `packages/ui`.** Fine while both are bundled builtins resolving to `/wallpapers/…`,
  and it is exactly the seam S1 has to solve properly for user themes.

---

## Phase S1 — Themes as JSON files

**Ask:** "lets make the themes stored in a folder as json files so they are
easily addable and removable to the project ... we will have to extract
structure for the theming."

### Today

Two sources of truth, deliberately: `packages/ui/src/themes.ts` holds metadata
(id, label, mode, gallery preview swatches) and `packages/ui/src/tokens.css`
holds the actual ~24-token block under `[data-rtheme="<id>"]`. The file comment
in `themes.ts` says the split was chosen to avoid the values drifting. Adding a
theme means editing two files in two languages, and the CSS block is ~25 lines
of which about 18 are the *same formula* in every theme.

### The insight that makes the JSON small

Most of the 24-token contract is not independent data. Read the three shipped
themes side by side and the redundancy is structural:

- **`--sf-hi` is exactly `--bg-elevated`** in both kanagawa (`#15334A` /
  `21,51,74`) and foam (`#ffffff` / `255,255,255`). `--sf-lo` is `--bg-surface`
  a hair darker; `--rc` is `--bg-deep` a hair darker. Three seeds collapse into
  the ground ramp.
- **`--text-1` and `--ink` are the same colour** to within a couple of points
  (kanagawa `#dce7ee` vs `214,226,232` = `#d6e2e8`; foam `#1a2129` vs
  `30,38,48` = `#1e2630`). One seed, two forms.
- **`--border-1/2/3` are hand-written `rgba()` of the accent** at 0.06/0.11/0.20
  (dark) and 0.05/0.10/0.18 (light). Pure derivation, and already expressible
  with the `oklch(from …)` syntax `tokens.css` proves works in WKWebView.
- **`--accent-bright/-hi/-dim/-glow/-tint/-border`, `--text-3`, `--text-4`,
  `--dot-field-color`, the `--a70…--a06` ramp** — all already derived from
  `--accent`, all already written identically in all three themes.
- **`--shadow-menu` / `--shadow-composer`** differ only in the shadow rgb
  triplet, which is `--bg-deep` darkened — i.e. `--rc`, which we already have.
- **`--grain-op` / `--vig-a`** cluster by mode (dark ≈ 0.28–0.30 / 0.58–0.60,
  light 0.12 / 0.22), not by theme.

The derivations that genuinely differ are **mode-dependent, not
theme-dependent**: `--text-3` is `l 0.66` on dark and `0.40` on light;
`--accent-dim` is `l 0.29` on dark and `0.90` on light; the border alphas step
down slightly on light. So:

> **`tokens.css` keeps exactly two blocks of pure formulas — one for
> `[data-rmode="dark"]`, one for `[data-rmode="light"]` — and every theme JSON
> supplies five colours.**

That is the extracted structure. The nine themes in S2 become nine ~12-line
files, and the "adding a theme is like adding a json file" goal is literally
true rather than aspirationally true.

### The theme file format

`packages/ui/src/themes/<id>.json`:

```jsonc
{
  "id": "matsu",
  "label": "Matsu",
  "family": "green",        // gallery grouping: "blue" | "red" | "green"
  "mode": "dark",           // drives which formula block applies

  "ground": "#0d1410",      // → --bg-base, --page-bg; --bg-deep/-surface/-elevated,
                            //   --sf-hi/-lo, --rc all derived as a lightness ramp
  "ink": "#d8e2d4",         // → --text-1 and the --ink rgb triplet
  "inkLoud": "#f2f6ee",     // → --ink-hi
  "accent": "#7fb069",      // → 6 accent variants, 3 borders, --text-3/-4,
                            //   --dot-field-color, the --a* alpha ramp

  // ── everything below is optional ───────────────────────────────────────
  "kanji": "松",                             // the theme seal's text (HOME_REDESIGN_PLAN HD0/HD2);
                                             //   defaults to the label's first character
  "wallpaper": {                             // S0's block, verbatim. Absent = no image.
    "css": "radial-gradient(120% 90% at 20% 0%, #1c3324, transparent 62%), \
            radial-gradient(90% 70% at 85% 15%, #0f2416, transparent 58%)",
    "veil": 0.58                             // 0 = full strength, 1 = fully covered
  },
  "semantic": { "bad": "#e0707a" },          // good/warn/bad/bad2; mode defaults otherwise
  "texture":  { "grain": 0.30, "vignette": 0.60 },  // dead since HOME_REDESIGN_PLAN HD0; still parsed
  "tokens":   { "--bg-elevated": "#1b2a1e" } // raw escape hatch, applied last
}
```

Four required colours. The `tokens` escape hatch is load-bearing: without it,
the first theme that wants to break a derivation forces a schema change, and
the schema calcifies. With it, a theme author can always fall back to writing
the token by hand and the format never has to grow a field for a one-off.

Gallery previews (`preview.bg/surface/accent/ink` in today's `themes.ts`) are
**computed, not authored** — `bg` is `ground`, `accent` is `accent`, `ink` is
`inkLoud`, `surface` comes off the derived ramp. One less thing to keep in
sync, and one less thing an author can get wrong.

### Where a wallpaper file lives — the one hard part of S0-in-JSON

A gradient is just a string and travels inside the JSON with nothing to
resolve. An `image` is a file, and the two theme sources resolve it completely
differently:

- **Builtin themes** — the file sits in `apps/desktop/public/wallpapers/` and
  resolves to `/wallpapers/<name>.jpg`, served by Vite / the Tauri asset
  protocol. This is what already works today.
- **User themes** — the file sits next to the JSON in `~/.rama/themes/`, a path
  the webview cannot reach. It needs an engine route:
  `GET /themes/asset/:file`, authed like every other engine route, so the
  token writes into the URL: `--wp: url('http://127.0.0.1:PORT/themes/matsu/pines.jpg?token=…')`.

The route must reject any `:file` that escapes the theme directory — it is a
path join off user input, and the engine can read the whole home directory.
Normalise, then assert the result is still under `THEMES_HOME`.

CSP is not in the way: `tauri.conf.json` has `"csp": null`, so a
`http://127.0.0.1` image URL loads. Worth knowing that the day a CSP is added,
this breaks, and the fix is `img-src` — note it next to the route.

**The gradient path needs none of this**, which is a second reason to make
gradients the default mechanism and files the escape hatch.

### Loading

`packages/ui/src/themes.ts` becomes a loader, not a table:

```ts
const files = import.meta.glob("./themes/*.json", { eager: true, import: "default" });
export const THEMES: RamaTheme[] = Object.values(files).map(parseTheme).sort(byFamilyThenMode);
```

Vite resolves the glob at build time: no runtime IO, JSON is type-checked
against the schema by `parseTheme`, and a malformed file fails the build rather
than the app. Adding a theme is `cp` + reload.

**Applying** moves from CSS attribute selection to a runtime write, because the
values now come from JS:

```ts
// theme.tsx apply effect
root.dataset.rmode = theme.mode;              // selects the formula block
for (const [k, v] of Object.entries(seedTokens(theme))) root.style.setProperty(k, v);
```

`data-rtheme` stays on the root as well — it costs nothing and keeps the door
open for a per-theme CSS override rule. Which we need immediately: the
`[data-rtheme="kanagawa"] .rama-btn-primary { box-shadow: … }` rule that exists
today for each theme becomes `--shadow-btn-primary`, a derived token, and the
per-theme rules are deleted.

### `ThemeId` stops being a union

`export type ThemeId = "kanagawa" | "sumi" | "foam"` cannot survive a directory
of files. It becomes `type ThemeId = string`, and the safety moves to a runtime
`getTheme(id)` that already falls back to the default. Consequence to track:
`packages/protocol`'s `ThemeIdDTO` and `chats.theme_id` relax to `string`, so
a chat row carrying a theme id whose file was deleted silently renders as the
default instead of failing to compile. That is the correct behaviour for a
format whose whole selling point is that files can be removed — but it means
**a typo in a theme id is now a runtime fallback, not a build error.** Mitigate
by having `parseTheme` assert the `id` field equals the filename stem.

### Two sources: bundled builtins **and** `~/.rama/themes` — resolved

Both. The glob above is source one. Source two is a user directory the engine
reads, so a theme can be dropped in without a rebuild.

```ts
// themes.ts — one merge, two sources, user wins on id collision
const BUILTIN = Object.values(import.meta.glob("./themes/*.json", { eager: true, import: "default" }));
export function mergeThemes(user: RamaTheme[]): RamaTheme[] { /* by id, user last */ }
```

**Shadowing rule: a user theme with a builtin id wins.** That is the useful
behaviour, not a hazard — it means you can retune `kanagawa`'s accent by
dropping one file in `~/.rama/themes/kanagawa.json`, without forking the repo.
The gallery marks such an entry so it is obvious why the shipped theme looks
different from someone else's.

**Engine side.** `THEMES_HOME = join(RAMA_HOME, "themes")`, `mkdirSync` on boot
next to `blobs`/`skills`. `GET /themes` returns `{ themes, errors }` — parsed
themes *and* the per-file validation failures, because a theme file that fails
silently is a theme file you will spend twenty minutes debugging. On first
creation, seed the directory with `README.md` and `example.json` so the format
is discoverable from the folder itself rather than only from this document.

**Live reload.** `fs.watch(THEMES_HOME)`, debounced ~150ms, pushed over the
existing WS in `engine/src/ws.ts`. Edit the JSON, watch the app restyle. That
authoring loop is most of the value of having a user directory at all — without
it, "no rebuild needed" still means "restart the app", which is barely better
than the bundled path.

**Errors surface in the pane.** `AppearancePane` renders the `errors` array
under the gallery: `sunset.json — missing required colour "accent"`. Never a
silent skip.

### The first-paint problem this creates

Builtins are available synchronously at module load; user themes arrive over
HTTP after boot. If the persisted `themeId` names a **user** theme, the first
paint has no palette for it and falls back to the default — a visible flash of
the wrong theme on every launch, on exactly the theme someone cared enough to
hand-write.

Fix: the theme engine already writes `rama.theme` to `localStorage`. Have it
cache **the resolved seed tokens** of the active theme there, not just the id.
First paint applies the cached tokens immediately; the fetch then confirms or
corrects them. Same trick as a dark-mode no-flash script, and it costs about
six lines. Without it the user-themes feature ships with a flicker on launch.

**The cache covers the veil and a gradient `--wp` — not an image URL.** A
gradient is a string and caches like any other token. An image on a user theme
resolves to an engine URL whose port is not known until the engine is up, so it
paints one frame late. That is acceptable: it lands behind a veil, under grain,
and the palette — the part the eye actually catches — is already correct. Do
not try to inline the image as a `data:` URI to fix it; a 390KB jpg becomes a
530KB base64 string in both the HTTP payload and `localStorage`, which is a
worse problem than one late frame.

---

## Phase S2 — Nine themes

**Ask:** three families (blue, red, green), three variants each — one
light/white-based and two dark — Japanese names throughout.

Blue already exists as three themes; it just needs its light member renamed for
naming consistency. `Foam` is the odd one out — it is the only English name in
a set of Japanese ones.

| family | light | dark | deep / bold |
|---|---|---|---|
| **blue** | **Nami** 波 — wave; today's `foam`, renamed | **Kanagawa** 神奈川 — the hero, unchanged | **Sumi** 墨 — ink-wash, unchanged |
| **red** | **Sakura** 桜 — pastel pink-white ground, deep rose accent | **Tsubaki** 椿 — camellia; the pastel-pink inverse: dusty rose on a dark plum ground | **Shu** 朱 — vermilion lacquer; near-black ground, high-chroma cinnabar accent |
| **green** | **Wakaba** 若葉 — new leaves; the painting's washi-cream side | **Matsu** 松 — pine; the painting itself, inverted into a dark ground | **Rokushō** 緑青 — verdigris, the *pigment* rather than the painting: near-black ground, saturated patina accent, gold-leaf `warn` |

### The green family, measured off the reference

The brief came with a picture: a blue-green landscape handscroll — jade
mountains under mist, waterfalls, dark pine, on a warm silk mount. I sampled it
rather than eyeballing it, and **the numbers contradict what I had written
here.** My earlier draft specified a "malachite accent" around `#7fb069`. The
painting contains nothing remotely that saturated.

| role in the painting | hex | HSL |
|---|---|---|
| paper / silk mount | `#ded6c3` | h 42° · s 29% · l 81% |
| far haze | `#c2bfac` | h 51° · s 15% · l 71% |
| pale water | `#939f8b` | h 96° · s 9% · l 58% |
| mid mountains | `#5c755d` | h 122° · s 11% · l 40% |
| deep green | `#3a5241` | h 137° · s 17% · l 27% |
| shadow | `#2b3e30` | h 135° · s 18% · l 20% |
| darkest | `#132118` | h 141° · s 26% · l 10% |

Three things fall out of that table, and all three are design rules:

1. **The greens are grey.** Saturation runs 9–26%, never higher. `#7fb069` at
   33% would look like a terminal prompt dropped into a painting. Cap the green
   family's chroma low and let *value* do the work.
2. **Hue drifts with value** — 96° at the lightest, 141° at the darkest. Lighter
   is yellower, darker is bluer. That is the single most characteristic thing
   about the image and it is free to reproduce: derive the green ramp along a
   hue axis, not a straight lightness ramp on one hue.
3. **The ground is a different hue family entirely** — the paper is warm yellow
   at 42°, not a desaturated green. The whole painting is two hues in tension,
   which is why it reads as paper-and-pigment rather than as a green picture.
   This confirms the `inkLoud` instinct from the earlier draft, now with a value
   attached: **`#ded6c3`, not white**, in all three green themes.

Which gives the three themes a genuine division of labour instead of three
lightness variations:

- **Wakaba** takes the paper side. Ground `#ded6c3`, surfaces up to `#f2ede0`,
  ink `#1f2a20`, accent `#3a5241` — deep pine on cream. (For scale: Foam's
  accent sits at l≈33%, so this is in family with the light theme that exists.)
- **Matsu** takes the painting, inverted. Ground `#131e18`, elevated `#2b3e30`
  (the measured shadow), ink `#c9cfbc`, `inkLoud` `#ded6c3`. Its accent is the
  one deliberate departure: the painting's lightest green is `#939f8b` at 9%
  saturation, which is dead as a UI accent — it drives focus rings, glows and
  the dot field. Lift it to about `#8fae91` (s≈17%). Of the painting, but alive.
- **Rokushō** is where the saturation the painting withholds finally goes. It is
  named for the *pigment*, not the picture, so it is free to be the bold one:
  near-black ground `#0b1410`, a real verdigris accent around `#43a98c` (blue-green,
  ~165° — patinated copper, not leaf), gold-leaf `warn` `#c9a227`.

### The measured gradient

The painting's vertical band profile, sampled in nine slices top to bottom:

```css
linear-gradient(180deg,
  #d7ccb6 0%,  #bcbaa6 12%, #929b8a 25%, #85917f 38%, #85917e 50%,
  #768270 62%, #5c6d5b 75%, #465a46 88%, #41513f 100%)
```

Its horizontal profile is nearly flat (`#75…#8d` across all six slices), so a
vertical gradient captures almost the whole composition. This is not an
invented gradient that gestures at the mood — it is the image's own value
structure, and it is what Wakaba and Rokushō use so the family holds together
whether or not the photograph is present.

**Provenance, worth settling before release.** The reference is a real painting
with an artist's seal on it, not a stock texture. Bundling it in a distributed
app is a licensing question — public-domain scan, licensed, or your own is
fine; unknown is not. It is staged so the theme can be built now, and the
measured gradient means **Matsu still works with the image removed**, which is
the cheap insurance. Also flag the resolution: 964×349 is thin for a full-window
background on a retina display, so a higher-res scan is worth sourcing if the
image stays.

Shu is the free-choice slot. Vermilion lacquer over near-black is the pick:
`accent` around `#e34a33`, `ground` around `#140a09`, with `bad` pushed
*away* from the accent (toward magenta-red) so error states stay legible — the
one place a red theme genuinely needs the `semantic` override S1 added.

**The `foam` → `nami` rename** is a migration: `chats.theme_id` rows say
`'foam'`. Do **not** write SQL for this. Add a one-line alias map in the
loader's `getTheme` (`const ALIASES = { foam: "nami" }`) — it resolves old rows
on read, costs nothing, and is the same shape as the fallback that already
exists there.

### Nine themes now means nine wallpapers too

S0 moved the wallpaper inside the theme record, so each of the nine is not a
palette but an environment, and each needs a `wallpaper` block (or a deliberate
absence — Sumi). Assignments are in S0's table: four photographs (three nebulas
plus the green handscroll), Sumi bare, and four gradients.

The gradients are real design work, not filler — a two- or three-stop radial in
the theme's own hues, offset toward one corner so the accent wash has something
to sit against. Budget them as part of writing each theme. Wakaba and Rokushō
are the easy two, because the measured profile above is already their gradient;
Nami and Sakura have to be authored from scratch, and the green one is the
worked example to author them against.

**Author each theme's `veil` against its own wallpaper, in the app.** A number
that reads well under Kanagawa's indigo nebula will be wrong under Sakura's
pale gradient — light grounds need far more veil to keep body text legible.
This is the one value in the JSON that cannot be derived and cannot be
eyeballed from the hex codes.

### Gallery UI

Nine flat swatches in `AppearancePane`'s `.rama-theme-gallery` is a long
scroll, and the titlebar `ThemePicker` dropdown is worse. Group by `family`:
three labelled rows of three, light member first. `ThemePicker` becomes a 3×3
grid with family as the row axis. Both read the same `family` field from the
JSON, so the grouping is data, not a hardcoded list.

Swatches are currently a flat `preview.bg` fill. Now that a theme carries a
wallpaper, the swatch should paint it — `background: var(--wp-of-that-theme)`
under the same veil — so the gallery previews the environment rather than one
colour out of it. That is most of what makes a nine-theme gallery worth
scrolling. Gradient themes get this for free; image themes need the swatch to
load the asset, which is fine for builtins and one more reason the user-theme
asset route in S1 has to exist.

---

## Phase S3 — Font size that actually works

**Ask:** "font size should be functional and should affect to all the fonts of
the app and not only the generated text prompts."

### Why it does not work today

There are **62 hardcoded `font-size: Npx` declarations in `app-shell.css`**,
~14 more in `primitives.css`, and **zero `rem` anywhere**. There is nothing to
turn. Worse, the sizes in use are `9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13,
14, 15, 16` — twelve steps, most of them a half-pixel apart from a neighbour.
That is not a type ramp, it is twelve independent guesses.

### Three ways to do it

1. **px → rem, scale `html`.** Mechanical, but scales only text while every
   padding, row height and icon box stays fixed — text grows and clips inside
   fixed-height rows. And it silently couples the app to the browser's default
   root size.
2. **A named type ramp × a scale multiplier.** Define the ramp once in
   `tokens.css` as `--fs-xs … --fs-xl: calc(<base>px * var(--font-scale))`,
   replace every literal with a ramp token. Same clipping risk, but explicit,
   and it forces the twelve guesses down to about six steps.
3. **`zoom` / `transform: scale()` on the root.** Scales layout too, so nothing
   clips — but it scales the *entire* UI including the titlebar and window
   chrome, blurs at fractional scales, and interacts badly with the Tauri drag
   regions in `drag.rs`.

**Recommendation: (2).** The ramp is worth building on its own merits — it is
the piece of the design system R0 did for colour and never did for type — and
the setting falls out of it for free. Doing (1) gets a knob and leaves the
twelve-guesses problem; doing (3) gets a knob and a blurry titlebar.

### The ramp

Collapse the twelve to six, mapped from actual usage:

| token | px | replaces | used for |
|---|---|---|---|
| `--fs-micro` | 9 | 9, 9.5 | `.t-label`, uppercase tracked labels |
| `--fs-xs` | 10.5 | 10, 10.5 | badges, status bar, metadata |
| `--fs-sm` | 11.5 | 11, 11.5 | nav rows, secondary chrome |
| `--fs-md` | 12.5 | 12, 12.5 | **body default**, most of the app |
| `--fs-lg` | 14 | 13, 14 | composer, message body, headings |
| `--fs-xl` | 16 | 15, 16 | page titles, the wordmark |

Each is `calc(<px> * var(--font-scale))`. `--font-scale` is a plain number set
on `:root` by the theme engine.

Scale steps: **90% / 100% / 112% / 125%**, labelled *compact / default / large
/ larger*, as a `SegmentedControl` — not a slider. A slider invites 103% and
gives you fractional-pixel text for no benefit.

### Scope: global, not per chat

Theme is per-chat state (it lives in `chats.theme_id`, it travels with a
popped-out window — R3's risk register). **Font scale is not.** It is an
accessibility/ergonomics preference about this human's eyes, and having it
change when you switch tabs would be absurd. It persists in the same
`localStorage` `rama.theme` blob the theme engine already writes, alongside
`themeId`, and never touches SQLite.

### Watch for

The clipping. Every fixed `height:` in `app-shell.css` that contains text needs
to become `min-height:` in the same pass, or 125% will overflow rows. Check the
sidebar rows, tab strip, status bar and composer at 125% in a light theme
before landing. `xterm.js` in `TerminalView.tsx` has its **own** font size and
does not read CSS tokens — either wire `--font-scale` into its `fontSize`
option too, or state that the terminal is deliberately independent. It should
be wired; "all the fonts of the app" includes that one.

---

## Phase S4 — The General pane

**Ask:** general is under-thought; startup project should just restore the last
session (not a setting); it needs default skills / agents / docs folder
locations, prefilled with sensible defaults, each with a "change folder" button
that opens the native file picker.

### Today

Three fields, one of which is not a setting: `defaultProjectDir` (a bare text
input), `defaultMode`, and a telemetry paragraph that is a statement of fact
with no control attached to it.

### What General becomes

Two groups. **New-chat defaults**, and **Folders**.

**New-chat defaults**
- default chat mode — keep as is, it is genuinely general.
- **default provider + model** — new. Today this is `DEFAULT_PROVIDER_ID` /
  `DEFAULT_MODEL`, two constants in `engine/src/agent/config.ts`, unreachable
  from the UI. Every new chat silently starts on Together AI's Llama 3.3 70B
  whether or not that provider is configured. This is the single most
  user-visible missing setting in the app. It reads from the providers the user
  has actually configured (S5), so it lands with S5 or after it.
  **Absorbed (2026-09-06) by `docs/PROVIDERS_PLAN.md` Phase P2** — it is not a
  standalone setting, it is the `chat` row of a three-role `model_roles` table
  (`chat` / `utility` / `summarize`). Build it there, not here.
- The telemetry paragraph **moves to the About pane**. It is a claim about the
  product, not a preference.

**Folders** — one repeated row component:

```
skills    ~/.rama/skills                    12 found   [change] [reveal] [reset]
agents    ~/.rama/agents                     0 found   [change] [reveal] [reset]
docs      ~/.rama/projects/<project>/docs    4 found   [change] [reveal] [reset]
projects  ~/dev                                        [change] [reveal] [reset]
```

The live count on each row is the detail that makes this pane feel like it is
wired to something rather than storing strings. It also gives immediate
feedback that a newly picked folder is the wrong one ("0 found").

**`projects`** is today's `defaultProjectDir`, moved into the group and given a
picker instead of a raw text field.

**`skills`** is real: `SKILLS_HOME = join(RAMA_HOME, "skills")` in
`engine/src/skills/discover.ts`, currently a hardcoded const. It becomes a
settings read with that value as the default. Note `discoverSkills` also scans
`<project>/.rama/skills` and lets project-local win — that stays, and the pane
should say so in a hint line rather than pretending the global root is the only
source.

**`docs`** is the subtle one. R6 resolved that docs stay **project-scoped**;
`engine/src/docs/store.ts` puts them at
`~/.rama/projects/<projectId>/docs`, deliberately outside the user's repo so
"gitignored" is trivially true. A global "docs folder" setting would quietly
reverse that decision. So the setting is the **root under which per-project doc
folders are created** — default `~/.rama/projects` — and the row displays the
resolved path for the active project so it is obvious what the setting controls.

**`agents`** does not exist. There is no agents concept anywhere in the engine —
no store, no discovery, no loader, no protocol DTO. Adding a picker for it is
exactly the thing R2/R4/R6 refused to do for the account system.

The difference that makes it acceptable here: a folder root is **storage
configuration, not a feature claim**. The row can be honest — it creates the
directory, it scans it, and it says `0 found` — without implying the agent
loader exists. What would *not* be acceptable is an "agents" nav row or a
picker in the composer. **Recommendation: ship the row, with the count wired to
a real (empty) scan, and file the agent-definition format as follow-up.** If
that feels like too much, the alternative is to ship skills/docs/projects now
and add agents when the concept lands. See Q2.

### Infrastructure this needs: there is no file picker

`apps/desktop/src-tauri/Cargo.toml` has `tauri`, `tauri-plugin-opener`,
`keyring`, `portable-pty`. **No `tauri-plugin-dialog`.** The capability file
lists `opener:default` and four `core:window:*` permissions. Nothing in the app
can open a native folder picker today.

Required, and it is the gating dependency for this whole phase:
- `Cargo.toml`: `tauri-plugin-dialog = "2"`, registered in `lib.rs`.
- `apps/desktop/package.json`: `@tauri-apps/plugin-dialog`.
- `capabilities/default.json`: `dialog:allow-open`.
- Frontend: `open({ directory: true, defaultPath })`.

Also needed for `[reveal]`: `tauri-plugin-opener` is already present and its
`revealItemInDir` is the right call — no new plugin, but check the capability
covers it (`opener:default` may not include `allow-reveal-item-in-dir`).

### Engine side

All four roots go into the existing key/value `settings` table under key
`"general"` via `getSetting`/`setSetting` — `engine/src/db/settings.ts` was
built for exactly this and its comment invites reuse. `GeneralSettingsDTO`
grows `skillsDir`, `agentsDir`, `docsRoot`, and renames `defaultProjectDir` →
`projectsDir` for consistency with the group.

Each read site (`SKILLS_HOME`, `DOCS_ROOT`) becomes a function that reads the
setting and falls back to the current constant, `mkdirSync(…, {recursive:true})`
on first use. **Validate on save**: path exists, is a directory, is writable.
Reject with a toast rather than persisting a path that will throw on next scan.

### Startup

"Startup project set from what was opened in the last session — that doesn't
need to be settings." Agreed, and it means there is nothing to add to this
pane. Restoring the last session is behaviour, not a preference. If it is not
already what happens, that is a `ProjectsProvider` change, not a settings one.

---

## Phase S5 — Provider setup wizard

> **SUPERSEDED (2026-09-06) by `docs/PROVIDERS_PLAN.md`, phases P0–P6.**
> Everything below is still true; it is just too big to land as one phase and it
> leaves three sibling problems untouched — the composer picker offers models
> nobody can reach, the model list has no way to stay current, and there is no
> cheap model available for background work like naming chats. PROVIDERS_PLAN
> keeps this section's inversion (P3), schema sketch (P0), migration rule (P3)
> and "never finish on a failed verify" rule (P5), and sequences the wizard
> *last* because it is unbuildable until user-defined models exist. Read that
> doc instead; this section is kept for its reasoning, not as the work order.

**Ask:** replace the list of every provider sitting around waiting for a key
with a wizard — pick from a preset list, and be able to add a custom provider.

### Why today's pane is wrong

`seedProviders()` runs on **every boot** and `INSERT OR IGNORE`s all six
`SEED_PROVIDERS` into the `providers` table. `listProviders()` returns all six.
So `ProvidersPane` renders six rows, five of them permanently reading "no key",
with no way to remove them, no way to add anything not in that list, and no way
to see which one new chats will actually use. The pane presents the *catalog*
as if it were the user's *configuration*.

### The inversion

**A row in `providers` should mean "the user configured this", not "Rama knows
this exists."** The catalog becomes a static TS constant the wizard reads; the
table holds only what has been set up.

- `seedProviders()` is deleted.
- `PROVIDER_CATALOG` (new, in `engine/src/agent/`) holds id, label, kind,
  default base URL, whether a key is needed, docs URL, and the builtin model
  list. It grows freely without touching the DB — add Fireworks, DeepSeek,
  Mistral, xAI, Cerebras, LM Studio, vLLM as entries, they cost nothing.
- `providers` gains columns: `is_custom`, `enabled`, `requires_key`. Today
  `requiresKey` comes from `REQUIRES_KEY`, a map keyed by seed id — a custom
  provider is not in it and silently defaults to `true`. It must be a column.

**Migration.** On first boot after this lands: keep seeded rows the user has a
keychain entry for, delete the rest. Anything referenced by a chat is kept
regardless. That rule is short, safe, and does not need the user to re-enter
anything.

### The wizard

Inline in the pane, not a nested modal — `Modal.tsx` is not built to stack and
a modal inside Settings inside a window is one layer too many.

1. **Choose** — a grid of catalog tiles plus a `custom (OpenAI-compatible)`
   tile. Already-configured providers show as configured, not selectable twice.
2. **Credentials** — API key (masked), base URL prefilled and editable. Custom
   adds: display label, and auth style (Bearer vs. a named header — that is the
   whole realistic space; skip query-param auth).
3. **Verify** — run the existing `providerHealth` check. Show latency on
   success; show the actual error text and a back button on failure. **Do not
   let the wizard finish on a failed check without an explicit "save anyway"** —
   silently saving a broken provider is how you get a mysterious failure three
   screens later.
4. **Models** — for `openai-compatible`, `GET {baseUrl}/models` and show the
   returned ids as a checkable list; fall back to the catalog's builtin list if
   that 404s (several providers do not implement it); for custom with neither,
   let the user type ids. At least one model must be enabled to finish.
5. **Finish** — "make this the default for new chats" checkbox, wired to S4's
   new default-provider setting.

### The part that is easy to miss: models are hardcoded

`MODEL_REGISTRY` in `engine/src/agent/config.ts` is a static object keyed by the
six seed provider ids, and `getModelsForProvider` returns `[]` for anything
else. **A custom provider would get zero models and be completely unusable.**
Any "add a custom provider" feature therefore requires user-defined models to
be persisted:

New table `provider_models`: `provider_id, model_id, label, supports_tools,
supports_thinking, context_window, input_per_million, output_per_million,
enabled, source` where `source ∈ {builtin, fetched, manual}`.
`getModelsForProvider` returns the enabled rows; `MODEL_REGISTRY` becomes the
seed data the wizard copies from when a catalog provider is chosen, not a
runtime lookup. `estimateCostUsd` reads the same rows and returns `0` with no
pricing rather than falling back to Together's first model, which is what it
does today and which produces quietly wrong cost numbers.

### Managing a configured provider

Each configured provider gets a card: status dot + label + base URL + model
count + a `default` badge. Expanding it gives: replace key, edit base URL,
re-run the health check, toggle individual models, add a model manually,
re-fetch the model list, and remove the provider.

**Removing** needs `DELETE /providers/:id`, a keychain delete on the Rust side
(`keyring` is already a dependency, so the deletion path may already exist —
check before writing it), and cascade of the `provider_models` rows. Chats
pointing at a removed provider are **not** migrated or deleted — the model
picker shows the id as unavailable and the chat cannot send until it is
repointed. That is honest and it is one branch; auto-migrating chats to another
provider silently changes what model someone's history was written by.

### Explicitly out of scope

Azure OpenAI (deployment name + `api-version`), Bedrock (SigV4), Vertex
(service-account JSON) do **not** fit the `openai-compatible` adapter and each
needs its own auth flow. For an app positioning itself as an enterprise LLM
layer these matter — but they are three separate integrations, not three
catalog entries. **Name them as follow-up rather than letting them be silently
absent.** Per-provider extra headers (OpenRouter wants `HTTP-Referer` /
`X-Title`) and request timeouts are a smaller follow-up on the same card.

---

## Pane-by-pane summary

| pane | verdict |
|---|---|
| **general** | Rewritten (S4). New-chat defaults + a Folders group with native pickers. Telemetry text moves to About. |
| **appearance** | Rewritten (S0/S1/S2/S3). Themes (nine, grouped by family) + font size. Wallpaper and dim controls deleted — the wallpaper itself moves inside the theme. |
| **providers & models** | Rewritten — but **not here**. See `docs/PROVIDERS_PLAN.md` P0–P6: catalog/roster/shortlist split, filtered composer picker, model roles + auto-titling, configured-providers list, setup wizard, custom providers, user-defined models. |
| **mcp servers** | Unchanged this pass. It is already the right shape — a list of things you added, with an add button. It is, in fact, the model S5's providers pane should copy. |
| **permissions** | Unchanged this pass. The real work there is enforcement in `engine/src/agent/permissions.ts`, which the pane's own hint already admits is missing — that is an engine task, not a settings task. |
| **keyboard** | Unchanged. Read-only is fine until there is a rebinding system. |
| **account** | Unchanged. Still nothing to build (R2/R4/R6). |
| **about** | Gains the telemetry paragraph from General. |

---

## Open questions

| # | Question | Gates | Recommendation |
|---|---|---|---|
| ~~1~~ | ~~Theme JSON: bundled-only, or also user-loadable from `~/.rama/themes/`?~~ **Resolved: both.** Merge two sources, user wins on id collision, live-reloaded over WS — see S1. | ~~S1~~ | — |
| ~~2~~ | ~~Ship the `agents` folder row before an agents subsystem exists?~~ **Resolved: yes**, as storage config with an honest `0 found` count — no agents nav row, no composer picker, nothing that claims the feature exists. | ~~S4~~ | — |
| 3 | `foam` → `nami` rename: alias map, or SQL migration? | S2 | **Alias map** in `getTheme`. One line, no schema churn, same shape as the fallback already there. |
| 4 | Does the terminal (`xterm.js`) follow the app font scale? | S3 | **Yes.** "All the fonts of the app" includes it; it needs an explicit wire since it does not read CSS tokens. |
| 5 | Consolidate `--text-1` and `--ink` into one seed, accepting a 2–3 point colour shift in existing themes? | S1 | **Yes.** The shift is imperceptible and it removes a whole class of drift between two values that are meant to be the same colour. |

## Risk register

1. **A theme that sets an image and forgets `veil` (S0).** The failure mode is a
   photo at full strength behind body text — unreadable, and it is a data error
   in a file anyone can write, not a code error. Mitigate twice: `--veil`'s
   `:root` default is `1` (fully covered, the safe failure), and `parseTheme`
   rejects a `wallpaper` block that has an image without a veil.
2. **`ThemeId` stops being a compile-time union (S1).** A typo in a theme id
   becomes a silent runtime fallback. Mitigate: `parseTheme` asserts `id` equals
   the filename stem, so a mismatch fails the build.
3. **Font scale clipping (S3).** Fixed `height:` on any row containing text will
   clip at 125%. Convert to `min-height:` in the same pass, verify at 125% in a
   light theme.
4. **The provider migration (S5).** Deleting seeded rows is destructive if the
   rule is wrong. The rule — keep rows with a keychain entry or a referencing
   chat, delete the rest — must be tested against a DB that has a configured
   provider *and* untouched seeds before it runs on a real `~/.rama/rama.db`.
5. **User theme first-paint flash (S1).** A persisted `themeId` naming a user
   theme has no palette until the fetch lands. Cache the active theme's resolved
   seed tokens in `localStorage` alongside the id and apply them on first paint.
   If this is skipped, the feature ships with a visible flicker on every launch.
6. **A user theme shadowing a builtin (S1).** Intended, but it means "kanagawa
   looks wrong" can be caused by a file the reporter forgot they wrote. The
   gallery must mark overridden entries, and `GET /themes` must report which ids
   were shadowed.
7. **Serving user-theme wallpaper files (S1).** `GET /themes/asset/:file` is
   a path join off user-controlled input in a process that can read the whole
   home directory. Normalise the joined path and assert it is still under
   `THEMES_HOME` before opening it. Separately: this works today only because
   `tauri.conf.json` sets `"csp": null` — if a CSP is ever added, `img-src` must
   allow the engine origin or every image-based theme goes blank.
8. **`estimateCostUsd`'s fallback (S5).** It currently falls back to
   `MODEL_REGISTRY[DEFAULT_PROVIDER_ID][0]` for any unknown model, i.e. it
   reports Together's Llama pricing for a model it has never heard of. With
   custom providers this goes from a rare edge case to the common path. Return
   `0` and mark the cost unknown instead.
