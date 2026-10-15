import { describe, expect, test } from "bun:test";
import type { ArtifactDTO, ToolCallDTO } from "@rama/protocol";
import { labelText, rowsFor, thinkingRow, type RowCtx } from "./rows";

let n = 0;
const call = (name: string, input: unknown, summary: string | null = "", ok: boolean | null = true, artifactId: string | null = null): ToolCallDTO => ({
  id: `c${++n}`,
  messageId: "m",
  chatId: "chat",
  name,
  input,
  ok,
  resultSummary: ok === null ? null : summary,
  startedAt: 0,
  endedAt: 0,
  artifactId,
});
const ctx = (artifacts: ArtifactDTO[] = []): RowCtx => ({ artifacts: new Map(artifacts.map((a) => [a.id, a])), state: {} });
const one = (c: ToolCallDTO, x = ctx()) => rowsFor([c], x)[0]!;
const meta = (r: { meta: { text: string }[] }) => r.meta.map((m) => m.text).join(" ");

describe("explore runs", () => {
  test("one read is 'Read name' with its length", () => {
    const r = one(call("read", { path: "docs/PLAN.md" }, "1-212 of 212 lines"));
    expect(labelText(r.label)).toBe("Read PLAN.md");
    expect(meta(r)).toBe("212 lines");
    expect(r.icon).toBe("search");
  });
  test("several reads and a search collapse into one row", () => {
    const calls = [
      call("read", { path: "a.ts" }, "1-9 of 9 lines"),
      call("read", { path: "b.ts" }, "1-9 of 9 lines"),
      call("read", { path: "a.ts" }, "1-9 of 9 lines"),
      call("grep", { pattern: "setThemeId" }, "7 matches across 4 files"),
    ];
    const rows = rowsFor(calls, ctx());
    expect(rows).toHaveLength(1);
    expect(labelText(rows[0]!.label)).toBe("Looked through 2 files");
    expect(meta(rows[0]!)).toBe("and searched once");
    const list = rows[0]!.body[0]!;
    expect(list.k === "list" && list.items.map((i) => i.verb)).toEqual(["Read", "Read", "Read", "Searched"]);
  });
  test("searches alone", () => {
    const r = rowsFor([call("grep", { pattern: "x" }, "2 files matched"), call("tree", { path: "src" }, "9 entries")], ctx())[0]!;
    expect(labelText(r.label)).toBe("Searched the project");
    expect(meta(r)).toBe("2 searches");
  });
  test("a glob's matches count as files looked through, not as a search", () => {
    const r = rowsFor([call("read", { path: "a.ts" }, "1-9 of 9 lines"), call("glob", { pattern: "docs/*.md" }, "7 files matched")], ctx())[0]!;
    expect(labelText(r.label)).toBe("Looked through 8 files");
    expect(meta(r)).toBe("");
  });
  test("an edit between two explores splits them", () => {
    const rows = rowsFor([call("read", { path: "a.ts" }, "1-2 of 2 lines"), call("edit", { path: "a.ts" }, "+1 −1"), call("read", { path: "b.ts" }, "1-2 of 2 lines")], ctx());
    expect(rows.map((r) => labelText(r.label))).toEqual(["Read a.ts", "Edited a.ts", "Read b.ts"]);
  });
  test("a running read is in the present tense, in the accent", () => {
    const r = one(call("read", { path: "a.ts" }, null, null));
    expect(labelText(r.label)).toBe("Reading a.ts");
    expect(r.status).toBe("running");
    expect(r.live).toBe(true);
    expect(r.meta[0]!.tone).toBe("accent");
  });
  test("images and PDFs", () => {
    expect(labelText(one(call("read", { path: "shot.png" }, "image (40 KB)")).label)).toBe("Looked at shot.png");
    expect(meta(one(call("read", { path: "a.pdf" }, "12 pages")))).toBe("12 pages");
  });
});

