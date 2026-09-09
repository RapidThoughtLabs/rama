import { useMemo } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { FileIcon, IconClose, IconCopy, IconPopOut } from "@rama/ui";
import { useFilesPane } from "./FilesPaneContext";
import { highlightCode } from "./syntax";

// docs/WORKSPACE_PANES_PLAN.md Phase W6 — Files stage with in-band tab strip, line-number gutter viewer, and external editor bridge.

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilesStage() {
  const {
    openTabs,
    activeTabPath,
    openFile,
    pinTab,
    closeTab,
    activeContent,
    contentLoading,
    wrapText,
    setWrapText,
    projectPath,
  } = useFilesPane();

  const lines = useMemo(() => {
    if (!activeContent || activeContent.binary) return [];
    return highlightCode(activeContent.content, activeTabPath ?? "");
  }, [activeContent, activeTabPath]);

  function copyPath() {
    if (activeTabPath) void navigator.clipboard.writeText(activeTabPath);
  }

  function openExternally() {
    if (!activeTabPath) return;
    const full = projectPath ? `${projectPath}/${activeTabPath}` : activeTabPath;
    void openPath(full).catch((err) => console.error("[rama] failed to open external file", err));
  }

  return (
    <>
      <div className="rama-files-stage-toolbar">
        <div className="rama-files-tab-strip">
          {openTabs.map((tab) => {
            const isActive = tab.path === activeTabPath;
            const fileName = tab.path.split("/").pop() ?? tab.path;
            return (
              <div
                key={tab.path}
                className={`rama-file-tab${isActive ? " rama-file-tab-active" : ""}`}
                title={tab.path}
                onClick={() => openFile(tab.path, true)}
                onDoubleClick={() => pinTab(tab.path)}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    closeTab(tab.path);
                  }
                }}
              >
                <FileIcon path={tab.path} width={13} height={13} className="rama-file-tab-icon" />
                <span className="rama-file-tab-title">{fileName}</span>
                <button
                  type="button"
                  className="rama-file-tab-close"
                  title="Close (middle-click)"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.path);
                  }}
                >
                  <IconClose width={10} height={10} />
                </button>
              </div>
            );
          })}
        </div>

        <div className="rama-files-toolbar-actions">
          {activeTabPath && (
            <>
              <button
                type="button"
                className={`rama-files-action-btn${wrapText ? " active" : ""}`}
                title={wrapText ? "Disable word wrap" : "Enable word wrap"}
                onClick={() => setWrapText(!wrapText)}
              >
                wrap
              </button>
              <button
                type="button"
                className="rama-files-action-btn"
                title="Copy path"
                onClick={copyPath}
              >
                <IconCopy width={12} height={12} />
              </button>
              <button
                type="button"
                className="rama-files-action-btn"
                title="Open in external editor"
                onClick={openExternally}
              >
                <IconPopOut width={12} height={12} />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="rama-files-stage-body">
        {openTabs.length === 0 || !activeTabPath ? (
          <div className="rama-mc-coming-soon">no file open — select a file in the tree to view.</div>
        ) : contentLoading && !activeContent ? (
          <div className="rama-mc-coming-soon">loading file…</div>
        ) : !activeContent ? (
          <div className="rama-mc-coming-soon">file could not be loaded.</div>
        ) : activeContent.binary ? (
          <div className="rama-mc-coming-soon" style={{ flexDirection: "column", gap: 10 }}>
            <span>binary file ({formatBytes(activeContent.size)})</span>
            <button
              type="button"
              className="rama-mc-rail-action-btn"
              style={{ width: "auto", padding: "4px 12px", border: "1px solid rgba(var(--ink), 0.1)" }}
              onClick={openExternally}
            >
              <IconPopOut width={12} height={12} style={{ marginRight: 6 }} /> open in external editor
            </button>
          </div>
        ) : (
          <div className="rama-file-viewer">
            {activeContent.truncated && (
              <div className="rama-files-oversize-banner">
                <span>
                  Oversize file: previewing first 2MB of {formatBytes(activeContent.size)}.
                </span>
                <button
                  type="button"
                  className="rama-files-action-btn"
                  style={{ textDecoration: "underline" }}
                  onClick={openExternally}
                >
                  <IconPopOut width={12} height={12} style={{ marginRight: 4 }} /> open full in editor
                </button>
              </div>
            )}
            <div className="rama-file-lines">
              {lines.map((lineHtml, idx) => (
                <div key={idx} className="rama-file-line">
                  <span className="rama-diff-line-num">{idx + 1}</span>
                  <span
                    className={`rama-file-line-text${wrapText ? " rama-file-line-wrap" : ""}`}
                    dangerouslySetInnerHTML={{ __html: lineHtml || "&nbsp;" }}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

