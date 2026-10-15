import { useRef, useState } from "react";
import type { ProjectDTO } from "@rama/protocol";
import { Icon, Popover } from "@rama/ui";
import { baseName, tildePath } from "../workspace/parts";
import type { ComposerContext } from "./useComposerContext";

/* The chip row above the Code composer — docs/CODE_REDESIGN_PLAN.md CR5 (mock:L398, 1551-1556).
   Project, branch, separate worktree, then one chip per extra folder (not in the mockup, plan §9)
   and "Add folder". The project chip opens a menu; on a draft, picking a project re-targets the
   draft, and on an existing chat the chat stays where it is and the menu offers a new chat in
   another project instead. */

export function ContextChips({
  project,
  projects,
  locked,
  context,
  onSwitchProject,
  onNewChatIn,
  onAddProject,
}: {
  project: ProjectDTO | undefined;
  projects: ProjectDTO[];
  /** An existing chat: its project can't change. */
  locked: boolean;
  context: ComposerContext;
  onSwitchProject: (projectId: string) => void;
  onNewChatIn: (projectId: string) => void;
  onAddProject: () => void;
}) {
  const projectRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [path, setPath] = useState("");
  const { branch, worktreeOn, extraFolders } = context;

  function submitFolder() {
    context.addFolder(path);
    setPath("");
    setAddOpen(false);
  }

  return (
    <div className="r-ctx-row">
      <button
        ref={projectRef}
        type="button"
        className="r-chip"
        title="Project"
        aria-haspopup="menu"
        aria-expanded={projectOpen}
        onClick={() => setProjectOpen((v) => !v)}
      >
        <Icon name="folder" />
        {project?.name ?? "Choose a project"}
        <Icon name="down" />
      </button>
      {branch && (
        <span className="r-chip" title="Branch">
          <Icon name="branch" />
          {branch}
        </span>
      )}
      {project && (
        <button
          type="button"
          className="r-chip"
          aria-pressed={worktreeOn}
          title="Work in a separate git worktree, so this chat's edits never touch your main checkout"
          onClick={() => context.toggleWorktree(!worktreeOn)}
        >
          <Icon name={worktreeOn ? "check" : "copy"} />
          Separate worktree
        </button>
      )}
      {extraFolders.map((folder) => (
        <span key={folder} className="r-chip r-chip-folder" title={folder}>
          <Icon name="folder" />
          {baseName(folder) || folder}
          <button type="button" className="x" aria-label={`Remove ${folder}`} onClick={() => context.removeFolder(folder)}>
            <Icon name="x" />
          </button>
        </span>
      ))}
      {project && (
        <button
          ref={addRef}
          type="button"
          className="r-chip"
          aria-haspopup="dialog"
          aria-expanded={addOpen}
          title="Add a read-only folder as context"
          onClick={() => setAddOpen((v) => !v)}
        >
          <Icon name="plus" />
          Add folder
        </button>
      )}

      <Popover open={projectOpen} onClose={() => setProjectOpen(false)} anchor={projectRef} placement="below" className="r-model-pop" role="menu" aria-label="Project">
        {locked && <div className="r-mp-note">This chat stays in {project?.name ?? "its project"}.</div>}
        <div className="r-mp-label">{locked ? "New chat in" : "Project"}</div>
        {projects.map((p) => {
          const current = p.id === project?.id;
          return (
            <button
              key={p.id}
              type="button"
              className="r-mp-item"
              role={locked ? "menuitem" : "menuitemradio"}
              aria-checked={locked ? undefined : current}
              onClick={() => {
                setProjectOpen(false);
                if (locked) onNewChatIn(p.id);
                else if (!current) onSwitchProject(p.id);
              }}
            >
              <Icon name="folder" />
              <span>
                <b>{p.name}</b>
                <small>{tildePath(p.path)}</small>
              </span>
              {!locked && <Icon name="check" className="tick" />}
            </button>
          );
        })}
        <div className="r-mp-sep" />
        <button
          type="button"
          className="r-mp-item r-mp-plain"
          role="menuitem"
          onClick={() => {
            setProjectOpen(false);
            onAddProject();
          }}
        >
          <Icon name="plus" />
          <span>
            <b>Add a project…</b>
          </span>
        </button>
      </Popover>

      <Popover open={addOpen} onClose={() => setAddOpen(false)} anchor={addRef} placement="below" className="r-add-pop" role="dialog" aria-label="Add a folder">
        <label className="r-add-pop-label" htmlFor="r-add-folder">
          Folder path
        </label>
        <input
          id="r-add-folder"
          autoFocus
          className="r-add-pop-input"
          placeholder="/path/to/folder"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitFolder();
            }
          }}
        />
        <small>The agent can read it, never change it. Press Enter to add.</small>
      </Popover>
    </div>
  );
}