describe("edits", () => {
  test("edit shows the delta, an artifact and a link into Changes", () => {
    const r = one(call("edit", { path: "packages/ui/src/theme.tsx" }, "+14 −3", true, "a1"));
    expect(labelText(r.label)).toBe("Edited theme.tsx");
    expect(r.meta).toEqual([{ text: "+14", tone: "plus" }, { text: "−3", tone: "minus" }]);
    expect(r.body).toEqual([{ k: "artifact", artifactId: "a1", fallback: undefined }, { k: "link", goto: "changes:packages/ui/src/theme.tsx", label: "Open in Changes" }]);
    expect(r.icon).toBe("pencil");
  });
  test("a delta with nothing removed drops the minus", () => {
    expect(one(call("edit", { path: "a.ts" }, "+4 −0")).meta).toEqual([{ text: "+4", tone: "plus" }]);
  });
  test("write that created a file", () => {
    const r = one(call("write", { path: "src/new.ts" }, "created · 31 lines"));
    expect(labelText(r.label)).toBe("Created new.ts");
    expect(r.icon).toBe("file-plus");
    expect(r.meta).toEqual([{ text: "+31", tone: "plus" }]);
  });
  test("write that overwrote a file reads as an edit", () => {
    expect(labelText(one(call("write", { path: "src/a.ts" }, "+9 −2")).label)).toBe("Edited a.ts");
  });
  test("a refused edit", () => {
    const r = one(call("edit", { path: "a.ts" }, "refused: would shrink a.ts by 80%", false));
    expect(labelText(r.label)).toBe("Couldn't edit a.ts");
    expect(r.meta).toEqual([{ text: "refused", tone: "fail" }]);
    expect(r.status).toBe("fail");
    expect(r.body).toEqual([{ k: "text", text: "refused: would shrink a.ts by 80%" }]);
  });
  test("file_op", () => {
    expect(labelText(one(call("file_op", { op: "move", from: "src/a.ts", to: "lib/b.ts" })).label)).toBe("Moved a.ts to b.ts");
    const del = one(call("file_op", { op: "remove", path: "tmp/x.log" }));
    expect(labelText(del.label)).toBe("Deleted x.log");
    expect(del.icon).toBe("x");
  });
});

describe("bash", () => {
  test("a passing test run says how many passed", () => {
    const r = one(call("bash", { command: "bun test packages/ui" }, "exit 0 · 14 lines · 31 passed", true, "a2"));
    expect(labelText(r.label)).toBe("Ran bun test packages/ui");
    expect(r.meta).toEqual([{ text: "31 passed", tone: "ok" }]);
  });
  test("a plain run is 'done'", () => {
    expect(meta(one(call("bash", { command: "ls" }, "exit 0 · 3 lines")))).toBe("done");
  });
  test("failures", () => {
    expect(one(call("bash", { command: "make" }, "exit 2 · 9 lines", false)).meta).toEqual([{ text: "exit 2", tone: "fail" }]);
    expect(one(call("bash", { command: "bun test" }, "exit 1 · 20 lines · 2 failed", false)).meta).toEqual([{ text: "2 failed", tone: "fail" }]);
    expect(one(call("bash", { command: "sleep 99" }, "timed out after 30000ms", false)).meta).toEqual([{ text: "timed out", tone: "fail" }]);
  });
  test("long commands are cut at 48 characters, the full text kept for the tooltip", () => {
    const cmd = "bun test packages/ui packages/protocol engine/src/tools --coverage";
    const r = one(call("bash", { command: cmd }, "exit 0 · 1 line"));
    expect(labelText(r.label).length).toBeLessThanOrEqual(4 + 48);
    expect(labelText(r.label).endsWith("…")).toBe(true);
    expect(r.title).toBe(cmd);
  });
  test("background: starts in the Terminal pane and links to it", () => {
    const art = { id: "a3", meta: { terminalId: "t9" } } as unknown as ArtifactDTO;
    const r = one(call("bash", { command: "bun dev", background: true }, "background: terminal 2", true, "a3"), ctx([art]));
    expect(labelText(r.label)).toBe("Started bun dev in the Terminal pane");
    expect(r.meta).toEqual([{ text: "running", tone: "good" }]);
    expect(r.body).toEqual([{ k: "link", goto: "terminal:t9", label: "Open in Terminal" }]);
  });
  test("process kill names the terminal it stopped", () => {
    const x = { ...ctx(), terminalTitle: (id: string) => (id === "t9" ? "bun dev" : undefined) };
    expect(labelText(one(call("process", { op: "kill", id: "t9" }, "kill requested"), x).label)).toBe("Stopped bun dev");
  });
});

