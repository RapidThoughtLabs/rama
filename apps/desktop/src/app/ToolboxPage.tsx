import { useEffect, useState } from "react";
import { Button, IconToolbox, Input, useToast } from "@rama/ui";
import type { SkillDTO } from "@rama/protocol";
import { fetchSkills, installSkill, uninstallSkill } from "../engine/client";
import { McpServersModal } from "./McpServersModal";

// docs/REDESIGN_PLAN.md Phase R6 — Skills + MCP servers as one Toolbox page, replacing the old
// SkillsModal popover (deleted) plus the McpServersModal mount that used to live directly in
// Sidebar.tsx (that one's still shared — SettingsModal's "mcp servers" pane renders the same bare
// component). Full-bleed page reusing SettingsModal's nav/content two-pane classes rather than
// inventing new ones.

type Section = "skills" | "mcp";

function SkillsSection() {
  const [skills, setSkills] = useState<SkillDTO[]>([]);
  const [source, setSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const { push } = useToast();

  function reload() {
    fetchSkills()
      .then(setSkills)
      .catch(() => {});
  }

  useEffect(reload, []);

  async function handleInstall() {
    const src = source.trim();
    if (!src) return;
    setInstalling(true);
    try {
      await installSkill(src);
      setSource("");
      reload();
      push("skill installed", "good");
    } catch (err) {
      push(err instanceof Error ? err.message : String(err), "bad");
    } finally {
      setInstalling(false);
    }
  }

  async function handleUninstall(name: string) {
    try {
      await uninstallSkill(name);
      reload();
    } catch (err) {
      push(err instanceof Error ? err.message : String(err), "bad");
    }
  }

  return (
    <div className="rama-provider-settings">
      <div className="rama-provider-settings-input-row">
        <Input placeholder="git URL or local directory path…" value={source} onChange={(e) => setSource(e.target.value)} />
        <Button size="sm" onClick={handleInstall} disabled={!source.trim() || installing}>
          {installing ? "installing…" : "install"}
        </Button>
      </div>

      {skills.length === 0 && <div className="rama-provider-settings-hint">no skills installed yet.</div>}

      {skills.map((s) => (
        <div key={s.id} className="rama-provider-settings-row">
          <div className="rama-provider-settings-head">
            <span className="rama-statusbar-dot" style={{ background: "var(--good)" }} />
            <span className="rama-provider-settings-label">{s.name}</span>
            <span style={{ flex: 1 }} />
            <Button size="sm" variant="ghost" onClick={() => handleUninstall(s.name)}>
              remove
            </Button>
          </div>
          {s.description && <div className="rama-provider-settings-hint">{s.description}</div>}
        </div>
      ))}
    </div>
  );
}

export function ToolboxPage() {
  const [section, setSection] = useState<Section>("skills");

  return (
    <div className="rama-page">
      <div className="rama-page-header">
        <IconToolbox />
        <span>toolbox</span>
      </div>
      <div className="rama-settings rama-settings-page">
        <div className="rama-settings-nav">
          <button
            className={`rama-settings-nav-item ${section === "skills" ? "rama-settings-nav-item-active" : ""}`}
            onClick={() => setSection("skills")}
          >
            skills
          </button>
          <button
            className={`rama-settings-nav-item ${section === "mcp" ? "rama-settings-nav-item-active" : ""}`}
            onClick={() => setSection("mcp")}
          >
            mcp servers
          </button>
        </div>
        <div className="rama-settings-content">{section === "skills" ? <SkillsSection /> : <McpServersModal />}</div>
      </div>
    </div>
  );
}
