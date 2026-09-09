import type { ChangeEntryDTO } from "@rama/protocol";
import { ChangesTreeNode, useChangesPane } from "./ChangesPaneContext";

// docs/WORKSPACE_PANES_PLAN.md Phase W4 — Changes rail with compact folder tree and 44px collapsed strip.

function statusLetter(status: ChangeEntryDTO["status"]): string {
  switch (status) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "?";
    case "conflicted":
      return "!";
  }
}

function statusColor(status: ChangeEntryDTO["status"]): string {
  switch (status) {
    case "modified":
    case "renamed":
      return "var(--accent)";
    case "added":
      return "var(--good)";
    case "deleted":
    case "conflicted":
      return "var(--bad)";
    case "untracked":
      return "rgba(var(--ink), 0.45)";
  }
}

function renderNode(
  node: ChangesTreeNode,
  depth: number,
  activePath: string | null,
  onSelectFile: (path: string) => void,
  toggleFolder: (path: string) => void,
  isFolderCollapsed: (path: string) => boolean,
) {
  if (node.kind === "dir") {
    const collapsed = isFolderCollapsed(node.path);
    return (
      <div key={node.path} className="rama-changes-dir-group">
        <button
          type="button"
          className="rama-changes-dir-row"
          style={{ paddingLeft: depth * 14 + 6 }}
          onClick={() => toggleFolder(node.path)}
        >
          <span className="rama-changes-disclosure">{collapsed ? "▸" : "▾"}</span>
          <span className="rama-changes-dir-label" title={node.path}>
            {node.label}
          </span>
          <span style={{ flex: 1 }} />
          {(node.added !== null || node.removed !== null) && (
            <span className="rama-changes-dir-count">
              {node.added !== null && <span style={{ color: "var(--good)" }}>+{node.added}</span>}{" "}
              {node.removed !== null && <span style={{ color: "var(--bad)" }}>−{node.removed}</span>}
            </span>
          )}
        </button>
        {!collapsed &&
          node.children.map((child) =>
            renderNode(child, depth + 1, activePath, onSelectFile, toggleFolder, isFolderCollapsed),
          )}
      </div>
    );
  }

  const { entry } = node;
  const isActive = entry.path === activePath;
  const glyph = statusLetter(entry.status);
  const color = statusColor(entry.status);
  const isRename = entry.status === "renamed";
  const tooltip = isRename ? `${entry.origPath ?? ""} → ${entry.path}` : entry.path;

  return (
    <button
      key={entry.path}
      type="button"
      className={`rama-changes-row${isActive ? " rama-changes-row-active" : ""}`}
      style={{ paddingLeft: depth * 14 + 18 }}
      title={tooltip}
      onClick={() => onSelectFile(entry.path)}
    >
      <div className="rama-changes-row-head">
        <span className="rama-changes-status-glyph" style={{ color }}>
          {glyph}
        </span>
        <span className="rama-changes-file-name">{node.label}</span>
      </div>
      <div className="rama-changes-row-sub">
        {isRename && entry.origPath ? (
          <span className="rama-changes-orig-path" title={entry.origPath}>
            ← {entry.origPath.split("/").pop()}
          </span>
        ) : (
          <span />
        )}
        <span style={{ flex: 1 }} />
        {entry.binary ? (
          <span className="rama-changes-binary-tag">bin</span>
        ) : (
          (entry.added !== null || entry.removed !== null) && (
            <span className="rama-changes-counts">
              {entry.added !== null && <span style={{ color: "var(--good)" }}>+{entry.added}</span>}{" "}
              {entry.removed !== null && <span style={{ color: "var(--bad)" }}>−{entry.removed}</span>}
            </span>
          )
        )}
      </div>
    </button>
  );
}

export function ChangesRail({ collapsed }: { collapsed: boolean }) {
  const { changes, loading, activePath, setActivePath, tree, toggleFolder, isFolderCollapsed } = useChangesPane();

  if (collapsed) {
    if (!changes || changes.entries.length === 0) {
      return <div className="rama-mc-rail-icons" style={{ width: 44 }} />;
    }
    const visibleEntries = changes.entries.slice(0, 12);
    const overflowCount = changes.entries.length - 12;

    return (
      <div className="rama-mc-rail-icons" style={{ width: 44 }}>
        {visibleEntries.map((e) => {
          const isActive = e.path === activePath;
          const glyph = statusLetter(e.status);
          const color = statusColor(e.status);
          return (
            <button
              key={e.path}
              type="button"
              className={`rama-mc-rail-icon-row${isActive ? " rama-mc-rail-icon-row-active" : ""}`}
              style={{ color }}
              title={e.path}
              onClick={() => setActivePath(e.path)}
            >
              {glyph}
            </button>
          );
        })}
        {overflowCount > 0 && (
          <button
            type="button"
            className="rama-mc-rail-icon-row"
            title={`+${overflowCount} more changed files (click to expand rail)`}
            onClick={() => window.dispatchEvent(new CustomEvent("rama:mc-expand-rail"))}
            style={{ fontSize: "var(--fs-micro)" }}
          >
            +{overflowCount}
          </button>
        )}
      </div>
    );
  }

  if (loading && !changes) {
    return <div className="rama-mc-coming-soon">loading changes…</div>;
  }

  if (!changes || !changes.isRepo) {
    return (
      <div className="rama-mc-coming-soon">
        not a git repository — this project directory has no .git
      </div>
    );
  }

  if (changes.entries.length === 0) {
    return <div className="rama-mc-coming-soon">working tree clean.</div>;
  }

  return (
    <div className="rama-changes-tree">
      {tree.map((node) => renderNode(node, 0, activePath, setActivePath, toggleFolder, isFolderCollapsed))}
    </div>
  );
}

export function ChangesRailActions() {
  const { changes, refresh, loading } = useChangesPane();
  if (!changes || !changes.isRepo) return null;

  const branchLabel = changes.detached ? `detached @ ${changes.head ?? ""}` : changes.branch ?? "HEAD";
  const aheadBehind = [
    changes.ahead > 0 ? `↑${changes.ahead}` : null,
    changes.behind > 0 ? `↓${changes.behind}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span
        style={{
          fontSize: "var(--fs-micro)",
          color: "rgba(var(--ink), 0.6)",
          maxWidth: 100,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={`Branch: ${branchLabel}`}
      >
        {branchLabel}
      </span>
      {aheadBehind && (
        <span style={{ fontSize: "var(--fs-micro)", color: "rgba(var(--ink), 0.4)" }}>
          {aheadBehind}
        </span>
      )}
      {changes.midMerge && (
        <span
          style={{
            fontSize: "var(--fs-micro)",
            color: "var(--bad)",
            background: "rgba(255, 95, 87, 0.1)",
            padding: "1px 4px",
            borderRadius: 3,
          }}
          title="Repository is currently mid-merge"
        >
          ⚠ merging
        </span>
      )}
      {changes.midRebase && (
        <span
          style={{
            fontSize: "var(--fs-micro)",
            color: "var(--bad)",
            background: "rgba(255, 95, 87, 0.1)",
            padding: "1px 4px",
            borderRadius: 3,
          }}
          title="Repository is currently mid-rebase"
        >
          ⚠ rebasing
        </span>
      )}
      <button
        type="button"
        className="rama-mc-rail-action-btn"
        title="Refresh changes"
        onClick={refresh}
        disabled={loading}
      >
        ⟳
      </button>
    </div>
  );
}
