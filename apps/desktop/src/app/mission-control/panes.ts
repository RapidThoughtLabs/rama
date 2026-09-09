import { useEffect, useState } from "react";
import type { FC, ReactNode, SVGProps } from "react";
import { IconChanges, IconFiles, IconTerminal, IconWeb } from "@rama/ui";
import type { ChangesDTO, SessionEvent } from "@rama/protocol";
import { fetchChanges } from "../../engine/client";
import { onProjectEvent } from "../../engine/ws";
import { useProjectsData } from "../data/ProjectsProvider";
import { ChangesPaneProvider } from "./panes/ChangesPaneContext";
import { ChangesRail, ChangesRailActions } from "./panes/ChangesRail";
import { ChangesStage } from "./panes/ChangesStage";
import { TerminalPaneProvider } from "./panes/TerminalPaneContext";
import { TerminalRail, TerminalRailActions } from "./panes/TerminalRail";
import { TerminalStage } from "./panes/TerminalStage";
import { WebPaneProvider } from "./panes/WebPaneContext";
import { WebRail, WebRailActions } from "./panes/WebRail";
import { WebStage } from "./panes/WebStage";
import { FilesPaneProvider } from "./panes/FilesPaneContext";
import { FilesRail, FilesRailActions } from "./panes/FilesRail";
import { FilesStage } from "./panes/FilesStage";

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
  /** The rail body (index). Called with `collapsed: true` for the 44px icon strip. */
  Rail: FC<{ collapsed: boolean }>;
  /** The stage (content) — owns its own toolbar, matching the rail header's 36px band (§4.1). */
  Stage: FC;
  /** Rendered right-aligned in the rail header, e.g. Terminal's `+` (§4.6). */
  RailActions?: FC;
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
    Rail: ChangesRail,
    Stage: ChangesStage,
    RailActions: ChangesRailActions,
    Provider: ChangesPaneProvider,
  },
  {
    id: "terminal",
    label: "terminal",
    Icon: IconTerminal,
    scope: "project",
    useBadge: useNullBadge,
    Rail: TerminalRail,
    Stage: TerminalStage,
    RailActions: TerminalRailActions,
    Provider: TerminalPaneProvider,
  },
  {
    id: "web",
    label: "web",
    Icon: IconWeb,
    scope: "project",
    useBadge: useNullBadge,
    Rail: WebRail,
    Stage: WebStage,
    RailActions: WebRailActions,
    Provider: WebPaneProvider,
  },
  {
    id: "files",
    label: "files",
    Icon: IconFiles,
    scope: "project",
    useBadge: useNullBadge,
    Rail: FilesRail,
    Stage: FilesStage,
    RailActions: FilesRailActions,
    Provider: FilesPaneProvider,
  },
];
