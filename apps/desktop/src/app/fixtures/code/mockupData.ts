// Verbatim port of the Code-tab demo data in docs/Rama/home-redesign.html (lines 1015–1423):
// PROJECTS, SRC, DIFFS, TERM, WS and CODE_CHATS. Kept as close to the mockup's own shapes as
// TypeScript allows, so a diff against the HTML stays readable. fixtures/code/build.ts turns
// these into the DTOs the real providers consume. Prose that the mockup wrote as HTML is
// markdown here, because that's what a real assistant message carries.

export const FIXTURE_NOW = new Date(2026, 9, 5, 18, 30, 0).getTime(); // mockup's clock: Mon 5 Oct 2026, 18:30

export const PROJECTS = [
  { id: "rama", name: "Rama", branch: "main", path: "/Users/demo/rama" },
  { id: "demo", name: "demo-project", branch: "main", path: "/Users/demo/demo-project" },
] as const;

export interface SrcFile {
  /** First line number of the excerpt (mockup only; the real files API has no such concept). */
  start: number;
  text: string;
}

export const SRC: Record<string, SrcFile> = {
  "apps/desktop/src/App.tsx": {
    start: 1,
    text: `import { AppShell } from "./app/AppShell";
import { ThemeProvider, BUILTIN_THEMES } from "@rama/ui";

export function App() {
  return (
    <ThemeProvider themes={BUILTIN_THEMES}>
      <AppShell />
    </ThemeProvider>
  );
}`,
  },
  "apps/desktop/src/main.tsx": {
    start: 1,
    text: `import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@rama/ui/tokens.css";

// Paint the saved theme before React mounts, so the default never flashes.
try {
  const cached = JSON.parse(localStorage.getItem("rama.theme.tokens") ?? "null");
  if (cached) {
    document.documentElement.dataset.rtheme = cached.id;
    for (const [k, v] of Object.entries(cached.tokens)) document.documentElement.style.setProperty(k, String(v));
  }
} catch {}

createRoot(document.getElementById("root")!).render(<App />);`,
  },
  "packages/ui/src/theme.tsx": {
    start: 1,
    text: `import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { getTheme, seedTokens, type RamaTheme } from "./themes";

// Applies the active theme's tokens to :root and remembers them for the next cold start.
const ThemeContext = createContext<ThemeState | null>(null);

interface ThemeState {
  themeId: string;
  themes: RamaTheme[];
  setThemeId: (id: string) => void;
}

function applyTokens(tokens: Record<string, string>) {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value);
}

export function ThemeProvider({ children, themes }: { children: ReactNode; themes: RamaTheme[] }) {
  const [themeId, setThemeId] = useState(() => localStorage.getItem("rama.theme") ?? "kanagawa");

  useEffect(() => {
    const theme = getTheme(themeId);
    const tokens = seedTokens(theme);
    applyTokens(tokens);
    cacheTokens(theme.id, tokens);
  }, [themeId]);

  return <ThemeContext.Provider value={{ themeId, themes, setThemeId }}>{children}</ThemeContext.Provider>;
}

const CACHE_KEY = "rama.theme.tokens";

/** Lets main.tsx paint the saved theme before React mounts. */
function cacheTokens(id: string, tokens: Record<string, string>) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ id, tokens }));
  } catch {
    // Private mode or full storage: the first frame falls back to defaults.
  }
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}`,
  },
  "packages/ui/src/themes.ts": {
    start: 181,
    text: `// Display order within the gallery: three rows of three, family as the row axis.
const DISPLAY_ORDER = ["nami", "kanagawa", "sumi", "sakura", "tsubaki", "shu", "wakaba", "matsu", "rokusho"];

export function getTheme(id: string): RamaTheme {
  return BUILTIN_THEMES.find((t) => t.id === id) ?? BUILTIN_THEMES[0];
}

export function mergeThemes(builtin: RamaTheme[], user: RamaTheme[]): RamaTheme[] {
  // A user theme file changed, so a cached copy of it may be stale.
  clearCachedTokens();
  return [...builtin.filter((b) => !user.some((u) => u.id === b.id)), ...user];
}

export function clearCachedTokens() {
  try { localStorage.removeItem("rama.theme.tokens"); } catch {}
}`,
  },
  "packages/ui/src/theme.test.ts": {
    start: 1,
    text: `import { beforeEach, describe, expect, test } from "bun:test";
import { clearCachedTokens, getTheme, seedTokens } from "./themes";

const KEY = "rama.theme.tokens";

describe("cached theme tokens", () => {
  beforeEach(() => localStorage.clear());

  test("a saved theme is cached with its resolved tokens", () => {
    const tokens = seedTokens(getTheme("kanagawa"));
    localStorage.setItem(KEY, JSON.stringify({ id: "kanagawa", tokens }));
    const cached = JSON.parse(localStorage.getItem(KEY)!);
    expect(cached.tokens["--accent"]).toBe("#6fb6e6");
  });

  test("editing a user theme clears the cache", () => {
    localStorage.setItem(KEY, "{}");
    clearCachedTokens();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});`,
  },
  "packages/ui/src/tokens.css": {
    start: 1,
    text: `/* Rama design tokens. A theme supplies four colours; everything else is derived. */
:root {
  --font-ui: "Instrument Sans", system-ui, sans-serif;
  --font-read: "Literata", Georgia, serif;
  --font-code: "JetBrains Mono", monospace;
}

:root[data-rmode="light"] {
  color-scheme: light;
  --text-3: oklch(from var(--accent) 0.40 0.07 h);
  --border-1: rgb(from var(--accent) r g b / 0.05);
}`,
  },
  "docs/COMPOSER_CONTEXT_PLAN.md": {
    start: 1,
    text: `# Composer context plan (CC0–CC2)

Three small changes to what a chat can see, and where it does its work.

## CC0: pills and status line
The row above the message box shows the project, the branch and the worktree.

## CC1: extra folders
Add read-only folders from outside the project as context.

## CC2: worktrees
Each chat can work in its own git worktree under ~/.rama/worktrees.`,
  },
  "docs/REDESIGN_PLAN.md": {
    start: 1,
    text: `# Redesign plan (R0–R7)

Whale identity, whole-palette themes, a Claude-style sidebar,
no tab strip, and one settings modal.`,
  },
  "engine/src/agent/run.ts": {
    start: 1,
    text: `// engine/src/agent/run/run.ts
//
// The core run loop: setup, step execution, termination.
import type { ChatMode, GeneralSettingsDTO } from "@rama/protocol";
import { createCheckpointer } from "../../checkpoints";
import { getChat, getChatSettings, recordUsage } from "../../db/chats";
import { resolveClient } from "../../llm/client";`,
  },
  "package.json": {
    start: 1,
    text: `{
  "name": "rama",
  "private": true,
  "workspaces": ["apps/*", "engine", "packages/*"],
  "scripts": {
    "dev": "bun --filter desktop dev",
    "test": "bun test"
  }
}`,
  },
  "pixelated.py": {
    start: 1,
    text: `from PIL import Image


def pixelate(path, size=12):
    """Return a pixelated copy of the image at path."""
    img = Image.open(path)
    w, h = img.size
    out = img.copy()
    for x in range(0, w, size):
        for y in range(0, h, size):
            colour = img.getpixel((x, y))
            for dx in range(size):
                for dy in range(size):
                    if x + dx < w and y + dy < h:
                        out.putpixel((x + dx, y + dy), colour)
    return out


if __name__ == "__main__":
    pixelate("photo.jpg").save("photo-pixelated.jpg")`,
  },
  "requirements.txt": { start: 1, text: `Pillow>=10.0` },
  "README.md": {
    start: 1,
    text: `# demo-project

A scratch project for trying out Rama's agent.`,
  },
};

