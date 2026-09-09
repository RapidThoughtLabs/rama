// docs/PROMPT_STACK_PLAN.md §7.2, Phase PS7 — "evidence first, model second." Four collectors,
// one per row of the plan's own signal table, each a pure function over already-fetched rows so
// they're trivial to unit test without a database. Every EvidenceItem already carries its section,
// dedupe key, and provenance computed by the harness — the phrasing model (curator.ts) only ever
// gets to fill in `content`'s wording, never choose what gets proposed.
import type { ProjectMessage } from "../../db/messages";
import type { ProjectToolCallRow } from "../../db/toolCalls";
import type { ProposalEvidence } from "../../db/curationProposals";
import { verifyCommand } from "./verify";

export interface EvidenceItem {
  id: string;
  signal: "commands" | "gotcha" | "correction" | "orientation";
  section: string;
  raw: string;
  dedupeKey: string;
  evidence: ProposalEvidence;
}

const COMMAND_MIN_SUCCESS = 3;
const GOTCHA_MIN_FAILURES = 3;
const ORIENTATION_MIN_CHATS = 3;
const CORRECTION_MAX_EXCERPT = 200;

function commandCategory(command: string): string | null {
  const c = command.toLowerCase();
  if (/\btest\b/.test(c)) return "Tests";
  if (/\b(build|compile)\b/.test(c)) return "Build";
  if (/\blint\b/.test(c)) return "Lint";
  if (/\b(dev|start)\b/.test(c)) return "Dev server";
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// "bun test succeeded 4x, npm test failed once" — group raw bash calls by exact command text,
// tally per category, and only surface the category's clear winner: at least COMMAND_MIN_SUCCESS
// successes and zero observed failures. verifyCommand (§7.2's provenance hook) runs before a
// candidate is even counted, so a phantom `npm run <deleted-script>` never gets this far.
export function collectCommandEvidence(rows: ProjectToolCallRow[], projectPath: string): EvidenceItem[] {
  const stats = new Map<string, { category: string; success: number; failure: number; ids: string[] }>();
  for (const row of rows) {
    if (row.name !== "bash") continue;
    const command = asString((row.input as { command?: unknown })?.command);
    if (!command) continue;
    const category = commandCategory(command);
    if (!category) continue;
    if (!verifyCommand(command, projectPath)) continue;

    const key = command.trim().replace(/\s+/g, " ");
    const entry = stats.get(key) ?? { category, success: 0, failure: 0, ids: [] };
    if (row.ok) entry.success++;
    else entry.failure++;
    entry.ids.push(row.id);
    stats.set(key, entry);
  }

  const byCategory = new Map<string, { command: string; success: number; failure: number; ids: string[] }[]>();
  for (const [command, s] of stats) {
    const list = byCategory.get(s.category) ?? [];
    list.push({ command, success: s.success, failure: s.failure, ids: s.ids });
    byCategory.set(s.category, list);
  }

  const items: EvidenceItem[] = [];
  for (const [category, candidates] of byCategory) {
    const winner = candidates.reduce((a, b) => (b.success > a.success ? b : a));
    if (winner.success < COMMAND_MIN_SUCCESS || winner.failure > 0) continue;
    const rivals = candidates.filter((c) => c.command !== winner.command && c.failure > 0);
    const why =
      rivals.length > 0
        ? `\`${winner.command}\` succeeded ${winner.success}x with no failures; ${rivals.map((r) => `\`${r.command}\` failed ${r.failure}x`).join(", ")}.`
        : `\`${winner.command}\` succeeded ${winner.success}x with no failures.`;
    items.push({
      id: `commands:${items.length}`,
      signal: "commands",
      section: "Commands",
      raw: `The project's ${category.toLowerCase()} command is \`${winner.command}\` (${winner.success} clean runs observed).`,
      dedupeKey: `commands:${category}:${winner.command}`,
      evidence: { why, toolCallIds: winner.ids.slice(0, 8) },
    });
  }
  return items;
}

