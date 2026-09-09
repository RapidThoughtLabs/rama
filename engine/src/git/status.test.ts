import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChanges, readDiff } from "./status";

// docs/WORKSPACE_PANES_PLAN.md Phase W3 tests for git status & diff read APIs.

describe("engine/src/git/status", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rama-git-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("not a git repository", async () => {
    const res = await readChanges(tempDir);
    expect(res.isRepo).toBe(false);
    expect(res.entries).toEqual([]);
  });

  test("comprehensive git status with various change types", async () => {
    // 1. Initialize git repo
    execSync("git init -b main", { cwd: tempDir });
    execSync("git config user.name 'Test' && git config user.email 'test@example.com'", { cwd: tempDir });

    // Initial files
    writeFileSync(join(tempDir, "base.txt"), "line1\nline2\nline3\n");
    writeFileSync(join(tempDir, "to_delete.txt"), "delete me\n");
    writeFileSync(join(tempDir, "to_rename.txt"), "rename me\n");
    writeFileSync(join(tempDir, "dual.txt"), "initial\n");
    execSync("git add . && git commit -m 'initial'", { cwd: tempDir });

    // 2. Modifications:
    // a. Modified unstaged
    writeFileSync(join(tempDir, "base.txt"), "line1\nline2 modified\nline3\nline4 added\n");

    // b. Deleted staged
    execSync("git rm to_delete.txt", { cwd: tempDir });

    // c. Renamed staged
    execSync("git mv to_rename.txt renamed.txt", { cwd: tempDir });

    // d. Added staged
    writeFileSync(join(tempDir, "new_staged.txt"), "new content\n");
    execSync("git add new_staged.txt", { cwd: tempDir });

    // e. Untracked file
    writeFileSync(join(tempDir, "untracked.txt"), "untracked content\n");

    // f. Staged and unstaged on same file
    writeFileSync(join(tempDir, "dual.txt"), "staged change\n");
    execSync("git add dual.txt", { cwd: tempDir });
    writeFileSync(join(tempDir, "dual.txt"), "staged change\nunstaged addition\n");

    // g. File with spaces
    writeFileSync(join(tempDir, "file with space.txt"), "space file\n");

    // h. File with arrow symbol in name
    writeFileSync(join(tempDir, "file → arrow.txt"), "arrow file\n");

    // i. Binary file
    writeFileSync(join(tempDir, "binary.dat"), Buffer.from([0, 1, 2, 0, 4]));

    const changes = await readChanges(tempDir);
    expect(changes.isRepo).toBe(true);
    expect(changes.branch).toBe("main");
    expect(changes.detached).toBe(false);
    expect(changes.countsOmitted).toBe(false);

    const entryByPath = new Map(changes.entries.map((e) => [e.path, e]));

    // Check base.txt
    const baseEntry = entryByPath.get("base.txt");
    expect(baseEntry).toBeDefined();
    expect(baseEntry?.status).toBe("modified");
    expect(baseEntry?.staged).toBe(false);
    expect(baseEntry?.unstaged).toBe(true);
    expect(baseEntry?.added).toBe(2);
    expect(baseEntry?.removed).toBe(1);

    // Check to_delete.txt
    const deleteEntry = entryByPath.get("to_delete.txt");
    expect(deleteEntry).toBeDefined();
    expect(deleteEntry?.status).toBe("deleted");
    expect(deleteEntry?.staged).toBe(true);
    expect(deleteEntry?.unstaged).toBe(false);

    // Check renamed.txt
    const renameEntry = entryByPath.get("renamed.txt");
    expect(renameEntry).toBeDefined();
    expect(renameEntry?.status).toBe("renamed");
    expect(renameEntry?.origPath).toBe("to_rename.txt");
    expect(renameEntry?.staged).toBe(true);

    // Check dual.txt (staged + unstaged)
    const dualEntry = entryByPath.get("dual.txt");
    expect(dualEntry).toBeDefined();
    expect(dualEntry?.staged).toBe(true);
    expect(dualEntry?.unstaged).toBe(true);
    expect(dualEntry?.added).toBe(2);

    // Check untracked files
    expect(entryByPath.has("untracked.txt")).toBe(true);
    expect(entryByPath.get("untracked.txt")?.status).toBe("untracked");

    expect(entryByPath.has("file with space.txt")).toBe(true);
    expect(entryByPath.has("file → arrow.txt")).toBe(true);

    // Check binary file
    const binaryEntry = entryByPath.get("binary.dat");
    expect(binaryEntry).toBeDefined();
    expect(binaryEntry?.binary).toBe(true);

    // Test readDiff
    // 1. Unstaged diff
    const unstagedDiff = await readDiff(tempDir, "base.txt", false);
    expect(unstagedDiff.binary).toBe(false);
    expect(unstagedDiff.diff.startsWith("@@")).toBe(true);
    expect(unstagedDiff.diff).toContain("+line4 added");

    // 2. Staged diff
    const stagedDiff = await readDiff(tempDir, "new_staged.txt", true);
    expect(stagedDiff.binary).toBe(false);
    expect(stagedDiff.diff).toContain("+new content");

    // 3. Untracked diff
    const untrackedDiff = await readDiff(tempDir, "untracked.txt", false);
    expect(untrackedDiff.binary).toBe(false);
    expect(untrackedDiff.diff).toContain("+untracked content");

    // 4. Binary diff
    const binaryDiff = await readDiff(tempDir, "binary.dat", false);
    expect(binaryDiff.binary).toBe(true);
    expect(binaryDiff.diff).toBe("");

    // 5. Escaping path throws
    expect(readDiff(tempDir, "../escape.txt", false)).rejects.toThrow();
  });
});