/** Which files belong to which project (the mockup's WS[...].tree, flattened). */
export const PROJECT_FILES: Record<string, string[]> = {
  rama: [
    "apps/desktop/src/App.tsx",
    "apps/desktop/src/main.tsx",
    "docs/COMPOSER_CONTEXT_PLAN.md",
    "docs/REDESIGN_PLAN.md",
    "engine/src/agent/run.ts",
    "packages/ui/src/theme.test.ts",
    "packages/ui/src/theme.tsx",
    "packages/ui/src/themes.ts",
    "packages/ui/src/tokens.css",
    "package.json",
  ],
  demo: ["pixelated.py", "README.md", "requirements.txt"],
};

export interface DiffEntry {
  add: number;
  del: number;
  isNew?: boolean;
  hunks: { title: string; old: number; nu: number; body: string }[];
}

// Uncommitted changes in Rama. First character of each line: " " context, "+" added, "-" removed.
export const DIFFS: Record<string, DiffEntry> = {
  "packages/ui/src/theme.tsx": {
    add: 14,
    del: 1,
    hunks: [
      {
        title: "Lines 21 to 42, in ThemeProvider",
        old: 21,
        nu: 21,
        body: `   useEffect(() => {
     const theme = getTheme(themeId);
-    applyTokens(seedTokens(theme));
+    const tokens = seedTokens(theme);
+    applyTokens(tokens);
+    cacheTokens(theme.id, tokens);
   }, [themeId]);

   return <ThemeContext.Provider value={{ themeId, themes, setThemeId }}>{children}</ThemeContext.Provider>;
 }
+
+const CACHE_KEY = "rama.theme.tokens";
+
+/** Lets main.tsx paint the saved theme before React mounts. */
+function cacheTokens(id: string, tokens: Record<string, string>) {
+  try {
+    localStorage.setItem(CACHE_KEY, JSON.stringify({ id, tokens }));
+  } catch {
+    // Private mode or full storage: the first frame falls back to defaults.
+  }
+}

 export function useTheme() {`,
      },
    ],
  },
  "apps/desktop/src/main.tsx": {
    add: 9,
    del: 0,
    hunks: [
      {
        title: "Lines 1 to 14",
        old: 1,
        nu: 1,
        body: ` import { createRoot } from "react-dom/client";
 import { App } from "./App";
 import "@rama/ui/tokens.css";
+
+// Paint the saved theme before React mounts, so the default never flashes.
+try {
+  const cached = JSON.parse(localStorage.getItem("rama.theme.tokens") ?? "null");
+  if (cached) {
+    document.documentElement.dataset.rtheme = cached.id;
+    for (const [k, v] of Object.entries(cached.tokens)) document.documentElement.style.setProperty(k, String(v));
+  }
+} catch {}

 createRoot(document.getElementById("root")!).render(<App />);`,
      },
    ],
  },
  "packages/ui/src/themes.ts": {
    add: 7,
    del: 1,
    hunks: [
      {
        title: "Lines 188 to 196, in mergeThemes",
        old: 188,
        nu: 188,
        body: ` export function mergeThemes(builtin: RamaTheme[], user: RamaTheme[]): RamaTheme[] {
-  return [...builtin.filter((b) => !user.some((u) => u.id === b.id)), ...user];
+  // A user theme file changed, so a cached copy of it may be stale.
+  clearCachedTokens();
+  return [...builtin.filter((b) => !user.some((u) => u.id === b.id)), ...user];
 }
+
+export function clearCachedTokens() {
+  try { localStorage.removeItem("rama.theme.tokens"); } catch {}
+}`,
      },
    ],
  },
  "packages/ui/src/theme.test.ts": {
    add: 21,
    del: 0,
    isNew: true,
    hunks: [
      {
        title: "New file",
        old: 0,
        nu: 1,
        body: SRC["packages/ui/src/theme.test.ts"]!.text
          .split("\n")
          .map((l) => "+" + l)
          .join("\n"),
      },
    ],
  },
};

