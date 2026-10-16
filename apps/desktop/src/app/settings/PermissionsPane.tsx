import { useEffect, useState } from "react";
import { useToast } from "@rama/ui";
import type { PermissionRule, PermissionSettings, PermissionTool } from "@rama/protocol";
import { fetchGlobalPermissions, fetchProjectPermissions, saveGlobalPermissions, saveProjectPermissions } from "../../engine/client";
import { useProjectsData } from "../data/ProjectsProvider";
import { Card, MiniSeg, PaneHead, Row, Section, errorText } from "./parts";

/* Global rules plus a per-project override (docs/REDESIGN_PLAN.md R4, Q4). The engine resolves
   project › global › "ask" per tool bucket (engine/src/agent/permissions.ts). */

const TOOLS: { id: PermissionTool; label: string; hint: string }[] = [
  { id: "bash", label: "Run commands", hint: "Shell commands, including stopping background ones." },
  { id: "write", label: "Create files", hint: "New files in the project." },
  { id: "edit", label: "Edit files", hint: "Changes to files that already exist." },
  { id: "web", label: "Use the web", hint: "Fetch pages and open them in the browser." },
];
const RULES: { id: PermissionRule; label: string }[] = [
  { id: "allow", label: "Allow" },
  { id: "ask", label: "Ask" },
  { id: "deny", label: "Deny" },
];
type ProjectChoice = "inherit" | PermissionRule;
const PROJECT_RULES: { id: ProjectChoice; label: string }[] = [{ id: "inherit", label: "Default" }, ...RULES];

export function PermissionsPane() {
  const { activeProjectId, projects } = useProjectsData();
  const project = projects.find((p) => p.id === activeProjectId);
  const [global, setGlobal] = useState<PermissionSettings | null>(null);
  const [override, setOverride] = useState<PermissionSettings | null>(null);
  const { push } = useToast();

  useEffect(() => {
    fetchGlobalPermissions()
      .then(setGlobal)
      .catch((err) => console.error("[rama] failed to load global permissions", err));
  }, []);

  useEffect(() => {
    if (!activeProjectId) return setOverride(null);
    fetchProjectPermissions(activeProjectId)
      .then(setOverride)
      .catch((err) => console.error("[rama] failed to load project permissions", err));
  }, [activeProjectId]);

  async function setGlobalRule(tool: PermissionTool, rule: PermissionRule) {
    setGlobal((prev) => (prev ? { ...prev, [tool]: rule } : prev));
    try {
      await saveGlobalPermissions({ [tool]: rule });
    } catch (err) {
      push(errorText(err), "bad");
    }
  }

  async function setProjectRule(tool: PermissionTool, choice: ProjectChoice) {
    if (!activeProjectId) return;
    const rule = choice === "inherit" ? null : choice;
    setOverride((prev) => {
      const next = { ...(prev ?? {}) };
      if (rule === null) delete next[tool];
      else next[tool] = rule;
      return next;
    });
    try {
      await saveProjectPermissions(activeProjectId, { [tool]: rule });
    } catch (err) {
      push(errorText(err), "bad");
    }
  }

  return (
    <>
      <PaneHead title="Permissions" sub="What the agent may do without asking you first. Whatever you pick, Plan mode never changes anything and Ask mode always checks with you." />
      <div className="r-set-body">
        <Section title="Every project">
          <Card>
            {TOOLS.map((t) => (
              <Row key={t.id} title={t.label} hint={t.hint}>
                <MiniSeg label={t.label} options={RULES} value={global?.[t.id] ?? "ask"} onChange={(rule) => setGlobalRule(t.id, rule)} />
              </Row>
            ))}
          </Card>
        </Section>

        {project && (
          <Section title={`Only in ${project.name}`} note="Default follows the rule above.">
            <Card>
              {TOOLS.map((t) => (
                <Row key={t.id} title={t.label}>
                  <MiniSeg label={`${t.label} in ${project.name}`} options={PROJECT_RULES} value={override?.[t.id] ?? "inherit"} onChange={(c) => setProjectRule(t.id, c)} />
                </Row>
              ))}
            </Card>
          </Section>
        )}
      </div>
    </>
  );
}
