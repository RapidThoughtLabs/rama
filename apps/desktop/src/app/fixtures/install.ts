// Fixture mode bootstrap (docs/CODE_REDESIGN_PLAN.md CR1). Called from src/fixtures-entry.tsx
// before the app is imported.
//
//   /fixture.html?fixture=code-flash&theme=wakaba&scale=1&reading=serif&pane=changes
//
//   fixture   code-<chatId> opens that chat from the mockup's CODE_CHATS (flash, ccplan, about,
//             hello, yt, pix, harness). The empty "new chat" landing arrives with CR8.
//             landing, landing-model-pop, landing-web-on, landing-cloud-model, chat-<id> and
//             chat-working are Home's (HOME_REDESIGN_PLAN.md HD4-HD6; see home/build.ts for
//             their own parameters).
//   theme     any bundled theme id (default wakaba, the mockup's default)
//   scale     0.92 | 1 | 1.1        reading   serif | sans
//   pane      changes | terminal | web | files — the workspace's active pane
//   open      0 hides the workspace panel        rail   collapsed folds the list to icons
//   empty     projects | providers — the Code landing's two empty states (plan CR8): no project at all, or
//             projects but no provider configured
//   goto      pane:arg, e.g. changes:packages/ui/src/theme.tsx — applied through window.__rama.goto
//   os        windows draws the frameless Windows chrome (caption buttons, the seal moved left)
//
// What it does: pins the clock to the mockup's (Mon 5 Oct 2026, 18:30), answers every engine and
// Tauri call from the ported mockup data, and writes the persisted view state the app reads on
// boot (theme, active chat, workspace pane). It never runs in a production build: fixture.html is
// not an input to `vite build`.
//
// Which diff / terminal / page / file is *selected* inside a pane is component state; it is set
// through the workspace's `goto(pane:arg)` bridge (`&goto=…`, applied once the app has mounted).

import { buildCodeFixture } from "./code/build";
import { HOME_FIXTURES, applyHomeFixture } from "./home/build";
import { FIXTURE_NOW } from "./code/mockupData";
import { MockEngine, installEngineTransport } from "./mockEngine";
import { installTauriShim } from "./tauriShim";

const WINDOW = "main";

function freezeClock(now: number): void {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args: unknown[]) {
      // @ts-expect-error spread into the Date constructor overloads
      super(...(args.length ? args : [now]));
    }
    static override now(): number {
      return now;
    }
  }
  globalThis.Date = FrozenDate as DateConstructor;
}

function seedStorage(params: URLSearchParams, activeChatId: string): void {
  const set = (k: string, v: string) => window.localStorage.setItem(k, v);
  window.localStorage.clear();

  const scale = Number(params.get("scale") ?? 1);
  set("rama.theme", JSON.stringify({ themeId: params.get("theme") ?? "wakaba", fontScale: scale, reading: params.get("reading") === "sans" ? "sans" : "serif" }));

  set(`rama.activeChatId.${WINDOW}`, activeChatId);

  // Workspace (CR3): open / width (null = the mockup's 48%) / rail / pane.
  set(
    `rama:workspace:${WINDOW}`,
    JSON.stringify({ open: params.get("open") !== "0", widthPx: null, railCollapsed: params.get("rail") === "collapsed", pane: params.get("pane") ?? "changes" }),
  );
  set(`rama:files:tabs:${WINDOW}:rama`, JSON.stringify({ tabs: [{ path: "packages/ui/src/theme.tsx", pinned: true }, { path: "apps/desktop/src/main.tsx", pinned: true }], activePath: "packages/ui/src/theme.tsx" }));
  set(`rama:files:expanded:${WINDOW}:rama`, JSON.stringify(["apps", "apps/desktop", "apps/desktop/src", "packages", "packages/ui", "packages/ui/src"]));
  set(`rama:files:tabs:${WINDOW}:demo`, JSON.stringify({ tabs: [{ path: "pixelated.py", pinned: true }], activePath: "pixelated.py" }));
}

export async function installFixtures(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const name = params.get("fixture") ?? "code-flash";
  const home = HOME_FIXTURES.includes(name);
  if (!home && !name.startsWith("code-")) throw new Error(`[fixture] unknown fixture "${name}" (the Code fixtures are named code-<chatId>)`);

  const data = buildCodeFixture();
  // Home fixtures still give the Code side an active chat, as a real install would have.
  const chatId = home ? "flash" : name.slice("code-".length);
  const activeChatId = chatId;
  if (!data.chats.some((c) => c.id === activeChatId)) throw new Error(`[fixture] no chat "${activeChatId}" in CODE_CHATS`);
  const theme = params.get("theme") ?? "wakaba";
  for (const c of data.chats) c.themeId = theme;

  const empty = params.get("empty");
  if (empty === "projects") {
    data.projects = [];
    data.chats = [];
  } else if (empty === "providers") {
    data.providers = [];
  }

  // engine/window.ts reads IS_WINDOWS from the user agent at import, which is after this runs.
  if (params.get("os") === "windows") {
    Object.defineProperty(navigator, "userAgent", { value: `${navigator.userAgent} (Windows NT 10.0)`, configurable: true });
  }

  freezeClock(FIXTURE_NOW);
  seedStorage(params, activeChatId);
  if (home) applyHomeFixture(name, params, data);

  const engine = new MockEngine(data);
  installTauriShim((cmd, args) => engine.tauri(cmd, args), WINDOW);
  installEngineTransport(engine);

  // Hooks for the capture script and for poking from the console.
  (window as unknown as { __fixture: unknown }).__fixture = { name, data, engine };
  document.documentElement.dataset.fixture = name;
}
