import { Icon } from "@rama/ui";
import type { IconName } from "@rama/ui";
import type { ChangeEntryDTO, ChangesDTO } from "@rama/protocol";
import { Delta, Empty, baseName, dirName } from "../../code/workspace/parts";
import { useChangesPane } from "./ChangesPaneContext";

// docs/CODE_REDESIGN_PLAN.md CR4 (mock:L1760-1775) — the Changes rail head and rail: a flat list
// grouped by directory, one `.rrow` per file. Replaces the nested folder tree.

function iconFor(status: ChangeEntryDTO["status"]): IconName {
  switch (status) {
    case "added":
    case "untracked":
      return "file-plus";
    case "deleted":
      return "x";
    case "renamed":
      return "branch";
    default:
      return "pencil"; // modified, conflicted
  }
}

function subFor(e: ChangeEntryDTO): string {
  switch (e.status) {
    case "added":
    case "untracked":
      return "New file";
    case "deleted":
      return "Deleted";
    case "renamed":
      return e.origPath ? `Renamed from ${baseName(e.origPath)}` : "Renamed";
    case "conflicted":
      return "Conflict";
    default:
      return "Edited";
  }
}

/** What the head's grow cell says, and whether it is a warning (mock:L1761). */
function headline(changes: ChangesDTO): { text: string; bad: boolean } {
  if (changes.midMerge) return { text: "Merging", bad: true };
  if (changes.midRebase) return { text: "Rebasing", bad: true };
  if (changes.detached) return { text: `Detached at ${changes.head ?? "HEAD"}`, bad: true };
  const n = changes.entries.length;
  if (n > 0) return { text: n === 1 ? "1 file" : `${n} files`, bad: false };
  if (changes.ahead > 0) return { text: `${changes.ahead} to push`, bad: false };
  return { text: "Up to date", bad: false };
}

export function ChangesRailHead() {
  const { changes, refresh, loading } = useChangesPane();
  if (!changes || !changes.isRepo) return <b className="grow">Changes</b>;
  const { text, bad } = headline(changes);
  return (
    <>
      <Icon name="branch" />
      <b>{changes.branch ?? "HEAD"}</b>
      <span className="grow" style={bad ? { color: "var(--bad)" } : undefined}>
        {text}
      </span>
      <button className="r-icon-btn" title="Refresh" aria-label="Refresh" onClick={refresh} disabled={loading}>
        <Icon name="retry" />
      </button>
    </>
  );
}

export function ChangesRail({ collapsed }: { collapsed: boolean }) {
  const { changes, loading, activePath, setActivePath } = useChangesPane();

  if (loading && !changes) return collapsed ? null : <Empty compact title="Loading changes…" />;
  if (!changes || !changes.isRepo) return collapsed ? null : <Empty compact title="Not a repository" />;
  if (changes.entries.length === 0) return collapsed ? null : <Empty compact title="No changed files" />;

  // Group in the order git listed them; a directory's files stay together under one label.
  const groups = new Map<string, ChangeEntryDTO[]>();
  for (const e of changes.entries) {
    const dir = dirName(e.path);
    const list = groups.get(dir);
    if (list) list.push(e);
    else groups.set(dir, [e]);
  }

  return (
    <>
      {[...groups].map(([dir, entries]) => (
        <div key={dir}>
          <div className="r-rdir" title={dir || "Project root"}>
            <span>{dir || "Project root"}</span>
          </div>
          {entries.map((e) => (
            <button
              key={e.path}
              className={`r-rrow${e.status === "conflicted" ? " bad" : ""}`}
              aria-current={e.path === activePath}
              title={e.status === "renamed" && e.origPath ? `${e.origPath} → ${e.path}` : e.path}
              onClick={() => setActivePath(e.path)}
            >
              <Icon name={iconFor(e.status)} />
              <span className="t">{baseName(e.path)}</span>
              <span className="end">{e.binary ? "binary" : <Delta added={e.added} removed={e.removed} />}</span>
              <span className="sub">{subFor(e)}</span>
            </button>
          ))}
        </div>
      ))}
    </>
  );
}
