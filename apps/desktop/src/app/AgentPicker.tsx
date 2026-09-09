import { useEffect, useRef, useState } from "react";
import type { AgentSummaryDTO, ChatDTO } from "@rama/protocol";
import { fetchAgents, patchChat } from "../engine/client";
import { useProjectsData } from "./data/ProjectsProvider";

// docs/PROMPT_STACK_PLAN.md §5.3/§12 open question C, Phase PS4 — "composer pill, or session
// start only?" — this ships as a composer pill (switching mid-session is legal, just invalidates
// bp2 onward, same as the mode SegmentedControl right next to it). Reuses ModelPicker's CSS
// classes rather than inventing new ones — it's the same "button opens a menu of named things"
// shape.
export function AgentPicker({ chat, disabled }: { chat: ChatDTO | undefined; disabled: boolean }) {
  const [agents, setAgents] = useState<AgentSummaryDTO[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { applyChatPatch } = useProjectsData();

  useEffect(() => {
    let cancelled = false;
    fetchAgents(chat?.projectId)
      .then((list) => {
        if (!cancelled) setAgents(list);
      })
      .catch((err) => console.error("[rama] failed to load agents", err));
    return () => {
      cancelled = true;
    };
  }, [chat?.projectId]);

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  function choose(name: string) {
    setMenuOpen(false);
    if (!chat || name === chat.agentId) return;
    patchChat(chat.id, { agentId: name })
      .then(applyChatPatch)
      .catch((err) => {
        console.error("[rama] failed to switch agent", err);
      });
  }

  const active = agents.find((a) => a.name === chat?.agentId);

  return (
    <div className="rama-model-picker" ref={rootRef}>
      <button type="button" className="rama-model-pill" disabled={!chat || disabled} onClick={() => setMenuOpen((v) => !v)}>
        <span>{active?.name ?? chat?.agentId ?? "default"}</span>
      </button>
      {menuOpen && (
        <div className="rama-model-menu">
          {agents.length === 0 && <div className="rama-model-menu-group-label">no agents found</div>}
          {agents.map((agent) => (
            <button
              type="button"
              key={agent.name}
              className={"rama-model-menu-item" + (chat?.agentId === agent.name ? " rama-model-menu-item-active" : "")}
              onClick={() => choose(agent.name)}
              title={agent.description}
            >
              <span>{agent.name}</span>
              <span className="rama-model-menu-item-badges">
                {agent.source !== "bundled" && <span className="rama-model-menu-badge">{agent.source}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