describe("web pane", () => {
  test("open names the host and remembers it for later actions", () => {
    const x = ctx();
    const open = one(call("browser", { op: "open", url: "https://www.youtube.com/watch" }, "opened https://www.youtube.com/watch"), x);
    expect(labelText(open.label)).toBe("Opened youtube.com in the Web pane");
    expect(open.body.at(-1)).toEqual({ k: "link", goto: "web", label: "Open in Web" });
    const [check] = rowsFor([call("browser", { op: "snapshot" }, "snapshot of YouTube")], x);
    expect(labelText(check!.label)).toBe("Checked youtube.com in the Web pane");
  });
  test("a bare host is read as one", () => {
    expect(labelText(one(call("browser", { op: "open", url: "localhost:1420" }, "")).label)).toBe("Opened localhost:1420 in the Web pane");
  });
  test("consecutive actions are one row", () => {
    const x = ctx();
    x.state.host = "example.com";
    const rows = rowsFor([call("browser", { op: "click", ref: "e3" }, "clicked"), call("browser", { op: "type", ref: "e4", text: "hi" }, "typed")], x);
    expect(rows).toHaveLength(1);
    expect(labelText(rows[0]!.label)).toBe("Used the Web pane on example.com");
    expect(meta(rows[0]!)).toBe("2 steps");
  });
});

describe("sub-agents and git", () => {
  test("review", () => {
    const r = one(call("review", {}, "no issues found"));
    expect(labelText(r.label)).toBe("A reviewer read the diff");
    expect(meta(r)).toBe("no changes needed");
    expect(r.icon).toBe("eye");
    expect(meta(one(call("review", {}, "3 issues found")))).toBe("3 notes");
  });
  test("explore and test helpers", () => {
    expect(labelText(one(call("explore", { question: "Where is the theme cached?" }, "…")).label)).toBe("A helper explored: Where is the theme cached?");
    expect(labelText(one(call("test", {}, "tests written")).label)).toBe("A helper wrote tests");
  });
  test("commit", () => {
    const r = one(call("git_write", { op: "commit", message: "x" }, "committed · main 4c1e9a2"));
    expect(labelText(r.label)).toBe("Committed to main");
    expect(meta(r)).toBe("4c1e9a2");
  });
  test("a commit from before summaries carried the branch", () => {
    expect(labelText(one(call("git_write", { op: "commit", message: "x" }, "committed")).label)).toBe("Committed");
  });
  test("other git_write ops", () => {
    expect(labelText(one(call("git_write", { op: "stage", paths: ["a", "b", "c"] }, "staged")).label)).toBe("Staged 3 files");
    expect(labelText(one(call("git_write", { op: "checkout", ref: "dev" }, "on dev")).label)).toBe("Switched to dev");
    expect(labelText(one(call("git_write", { op: "stash" }, "stashed")).label)).toBe("Stashed changes");
  });
  test("check", () => {
    const clean = one(call("check", { kinds: ["typecheck", "lint"] }, "typecheck: clean · lint: clean · (test not run) · (build not run)"));
    expect(labelText(clean.label)).toBe("Checked types and lint");
    expect(clean.meta).toEqual([{ text: "clean", tone: "ok" }]);
    const bad = one(call("check", { kinds: ["typecheck"] }, "typecheck: 2 errors, 1 warning · (lint not run)", false));
    expect(meta(bad)).toBe("3 problems");
  });
});

describe("hidden and failed", () => {
  test("todo and clarify draw no row", () => {
    expect(rowsFor([call("todo", { op: "set", items: [] }), call("clarify", { questions: [] })], ctx())).toEqual([]);
  });
  test("an unknown tool still gets a plain row", () => {
    expect(labelText(one(call("mystery", {}, "did a thing")).label)).toBe("Used a tool");
  });
});

describe("thinking", () => {
  test("finished: seconds, a moment, or nothing known", () => {
    expect(labelText(thinkingRow("k", "x", 4000, false, 0).label)).toBe("Thought for 4 seconds");
    expect(labelText(thinkingRow("k", "x", 1000, false, 0).label)).toBe("Thought for 1 second");
    expect(labelText(thinkingRow("k", "x", 300, false, 0).label)).toBe("Thought for a moment");
    expect(labelText(thinkingRow("k", "x", undefined, false, 0).label)).toBe("Thought it through");
  });
  test("live: counts the seconds, opens by itself", () => {
    const r = thinkingRow("k", "hm", undefined, true, 3400);
    expect(labelText(r.label)).toBe("Thinking");
    expect(meta(r)).toBe("3 seconds");
    expect(r.live).toBe(true);
  });
});
