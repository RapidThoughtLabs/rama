import { useEffect, useState } from "react";
import { Button, IconDocs, Input, useToast } from "@rama/ui";
import type { CurationProposalDTO, DocDTO, InstructionsDTO } from "@rama/protocol";
import {
  createDoc,
  deleteDoc,
  fetchCurationProposals,
  fetchDocContent,
  fetchDocs,
  fetchProjectInstructions,
  resolveCurationProposal,
  runCuratorNow,
  saveDoc,
  saveProjectInstructions,
} from "../engine/client";
import { useProjectsData } from "./data/ProjectsProvider";

// docs/REDESIGN_PLAN.md Phase R6 — Docs as a full page, replacing the old DocsModal popover
// (deleted). Kept project-scoped, same as today — Q2 resolved that way since docs already live
// under a project's own directory (engine/src/docs) and this phase is a content move (modal →
// page), not a data-model change. Global docs would need real aggregation-across-projects backend
// work that's out of scope here.
//
// docs/PROMPT_STACK_PLAN.md §7, Phase PS7 — the "knowledge" section added below is RAMA.md itself
// plus the curator's accept/reject queue on top of it. Folded into this existing project-scoped
// page (a second section, same as ToolboxPage's skills/mcp split) rather than a new top-level nav
// entry — RAMA.md never had its own desktop surface before PS7, and inventing a whole new route
// for it would be more surface area than the feature itself needs.
type Section = "docs" | "knowledge";

