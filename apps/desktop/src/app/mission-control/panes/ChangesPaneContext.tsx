import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { ChangeDiffDTO, ChangeEntryDTO, ChangesDTO } from "@rama/protocol";
import { fetchChangeDiff, fetchChanges, initProjectRepo } from "../../../engine/client";
import { onProjectEvent, send } from "../../../engine/ws";
import { WINDOW_LABEL } from "../../../engine/window";
import { useProjectsData } from "../../data/ProjectsProvider";

// docs/WORKSPACE_PANES_PLAN.md Phase W4 — Changes pane state layer.

export type ChangesTreeNode =
  | {
      kind: "dir";
      path: string;
      label: string;
      children: ChangesTreeNode[];
      added: number | null;
      removed: number | null;
      fileCount: number;
      untracked?: boolean;
    }
  | {
      kind: "file";
      entry: ChangeEntryDTO;
      label: string;
      path: string;
    };

interface InternalDirNode {
  kind: "dir";
  name: string;
  path: string;
  children: Map<string, InternalDirNode | { kind: "file"; entry: ChangeEntryDTO; name: string; path: string }>;
}

function buildTree(entries: ChangeEntryDTO[]): ChangesTreeNode[] {
  const trackedEntries = entries.filter((e) => e.status !== "untracked");
  const untrackedEntries = entries.filter((e) => e.status === "untracked");

  const root: InternalDirNode = { kind: "dir", name: "", path: "", children: new Map() };

  for (const entry of trackedEntries) {
    const segments = entry.path.split("/");
    let curr = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      let next = curr.children.get(seg);
      if (!next || next.kind !== "dir") {
        next = { kind: "dir", name: seg, path: segments.slice(0, i + 1).join("/"), children: new Map() };
        curr.children.set(seg, next);
      }
      curr = next as InternalDirNode;
    }
    const fileName = segments[segments.length - 1]!;
    curr.children.set(fileName, { kind: "file", entry, name: fileName, path: entry.path });
  }

  function convertAndCompact(dir: InternalDirNode): ChangesTreeNode {
    // Recursively convert children
    let convertedChildren: ChangesTreeNode[] = Array.from(dir.children.values()).map((child) => {
      if (child.kind === "dir") return convertAndCompact(child);
      return { kind: "file", entry: child.entry, label: child.name, path: child.path };
    });

    // Compact single-child directories: dir with 1 child dir collapses into one row
    let label = dir.name;
    let path = dir.path;
    while (convertedChildren.length === 1 && convertedChildren[0]!.kind === "dir") {
      const onlyChild = convertedChildren[0]! as Extract<ChangesTreeNode, { kind: "dir" }>;
      label = label ? `${label}/${onlyChild.label}` : onlyChild.label;
      path = onlyChild.path;
      convertedChildren = onlyChild.children;
    }

    // Sort: directories first, then files; both alphabetical
    convertedChildren.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.label.localeCompare(b.label);
    });

    let added: number | null = null;
    let removed: number | null = null;
    let fileCount = 0;

    for (const child of convertedChildren) {
      if (child.kind === "file") {
        fileCount++;
        if (child.entry.added !== null) added = (added ?? 0) + child.entry.added;
        if (child.entry.removed !== null) removed = (removed ?? 0) + child.entry.removed;
      } else {
        fileCount += child.fileCount;
        if (child.added !== null) added = (added ?? 0) + child.added;
        if (child.removed !== null) removed = (removed ?? 0) + child.removed;
      }
    }

    return {
      kind: "dir",
      path,
      label,
      children: convertedChildren,
      added,
      removed,
      fileCount,
    };
  }

  const result: ChangesTreeNode[] = [];

  for (const child of Array.from(root.children.values())) {
    if (child.kind === "dir") {
      result.push(convertAndCompact(child));
    } else {
      result.push({ kind: "file", entry: child.entry, label: child.name, path: child.path });
    }
  }

  // Sort top-level entries: directories first, then files
  result.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.label.localeCompare(b.label);
  });

  // Synthetic (untracked) group at bottom if untracked entries exist
  if (untrackedEntries.length > 0) {
    let untrackedAdded: number | null = null;
    let untrackedRemoved: number | null = null;
    const untrackedChildren: ChangesTreeNode[] = untrackedEntries.map((e) => {
      if (e.added !== null) untrackedAdded = (untrackedAdded ?? 0) + e.added;
      if (e.removed !== null) untrackedRemoved = (untrackedRemoved ?? 0) + e.removed;
      return {
        kind: "file",
        entry: e,
        label: e.path,
        path: e.path,
      };
    });

    untrackedChildren.sort((a, b) => a.label.localeCompare(b.label));

    result.push({
      kind: "dir",
      path: "(untracked)",
      label: "(untracked)",
      children: untrackedChildren,
      added: untrackedAdded,
      removed: untrackedRemoved,
      fileCount: untrackedChildren.length,
      untracked: true,
    });
  }

  return result;
}

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
  tree: ChangesTreeNode[];
  toggleFolder: (path: string) => void;
  isFolderCollapsed: (path: string) => boolean;
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

  const storageKey = `rama:changes:collapsed:${WINDOW_LABEL}:${activeProjectId ?? "none"}`;
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  const toggleFolder = useCallback(
    (folderPath: string) => {
      setCollapsedFolders((prev) => {
        const next = { ...prev, [folderPath]: !prev[folderPath] };
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // ignore
        }
        return next;
      });
    },
    [storageKey],
  );

  const isFolderCollapsed = useCallback(
    (folderPath: string) => {
      return !!collapsedFolders[folderPath];
    },
    [collapsedFolders],
  );

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

  const tree = useMemo(() => {
    if (!changes || changes.entries.length === 0) return [];
    return buildTree(changes.entries);
  }, [changes]);

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
      tree,
      toggleFolder,
      isFolderCollapsed,
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
      tree,
      toggleFolder,
      isFolderCollapsed,
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
