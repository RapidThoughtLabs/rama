import type { FC, ReactNode, SVGProps } from "react";
import { IconArtifacts, IconTerminal, IconWeb } from "@rama/ui";
import { useSessionData } from "../data/SessionProvider";
import { ArtifactsPaneProvider } from "./panes/ArtifactsPaneContext";
import { ArtifactsRail } from "./panes/ArtifactsRail";
import { ArtifactsStage } from "./panes/ArtifactsStage";
import { TerminalPaneProvider } from "./panes/TerminalPaneContext";
import { TerminalRail, TerminalRailActions } from "./panes/TerminalRail";
import { TerminalStage } from "./panes/TerminalStage";
import { WebPaneProvider } from "./panes/WebPaneContext";
import { WebRail, WebRailActions } from "./panes/WebRail";
import { WebStage } from "./panes/WebStage";

// docs/MISSION_CONTROL_PLAN.md §3.2 — a registry, not three hardcoded branches, so a fourth pane
// (Preview, Git, Todos, heku) is an addition to this array, not a rewrite of MissionControl.tsx.
export type MissionControlPaneId = "artifacts" | "terminal" | "web";

export interface MissionControlBadge {
  count: number;
  attention: boolean;
}

export interface MissionControlPane {
  id: MissionControlPaneId;
  label: string;
  Icon: FC<SVGProps<SVGSVGElement>>;
  /** What the pane's contents belong to — drives what a chat switch clears (§3.3). Not yet
   *  enforced anywhere; recorded here so M2+ can key terminals/pages by project, not chat. */
  scope: "chat" | "project";
  useBadge: () => MissionControlBadge | null;
  /** The rail body (index). Called with `collapsed: true` for the 44px wide-mode icon strip and
   *  the narrow-mode overlay sheet's full-width variant. */
  Rail: FC<{ collapsed: boolean }>;
  /** The stage (content) — owns its own toolbar, matching the rail header's 36px band (§4.1). */
  Stage: FC;
  /** Rendered right-aligned in the rail header, e.g. Terminal's `+` (§4.6). */
  RailActions?: FC;
  /** Wraps Rail + Stage while this pane is active, for pane-local shared state (e.g. Artifacts'
   *  selected row) — not in the original plan snippet, added because Rail and Stage are declared
   *  as two independent components that still need to agree on "which row is active". */
  Provider?: FC<{ children: ReactNode }>;
  /** M1 ships Terminal/Web visible but inert — the tab bar's alignment gets settled once. */
  disabled?: boolean;
}

function useArtifactsBadge(): MissionControlBadge | null {
  const { artifacts } = useSessionData();
  if (artifacts.length === 0) return null;
  return { count: artifacts.length, attention: false };
}

function useNullBadge(): MissionControlBadge | null {
  return null;
}

export const MISSION_CONTROL_PANES: MissionControlPane[] = [
  {
    id: "artifacts",
    label: "artifacts",
    Icon: IconArtifacts,
    scope: "chat",
    useBadge: useArtifactsBadge,
    Rail: ArtifactsRail,
    Stage: ArtifactsStage,
    Provider: ArtifactsPaneProvider,
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
];
