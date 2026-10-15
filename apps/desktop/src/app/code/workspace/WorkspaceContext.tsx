import { createContext, useContext, useEffect } from "react";
import type { ReactNode } from "react";
import { useWorkspaceGeometry, type WorkspaceGeometry } from "./useWorkspaceGeometry";

/* Owns the workspace's state above both its consumers: the top bar's workspace toggle and the
   command palette live outside the code view, so a hook inside <Workspace> couldn't reach them. */
const Ctx = createContext<WorkspaceGeometry | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const geometry = useWorkspaceGeometry();

  // `window.__rama.goto("changes:path")` — the address the parity harness (scripts/parity.ts) uses
  // to put a pane in a known state. Dev builds only; nothing in the app reads it back.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __rama?: { goto?: (spec: string) => void } };
    w.__rama = { ...w.__rama, goto: geometry.goto };
    return () => {
      if (w.__rama?.goto === geometry.goto) delete w.__rama.goto;
    };
  }, [geometry.goto]);

  return <Ctx.Provider value={geometry}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceGeometry {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return v;
}
