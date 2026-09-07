import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ArtifactDTO } from "@rama/protocol";
import { fetchArtifactContent } from "../../../engine/client";
import { useSessionData } from "../../data/SessionProvider";

// Split out of the old ArtifactsPanel.tsx (docs/MISSION_CONTROL_PLAN.md M1) — the selected-row +
// fetched-content state that used to live in one component now has to be shared between
// ArtifactsRail (the list) and ArtifactsStage (the preview), which the pane registry declares as
// two independent components. This is that shared state, unchanged in behavior from the original.

interface ArtifactsPaneValue {
  artifacts: ArtifactDTO[];
  active: ArtifactDTO | null;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  content: string;
}

const ArtifactsPaneContext = createContext<ArtifactsPaneValue | null>(null);

export function ArtifactsPaneProvider({ children }: { children: ReactNode }) {
  const { artifacts, artifactBuffers } = useSessionData();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [content, setContent] = useState("");

  useEffect(() => {
    if (artifacts.length === 0) {
      setActiveId(null);
    } else if (!activeId || !artifacts.some((a) => a.id === activeId)) {
      setActiveId(artifacts[0].id);
    }
  }, [artifacts, activeId]);

  const active = artifacts.find((a) => a.id === activeId) ?? null;

  useEffect(() => {
    if (!active) {
      setContent("");
      return;
    }
    if (active.status === "streaming") {
      setContent(artifactBuffers[active.id] ?? "");
      return;
    }
    let cancelled = false;
    fetchArtifactContent(active.id)
      .then((res) => {
        if (!cancelled) setContent(res.content);
      })
      .catch((err) => {
        console.error("[rama] failed to fetch artifact content", err);
      });
    return () => {
      cancelled = true;
    };
  }, [active, artifactBuffers]);

  return (
    <ArtifactsPaneContext.Provider value={{ artifacts, active, activeId, setActiveId, content }}>
      {children}
    </ArtifactsPaneContext.Provider>
  );
}

export function useArtifactsPane(): ArtifactsPaneValue {
  const ctx = useContext(ArtifactsPaneContext);
  if (!ctx) throw new Error("useArtifactsPane must be used within an ArtifactsPaneProvider");
  return ctx;
}
