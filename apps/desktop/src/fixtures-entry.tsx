// Dev-only entry (fixture.html). The fakes must be installed before any module that touches
// Tauri or the engine is evaluated — engine/window.ts reads the window label at import time —
// so App is imported dynamically, after install. index.html / main.tsx are untouched, which is
// why production builds carry none of this.
import React from "react";
import ReactDOM from "react-dom/client";
import { installFixtures } from "./app/fixtures/install";

async function boot() {
  await installFixtures();
  const { default: App } = await import("./App");
  // Web pages live in a module-level store (there is no engine row), so seed them here.
  const { seedWebPages } = await import("./app/mission-control/panes/WebPaneContext");
  const { WS } = await import("./app/fixtures/code/mockupData");
  seedWebPages(
    Object.entries(WS).flatMap(([projectId, w]) =>
      w.pages.map((p) => ({
        id: p.id,
        projectId,
        url: p.url,
        title: p.title,
        owner: "agent" as const,
        originChatId: null,
        loading: false,
        createdAt: 0,
      })),
    ),
  );
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

  // `&goto=pane:arg` — wait for the workspace to register its bridge, then address it.
  const spec = new URLSearchParams(location.search).get("goto");
  if (spec) {
    const w = window as unknown as { __rama?: { goto?: (s: string) => void } };
    for (let i = 0; i < 100 && !w.__rama?.goto; i++) await new Promise((r) => setTimeout(r, 50));
    w.__rama?.goto?.(spec);
  }
}

void boot();
