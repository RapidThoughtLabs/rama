import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ChangeStatus, FileContentDTO, FileEntryDTO } from "@rama/protocol";
import { fetchChanges, fetchProjectFileContent, fetchProjectFiles } from "../../../engine/client";
import { onProjectEvent } from "../../../engine/ws";
import { WINDOW_LABEL } from "../../../engine/window";
import { useProjectsData } from "../../data/ProjectsProvider";

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

export function FilesPaneProvider({ children }: { children: ReactNode }) {
  const { activeProjectId, projects } = useProjectsData();
  const currentProject = projects.find((p) => p.id === activeProjectId);

  const tabsKey = `rama:files:tabs:${WINDOW_LABEL}:${activeProjectId ?? "none"}`;
  const expandedKey = `rama:files:expanded:${WINDOW_LABEL}:${activeProjectId ?? "none"}`;
  const wrapKey = `rama:files:wrap:${WINDOW_LABEL}`;
  const showIgnoredKey = `rama:files:show-ignored:${WINDOW_LABEL}`;

  // Tabs persistence
  const [openTabs, setOpenTabs] = useState<OpenFileTab[]>(() => {
    try {
      const raw = localStorage.getItem(tabsKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.tabs) ? parsed.tabs : [];
    } catch {
      return [];
    }
  });

  const [activeTabPath, setActiveTabPath] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem(tabsKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return typeof parsed?.activePath === "string" ? parsed.activePath : null;
    } catch {
      return null;
    }
  });

  // Expanded folders persistence
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(expandedKey);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
      return new Set();
    }
  });

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

  // Load a directory's children
  const loadDir = useCallback(
    async (dirPath: string) => {
      if (!activeProjectId) return;
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
    contentCache.current.clear();
    if (!activeProjectId) return;

    void loadDir("");
    for (const dir of expandedFoldersRef.current) {
      void loadDir(dir);
    }
  }, [activeProjectId, loadDir]);

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
        } else {
          next = [...prev, { path, pinned: true }];
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
    }
    window.addEventListener("rama:open-file", handleOpenFile);
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
          contentCache.current.set(activeTabPath, data);
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
