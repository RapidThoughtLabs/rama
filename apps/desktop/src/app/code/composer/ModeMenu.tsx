import { useEffect, useRef, useState } from "react";
import type { AgentSummaryDTO, ChatMode } from "@rama/protocol";
import { Icon, Popover, type IconName } from "@rama/ui";
import { fetchAgents } from "../../../engine/client";

/* The mode pill and its menu — docs/CODE_REDESIGN_PLAN.md CR5 (mock:L1544-1559, 2014-2021). It sits
   where Home's web-search toggle does and replaces the old mode tile and agent picker: a "Mode"
   section (Agent, Plan, Ask) and an "Agent" section ("Default" first, then whatever
   `fetchAgents` finds for the project). */

export const MODES: Record<ChatMode, { label: string; icon: IconName; desc: string }> = {
  agent: { label: "Agent", icon: "agent", desc: "Reads, edits and runs commands" },
  plan: { label: "Plan", icon: "list", desc: "Proposes a plan, changes nothing" },
  ask: { label: "Ask", icon: "ask", desc: "Answers questions about the code" },
};

const DEFAULT_AGENT = { name: "default", description: "Uses this project's RAMA.md and tools" };

export function ModePill({
  mode,
  onMode,
  projectId,
  agentId,
  onAgent,
  disabled,
}: {
  mode: ChatMode;
  onMode: (mode: ChatMode) => void;
  projectId: string | undefined;
  agentId: string | undefined;
  onAgent: (agentId: string) => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentSummaryDTO[]>([]);
  const current = MODES[mode];

  useEffect(() => {
    let cancelled = false;
    fetchAgents(projectId)
      .then((list) => {
        if (!cancelled) setAgents(list);
      })
      .catch((err) => console.error("[rama] failed to load agents", err));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // "Default" is always first and always reads the same; every other agent speaks for itself.
  const agentRows = [DEFAULT_AGENT, ...agents.filter((a) => a.name !== "default").map((a) => ({ name: a.name, description: a.description }))];
  const selectedAgent = agentId ?? "default";

  return (
    <>
      <button
        ref={ref}
        type="button"
        className="r-model-pill r-mode-pill"
        aria-haspopup="menu"
        aria-expanded={open}
        title={current.desc}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={current.icon} />
        <span>{current.label}</span>
        <Icon name="down" className="chev" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement="above" className="r-model-pop" role="menu" aria-label="Mode">
        <div className="r-mp-label">Mode</div>
        {(Object.keys(MODES) as ChatMode[]).map((id) => (
          <button
            key={id}
            type="button"
            className="r-mp-item"
            role="menuitemradio"
            aria-checked={id === mode}
            onClick={() => {
              setOpen(false);
              if (id !== mode) onMode(id);
            }}
          >
            <Icon name={MODES[id].icon} />
            <span>
              <b>{MODES[id].label}</b>
              <small>{MODES[id].desc}</small>
            </span>
            <Icon name="check" className="tick" />
          </button>
        ))}
        <div className="r-mp-label">Agent</div>
        {agentRows.map((a) => (
          <button
            key={a.name}
            type="button"
            className="r-mp-item"
            role="menuitemradio"
            aria-checked={a.name === selectedAgent}
            onClick={() => {
              setOpen(false);
              if (a.name !== selectedAgent) onAgent(a.name);
            }}
          >
            <Icon name="agent" />
            <span>
              <b>{a.name === "default" ? "Default" : a.name}</b>
              <small>{a.description}</small>
            </span>
            <Icon name="check" className="tick" />
          </button>
        ))}
      </Popover>
    </>
  );
}
