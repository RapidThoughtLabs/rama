import {
  FileIcon,
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconFolderOpen,
  IconMore,
  IconRefresh,
} from "@rama/ui";
import { useFilesPane } from "./FilesPaneContext";

// docs/WORKSPACE_PANES_PLAN.md Phase W6 — Files rail with lazy directory tree and open-files 44px collapsed strip.

function DirectoryBranch({
  dirPath,
  depth,
}: {
  dirPath: string;
  depth: number;
}) {
  const {
    treeChildren,
    loadingDirs,
    expandedFolders,
    toggleFolder,
    showIgnored,
    openFile,
    activeTabPath,
    statusMap,
  } = useFilesPane();

  const entries = treeChildren[dirPath] ?? [];
  const isLoading = loadingDirs.has(dirPath);

  if (isLoading && entries.length === 0) {
    return (
      <div
        className="rama-files-loading"
        style={{ paddingLeft: depth * 14 + 18, fontSize: "var(--fs-micro)", color: "rgba(var(--ink), 0.4)" }}
      >
        loading…
      </div>
    );
  }

  const visibleEntries = entries.filter((e) => !e.ignored || showIgnored);

  return (
    <>
      {visibleEntries.map((entry) => {
        if (entry.kind === "dir") {
          const isExpanded = expandedFolders.has(entry.path);
          return (
            <div key={entry.path} className="rama-files-dir-group">
              <button
                type="button"
                className="rama-files-dir-row"
                style={{ paddingLeft: depth * 14 + 6 }}
                onClick={() => toggleFolder(entry.path)}
                title={entry.path}
              >
                <span className="rama-files-disclosure">
                  {isExpanded ? (
                    <IconChevronDown width={11} height={11} />
                  ) : (
                    <IconChevronRight width={11} height={11} />
                  )}
                </span>
                <span className="rama-files-dir-icon">
                  {isExpanded ? (
                    <IconFolderOpen width={14} height={14} />
                  ) : (
                    <IconFolder width={14} height={14} />
                  )}
                </span>
                <span className={`rama-files-name${entry.ignored ? " rama-files-ignored" : ""}`}>
                  {entry.name}
                </span>
              </button>
              {isExpanded && <DirectoryBranch dirPath={entry.path} depth={depth + 1} />}
            </div>
          );
        }

        const isActive = entry.path === activeTabPath;
        const gitStatus = statusMap[entry.path];

        return (
          <button
            key={entry.path}
            type="button"
            className={`rama-files-row${isActive ? " rama-files-row-active" : ""}`}
            style={{ paddingLeft: depth * 14 + 20 }}
            title={entry.path}
            onClick={() => openFile(entry.path, true)}
          >
            <span className="rama-files-file-icon">
              <FileIcon path={entry.path} width={13} height={13} />
            </span>
            <span className={`rama-files-name${entry.ignored ? " rama-files-ignored" : ""}`}>
              {entry.name}
            </span>
            {gitStatus && (
              <span
                style={{
                  fontSize: "var(--fs-micro)",
                  fontWeight: 700,
                  color:
                    gitStatus === "modified" || gitStatus === "renamed"
                      ? "var(--accent)"
                      : gitStatus === "added"
                      ? "var(--good)"
                      : gitStatus === "deleted" || gitStatus === "conflicted"
                      ? "var(--bad)"
                      : "rgba(var(--ink), 0.4)",
                  marginLeft: "auto",
                  paddingLeft: 6,
                }}
                title={`Git: ${gitStatus}`}
              >
                {gitStatus === "modified"
                  ? "M"
                  : gitStatus === "added"
                  ? "A"
                  : gitStatus === "deleted"
                  ? "D"
                  : gitStatus === "renamed"
                  ? "R"
                  : gitStatus === "conflicted"
                  ? "!"
                  : "?"}
              </span>
            )}
          </button>
        );
      })}
    </>
  );
}

export function FilesRail({ collapsed }: { collapsed: boolean }) {
  const { openTabs, activeTabPath, openFile, treeChildren, loadingDirs, rootError, refreshTree } = useFilesPane();

  if (collapsed) {
    if (openTabs.length === 0) {
      return <div className="rama-mc-rail-icons" style={{ width: 44 }} />;
    }

    return (
      <div className="rama-mc-rail-icons" style={{ width: 44 }}>
        {openTabs.map((tab) => {
          const isActive = tab.path === activeTabPath;
          const fileName = tab.path.split("/").pop() ?? tab.path;
          return (
            <button
              key={tab.path}
              type="button"
              className={`rama-mc-rail-icon-row${isActive ? " rama-mc-rail-icon-row-active" : ""}`}
              style={{ fontSize: "var(--fs-micro)", fontWeight: 600 }}
              title={`${fileName} (${tab.path})`}
              onClick={() => openFile(tab.path, tab.pinned)}
            >
              <FileIcon path={tab.path} width={16} height={16} />
            </button>
          );
        })}
      </div>
    );
  }

  const rootEntries = treeChildren[""];

  if (rootError) {
    return (
      <div className="rama-mc-coming-soon" style={{ flexDirection: "column", gap: 8 }}>
        <span style={{ color: "var(--bad)" }}>failed to load files: {rootError}</span>
        <button type="button" className="rama-mc-rail-action-btn" style={{ width: "auto", padding: "4px 12px" }} onClick={refreshTree}>
          <IconRefresh width={12} height={12} style={{ marginRight: 4 }} /> retry
        </button>
      </div>
    );
  }

  if (rootEntries === undefined) {
    return <div className="rama-mc-coming-soon">{loadingDirs.has("") ? "loading files…" : "…"}</div>;
  }

  if (rootEntries.length === 0) {
    return <div className="rama-mc-coming-soon">(empty directory)</div>;
  }

  return (
    <div className="rama-files-tree">
      <DirectoryBranch dirPath="" depth={0} />
    </div>
  );
}

export function FilesRailActions() {
  const { refreshTree, showIgnored, setShowIgnored } = useFilesPane();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <button
        type="button"
        className={`rama-mc-rail-action-btn${showIgnored ? " active" : ""}`}
        title={showIgnored ? "Hide ignored files" : "Show ignored files"}
        onClick={() => setShowIgnored(!showIgnored)}
        style={showIgnored ? { color: "var(--accent)" } : undefined}
      >
        <IconMore width={13} height={13} />
      </button>
      <button
        type="button"
        className="rama-mc-rail-action-btn"
        title="Refresh files tree"
        onClick={refreshTree}
      >
        <IconRefresh width={13} height={13} />
      </button>
    </div>
  );
}

