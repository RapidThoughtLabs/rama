import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useGotoArg } from "../../code/workspace/gotoBridge";
import type { ReactNode } from "react";
import type { ChangeDiffDTO, ChangeEntryDTO, ChangesDTO } from "@rama/protocol";
import { fetchChangeDiff, fetchChanges, initProjectRepo } from "../../../engine/client";
import { onProjectEvent, send } from "../../../engine/ws";
import { useProjectsData } from "../../data/ProjectsProvider";

// docs/WORKSPACE_PANES_PLAN.md Phase W4 — Changes pane state layer. CR4 dropped the folder tree: the
// rail is a flat list grouped by directory, so there is no collapse state to keep.

interface ChangesPaneValue {
  changes: ChangesDTO | null;
  loading: boolean;
  activePath: string | null;
  setActivePath: (path: string | null) => void;
  activeEntry: ChangeEntryDTO | null;
  stagedView: boolean;
  setStagedView: (staged: boolean) => void;
  diff: ChangeDiffDTO | null;
  diffLoading: boolean;
  refresh: () => void;
  initRepo: () => Promise<void>;
  initializingRepo: boolean;
  initRepoError: string | null;
  projectPath: string | null;
}

const ChangesPaneContext = createContext<ChangesPaneValue | null>(null);

export function ChangesPaneProvider({ children }: { children: ReactNode }) {
  const { activeProjectId, projects } = useProjectsData();
  const currentProject = projects.find((p) => p.id === activeProjectId);

  const [changes, setChanges] = useState<ChangesDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [stagedView, setStagedView] = useState(false);
  const [diff, setDiff] = useState<ChangeDiffDTO | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [initializingRepo, setInitializingRepo] = useState(false);
  const [initRepoError, setInitRepoError] = useState<string | null>(null);

  const loadChanges = useCallback(
    async (silent = false) => {
      if (!activeProjectId) {
        setChanges(null);
        setLoading(false);
        return;
      }
      if (!silent) setLoading(true);
      try {
        const data = await fetchChanges(activeProjectId);
        setChanges(data);
      } catch (err) {
        console.error("[rama] failed to fetch changes", err);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [activeProjectId],
  );

  const initRepo = useCallback(async () => {
    if (!activeProjectId) return;
    setInitializingRepo(true);
    setInitRepoError(null);
    try {
      const data = await initProjectRepo(activeProjectId);
      setChanges(data);
    } catch (err) {
      setInitRepoError(err instanceof Error ? err.message : String(err));
    } finally {
      setInitializingRepo(false);
    }
  }, [activeProjectId]);

  // Subscribe to changes.invalidated on active project
  useEffect(() => {
    if (!activeProjectId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    void send({ type: "subscribeProject", projectId: activeProjectId });

    const unsub = onProjectEvent((projectId, event) => {
      if (projectId !== activeProjectId) return;
      if (event.type === "changes.invalidated") {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          void loadChanges(true);
        }, 250);
      }
    });

    const onFocus = () => void loadChanges(true);
    window.addEventListener("focus", onFocus);

    const onManualRefresh = () => void loadChanges(true);
    window.addEventListener("rama:refresh-changes", onManualRefresh);

    void loadChanges(false);

    return () => {
      if (timer) clearTimeout(timer);
      unsub();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("rama:refresh-changes", onManualRefresh);
      void send({ type: "unsubscribeProject", projectId: activeProjectId });
    };
  }, [activeProjectId, loadChanges]);

  // Ensure activePath selects first available file if unselected or stale
  useEffect(() => {
    if (!changes || changes.entries.length === 0) {
      setActivePath(null);
      return;
    }
    if (!activePath || !changes.entries.some((e) => e.path === activePath)) {
      setActivePath(changes.entries[0]!.path);
    }
  }, [changes, activePath]);

  // goto("changes:<path>") from the workspace bridge (docs/CODE_REDESIGN_PLAN.md CR3).
  const changedPaths = useMemo(() => changes?.entries.map((e) => e.path) ?? [], [changes]);
  useGotoArg("changes", changedPaths, setActivePath);

  const activeEntry = useMemo(() => {
    if (!changes || !activePath) return null;
    return changes.entries.find((e) => e.path === activePath) ?? null;
  }, [changes, activePath]);

  // If entry is only staged, force stagedView = true; if only unstaged, false
  useEffect(() => {
    if (!activeEntry) return;
    if (activeEntry.staged && !activeEntry.unstaged) {
      setStagedView(true);
    } else if (!activeEntry.staged && activeEntry.unstaged) {
      setStagedView(false);
    }
  }, [activeEntry]);

  // Fetch diff when activeEntry or stagedView changes
  useEffect(() => {
    if (!activeProjectId || !activePath || !activeEntry) {
      setDiff(null);
      setDiffLoading(false);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);

    fetchChangeDiff(activeProjectId, activePath, stagedView)
      .then((res) => {
        if (!cancelled) {
          setDiff(res);
          setDiffLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error("[rama] failed to fetch change diff", err);
          setDiff(null);
          setDiffLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeProjectId, activePath, activeEntry, stagedView]);

  const value = useMemo<ChangesPaneValue>(
    () => ({
      changes,
      loading,
      activePath,
      setActivePath,
      activeEntry,
      stagedView,
      setStagedView,
      diff,
      diffLoading,
      refresh: () => void loadChanges(false),
      initRepo,
      initializingRepo,
      initRepoError,
      projectPath: currentProject?.path ?? null,
    }),
    [
      changes,
      loading,
      activePath,
      activeEntry,
      stagedView,
      diff,
      diffLoading,
      loadChanges,
      initRepo,
      initializingRepo,
      initRepoError,
      currentProject?.path,
    ],
  );

  return <ChangesPaneContext.Provider value={value}>{children}</ChangesPaneContext.Provider>;
}

export function useChangesPane(): ChangesPaneValue {
  const ctx = useContext(ChangesPaneContext);
  if (!ctx) throw new Error("useChangesPane must be used within a ChangesPaneProvider");
  return ctx;
}
