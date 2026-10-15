import { openPath } from "@tauri-apps/plugin-opener";
import { Icon } from "@rama/ui";
import { Delta, Empty, baseName, dirName } from "../../code/workspace/parts";
import { Diff } from "../../code/workspace/Diff";
import { useChangesPane } from "./ChangesPaneContext";

// docs/CODE_REDESIGN_PLAN.md CR4 (mock:L1760-1775) — the Changes stage bar and stage. The bar says
// which file, then its delta and two actions; the stage is the diff or one of the empty states.

export function ChangesStageBar() {
  const { changes, activePath, activeEntry, stagedView, setStagedView, projectPath } = useChangesPane();

  if (!changes || !changes.isRepo || changes.entries.length === 0 || !activeEntry || !activePath) {
    return (
      <div className="r-stage-title">
        <small>Working tree</small>
      </div>
    );
  }

  const both = activeEntry.staged && activeEntry.unstaged;
  const dir = dirName(activePath);

  function openExternally() {
    const full = projectPath ? `${projectPath}/${activePath}` : activePath!;
    void openPath(full).catch((err) => console.error("[rama] failed to open external file", err));
  }

  return (
    <>
      <div className="r-stage-title">
        <b>{baseName(activePath)}</b>
        {dir && <small>{dir}</small>}
      </div>
      <span className="grow" />
      {both && (
        <div className="r-mini-seg" role="group" aria-label="Which changes to show">
          <button aria-pressed={!stagedView} onClick={() => setStagedView(false)}>
            Unstaged
          </button>
          <button aria-pressed={stagedView} onClick={() => setStagedView(true)}>
            Staged
          </button>
        </div>
      )}
      <span className="delta-inline">
        {activeEntry.binary ? "binary" : <Delta added={activeEntry.added} removed={activeEntry.removed} />}
      </span>
      <button className="r-icon-btn" title="Copy path" aria-label="Copy path" onClick={() => void navigator.clipboard.writeText(activePath)}>
        <Icon name="copy" />
      </button>
      <button className="r-icon-btn" title="Open in your editor" aria-label="Open in your editor" onClick={openExternally}>
        <Icon name="pop" />
      </button>
    </>
  );
}

export function ChangesStage() {
  const { changes, loading, activePath, activeEntry, stagedView, diff, diffLoading, initRepo, initializingRepo, initRepoError } = useChangesPane();

  if (loading && !changes) return <Empty title="Loading changes…" />;

  if (!changes || !changes.isRepo) {
    return (
      <div className="r-empty">
        <div>
          <b>Not a git repository</b>
          This project has no .git folder.
          <div>
            <button className="r-btn r-btn-soft" disabled={initializingRepo} onClick={() => void initRepo()}>
              {initializingRepo ? "Initializing…" : "Initialize repository"}
            </button>
          </div>
          {initRepoError && <div className="err">{initRepoError}</div>}
        </div>
      </div>
    );
  }

  if (changes.entries.length === 0) {
    const branch = changes.branch ?? "HEAD";
    return (
      <Empty title="Nothing to commit">
        {changes.ahead > 0
          ? `${branch} is ${changes.ahead} commit${changes.ahead === 1 ? "" : "s"} ahead of origin. Push when you're ready.`
          : "The working tree is clean."}
      </Empty>
    );
  }

  if (!activeEntry || !activePath) return <Empty title="Pick a file">Choose one from the list to see what changed.</Empty>;
  if (diffLoading) return <Empty title="Loading diff…" />;
  if (diff?.binary || activeEntry.binary) return <Empty title="Binary file">There is no text diff to show.</Empty>;
  if (diff && diff.diff) return <Diff diff={diff.diff} path={activePath} />;
  return <Empty title={`No ${stagedView ? "staged" : "unstaged"} changes`}>This file has nothing in that view.</Empty>;
}
