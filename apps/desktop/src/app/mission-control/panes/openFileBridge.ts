// docs/WORKSPACE_PANES_PLAN.md Phase W7 — rama:open-file cross-pane link.
//
// FilesPaneProvider (which actually opens the file into a tab) is only mounted while the
// Files pane is the active Mission Control pane. A click from chat usually arrives while some
// other pane is active: AppShell's always-mounted listener switches the active pane in
// response to the same event, but that switch — and therefore FilesPaneProvider's mount — lands
// on a later render, after the CustomEvent has already fired and gone. Stashing the path here
// lets FilesPaneProvider pick it up once it mounts, instead of only reacting to events it was
// alive to see.
let pendingPath: string | null = null;

export function requestOpenFile(path: string) {
  pendingPath = path;
  window.dispatchEvent(new CustomEvent("rama:open-file", { detail: { path } }));
}

export function takePendingOpenFile(): string | null {
  const path = pendingPath;
  pendingPath = null;
  return path;
}
