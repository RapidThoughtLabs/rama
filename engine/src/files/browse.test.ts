import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearIgnoredDirsCache, listDirectory, readFileContent } from "./browse";

// docs/WORKSPACE_PANES_PLAN.md Phase W5 unit tests for files browsing & reading.

describe("engine/src/files/browse", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rama-files-test-"));
    clearIgnoredDirsCache();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("listDirectory: lists entries, excludes, symlinks, and respects 1000 cap", async () => {
    mkdirSync(join(tempDir, "src"));
    mkdirSync(join(tempDir, "node_modules"));
    writeFileSync(join(tempDir, "src", "index.ts"), "export const a = 1;");
    writeFileSync(join(tempDir, "README.md"), "# Hello");

    // Symlink inside project
    symlinkSync(join(tempDir, "README.md"), join(tempDir, "readme-link.md"));

    const res = await listDirectory(tempDir, "");
    expect(res.entries.length).toBe(4);

    const dirNames = res.entries.map((e) => e.name);
    expect(dirNames).toContain("src");
    expect(dirNames).toContain("node_modules");
    expect(dirNames).toContain("README.md");
    expect(dirNames).toContain("readme-link.md");

    const nodeModules = res.entries.find((e) => e.name === "node_modules");
    expect(nodeModules?.ignored).toBe(true);
    expect(nodeModules?.kind).toBe("dir");

    const src = res.entries.find((e) => e.name === "src");
    expect(src?.ignored).toBe(false);
    expect(src?.kind).toBe("dir");

    const symlink = res.entries.find((e) => e.name === "readme-link.md");
    expect(symlink?.kind).toBe("symlink");

    // Subdirectory listing
    const subRes = await listDirectory(tempDir, "src");
    expect(subRes.entries.length).toBe(1);
    expect(subRes.entries[0]?.name).toBe("index.ts");
    expect(subRes.entries[0]?.path).toBe("src/index.ts");

    // Directory with 1,200 entries caps at 1,000
    const bigDir = join(tempDir, "big");
    mkdirSync(bigDir);
    for (let i = 0; i < 1200; i++) {
      writeFileSync(join(bigDir, `file_${String(i).padStart(4, "0")}.txt`), "content");
    }
    const bigRes = await listDirectory(tempDir, "big");
    expect(bigRes.entries.length).toBe(1000);
  });

  test("listDirectory: path escape throws", async () => {
    expect(listDirectory(tempDir, "../../etc")).rejects.toThrow();
  });

  test("readFileContent: normal text file, lines count", async () => {
    writeFileSync(join(tempDir, "test.txt"), "line 1\nline 2\nline 3\n");
    const res = await readFileContent(tempDir, "test.txt");
    expect(res.binary).toBe(false);
    expect(res.truncated).toBe(false);
    expect(res.lines).toBe(4);
    expect(res.content).toBe("line 1\nline 2\nline 3\n");
  });

  test("readFileContent: binary file returns empty content with binary: true", async () => {
    const binBuf = Buffer.from([65, 66, 0, 67, 68]);
    writeFileSync(join(tempDir, "image.png"), binBuf);
    const res = await readFileContent(tempDir, "image.png");
    expect(res.binary).toBe(true);
    expect(res.content).toBe("");
    expect(res.size).toBe(5);
  });

  test("readFileContent: 3MB file returns truncated: true with 2MB cap", async () => {
    const threeMbBuf = Buffer.alloc(3 * 1024 * 1024, "a".charCodeAt(0));
    writeFileSync(join(tempDir, "large.log"), threeMbBuf);
    const res = await readFileContent(tempDir, "large.log");
    expect(res.binary).toBe(false);
    expect(res.truncated).toBe(true);
    expect(res.size).toBe(3 * 1024 * 1024);
    expect(res.content.length).toBe(2 * 1024 * 1024);
  });

  test("readFileContent: path escape and outside symlink throw", async () => {
    // 1. Path escape
    expect(readFileContent(tempDir, "../../etc/passwd")).rejects.toThrow();

    // 2. Symlink pointing outside project
    const outsideFile = join(tmpdir(), `outside-secret-${Date.now()}.txt`);
    writeFileSync(outsideFile, "secret");
    try {
      symlinkSync(outsideFile, join(tempDir, "outside-link.txt"));
      expect(readFileContent(tempDir, "outside-link.txt")).rejects.toThrow();
    } finally {
      rmSync(outsideFile, { force: true });
    }
  });
});
