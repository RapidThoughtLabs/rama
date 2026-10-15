import { useEffect, useState } from "react";
import { Icon, Popover } from "@rama/ui";
import type { ChangeStatus, FileEntryDTO } from "@rama/protocol";
import { Empty, baseName } from "../../code/workspace/parts";
import { useFilesPane } from "./FilesPaneContext";

// docs/CODE_REDESIGN_PLAN.md CR4 (mock:L1797-1806) — the Files rail head and tree. A directory whose
// only child is a directory reads as one row ("apps/desktop/src"); open files stand in as `doc` rows
// when the rail is collapsed.

const GIT_LETTER: Record<ChangeStatus, string> = { modified: "M", added: "A", deleted: "D", renamed: "R", conflicted: "!", untracked: "?" };

export function FilesRailHead() {
  const { refreshTree } = useFilesPane();
  return (
    <>
      <b className="grow">Files</b>
      <button className="r-icon-btn" title="Refresh" aria-label="Refresh" onClick={refreshTree}>
        <Icon name="retry" />
      </button>
    </>
  );
}

/** Follows single-subdirectory links downward: `apps` → `apps/desktop` → `apps/desktop/src`. */
function compactChain(
  entry: FileEntryDTO,
  treeChildren: Record<string, FileEntryDTO[]>,
  showIgnored: boolean,
): { end: string; label: string } {
  let end = entry.path;
  let label = entry.name;
  for (;;) {
    const kids = treeChildren[end]?.filter((e) => showIgnored || !e.ignored);
    if (kids?.length === 1 && kids[0]!.kind === "dir") {
      end = kids[0]!.path;
      label += `/${kids[0]!.name}`;
    } else {
      return { end, label };
    }
  }
}

function Branch({ dirPath, depth }: { dirPath: string; depth: number }) {
  const { treeChildren, loadingDirs, expandedFolders, toggleFolder, showIgnored, openFile, activeTabPath, statusMap, ensureDir } = useFilesPane();
  const entries = treeChildren[dirPath] ?? [];

  // Look one chain ahead of every folder row, so "apps/desktop/src" can be drawn as one row before
  // anyone opens it. Each load re-runs this and follows the chain another link.
  useEffect(() => {
    for (const e of entries.slice(0, 60)) {
      if (e.kind !== "dir" || (e.ignored && !showIgnored)) continue;
      let cur = e.path;
      for (;;) {
        const kids = treeChildren[cur]?.filter((k) => showIgnored || !k.ignored);
        if (!kids) {
          ensureDir(cur);
          break;
        }
        if (kids.length === 1 && kids[0]!.kind === "dir") cur = kids[0]!.path;
        else break;
      }
    }
  }, [entries, treeChildren, showIgnored, ensureDir]);

  if (loadingDirs.has(dirPath) && entries.length === 0) {
    return (
      <div className="r-tree-row" style={{ paddingLeft: 26 + 18 * depth, color: "var(--ink-4)" }}>
        Loading…
      </div>
    );
  }

  return (
    <>
      {entries
        .filter((e) => showIgnored || !e.ignored)
        .map((entry) => {
          if (entry.kind === "dir") {
            const { end, label } = compactChain(entry, treeChildren, showIgnored);
            const open = expandedFolders.has(end);
            return (
              <div key={entry.path}>
                <button className="r-tree-row" style={depth ? { paddingLeft: 8 + 18 * depth } : undefined} aria-expanded={open} title={end} onClick={() => toggleFolder(end)}>
                  <Icon name="right" className={open ? "tw open" : "tw"} />
                  <Icon name="folder" />
                  <span className={entry.ignored ? "ign" : undefined}>{label}</span>
                </button>
                {open && <Branch dirPath={end} depth={depth + 1} />}
              </div>
            );
          }
          const status = statusMap[entry.path];
          return (
            <button
              key={entry.path}
              className="r-tree-row leaf"
              style={{ paddingLeft: 26 + 18 * depth }}
              aria-current={entry.path === activeTabPath}
              title={entry.path}
              // One click previews and a second pins (the stage's tab handles double-click too).
              onClick={() => openFile(entry.path, false)}
              onDoubleClick={() => openFile(entry.path, true)}
            >
              <Icon name="doc" />
              <span className={entry.ignored ? "ign" : undefined}>{entry.name}</span>
              {status && (
                <span className={`gs ${status}`} title={`Git: ${status}`}>
                  {GIT_LETTER[status]}
                </span>
              )}
            </button>
          );
        })}
    </>
  );
}

export function FilesRail({ collapsed }: { collapsed: boolean }) {
  const { openTabs, activeTabPath, openFile, treeChildren, loadingDirs, rootError, refreshTree, showIgnored, setShowIgnored } = useFilesPane();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const rootEntries = treeChildren[""];
  let body;
  if (rootError) {
    body = collapsed ? null : (
      <div className="r-empty" style={{ height: "auto", padding: "28px 12px" }}>
        <div>
          <b>Couldn't load files</b>
          {rootError}
          <div>
            <button className="r-btn r-btn-soft" onClick={refreshTree}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  } else if (rootEntries === undefined) {
    body = collapsed ? null : <Empty compact title={loadingDirs.has("") ? "Loading files…" : "…"} />;
  } else if (rootEntries.length === 0) {
    body = collapsed ? null : <Empty compact title="This folder is empty" />;
  } else {
    body = <Branch dirPath="" depth={0} />;
  }

  return (
    <div
      style={{ minHeight: "100%" }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {body}
      {openTabs.map((t) => (
        <button key={t.path} className="r-rrow r-only-collapsed" aria-current={t.path === activeTabPath} title={t.path} onClick={() => openFile(t.path, t.pinned)}>
          <Icon name="doc" />
          <span className="t">{baseName(t.path)}</span>
        </button>
      ))}
      <Popover open={menu !== null} onClose={() => setMenu(null)} className="r-menu" role="menu" style={menu ? { left: menu.x, top: menu.y } : undefined}>
        <button
          role="menuitem"
          className="r-mp-item"
          onClick={() => {
            setShowIgnored(!showIgnored);
            setMenu(null);
          }}
        >
          <Icon name="eye" />
          <span>{showIgnored ? "Hide ignored files" : "Show ignored files"}</span>
        </button>
      </Popover>
    </div>
  );
}
