import { openPath } from "@tauri-apps/plugin-opener";
import { DiffView } from "../../diff/DiffView";
import { useChangesPane } from "./ChangesPaneContext";

// docs/WORKSPACE_PANES_PLAN.md Phase W4 — Changes stage: toolbar + DiffView + staged/unstaged switch.

export function ChangesStage() {
  const {
    changes,
    loading,
    activePath,
    activeEntry,
    stagedView,
    setStagedView,
    diff,
    diffLoading,
    projectPath,
    initRepo,
    initializingRepo,
    initRepoError,
  } = useChangesPane();

  if (loading && !changes) {
    return <div className="rama-mc-coming-soon">loading changes…</div>;
  }

  if (!changes || !changes.isRepo) {
    return (
      <div className="rama-mc-coming-soon" style={{ flexDirection: "column", gap: 10 }}>
        <span>not a git repository — this project directory has no .git</span>
        <button
          type="button"
          className="rama-mc-rail-action-btn"
          style={{ width: "auto", padding: "4px 12px", border: "1px solid rgba(var(--ink), 0.1)" }}
          disabled={initializingRepo}
          onClick={() => void initRepo()}
        >
          {initializingRepo ? "initializing…" : "initialize repository"}
        </button>
        {initRepoError && <span style={{ color: "var(--bad)", fontSize: "var(--fs-sm)" }}>{initRepoError}</span>}
      </div>
    );
  }

  if (changes.entries.length === 0) {
    return <div className="rama-mc-coming-soon">working tree clean.</div>;
  }

  if (!activeEntry || !activePath) {
    return <div className="rama-mc-coming-soon">select a file to view diff.</div>;
  }

  const hasBothStagedAndUnstaged = activeEntry.staged && activeEntry.unstaged;

  function copyPath() {
    if (activePath) void navigator.clipboard.writeText(activePath);
  }

  function openExternally() {
    if (!activePath) return;
    const full = projectPath ? `${projectPath}/${activePath}` : activePath;
    void openPath(full).catch((err) => console.error("[rama] failed to open external file", err));
  }

  return (
    <>
      <div className="rama-changes-stage-toolbar">
        <span className="rama-changes-stage-path" title={activePath}>
          {activePath}
        </span>
        <span className={`rama-changes-status-pill rama-changes-status-${activeEntry.status}`}>
          {activeEntry.status}
        </span>
        {hasBothStagedAndUnstaged && (
          <div className="rama-changes-segment-switch">
            <button
              type="button"
              className={`rama-changes-segment-btn${!stagedView ? " active" : ""}`}
              onClick={() => setStagedView(false)}
            >
              unstaged
            </button>
            <button
              type="button"
              className={`rama-changes-segment-btn${stagedView ? " active" : ""}`}
              onClick={() => setStagedView(true)}
            >
              staged
            </button>
          </div>
        )}
        <span style={{ flex: 1 }} />
        {activeEntry.binary ? (
          <span className="rama-changes-binary-tag">binary</span>
        ) : (
          (activeEntry.added !== null || activeEntry.removed !== null) && (
            <span style={{ fontSize: "var(--fs-sm)", display: "flex", gap: 5 }}>
              {activeEntry.added !== null && <span style={{ color: "var(--good)" }}>+{activeEntry.added}</span>}
              {activeEntry.removed !== null && <span style={{ color: "var(--bad)" }}>−{activeEntry.removed}</span>}
            </span>
          )
        )}
        <button
          type="button"
          className="rama-changes-action-btn"
          title="Copy path"
          onClick={copyPath}
        >
          ⧉
        </button>
        <button
          type="button"
          className="rama-changes-action-btn"
          title="Open in external editor"
          onClick={openExternally}
        >
          ↗
        </button>
      </div>

      <div className="rama-changes-stage-body">
        {diffLoading ? (
          <div className="rama-mc-coming-soon">loading diff…</div>
        ) : diff?.binary || activeEntry.binary ? (
          <div className="rama-mc-coming-soon">binary file — diff not available.</div>
        ) : diff && diff.diff ? (
          <DiffView diff={diff.diff} />
        ) : (
          <div className="rama-mc-coming-soon">no changes in {stagedView ? "staged" : "unstaged"}.</div>
        )}
      </div>
    </>
  );
}
