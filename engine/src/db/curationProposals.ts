// docs/PROMPT_STACK_PLAN.md §7.2, Phase PS7 — the DAO for the curator's proposal queue. Every
// write here is either "insert a new pending row" or "resolve one to accepted/rejected"; nothing
// in this module ever touches RAMA.md itself — applying an accepted proposal to disk is
// instructions.ts's job (decision 6 keeps the write path in one place, already trusted for PS3).
import type { CurationProposalDTO } from "@rama/protocol";
import { db } from "./index";
import { newId } from "./ids";

export type ProposalKind = "add" | "remove";
export type ProposalStatus = "pending" | "accepted" | "rejected";

export interface ProposalEvidence {
  why: string;
  toolCallIds?: string[];
  messageIds?: string[];
}

interface ProposalRow {
  id: string;
  project_id: string;
  kind: ProposalKind;
  section: string;
  content: string;
  signal: string;
  evidence_json: string;
  dedupe_key: string;
  status: ProposalStatus;
  created_at: number;
  resolved_at: number | null;
}

function toDTO(row: ProposalRow): CurationProposalDTO {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    section: row.section,
    content: row.content,
    signal: row.signal,
    evidence: JSON.parse(row.evidence_json) as ProposalEvidence,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export interface NewProposal {
  projectId: string;
  kind: ProposalKind;
  section: string;
  content: string;
  signal: string;
  evidence: ProposalEvidence;
  dedupeKey: string;
}

// Returns null when an identical proposal (same project + dedupe key) already exists, regardless
// of its status — a rejected suggestion should not come back on the next run just because the
// same evidence is still there; the user already ruled on it.
export function createProposal(input: NewProposal): CurationProposalDTO | null {
  const id = newId();
  const now = Date.now();
  const result = db
    .query(
      `INSERT OR IGNORE INTO instruction_proposals
         (id, project_id, kind, section, content, signal, evidence_json, dedupe_key, status, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
    )
    .run(
      id,
      input.projectId,
      input.kind,
      input.section,
      input.content,
      input.signal,
      JSON.stringify(input.evidence),
      input.dedupeKey,
      now,
    );
  if (result.changes === 0) return null;
  return {
    id,
    projectId: input.projectId,
    kind: input.kind,
    section: input.section,
    content: input.content,
    signal: input.signal,
    evidence: input.evidence,
    status: "pending",
    createdAt: now,
    resolvedAt: null,
  };
}

export function listProposals(projectId: string, status?: ProposalStatus): CurationProposalDTO[] {
  const rows = status
    ? db
        .query<
          ProposalRow,
          [string, string]
        >("SELECT * FROM instruction_proposals WHERE project_id = ? AND status = ? ORDER BY created_at DESC")
        .all(projectId, status)
    : db
        .query<ProposalRow, [string]>("SELECT * FROM instruction_proposals WHERE project_id = ? ORDER BY created_at DESC")
        .all(projectId);
  return rows.map(toDTO);
}

export function getProposal(id: string): CurationProposalDTO | null {
  const row = db.query<ProposalRow, [string]>("SELECT * FROM instruction_proposals WHERE id = ?").get(id);
  return row ? toDTO(row) : null;
}

// Every existing dedupe_key for a project, regardless of status — the harness's cheap
// "have we already surfaced this" check before spending a utility-model call phrasing it.
export function listDedupeKeys(projectId: string): Set<string> {
  const rows = db
    .query<{ dedupe_key: string }, [string]>("SELECT dedupe_key FROM instruction_proposals WHERE project_id = ?")
    .all(projectId);
  return new Set(rows.map((r) => r.dedupe_key));
}

// Called from projects.ts's deleteProject — instruction_proposals.project_id is a foreign key,
// so a project with any proposal rows (even resolved ones) can't be deleted until these are gone
// first; there is no ON DELETE CASCADE in schema.ts (bun:sqlite's default, matching every other
// project_id-referencing table here).
export function deleteProposalsForProject(projectId: string): void {
  db.query("DELETE FROM instruction_proposals WHERE project_id = ?").run(projectId);
}

export function resolveProposal(id: string, status: "accepted" | "rejected"): CurationProposalDTO | null {
  const now = Date.now();
  db.query("UPDATE instruction_proposals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'").run(
    status,
    now,
    id,
  );
  return getProposal(id);
}