export const CHANGE_ORDER = [
  "packages/ui/src/theme.tsx",
  "apps/desktop/src/main.tsx",
  "packages/ui/src/themes.ts",
  "packages/ui/src/theme.test.ts",
];

// Terminal output. Plain text with three semantic marks the mockup colours with spans:
// {p:…} prompt, {m:…} muted, {g:…} green. build.ts expands them to ANSI for xterm and strips
// them for the transcript's output card.
export const TERM = {
  dev: `{p:$} bun dev
{m:$ vite}

  VITE v6.3.1  ready in 412 ms

  ➜  Local:   http://localhost:1420/
  ➜  Network: use --host to expose

{m:[engine]} listening on 127.0.0.1:4317
{m:[engine]} watching ~/.rama/themes`,
  test: `{p:$} bun test packages/ui
bun test v1.3.2

packages/ui/src/theme.test.ts:
{g:✓} cached theme tokens > a saved theme is cached with its resolved tokens {m:[0.42ms]}
{g:✓} cached theme tokens > editing a user theme clears the cache {m:[0.11ms]}

packages/ui/src/themes.test.ts:
{g:✓} parseTheme rejects a theme with no accent {m:[0.08ms]}
{m:… 28 more}

 {g:31 pass}
 0 fail
Ran 31 tests across 6 files. {m:[388.00ms]}`,
  zsh: `{m:Last login: Mon Oct  5 18:02 on ttys004}
{p:~/rama $} `,
  commit: `{p:$} git commit -m "Apply the saved theme before first paint"
[main 4c1e9a2] Apply the saved theme before first paint
 4 files changed, 51 insertions(+), 2 deletions(-)
 create mode 100644 packages/ui/src/theme.test.ts`,
};

