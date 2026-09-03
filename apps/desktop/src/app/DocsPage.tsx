import { useEffect, useState } from "react";
import { Button, IconDocs, Input, useToast } from "@rama/ui";
import type { DocDTO } from "@rama/protocol";
import { createDoc, deleteDoc, fetchDocContent, fetchDocs, saveDoc } from "../engine/client";
import { useProjectsData } from "./data/ProjectsProvider";

// docs/REDESIGN_PLAN.md Phase R6 — Docs as a full page, replacing the old DocsModal popover
// (deleted). Kept project-scoped, same as today — Q2 resolved that way since docs already live
// under a project's own directory (engine/src/docs) and this phase is a content move (modal →
// page), not a data-model change. Global docs would need real aggregation-across-projects backend
// work that's out of scope here.
export function DocsPage() {
  const { activeProjectId, projects } = useProjectsData();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const [docs, setDocs] = useState<DocDTO[]>([]);
  const [selected, setSelected] = useState<string | null>(null); // doc name, or "__new__"
  const [draftName, setDraftName] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [saving, setSaving] = useState(false);
  const { push } = useToast();

  function reload() {
    if (!activeProjectId) return;
    fetchDocs(activeProjectId)
      .then(setDocs)
      .catch(() => {});
  }

  useEffect(() => {
    setSelected(null);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  function startNew() {
    setSelected("__new__");
    setDraftName("");
    setDraftContent("");
  }

  function openDoc(name: string) {
    if (!activeProjectId) return;
    setSelected(name);
    setDraftName(name.replace(/\.md$/, ""));
    setDraftContent("");
    fetchDocContent(activeProjectId, name)
      .then((d) => setDraftContent(d.content))
      .catch(() => {});
  }

  async function handleSave() {
    if (!activeProjectId || !draftName.trim()) return;
    setSaving(true);
    try {
      if (selected === "__new__") {
        await createDoc(activeProjectId, draftName.trim(), draftContent);
      } else if (selected) {
        await saveDoc(activeProjectId, selected, draftContent);
      }
      setSelected(null);
      reload();
    } catch (err) {
      push(err instanceof Error ? err.message : String(err), "bad");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(name: string) {
    if (!activeProjectId) return;
    try {
      await deleteDoc(activeProjectId, name);
      if (selected === name) setSelected(null);
      reload();
    } catch (err) {
      push(err instanceof Error ? err.message : String(err), "bad");
    }
  }

  return (
    <div className="rama-page">
      <div className="rama-page-header">
        <IconDocs />
        <span>docs</span>
        {activeProject && <span className="rama-page-header-sub">{activeProject.name}</span>}
      </div>
      <div className="rama-page-content">
        {!activeProjectId && <div className="rama-provider-settings-hint">select a project in the sidebar first.</div>}

        {activeProjectId && selected === null && (
          <div className="rama-provider-settings" style={{ maxWidth: 640 }}>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Button size="sm" onClick={startNew}>
                + new doc
              </Button>
            </div>
            {docs.length === 0 && <div className="rama-provider-settings-hint">no docs yet for this project.</div>}
            {docs.map((d) => (
              <div key={d.name} className="rama-provider-settings-row">
                <div className="rama-provider-settings-head" style={{ cursor: "pointer" }} onClick={() => openDoc(d.name)}>
                  <IconDocs style={{ color: "var(--accent)" }} />
                  <span className="rama-provider-settings-label">{d.name}</span>
                  <span style={{ flex: 1 }} />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(d.name);
                    }}
                  >
                    remove
                  </Button>
                </div>
                {d.subtitle && <div className="rama-provider-settings-hint">{d.subtitle}</div>}
              </div>
            ))}
          </div>
        )}

        {activeProjectId && selected !== null && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 720 }}>
            <Input
              placeholder="doc name"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              disabled={selected !== "__new__"}
              autoFocus
            />
            <textarea
              className="rama-doc-editor"
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              rows={20}
              placeholder="# doc content…"
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving || !draftName.trim()}>
                {saving ? "saving…" : "save"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
