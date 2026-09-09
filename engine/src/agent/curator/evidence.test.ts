// docs/PROMPT_STACK_PLAN.md §7.2, Phase PS7 — each collector is a pure function over already-
// fetched rows, so these run against hand-built fixtures rather than a real DB or filesystem.
// verifyCommand's own package.json check is exercised separately in verify.test.ts; here the
// commands collector is tested against a scratch dir with an empty package.json so `npm run x`
// forms don't accidentally verify true.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ProjectMessage } from "../../db/messages";
import type { ProjectToolCallRow } from "../../db/toolCalls";
import { collectCommandEvidence, collectCorrectionEvidence, collectGotchaEvidence, collectOrientationEvidence } from "./evidence";

let projectPath: string;

beforeEach(() => {
  projectPath = mkdtempSync(join(tmpdir(), "rama-evidence-"));
  writeFileSync(join(projectPath, "package.json"), JSON.stringify({ scripts: {} }));
});

afterEach(() => {
  rmSync(projectPath, { recursive: true, force: true });
});

function toolCall(overrides: Partial<ProjectToolCallRow>): ProjectToolCallRow {
  return { id: "tc", chatId: "chat-1", name: "bash", input: {}, ok: true, startedAt: 0, ...overrides };
}

describe("collectCommandEvidence", () => {
  test("proposes the clear winner: 4 clean bun test runs beats one failed npm test", () => {
    const rows: ProjectToolCallRow[] = [
      ...Array.from({ length: 4 }, (_, i) => toolCall({ id: `s${i}`, input: { command: "bun test" }, ok: true })),
      toolCall({ id: "f1", input: { command: "npm test" }, ok: false }),
    ];
    const items = collectCommandEvidence(rows, projectPath);
    expect(items).toHaveLength(1);
    expect(items[0].section).toBe("Commands");
    expect(items[0].raw).toContain("bun test");
    expect(items[0].evidence.why).toContain("npm test");
  });

  test("does not propose a command below the success threshold", () => {
    const rows = [toolCall({ input: { command: "bun test" }, ok: true }), toolCall({ input: { command: "bun test" }, ok: true })];
    expect(collectCommandEvidence(rows, projectPath)).toHaveLength(0);
  });

  test("does not propose a command that has ever failed", () => {
    const rows = [
      ...Array.from({ length: 3 }, () => toolCall({ input: { command: "bun test" }, ok: true })),
      toolCall({ input: { command: "bun test" }, ok: false }),
    ];
    expect(collectCommandEvidence(rows, projectPath)).toHaveLength(0);
  });

  test("ignores commands outside the tracked categories", () => {
    const rows = Array.from({ length: 5 }, () => toolCall({ input: { command: "ls -la" }, ok: true }));
    expect(collectCommandEvidence(rows, projectPath)).toHaveLength(0);
  });

  test("verification gate: `npm run <missing script>` never counts as evidence, even if it always succeeds", () => {
    const rows = Array.from({ length: 5 }, () => toolCall({ input: { command: "npm run test:missing" }, ok: true }));
    expect(collectCommandEvidence(rows, projectPath)).toHaveLength(0);
  });

  test("verification gate: `npm run <script>` counts once the script exists in package.json", () => {
    writeFileSync(join(projectPath, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    const rows = Array.from({ length: 3 }, () => toolCall({ input: { command: "npm run test" }, ok: true }));
    expect(collectCommandEvidence(rows, projectPath)).toHaveLength(1);
  });
});

describe("collectGotchaEvidence", () => {
  test("flags a path with 3+ failed edits", () => {
    const rows: ProjectToolCallRow[] = Array.from({ length: 3 }, (_, i) =>
      toolCall({ id: `e${i}`, name: "edit", input: { path: "src/generated/types.ts" }, ok: false }),
    );
    const items = collectGotchaEvidence(rows);
    expect(items).toHaveLength(1);
    expect(items[0].dedupeKey).toBe("gotcha:src/generated/types.ts");
  });

  test("does not flag a path below the threshold, or successful edits", () => {
    const rows: ProjectToolCallRow[] = [
      toolCall({ name: "edit", input: { path: "a.ts" }, ok: false }),
      toolCall({ name: "edit", input: { path: "a.ts" }, ok: false }),
      toolCall({ name: "write", input: { path: "b.ts" }, ok: true }),
    ];
    expect(collectGotchaEvidence(rows)).toHaveLength(0);
  });
});

function userMsg(chatId: string, seq: number, content: string): ProjectMessage {
  return { id: `${chatId}-${seq}`, chatId, seq, role: "user", content };
}
function assistantMsg(chatId: string, seq: number): ProjectMessage {
  return { id: `${chatId}-${seq}`, chatId, seq, role: "assistant", content: "done." };
}

describe("collectCorrectionEvidence", () => {
  test("flags a user reply that opens with a correction marker", () => {
    const messages = [assistantMsg("c1", 1), userMsg("c1", 2, "No, don't use npm here, this repo uses bun.")];
    const items = collectCorrectionEvidence(messages);
    expect(items).toHaveLength(1);
    expect(items[0].evidence.messageIds).toEqual(["c1-2"]);
  });

  test("ignores an opening user message with no prior assistant turn", () => {
    const messages = [userMsg("c1", 1, "No, don't use npm here.")];
    expect(collectCorrectionEvidence(messages)).toHaveLength(0);
  });

  test("ignores an ordinary reply with no correction marker", () => {
    const messages = [assistantMsg("c1", 1), userMsg("c1", 2, "thanks, looks good")];
    expect(collectCorrectionEvidence(messages)).toHaveLength(0);
  });
});

describe("collectOrientationEvidence", () => {
  test("flags a path read cold in 3+ distinct chats", () => {
    const rows: ProjectToolCallRow[] = ["chat-a", "chat-b", "chat-c"].map((chatId, i) =>
      toolCall({ id: `r${i}`, chatId, name: "read", input: { path: "engine/src/server.ts" }, ok: true }),
    );
    const items = collectOrientationEvidence(rows);
    expect(items).toHaveLength(1);
    expect(items[0].dedupeKey).toBe("orientation:engine/src/server.ts");
  });

  test("does not flag a path read in fewer than 3 distinct chats", () => {
    const rows: ProjectToolCallRow[] = ["chat-a", "chat-a", "chat-b"].map((chatId, i) =>
      toolCall({ id: `r${i}`, chatId, name: "read", input: { path: "x.ts" }, ok: true }),
    );
    expect(collectOrientationEvidence(rows)).toHaveLength(0);
  });
});