export interface FixtureTerminal {
  id: string;
  title: string;
  /** Mockup's status chip: run / done / idle. The app derives these from status + exitCode + a quiet timer. */
  status: "run" | "done" | "idle";
  sub: string;
  out: string;
  owner: "user" | "agent";
}

export interface FixtureWorkspace {
  pane: "changes" | "terminal" | "web" | "files";
  clean?: boolean;
  terms: FixtureTerminal[];
  term: string | null;
  pages: { id: string; title: string; url: string; sub: string; kind: string }[];
  page: string;
  open: string[];
  tabs: string[];
  tab: string;
}

export const WS: Record<string, FixtureWorkspace> = {
  rama: {
    pane: "changes",
    terms: [
      { id: "t1", title: "bun dev", status: "run", sub: "Running, started by you", out: TERM.dev, owner: "user" },
      { id: "t2", title: "bun test packages/ui", status: "done", sub: "Finished, started by Rama", out: TERM.test, owner: "agent" },
      { id: "t3", title: "zsh", status: "idle", sub: "Idle", out: TERM.zsh, owner: "user" },
    ],
    term: "t2",
    pages: [{ id: "w1", title: "Rama", url: "localhost:1420", sub: "Opened by Rama", kind: "rama" }],
    page: "w1",
    open: ["apps/desktop/src", "packages/ui/src"],
    tabs: ["packages/ui/src/theme.tsx", "apps/desktop/src/main.tsx"],
    tab: "packages/ui/src/theme.tsx",
  },
  demo: {
    pane: "files",
    clean: true,
    terms: [],
    term: null,
    pages: [{ id: "w2", title: "YouTube", url: "youtube.com", sub: "Opened by Rama", kind: "vids" }],
    page: "w2",
    open: [],
    tabs: ["pixelated.py"],
    tab: "pixelated.py",
  },
};

// ── Chats ──────────────────────────────────────────────────────────────────────────────────
// A turn's blocks, in the order the model produced them. `tool` blocks are real engine tool
// calls (name + input + the exact resultSummary the engine would write); everything else the
// mockup draws (plan card, changes card, permission card) is derived by the app from those
// tool calls and live events, the same as it will be in production.

export type FxBlock =
  | { k: "think"; seconds: number; text: string }
  | { k: "text"; md: string }
  | { k: "tool"; name: string; input: unknown; summary: string; ok?: boolean | null; artifact?: { kind: "diff" | "terminal"; name: string; body: string; meta?: Record<string, unknown> } };

export type FxTurn = { role: "user"; text: string } | { role: "ai"; blocks: FxBlock[] };