// Repeated failed edit/write on the same path — a gotcha worth flagging (generated file? CRLF?
// codegen?) rather than diagnosing here; the harness only reports the pattern.
export function collectGotchaEvidence(rows: ProjectToolCallRow[]): EvidenceItem[] {
  const byPath = new Map<string, { count: number; ids: string[] }>();
  for (const row of rows) {
    if (row.name !== "edit" && row.name !== "write") continue;
    if (row.ok) continue;
    const path = asString((row.input as { path?: unknown })?.path);
    if (!path) continue;
    const entry = byPath.get(path) ?? { count: 0, ids: [] };
    entry.count++;
    entry.ids.push(row.id);
    byPath.set(path, entry);
  }

  const items: EvidenceItem[] = [];
  for (const [path, entry] of byPath) {
    if (entry.count < GOTCHA_MIN_FAILURES) continue;
    items.push({
      id: `gotcha:${items.length}`,
      signal: "gotcha",
      section: "Gotchas",
      raw: `Editing \`${path}\` has failed ${entry.count} separate times.`,
      dedupeKey: `gotcha:${path}`,
      evidence: { why: `${entry.count} failed edit/write attempts on this file.`, toolCallIds: entry.ids.slice(0, 8) },
    });
  }
  return items;
}

const CORRECTION_RE =
  /^\s*(no[,.!]|don'?t\b|do not\b|stop\b|that'?s (not|wrong)\b|not that\b|wrong[,.]|actually[,.\s]|please don'?t\b)/i;

// "the user corrected the agent in prose" — a user turn that immediately follows an assistant
// turn (so it's a reply, not an opening ask) and opens with a correction marker. Deliberately
// narrow and pattern-based rather than a model call of its own: a false negative here just means
// one fewer proposal, a false positive would waste the phrasing model's time on noise.
export function collectCorrectionEvidence(messages: ProjectMessage[]): EvidenceItem[] {
  const byChat = new Map<string, ProjectMessage[]>();
  for (const m of messages) {
    const list = byChat.get(m.chatId) ?? [];
    list.push(m);
    byChat.set(m.chatId, list);
  }

  const items: EvidenceItem[] = [];
  for (const list of byChat.values()) {
    for (let i = 1; i < list.length; i++) {
      const msg = list[i];
      const prev = list[i - 1];
      if (msg.role !== "user" || prev.role !== "assistant") continue;
      if (!msg.content || !CORRECTION_RE.test(msg.content)) continue;
      const excerpt = msg.content.trim().slice(0, CORRECTION_MAX_EXCERPT);
      items.push({
        id: `correction:${items.length}`,
        signal: "correction",
        section: "Notes",
        raw: `The user corrected the agent mid-session: "${excerpt}"`,
        dedupeKey: `correction:${msg.id}`,
        evidence: { why: "user correction, verbatim.", messageIds: [msg.id] },
      });
    }
  }
  return items;
}

// The same path read cold (i.e. at all) in enough distinct sessions is a sign every fresh session
// has to go rediscover what it does — worth a one-line pointer instead of thirty more cold reads.
export function collectOrientationEvidence(rows: ProjectToolCallRow[]): EvidenceItem[] {
  const byPath = new Map<string, { chatIds: Set<string>; ids: string[] }>();
  for (const row of rows) {
    if (row.name !== "read") continue;
    if (!row.ok) continue;
    const path = asString((row.input as { path?: unknown })?.path);
    if (!path) continue;
    const entry = byPath.get(path) ?? { chatIds: new Set(), ids: [] };
    entry.chatIds.add(row.chatId);
    entry.ids.push(row.id);
    byPath.set(path, entry);
  }

  const items: EvidenceItem[] = [];
  for (const [path, entry] of byPath) {
    if (entry.chatIds.size < ORIENTATION_MIN_CHATS) continue;
    items.push({
      id: `orientation:${items.length}`,
      signal: "orientation",
      section: "Orientation",
      raw: `\`${path}\` was read in ${entry.chatIds.size} separate sessions.`,
      dedupeKey: `orientation:${path}`,
      evidence: { why: `read cold in ${entry.chatIds.size} sessions.`, toolCallIds: entry.ids.slice(0, 8) },
    });
  }
  return items;
}

export function gatherEvidence(rows: ProjectToolCallRow[], messages: ProjectMessage[], projectPath: string): EvidenceItem[] {
  return [
    ...collectCommandEvidence(rows, projectPath),
    ...collectGotchaEvidence(rows),
    ...collectCorrectionEvidence(messages),
    ...collectOrientationEvidence(rows),
  ];
}