function ProjectDocsSection({ projectId }: { projectId: string }) {
  const [docs, setDocs] = useState<DocDTO[]>([]);
  const [selected, setSelected] = useState<string | null>(null); // doc name, or "__new__"
  const [draftName, setDraftName] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [saving, setSaving] = useState(false);
  const { push } = useToast();

  function reload() {
    fetchDocs(projectId)
      .then(setDocs)
      .catch(() => {});
  }

  useEffect(() => {
    setSelected(null);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  function startNew() {
    setSelected("__new__");
    setDraftName("");
    setDraftContent("");
  }

  function openDoc(name: string) {
    setSelected(name);
    setDraftName(name.replace(/\.md$/, ""));
    setDraftContent("");
    fetchDocContent(projectId, name)
      .then((d) => setDraftContent(d.content))
      .catch(() => {});
  }

  async function handleSave() {
    if (!draftName.trim()) return;
    setSaving(true);
    try {
      if (selected === "__new__") {
        await createDoc(projectId, draftName.trim(), draftContent);
      } else if (selected) {
        await saveDoc(projectId, selected, draftContent);
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
    try {
      await deleteDoc(projectId, name);
      if (selected === name) setSelected(null);
      reload();
    } catch (err) {
      push(err instanceof Error ? err.message : String(err), "bad");
    }
  }

  return (
    <>
      {selected === null && (
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

      {selected !== null && (
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
    </>
  );
}

function ProposalCard({
  proposal,
  onResolve,
}: {
  proposal: CurationProposalDTO;
  onResolve: (id: string, action: "accept" | "reject") => void;
}) {
  return (
    <div className="rama-provider-settings-row">
      <div className="rama-provider-settings-hint">
        {proposal.section} · {proposal.evidence.why}
      </div>
      <div className={`rama-diff-line ${proposal.kind === "add" ? "rama-diff-add" : "rama-diff-del"}`}>
        <span className="rama-diff-line-marker">{proposal.kind === "add" ? "+" : "−"}</span>
        <span className="rama-diff-line-text">{proposal.content}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
        <Button size="sm" variant="ghost" onClick={() => onResolve(proposal.id, "reject")}>
          reject
        </Button>
        <Button size="sm" onClick={() => onResolve(proposal.id, "accept")}>
          accept
        </Button>
      </div>
    </div>
  );
}

// docs/PROMPT_STACK_PLAN.md §7.2, Phase PS7 exit criterion — RAMA.md gains a section only once a
// proposal here is accepted; a proposal is a `remove` (findStaleEntries, verify.ts) just as often
// as an `add`, and both render the same accept/reject diff card.
function KnowledgeSection({ projectId }: { projectId: string }) {
  const [doc, setDoc] = useState<InstructionsDTO | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [proposals, setProposals] = useState<CurationProposalDTO[]>([]);
  const [checking, setChecking] = useState(false);
  const { push } = useToast();

  function reload() {
    fetchProjectInstructions(projectId)
      .then((d) => {
        setDoc(d);
        setDraft(d.content);
      })
      .catch(() => {});
    fetchCurationProposals(projectId, "pending")
      .then(setProposals)
      .catch(() => {});
  }

  useEffect(() => {
    setEditing(false);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleSave() {
    setSaving(true);
    try {
      const updated = await saveProjectInstructions(projectId, draft);
      setDoc(updated);
      setEditing(false);
    } catch (err) {
      push(err instanceof Error ? err.message : String(err), "bad");
    } finally {
      setSaving(false);
    }
  }

  async function handleResolve(id: string, action: "accept" | "reject") {
    try {
      await resolveCurationProposal(projectId, id, action);
      if (action === "accept") push("added to RAMA.md", "good");
      reload();
    } catch (err) {
      push(err instanceof Error ? err.message : String(err), "bad");
    }
  }

  async function handleCheck() {
    setChecking(true);
    try {
      await runCuratorNow(projectId);
      reload();
    } catch (err) {
      push(err instanceof Error ? err.message : String(err), "bad");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 720 }}>
      <div className="rama-provider-settings">
        <div className="rama-provider-settings-head">
          <IconDocs style={{ color: "var(--accent)" }} />
          <span className="rama-provider-settings-label">RAMA.md</span>
          <span style={{ flex: 1 }} />
          {editing ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setDraft(doc?.content ?? ""); }}>
                cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? "saving…" : "save"}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              edit
            </Button>
          )}
        </div>
        {editing ? (
          <textarea className="rama-doc-editor" value={draft} onChange={(e) => setDraft(e.target.value)} rows={14} />
        ) : doc?.content ? (
          <pre className="rama-doc-editor" style={{ whiteSpace: "pre-wrap" }}>
            {doc.content}
          </pre>
        ) : (
          <div className="rama-provider-settings-hint">no RAMA.md yet for this project — accept a suggestion below to start one.</div>
        )}
      </div>

      <div className="rama-provider-settings">
        <div className="rama-provider-settings-head">
          <span className="rama-provider-settings-label">suggestions</span>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" onClick={handleCheck} disabled={checking}>
            {checking ? "checking…" : "check for suggestions"}
          </Button>
        </div>
        {proposals.length === 0 && (
          <div className="rama-provider-settings-hint">no pending suggestions — nothing new observed yet, or nothing accepted or rejected.</div>
        )}
        {proposals.map((p) => (
          <ProposalCard key={p.id} proposal={p} onResolve={handleResolve} />
        ))}
      </div>
    </div>
  );
}

export function DocsPage() {
  const { activeProjectId, projects } = useProjectsData();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const [section, setSection] = useState<Section>("docs");

  return (
    <div className="rama-page">
      <div className="rama-page-header">
        <IconDocs />
        <span>docs</span>
        {activeProject && <span className="rama-page-header-sub">{activeProject.name}</span>}
      </div>
      <div className="rama-page-content">
        {!activeProjectId && <div className="rama-provider-settings-hint">select a project in the sidebar first.</div>}

        {activeProjectId && (
          <div className="rama-settings rama-settings-page">
            <div className="rama-settings-nav">
              <button
                className={`rama-settings-nav-item ${section === "docs" ? "rama-settings-nav-item-active" : ""}`}
                onClick={() => setSection("docs")}
              >
                project docs
              </button>
              <button
                className={`rama-settings-nav-item ${section === "knowledge" ? "rama-settings-nav-item-active" : ""}`}
                onClick={() => setSection("knowledge")}
              >
                knowledge
              </button>
            </div>
            <div className="rama-settings-content">
              {section === "docs" ? <ProjectDocsSection projectId={activeProjectId} /> : <KnowledgeSection projectId={activeProjectId} />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
