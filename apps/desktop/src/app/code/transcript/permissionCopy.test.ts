import { describe, expect, test } from "bun:test";
import { permissionCopy } from "./permissionCopy";
import { labelText } from "./rows";

describe("permissionCopy", () => {
  test("bash says where it runs, and that a background command outlives the turn", () => {
    const c = permissionCopy("bash", { command: "bun test" }, { cwd: "~/code/rama" });
    expect(c.title).toBe("Run this command?");
    expect(c.code).toBe("bun test");
    expect(labelText(c.body)).toBe("It runs in ~/code/rama on this Mac.");
    expect(labelText(permissionCopy("bash", { command: "bun dev", background: true }).body)).toContain("keeps running after you say yes");
  });
  test("commit names the branch (bold) and the file count", () => {
    const c = permissionCopy("git_write", { op: "commit", message: "Apply the saved theme before first paint" }, { branch: "main", changedCount: 4 });
    expect(c.title).toBe("Commit these changes to main?");
    expect(c.code).toBe('git commit -m "Apply the saved theme before first paint"');
    expect(labelText(c.body)).toBe("This records the 4 changed files on your local main branch. Nothing leaves this Mac until you push.");
    expect(c.body).toContainEqual({ b: "main" });
  });
  test("commit without context still reads", () => {
    expect(labelText(permissionCopy("git_write", { op: "commit", message: "x" }).body)).toBe("This records your changed files on your local branch. Nothing leaves this Mac until you push.");
  });
  test("edit and write", () => {
    const e = permissionCopy("edit", { path: "src/a.ts", edits: [{ oldString: "a\nb", newString: "a\nb\nc" }] });
    expect(e.title).toBe("Edit a.ts?");
    expect(labelText(e.body)).toContain("+3 −2");
    expect(permissionCopy("write", { path: "x/new.ts", content: "a\nb" }).title).toBe("Write new.ts?");
  });
  test("browser open and process kill", () => {
    const o = permissionCopy("browser", { op: "open", url: "https://www.youtube.com/watch" });
    expect(o.title).toBe("Open youtube.com in the Web pane?");
    expect(permissionCopy("process", { op: "kill", id: "t9" }, { terminalTitle: () => "bun dev" }).title).toBe("Stop bun dev?");
  });
  test("an unknown tool still asks plainly", () => {
    expect(permissionCopy("mystery_tool", {}).title).toBe("Allow mystery tool?");
  });
});