export interface FxChat {
  id: string;
  project: "rama" | "demo";
  model: "glm" | "qwen" | "sonnet";
  mode: "agent" | "plan" | "ask";
  /** "waiting" → the last turn ends on a pending permission request. */
  flag?: "waiting";
  /** [usedK, maxK] */
  ctx: [number, number];
  title: string;
  snippet: string;
  /** Milliseconds before FIXTURE_NOW that the chat last changed. */
  ago: number;
  turns: FxTurn[];
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const read = (path: string): FxBlock => {
  const n = SRC[path]!.text.split("\n").length;
  return { k: "tool", name: "read", input: { path }, summary: `1-${n} of ${n} lines` };
};

const edit = (path: string): FxBlock => {
  const d = DIFFS[path]!;
  const body = d.hunks.map((h) => h.body).join("\n");
  const oldText = body.split("\n").filter((l) => l[0] === " " || l[0] === "-").map((l) => l.slice(1)).join("\n");
  const newText = body.split("\n").filter((l) => l[0] === " " || l[0] === "+").map((l) => l.slice(1)).join("\n");
  const artifact = { kind: "diff" as const, name: path, body, meta: { added: d.add, removed: d.del } };
  if (d.isNew) {
    return { k: "tool", name: "write", input: { path, content: newText }, summary: `created · ${d.add} lines`, artifact };
  }
  return { k: "tool", name: "edit", input: { path, edits: [{ oldString: oldText, newString: newText }] }, summary: `+${d.add} −${d.del}`, artifact };
};

const todoSet = (items: string[]): FxBlock => ({
  k: "tool",
  name: "todo",
  input: { op: "set", items: items.map((text) => ({ text })) },
  summary: `0/${items.length} done`,
});
const todoDone = (index: number, done: number, total: number, next?: string): FxBlock => ({
  k: "tool",
  name: "todo",
  input: { op: "update", index, status: "done" },
  summary: `${done}/${total} done${next ? `, "${next}" active` : ""}`,
});

const PLAN = [
  "Cache the resolved tokens whenever a theme is applied",
  "Paint the cached tokens in main.tsx before React mounts",
  "Clear the cache when a theme file in ~/.rama/themes changes",
  "Add tests and run the UI suite",
];

export const CODE_CHATS: FxChat[] = [
  {
    id: "flash",
    project: "rama",
    model: "glm",
    mode: "agent",
    flag: "waiting",
    ctx: [18, 200],
    title: "Fix the theme flash on first paint",
    snippet: "Waiting for your OK to commit.",
    ago: 20_000,
    turns: [
      { role: "user", text: "When the app starts there's a quick flash of the default theme before my saved one shows up. Can you find out why and fix it?" },
      {
        role: "ai",
        blocks: [
          { k: "think", seconds: 4, text: "Started from where the saved theme is read on startup, then followed it to the first paint." },
          read("packages/ui/src/theme.tsx"),
          read("packages/ui/src/themes.ts"),
          read("apps/desktop/src/main.tsx"),
          read("packages/ui/src/tokens.css"),
          { k: "tool", name: "grep", input: { pattern: "setThemeId" }, summary: "7 matches across 4 files" },
          {
            k: "text",
            md: `It's a timing problem. \`packages/ui/src/theme.tsx\` applies the saved theme inside a React effect, and effects only run after the first frame has painted. Until then the page uses the fallback values in \`packages/ui/src/tokens.css\`, which is the flash you're seeing.

The fix is to remember the resolved colours and paint them before React starts:`,
          },
          todoSet(PLAN),
          edit("packages/ui/src/theme.tsx"),
          todoDone(0, 1, 4, PLAN[1]),
          edit("apps/desktop/src/main.tsx"),
          todoDone(1, 2, 4, PLAN[2]),
          edit("packages/ui/src/themes.ts"),
          todoDone(2, 3, 4, PLAN[3]),
          edit("packages/ui/src/theme.test.ts"),
          {
            k: "tool",
            name: "bash",
            input: { command: "bun test packages/ui" },
            summary: "exit 0 · 14 lines · 31 passed",
            artifact: { kind: "terminal", name: "bun test packages/ui", body: "", meta: { exitCode: 0 } },
          },
          todoDone(3, 4, 4),
          { k: "tool", name: "browser", input: { op: "open", url: "localhost:1420" }, summary: "opened http://localhost:1420" },
          { k: "tool", name: "review", input: {}, summary: "no issues found" },
          {
            k: "text",
            md: `Fixed. A cold start now paints your saved theme from the very first frame. If the cache is missing or broken, the app falls back to the old behaviour, so nothing gets worse.

I also clear the cache when a theme file in \`~/.rama/themes\` changes, so an edited theme can't get stuck on old colours.`,
          },
        ],
      },
      { role: "user", text: "Looks good. Commit it." },
      {
        role: "ai",
        blocks: [
          {
            k: "tool",
            name: "git_write",
            input: { op: "commit", message: "Apply the saved theme before first paint", stageAll: true },
            summary: "",
            ok: null,
          },
        ],
      },
    ],
  },
  {
    id: "ccplan",
    project: "rama",
    model: "glm",
    mode: "ask",
    ctx: [9, 200],
    title: "Go through the composer context plan",
    snippet: "All three parts have shipped.",
    ago: 4 * HOUR,
    turns: [
      { role: "user", text: "Go through docs/COMPOSER_CONTEXT_PLAN.md and tell me where we are." },
      {
        role: "ai",
        blocks: [
          { k: "tool", name: "read", input: { path: "docs/COMPOSER_CONTEXT_PLAN.md" }, summary: "1-212 of 212 lines" },
          {
            k: "text",
            md: `It has three parts, and all three have shipped:

- **Pills and status line (CC0).** The row above the message box shows the project, branch and worktree, and a status line says what the agent is doing.
- **Extra folders (CC1).** You can add read-only folders from outside the project, and the file tools can read them.
- **Worktrees (CC2).** Each chat can work in its own git worktree under \`~/.rama/worktrees\`, so two chats can't trip over each other's edits.

The one loose end is cleanup: worktrees are removed when a chat is deleted, but not when a chat is archived.`,
          },
        ],
      },
    ],
  },
  {
    id: "about",
    project: "rama",
    model: "qwen",
    mode: "ask",
    ctx: [24, 128],
    title: "What can you tell me about the project",
    snippet: "A desktop app for working with AI models.",
    ago: 9 * DAY,
    turns: [
      { role: "user", text: "What can you tell me about the project?" },
      {
        role: "ai",
        blocks: [
          read("package.json"),
          read("apps/desktop/src/App.tsx"),
          read("engine/src/agent/run.ts"),
          { k: "tool", name: "glob", input: { pattern: "docs/*.md" }, summary: "7 files" },
          {
            k: "text",
            md: `Rama is a desktop app for working with AI models, local or hosted, and it's especially good at coding. It's built with Tauri and React, and a Bun process runs the agent: the loop that reads files, edits them and runs commands.

The code is split three ways. \`apps/desktop\` is the window you're looking at, \`engine\` is the agent and its tools, and \`packages\` holds the shared UI kit and the protocol the two talk over.`,
          },
        ],
      },
    ],
  },
  {
    id: "hello",
    project: "rama",
    model: "qwen",
    mode: "agent",
    ctx: [3, 128],
    title: "Hello",
    snippet: "What are we working on today?",
    ago: 9 * DAY + HOUR,
    turns: [
      { role: "user", text: "hello" },
      { role: "ai", blocks: [{ k: "text", md: "Hi! I'm in Rama and ready to go. What are we working on today?" }] },
    ],
  },
  {
    id: "yt",
    project: "demo",
    model: "glm",
    mode: "agent",
    ctx: [6, 200],
    title: "Open YouTube in browser",
    snippet: "It's open in the Web pane.",
    ago: 19 * DAY,
    turns: [
      { role: "user", text: "Open YouTube in the browser." },
      {
        role: "ai",
        blocks: [
          { k: "tool", name: "browser", input: { op: "open", url: "youtube.com" }, summary: "opened https://youtube.com" },
          { k: "text", md: "It's open in the Web pane on the right. Want me to search for something?" },
        ],
      },
    ],
  },
  {
    id: "pix",
    project: "demo",
    model: "qwen",
    mode: "agent",
    ctx: [11, 128],
    title: "Review the pixelated py",
    snippet: "Two Pillow calls can replace the loop.",
    ago: 25 * DAY,
    turns: [
      { role: "user", text: "Review pixelated.py" },
      {
        role: "ai",
        blocks: [
          { k: "tool", name: "read", input: { path: "pixelated.py" }, summary: "1-20 of 20 lines" },
          {
            k: "text",
            md: `It works, but it's slow on big images because it visits every pixel in Python. The nested loop on lines 9 to 15 can become two calls that Pillow runs in C:

\`\`\`python
small = img.resize((w // size, h // size), Image.NEAREST)
return small.resize((w, h), Image.NEAREST)
\`\`\`

On a 12-megapixel photo that's the difference between several seconds and a few milliseconds. Want me to make the change?`,
          },
        ],
      },
    ],
  },
  {
    id: "harness",
    project: "demo",
    model: "sonnet",
    mode: "ask",
    ctx: [4, 200],
    title: "What do you think about this harness app",
    snippet: "Strongest when the tools stay visible.",
    ago: 25 * DAY + HOUR,
    turns: [
      { role: "user", text: "What do you think about this harness app?" },
      {
        role: "ai",
        blocks: [
          {
            k: "text",
            md: "It's strongest where it shows its work: you can see every file it read and every command it ran, and you can stop it before anything risky. The parts that still feel rough are the ones that look like a terminal when they don't need to.",
          },
        ],
      },
    ],
  },
];

export const MODELS = {
  qwen: { providerId: "ollama", id: "qwen3:14b", label: "Qwen3 14B", ctx: 128_000 },
  glm: { providerId: "together", id: "zai-org/GLM-5.3-Flash", label: "GLM 5.3 Flash", ctx: 200_000 },
  sonnet: { providerId: "anthropic", id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", ctx: 200_000 },
} as const;
