import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RAMA_HOME } from "../db/index";

// docs/PROMPT_STACK_PLAN.md §7.1, Phase PS3 — "~/.rama/RAMA.md then <project>/RAMA.md ... size-
// warned past 500 lines." Root-only for v1 (open question E). Deliberately a plain file on disk,
// not a DB row: RAMA.md is meant to be a real, git-tracked, human-editable file other tools (and
// humans) can find at the project root — same reasoning that keeps engine/src/docs/store.ts's
// per-project docs *outside* the repo doesn't apply here; this is the opposite case.
const SIZE_WARNING_LINES = 500;
const GLOBAL_INSTRUCTIONS_PATH = join(RAMA_HOME, "RAMA.md");

export interface InstructionsDoc {
  content: string;
  lines: number;
  oversize: boolean;
}

function readInstructions(path: string): InstructionsDoc | null {
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n").length;
  return { content, lines, oversize: lines > SIZE_WARNING_LINES };
}

export function getGlobalInstructions(): InstructionsDoc | null {
  return readInstructions(GLOBAL_INSTRUCTIONS_PATH);
}

export function setGlobalInstructions(content: string): InstructionsDoc {
  writeFileSync(GLOBAL_INSTRUCTIONS_PATH, content);
  return readInstructions(GLOBAL_INSTRUCTIONS_PATH)!;
}

function projectInstructionsPath(projectPath: string): string {
  return join(projectPath, "RAMA.md");
}

export function getProjectInstructions(projectPath: string): InstructionsDoc | null {
  return readInstructions(projectInstructionsPath(projectPath));
}

export function setProjectInstructions(projectPath: string, content: string): InstructionsDoc {
  writeFileSync(projectInstructionsPath(projectPath), content);
  return readInstructions(projectInstructionsPath(projectPath))!;
}

// docs/PROMPT_STACK_PLAN.md §7.2, Phase PS7 — the one place an accepted curator proposal actually
// touches disk (decision 6: nothing else may). 'add' inserts a new bullet under its '## Section'
// header, creating the header if it's not there yet; 'remove' deletes the exact existing line a
// stale-entry check (curator/verify.ts) flagged. Pure string transform so it's unit-testable
// without touching the filesystem.
export function applyProposalToContent(
  content: string,
  proposal: { kind: "add" | "remove"; section: string; content: string },
): string {
  const lines = content.length > 0 ? content.split("\n") : [];
  const bullet = `- ${proposal.content}`;

  if (proposal.kind === "remove") {
    return lines.filter((l) => l.trim() !== bullet.trim()).join("\n");
  }

  if (lines.some((l) => l.trim() === bullet.trim())) return content;

  const headerLine = `## ${proposal.section}`;
  const headerIdx = lines.findIndex((l) => l.trim() === headerLine);
  if (headerIdx === -1) {
    const sep = content.trim().length > 0 ? "\n\n" : "";
    return `${content}${sep}${headerLine}\n${bullet}\n`;
  }

  let sectionEnd = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }
  // Land right after the section's last real line, not before the blank-line gap that precedes
  // the next header — otherwise every insertion widens that gap by one more blank line.
  let insertAt = sectionEnd;
  while (insertAt > headerIdx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  return [...lines.slice(0, insertAt), bullet, ...lines.slice(insertAt)].join("\n");
}

export function applyProjectProposal(
  projectPath: string,
  proposal: { kind: "add" | "remove"; section: string; content: string },
): InstructionsDoc {
  const existing = getProjectInstructions(projectPath)?.content ?? "";
  return setProjectInstructions(projectPath, applyProposalToContent(existing, proposal));
}
