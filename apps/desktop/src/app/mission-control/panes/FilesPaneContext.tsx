import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ChangeStatus, FileContentDTO, FileEntryDTO } from "@rama/protocol";
import { fetchChanges, fetchProjectFileContent, fetchProjectFiles } from "../../../engine/client";
import { onProjectEvent } from "../../../engine/ws";
import { WINDOW_LABEL } from "../../../engine/window";
import { useProjectsData } from "../../data/ProjectsProvider";
import { takePendingOpenFile } from "./openFileBridge";

// docs/WORKSPACE_PANES_PLAN.md Phase W6 — Files pane state layer.

export interface OpenFileTab {
  path: string;
  pinned: boolean;
}

interface FilesPaneValue {
  // Tree state
  treeChildren: Record<string, FileEntryDTO[]>;
  loadingDirs: Set<string>;
  rootError: string | null;
  expandedFolders: Set<string>;
  toggleFolder: (path: string) => void;
  showIgnored: boolean;
  setShowIgnored: (show: boolean) => void;
  refreshTree: () => void;
  ensureDir: (path: string) => void;

  // Tabs state
  openTabs: OpenFileTab[];
  activeTabPath: string | null;
  openFile: (path: string, pin?: boolean) => void;
  pinTab: (path: string) => void;
  closeTab: (path: string) => void;

  // Viewer state
  activeContent: FileContentDTO | null;
  contentLoading: boolean;
  wrapText: boolean;
  setWrapText: (wrap: boolean) => void;
  projectPath: string | null;
  statusMap: Record<string, ChangeStatus>;
}

const FilesPaneContext = createContext<FilesPaneValue | null>(null);

function readTabs(key: string): { tabs: OpenFileTab[]; activePath: string | null } {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "null");
    return {
      tabs: Array.isArray(parsed?.tabs) ? parsed.tabs : [],
      activePath: typeof parsed?.activePath === "string" ? parsed.activePath : null,
    };
  } catch {
    return { tabs: [], activePath: null };
  }
}

function readExpanded(key: string): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "null");
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

