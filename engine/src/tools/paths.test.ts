// docs/COMPOSER_CONTEXT_PLAN.md Phase CC1 — resolveReadPath is the sandbox boundary for a chat's
// "+folder" extra roots (read/tree/grep/glob only, never edit/write/fileOp/gitWrite/git — those
// keep calling resolveInProject directly, untouched by this file). Worth its own coverage since a
// bug here is a real escape, not just a wrong answer.

import { describe, expect, test } from "bun:test";
import { resolveInProject, resolveReadPath } from "./paths";

const PROJECT = "/repo/project";
const EXTRA = "/repo/other";

describe("resolveInProject", () => {
  test("resolves a plain relative path", () => {
    expect(resolveInProject(PROJECT, "src/index.ts")).toBe("/repo/project/src/index.ts");
  });

  test("throws on a path that escapes via ..", () => {
    expect(() => resolveInProject(PROJECT, "../other/secret.txt")).toThrow();
  });

  test("throws on an absolute path outside the project", () => {
    expect(() => resolveInProject(PROJECT, "/repo/other/secret.txt")).toThrow();
  });
});

describe("resolveReadPath", () => {
  test("behaves exactly like resolveInProject for anything inside the project", () => {
    expect(resolveReadPath(PROJECT, [EXTRA], "src/index.ts")).toBe("/repo/project/src/index.ts");
  });

  test("allows an absolute path under a configured extra root", () => {
    expect(resolveReadPath(PROJECT, [EXTRA], "/repo/other/notes.md")).toBe("/repo/other/notes.md");
  });

  test("allows the extra root's own directory", () => {
    expect(resolveReadPath(PROJECT, [EXTRA], EXTRA)).toBe(EXTRA);
  });

  test("still throws for an absolute path under a directory that merely shares a prefix with an extra root", () => {
    expect(() => resolveReadPath(PROJECT, [EXTRA], "/repo/othersibling/file.txt")).toThrow();
  });

  test("throws for an absolute path outside every extra root", () => {
    expect(() => resolveReadPath(PROJECT, [EXTRA], "/etc/passwd")).toThrow();
  });

  test("throws for a relative .. escape even when extra roots are configured — only absolute paths reach them", () => {
    expect(() => resolveReadPath(PROJECT, [EXTRA], "../other/notes.md")).toThrow();
  });

  test("with no extra roots configured, behaves exactly like resolveInProject", () => {
    expect(() => resolveReadPath(PROJECT, [], "/repo/other/notes.md")).toThrow();
  });
});
