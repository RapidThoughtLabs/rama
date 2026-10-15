import { useEffect, useState } from "react";
import type { FC, ReactNode, SVGProps } from "react";
import { IconChanges, IconFiles, IconTerminal, IconWeb } from "@rama/ui";
import type { ChangesDTO, SessionEvent } from "@rama/protocol";
import { fetchChanges } from "../../engine/client";
import { onProjectEvent } from "../../engine/ws";
import { useProjectsData } from "../data/ProjectsProvider";
import { ChangesPaneProvider } from "./panes/ChangesPaneContext";
import { ChangesRail, ChangesRailHead } from "./panes/ChangesRail";
import { ChangesStage, ChangesStageBar } from "./panes/ChangesStage";
import { TerminalPaneProvider } from "./panes/TerminalPaneContext";
import { TerminalRail, TerminalRailHead } from "./panes/TerminalRail";
import { TerminalStage, TerminalStageBar } from "./panes/TerminalStage";
import { WebPaneProvider } from "./panes/WebPaneContext";
import { WebRail, WebRailHead } from "./panes/WebRail";
import { WebStage, WebStageBar } from "./panes/WebStage";
import { FilesPaneProvider } from "./panes/FilesPaneContext";
import { FilesRail, FilesRailHead } from "./panes/FilesRail";
import { FilesStage, FilesStageBar } from "./panes/FilesStage";

// docs/WORKSPACE_PANES_PLAN.md §3 — 4 panes: Changes · Terminal · Web · Files.
export type MissionControlPaneId = "changes" | "terminal" | "web" | "files";

export interface MissionControlBadge {
  count: number;
  attention: boolean;
}

export interface MissionControlPane {
  id: MissionControlPaneId;
  label: string;
  Icon: FC<SVGProps<SVGSVGElement>>;
  /** What the pane's contents belong to — drives what a chat switch clears (§3.3). */
  scope: "chat" | "project";
  useBadge: () => MissionControlBadge | null;
  /** The rail head's own content (icon, title, actions); the workspace appends the collapse toggle.
   *  CR4: one cell of the 42px band row (mock:L1761-1798). */
  RailHead: FC;
  /** The rail body (index). Called with `collapsed: true` for the 48px icon column. */
  Rail: FC<{ collapsed: boolean }>;
  /** The stage bar's content — the other cell of the band row, left of the rail head. */
  StageBar: FC;
  /** The stage (content) under the bar. */
  Stage: FC;
  /** Wraps Rail + Stage while this pane is active, for pane-local shared state. */
  Provider?: FC<{ children: ReactNode }>;
  disabled?: boolean;
}

function useChangesBadge(): MissionControlBadge | null {
  const { activeProjectId } = useProjectsData();
  const [badge, setBadge] = useState<MissionControlBadge | null>(null);

  useEffect(() => {
    if (!activeProjectId) {
      setBadge(null);
      return;
    }
    let cancelled = false;
    function update() {
      fetchChanges(activeProjectId!)
        .then((changes: ChangesDTO) => {
          if (cancelled) return;
          if (!changes.isRepo || changes.entries.length === 0) {
            setBadge(null);
            return;
          }
          const hasConflict = changes.entries.some((e) => e.status === "conflicted");
          setBadge({ count: changes.entries.length, attention: hasConflict });
        })
        .catch(() => {
          if (!cancelled) setBadge(null);
        });
    }

    update();

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const unsub = onProjectEvent((projectId: string, event: SessionEvent) => {
      if (projectId !== activeProjectId) return;
      if (event.type === "changes.invalidated") {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(update, 250);
      }
    });

    const onFocus = () => update();
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      unsub();
      window.removeEventListener("focus", onFocus);
    };
  }, [activeProjectId]);

  return badge;
}

function useNullBadge(): MissionControlBadge | null {
  return null;
}

export const MISSION_CONTROL_PANES: MissionControlPane[] = [
  {
    id: "changes",
    label: "changes",
    Icon: IconChanges,
    scope: "project",
    useBadge: useChangesBadge,
    RailHead: ChangesRailHead,
    Rail: ChangesRail,
    StageBar: ChangesStageBar,
    Stage: ChangesStage,
    Provider: ChangesPaneProvider,
  },
  {
    id: "terminal",
    label: "terminal",
    Icon: IconTerminal,
    scope: "project",
    useBadge: useNullBadge,
    RailHead: TerminalRailHead,
    Rail: TerminalRail,
    StageBar: TerminalStageBar,
    Stage: TerminalStage,
    Provider: TerminalPaneProvider,
  },
  {
    id: "web",
    label: "web",
    Icon: IconWeb,
    scope: "project",
    useBadge: useNullBadge,
    RailHead: WebRailHead,
    Rail: WebRail,
    StageBar: WebStageBar,
    Stage: WebStage,
    Provider: WebPaneProvider,
  },
  {
    id: "files",
    label: "files",
    Icon: IconFiles,
    scope: "project",
    useBadge: useNullBadge,
    RailHead: FilesRailHead,
    Rail: FilesRail,
    StageBar: FilesStageBar,
    Stage: FilesStage,
    Provider: FilesPaneProvider,
  },
];