export function FilesPaneProvider({ children }: { children: ReactNode }) {
  const { activeProjectId, projects } = useProjectsData();
  const currentProject = projects.find((p) => p.id === activeProjectId);

  const tabsKey = `rama:files:tabs:${WINDOW_LABEL}:${activeProjectId ?? "none"}`;
  const expandedKey = `rama:files:expanded:${WINDOW_LABEL}:${activeProjectId ?? "none"}`;
  const wrapKey = `rama:files:wrap:${WINDOW_LABEL}`;
  const showIgnoredKey = `rama:files:show-ignored:${WINDOW_LABEL}`;

  // Tabs and expanded folders are persisted per project. The keys depend on `activeProjectId`, which
  // is still null when this provider mounts on a cold start with Files as the saved pane, so the
  // initial read is repeated whenever the keys change (otherwise the tabs came up empty).
  const [openTabs, setOpenTabs] = useState<OpenFileTab[]>(() => readTabs(tabsKey).tabs);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(() => readTabs(tabsKey).activePath);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => readExpanded(expandedKey));
  useEffect(() => {
    const saved = readTabs(tabsKey);
    setOpenTabs(saved.tabs);
    setActiveTabPath(saved.activePath);
    setExpandedFolders(readExpanded(expandedKey));
  }, [tabsKey, expandedKey]);

  // View settings persistence
  const [wrapText, setWrapTextState] = useState<boolean>(() => {
    return localStorage.getItem(wrapKey) === "true";
  });

  const [showIgnored, setShowIgnoredState] = useState<boolean>(() => {
    return localStorage.getItem(showIgnoredKey) === "true";
  });

  const setWrapText = useCallback(
    (wrap: boolean) => {
      setWrapTextState(wrap);
      try {
        localStorage.setItem(wrapKey, String(wrap));
      } catch {
        // ignore
      }
    },
    [wrapKey],
  );

  const setShowIgnored = useCallback(
    (show: boolean) => {
      setShowIgnoredState(show);
      try {
        localStorage.setItem(showIgnoredKey, String(show));
      } catch {
        // ignore
      }
    },
    [showIgnoredKey],
  );

  // Save tabs on change
  const saveTabs = useCallback(
    (tabs: OpenFileTab[], activePath: string | null) => {
      try {
        localStorage.setItem(tabsKey, JSON.stringify({ tabs, activePath }));
      } catch {
        // ignore
      }
    },
    [tabsKey],
  );

  // Save expanded folders on change
  const saveExpanded = useCallback(
    (set: Set<string>) => {
      try {
        localStorage.setItem(expandedKey, JSON.stringify(Array.from(set)));
      } catch {
        // ignore
      }
    },
    [expandedKey],
  );

  // Directory entries cache: "" is root
  const [treeChildren, setTreeChildren] = useState<Record<string, FileEntryDTO[]>>({});
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [rootError, setRootError] = useState<string | null>(null);

  // Content state for active tab
  const [activeContent, setActiveContent] = useState<FileContentDTO | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const contentCache = useRef<Map<string, FileContentDTO>>(new Map());

  // Directories a load was started for, so `ensureDir` neither repeats a load nor retries a failed one.
  const attemptedDirs = useRef<Set<string>>(new Set());

  // Load a directory's children
  const loadDir = useCallback(
    async (dirPath: string) => {
      if (!activeProjectId) return;
      attemptedDirs.current.add(dirPath);
      setLoadingDirs((prev) => new Set(prev).add(dirPath));
      try {
        const res = await fetchProjectFiles(activeProjectId, dirPath);
        setTreeChildren((prev) => ({ ...prev, [dirPath]: res.entries }));
        if (dirPath === "") setRootError(null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[rama] failed to load directory "${dirPath}"`, err);
        if (dirPath === "") setRootError(message);
      } finally {
        setLoadingDirs((prev) => {
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
      }
    },
    [activeProjectId],
  );

  // expandedFolders changes on every toggle (a new Set each time); the initial-load effect below
  // must only re-run on an actual project switch, not on every toggle — otherwise each expand
  // wipes the whole cache (including the already-loaded root) and refires every previously
  // expanded directory's fetch on top of the one toggleFolder already kicked off. A ref sidesteps
  // that without dropping expandedFolders from the reset-time restore loop.
  const expandedFoldersRef = useRef(expandedFolders);
  useEffect(() => {
    expandedFoldersRef.current = expandedFolders;
  }, [expandedFolders]);

  // Initial load: root directory and any previously expanded directories
  useEffect(() => {
    setTreeChildren({});
    setRootError(null);
    attemptedDirs.current.clear();
    contentCache.current.clear();
    if (!activeProjectId) return;

    void loadDir("");
    for (const dir of expandedFoldersRef.current) {
      void loadDir(dir);
    }
  }, [activeProjectId, loadDir]);

  // Loads a directory the tree only needs to look inside: a collapsed folder whose single child is a
  // folder is drawn as one "a/b/c" row, which needs the chain's links loaded (FilesRail).
  const ensureDir = useCallback(
    (dirPath: string) => {
      if (!attemptedDirs.current.has(dirPath)) void loadDir(dirPath);
    },
    [loadDir],
  );

  const refreshTree = useCallback(() => {
    if (!activeProjectId) return;
    void loadDir("");
    for (const dir of expandedFolders) {
      void loadDir(dir);
    }
    // Also re-fetch active file content
    if (activeTabPath) {
      setContentLoading(true);
      fetchProjectFileContent(activeProjectId, activeTabPath)
        .then((data) => {
          contentCache.current.set(activeTabPath, data);
          setActiveContent(data);
        })
        .catch(() => {})
        .finally(() => setContentLoading(false));
    }
  }, [activeProjectId, expandedFolders, activeTabPath, loadDir]);

  const toggleFolder = useCallback(
    (folderPath: string) => {
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        if (next.has(folderPath)) {
          next.delete(folderPath);
        } else {
          next.add(folderPath);
          // Load if not present
          if (!treeChildren[folderPath]) {
            void loadDir(folderPath);
          }
        }
        saveExpanded(next);
        return next;
      });
    },
    [treeChildren, loadDir, saveExpanded],
  );

  // Tab operations
  const openFile = useCallback(
    (path: string, pin = true) => {
      setOpenTabs((prev) => {
        const existingIdx = prev.findIndex((t) => t.path === path);
        let next: OpenFileTab[];

        if (existingIdx !== -1) {
          next = [...prev];
          if (pin) next[existingIdx] = { path, pinned: true };
        } else if (!pin && prev.some((t) => !t.pinned)) {
          // A single click previews: it takes over the one preview tab instead of adding another
          // (mock:L1813-1824). Double-click or opening via a link pins.
          next = prev.map((t) => (t.pinned ? t : { path, pinned: false }));
        } else {
          next = [...prev, { path, pinned: pin }];
        }
        setActiveTabPath(path);
        saveTabs(next, path);
        return next;
      });
    },
    [saveTabs],
  );


  const pinTab = useCallback(
    (path: string) => {
      setOpenTabs((prev) => {
        const next = prev.map((t) => (t.path === path ? { ...t, pinned: true } : t));
        saveTabs(next, activeTabPath);
        return next;
      });
    },
    [activeTabPath, saveTabs],
  );

  const closeTab = useCallback(
    (path: string) => {
      setOpenTabs((prev) => {
        const idx = prev.findIndex((t) => t.path === path);
        if (idx === -1) return prev;
        const next = prev.filter((t) => t.path !== path);

        let nextActive = activeTabPath;
        if (activeTabPath === path) {
          if (next.length === 0) {
            nextActive = null;
          } else if (idx < next.length) {
            nextActive = next[idx]!.path; // right neighbour
          } else {
            nextActive = next[idx - 1]!.path; // left neighbour
          }
          setActiveTabPath(nextActive);
        }

        saveTabs(next, nextActive);
        return next;
      });
    },
    [activeTabPath, saveTabs],
  );

  // Changed files status map (W7 cross-linking)
  const [statusMap, setStatusMap] = useState<Record<string, ChangeStatus>>({});

  useEffect(() => {
    if (!activeProjectId) {
      setStatusMap({});
      return;
    }
    let cancelled = false;
    function updateChanges() {
      fetchChanges(activeProjectId!)
        .then((data) => {
          if (cancelled) return;
          const map: Record<string, ChangeStatus> = {};
          for (const entry of data.entries) {
            map[entry.path] = entry.status;
          }
          setStatusMap(map);
        })
        .catch(() => {
          if (!cancelled) setStatusMap({});
        });
    }

    updateChanges();

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const unsub = onProjectEvent((projectId, event) => {
      if (projectId !== activeProjectId) return;
      if (event.type === "changes.invalidated") {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(updateChanges, 250);
      }
    });

    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      unsub();
    };
  }, [activeProjectId]);

  const expandToPath = useCallback(
    (filePath: string) => {
      const parts = filePath.split("/");
      parts.pop();
      if (parts.length === 0) return;
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        let curr = "";
        for (const part of parts) {
          curr = curr ? `${curr}/${part}` : part;
          next.add(curr);
          void loadDir(curr);
        }
        saveExpanded(next);
        return next;
      });
    },
    [loadDir, saveExpanded],
  );

  // docs/WORKSPACE_PANES_PLAN.md Phase W7 — cross-pane link: open file via rama:open-file
  useEffect(() => {
    function handleOpenFile(e: Event) {
      const ce = e as CustomEvent<{ path: string }>;
      if (ce.detail?.path) {
        expandToPath(ce.detail.path);
        openFile(ce.detail.path, true);
      }
      takePendingOpenFile();
    }
    window.addEventListener("rama:open-file", handleOpenFile);

    // This provider only mounts while the Files pane is active. A click while some other
    // pane is showing dispatched its event before we existed to hear it — pick up whatever
    // AppShell's global listener stashed when it switched the active pane to "files".
    const pending = takePendingOpenFile();
    if (pending) {
      expandToPath(pending);
      openFile(pending, true);
    }

    return () => window.removeEventListener("rama:open-file", handleOpenFile);
  }, [expandToPath, openFile]);

  // Fetch active tab file content
  useEffect(() => {
    if (!activeProjectId || !activeTabPath) {
      setActiveContent(null);
      setContentLoading(false);
      return;
    }

    const cached = contentCache.current.get(activeTabPath);
    if (cached) {
      setActiveContent(cached);
      return;
    }

    let cancelled = false;
    setContentLoading(true);

    fetchProjectFileContent(activeProjectId, activeTabPath)
      .then((data) => {
        if (!cancelled) {
          // The server resolves shorthand/partial references (a tool call's raw path, a
          // "./"-prefixed link from chat) to the real project-relative path — see
          // engine/src/files/browse.ts resolveRelPath. Swap the tab over to it so the tab
          // label, "copy path", and "open externally" all point at a file that actually exists.
          if (data.path && data.path !== activeTabPath) {
            const resolvedPath = data.path;
            contentCache.current.set(resolvedPath, data);
            const nextTabs = openTabs.map((t) =>
              t.path === activeTabPath ? { path: resolvedPath, pinned: t.pinned } : t,
            );
            setOpenTabs(nextTabs);
            setActiveTabPath(resolvedPath);
            saveTabs(nextTabs, resolvedPath);
          } else {
            contentCache.current.set(activeTabPath, data);
          }
          setActiveContent(data);
          setContentLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          // A path that no longer exists is dropped silently on restore (§4.2)
          console.warn(`[rama] failed to fetch file content for "${activeTabPath}"`, err);
          closeTab(activeTabPath);
          setContentLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeProjectId, activeTabPath, closeTab]);

  const value = useMemo<FilesPaneValue>(
    () => ({
      treeChildren,
      loadingDirs,
      rootError,
      expandedFolders,
      toggleFolder,
      showIgnored,
      setShowIgnored,
      refreshTree,
      ensureDir,
      openTabs,
      activeTabPath,
      openFile,
      pinTab,
      closeTab,
      activeContent,
      contentLoading,
      wrapText,
      setWrapText,
      projectPath: currentProject?.path ?? null,
      statusMap,
    }),
    [
      treeChildren,
      loadingDirs,
      rootError,
      expandedFolders,
      toggleFolder,
      showIgnored,
      setShowIgnored,
      refreshTree,
      ensureDir,
      openTabs,
      activeTabPath,
      openFile,
      pinTab,
      closeTab,
      activeContent,
      contentLoading,
      wrapText,
      setWrapText,
      currentProject?.path,
      statusMap,
    ],
  );

  return <FilesPaneContext.Provider value={value}>{children}</FilesPaneContext.Provider>;
}

export function useFilesPane(): FilesPaneValue {
  const ctx = useContext(FilesPaneContext);
  if (!ctx) throw new Error("useFilesPane must be used within a FilesPaneProvider");
  return ctx;
}
