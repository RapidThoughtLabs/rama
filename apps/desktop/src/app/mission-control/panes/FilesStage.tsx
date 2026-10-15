import { useMemo } from "react";
import type { KeyboardEvent } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { Icon } from "@rama/ui";
import { Empty, baseName } from "../../code/workspace/parts";
import { useFilesPane } from "./FilesPaneContext";
import { highlightCode } from "./syntax";

// docs/CODE_REDESIGN_PLAN.md CR4 (mock:L1797-1806) — the Files stage bar (open-file tabs, wrap, copy
// path, open in your editor) and the code view. One click in the tree previews a file in the single
// italic tab; double-click or opening from a link pins it.

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function useOpenExternally() {
  const { activeTabPath, projectPath } = useFilesPane();
  return () => {
    if (!activeTabPath) return;
    const full = projectPath ? `${projectPath}/${activeTabPath}` : activeTabPath;
    void openPath(full).catch((err) => console.error("[rama] failed to open external file", err));
  };
}

export function FilesStageBar() {
  const { openTabs, activeTabPath, openFile, pinTab, closeTab, wrapText, setWrapText } = useFilesPane();
  const openExternally = useOpenExternally();

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>, path: string) {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      closeTab(path);
    }
  }

  return (
    <>
      <div className="r-ftabs" role="tablist">
        {openTabs.map((tab) => (
          <button
            key={tab.path}
            className={`r-ftab${tab.pinned ? "" : " preview"}`}
            role="tab"
            aria-selected={tab.path === activeTabPath}
            title={tab.path}
            onClick={() => openFile(tab.path, tab.pinned)}
            onDoubleClick={() => pinTab(tab.path)}
            onKeyDown={(e) => onTabKey(e, tab.path)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeTab(tab.path);
              }
            }}
          >
            {baseName(tab.path)}
            <span
              className="x"
              title="Close"
              aria-label={`Close ${baseName(tab.path)}`}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.path);
              }}
            >
              <Icon name="x" />
            </span>
          </button>
        ))}
      </div>
      <span className="grow" />
      {activeTabPath && (
        <>
          <button
            className={`r-icon-btn${wrapText ? " on" : ""}`}
            title={wrapText ? "Stop wrapping long lines" : "Wrap long lines"}
            aria-label="Wrap long lines"
            aria-pressed={wrapText}
            onClick={() => setWrapText(!wrapText)}
          >
            <Icon name="wrap" />
          </button>
          <button className="r-icon-btn" title="Copy path" aria-label="Copy path" onClick={() => void navigator.clipboard.writeText(activeTabPath)}>
            <Icon name="copy" />
          </button>
          <button className="r-icon-btn" title="Open in your editor" aria-label="Open in your editor" onClick={openExternally}>
            <Icon name="pop" />
          </button>
        </>
      )}
    </>
  );
}

export function FilesStage() {
  const { openTabs, activeTabPath, activeContent, contentLoading, wrapText } = useFilesPane();
  const openExternally = useOpenExternally();

  const lines = useMemo(() => {
    if (!activeContent || activeContent.binary) return [];
    return highlightCode(activeContent.content, activeTabPath ?? "");
  }, [activeContent, activeTabPath]);

  if (openTabs.length === 0 || !activeTabPath) return <Empty title="No file open">Pick a file from the list.</Empty>;
  if (contentLoading && !activeContent) return <Empty title="Opening file…" />;
  if (!activeContent) return <Empty title="Couldn't open this file">It may have been moved or deleted.</Empty>;

  if (activeContent.binary) {
    return (
      <div className="r-empty">
        <div>
          <b>Binary file</b>
          {formatBytes(activeContent.size)}, so there is no text to show.
          <div>
            <button className="r-btn r-btn-soft" onClick={openExternally}>
              Open in your editor
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {activeContent.truncated && (
        <div className="r-banner">
          <span>Showing the first 2 MB of {formatBytes(activeContent.size)}.</span>
          <button className="r-btn r-btn-soft" onClick={openExternally}>
            Open the whole file
          </button>
        </div>
      )}
      <div className={`r-codeview r-code${wrapText ? " wrap" : ""}`} style={{ padding: "12px 0 28px" }}>
        {lines.map((html, i) => (
          <div key={i} className="r-cl">
            <span className="n">{i + 1}</span>
            <span dangerouslySetInnerHTML={{ __html: html || " " }} />
          </div>
        ))}
      </div>
    </>
  );
}
