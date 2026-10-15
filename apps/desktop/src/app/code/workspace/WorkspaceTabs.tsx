import { useEffect, useState } from "react";
import { Icon, type IconName } from "@rama/ui";
import { fetchProjectTerminals } from "../../../engine/client";
import { onProjectEvent } from "../../../engine/ws";
import { useProjectsData } from "../../data/ProjectsProvider";
import { MISSION_CONTROL_PANES, type MissionControlPaneId } from "../../mission-control/panes";

/* The workspace's tab row (mock:L522-531, 1754-1755): four tabs, 34px tall, the selected one on
   `--well`. Changes carries a count badge (tinted `--bad` when a file is conflicted — an addition,
   plan §9); Terminal carries a live dot while any shell is running. */

const TABS: { id: MissionControlPaneId; label: string; icon: IconName }[] = [
  { id: "changes", label: "Changes", icon: "changes" },
  { id: "terminal", label: "Terminal", icon: "term" },
  { id: "web", label: "Web", icon: "globe" },
  { id: "files", label: "Files", icon: "folder" },
];

/** True while any terminal in the active project is running. The pane's own provider only mounts
 *  while its pane is active, so the tab row keeps its own lightweight view of the list. */
function useTerminalLive(): boolean {
  const { activeProjectId } = useProjectsData();
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!activeProjectId) {
      setLive(false);
      return;
    }
    let cancelled = false;
    const running = new Set<string>();
    const publish = () => !cancelled && setLive(running.size > 0);
    fetchProjectTerminals(activeProjectId)
      .then((list) => {
        for (const t of list) if (t.status === "running") running.add(t.id);
        publish();
      })
      .catch(() => {});
    const off = onProjectEvent((projectId, event) => {
      if (projectId !== activeProjectId) return;
      if (event.type === "terminal.created") running.add(event.terminal.id);
      else if (event.type === "terminal.exited") running.delete(event.terminalId);
      else return;
      publish();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [activeProjectId]);

  return live;
}

export function WorkspaceTabs({ pane, onSelect }: { pane: MissionControlPaneId; onSelect: (id: MissionControlPaneId) => void }) {
  // The registry is a constant list, so calling each entry's badge hook in order is stable.
  const badges = Object.fromEntries(MISSION_CONTROL_PANES.map((p) => [p.id, p.useBadge()]));
  const terminalLive = useTerminalLive();

  return (
    <div className="r-ws-tabs" role="tablist" aria-label="Workspace">
      {TABS.map((t) => {
        const badge = badges[t.id];
        return (
          <button key={t.id} className="r-ws-tab" role="tab" aria-selected={pane === t.id} title={t.label} onClick={() => onSelect(t.id)}>
            <Icon name={t.icon} />
            <span className="lbl">{t.label}</span>
            {t.id === "changes" && badge && badge.count > 0 && <span className={badge.attention ? "badge bad" : "badge"}>{badge.count}</span>}
            {t.id === "terminal" && terminalLive && <span className="live" title="A process is running" />}
          </button>
        );
      })}
    </div>
  );
}
