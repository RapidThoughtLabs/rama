// docs/PROMPT_STACK_PLAN.md §7.2, Phase PS7 — the two verification hooks: a fresh command
// candidate checked against package.json before it is trusted (verifyCommand), and every existing
// RAMA.md bullet re-checked so a since-deleted script or path surfaces as a removal proposal
// (findStaleEntries) instead of quietly lying to every future session.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setProjectInstructions } from "../instructions";
import { findStaleEntries, verifyCommand } from "./verify";

let projectPath: string;

beforeEach(() => {
  projectPath = mkdtempSync(join(tmpdir(), "rama-verify-"));
});

afterEach(() => {
  rmSync(projectPath, { recursive: true, force: true });
});

describe("verifyCommand", () => {
  test("a bare `npm test`/`bun test` needs no package.json at all", () => {
    expect(verifyCommand("bun test", projectPath)).toBe(true);
    expect(verifyCommand("npm test", projectPath)).toBe(true);
  });

  test("`npm run <script>` is trusted only once package.json actually has that script", () => {
    expect(verifyCommand("npm run build", projectPath)).toBe(false);
    writeFileSync(join(projectPath, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    expect(verifyCommand("npm run build", projectPath)).toBe(true);
    expect(verifyCommand("npm run lint", projectPath)).toBe(false);
  });

  test("a malformed package.json fails closed, not open", () => {
    writeFileSync(join(projectPath, "package.json"), "{ not json");
    expect(verifyCommand("npm run build", projectPath)).toBe(false);
  });
});

describe("findStaleEntries", () => {
  test("no RAMA.md means nothing to check", () => {
    expect(findStaleEntries(projectPath)).toEqual([]);
  });

  test("flags a `npm run <script>` bullet whose script is gone from package.json", () => {
    writeFileSync(join(projectPath, "package.json"), JSON.stringify({ scripts: {} }));
    setProjectInstructions(projectPath, "## Commands\n\n- Build: `npm run build`\n");
    const stale = findStaleEntries(projectPath);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toEqual({ section: "Commands", line: "Build: `npm run build`" });
  });

  test("does not flag a `npm run <script>` bullet whose script still exists", () => {
    writeFileSync(join(projectPath, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    setProjectInstructions(projectPath, "## Commands\n\n- Build: `npm run build`\n");
    expect(findStaleEntries(projectPath)).toEqual([]);
  });

  test("flags a bullet naming a path that no longer exists on disk", () => {
    setProjectInstructions(projectPath, "## Gotchas\n\n- Generated file, do not hand-edit: `src/generated/types.ts`\n");
    const stale = findStaleEntries(projectPath);
    expect(stale).toHaveLength(1);
    expect(stale[0].section).toBe("Gotchas");
  });

  test("does not flag a bullet naming a path that exists", () => {
    mkdirSync(join(projectPath, "src"), { recursive: true });
    writeFileSync(join(projectPath, "src", "index.ts"), "export {};\n");
    setProjectInstructions(projectPath, "## Orientation\n\n- Entry point: `src/index.ts`\n");
    expect(findStaleEntries(projectPath)).toEqual([]);
  });

  test("leaves a bullet with no backticked token, or a bare non-path token, alone", () => {
    setProjectInstructions(projectPath, "## Notes\n\n- Use bun, not npm, for everything.\n- Always run `test` first.\n");
    expect(findStaleEntries(projectPath)).toEqual([]);
  });
});
