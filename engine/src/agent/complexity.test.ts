// docs/PROMPT_STACK_PLAN.md §8.1/§12 open question D, Phase PS6 — only the pure, synchronous
// heuristic tier is unit tested here (gatherComplexitySignals/classifyByHeuristic); the model-tier
// escalation (classifyByModel, reached only for a "borderline" verdict) mirrors titling.ts's
// untested-by-design network path exactly and is deliberately left to live verification, same as
// PS5's own sub-agent model-role plumbing.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { classifyByHeuristic, gatherComplexitySignals } from "./complexity";

let projectPath: string;

beforeEach(() => {
  projectPath = mkdtempSync(join(tmpdir(), "rama-complexity-"));
  writeFileSync(join(projectPath, "existing.ts"), "export {};\n");
});

afterEach(() => {
  rmSync(projectPath, { recursive: true, force: true });
});

describe("gatherComplexitySignals", () => {
  test("a short message with no markers has zero requirement markers", () => {
    const s = gatherComplexitySignals("fix the typo in the readme", projectPath);
    expect(s.requirementMarkers).toBe(0);
    expect(s.missingFiles).toEqual([]);
  });

  test("counts bullets, numbered lines, and connector phrases", () => {
    const text = "Do this:\n1. one\n2. two\n- three\nand also four; and five";
    const s = gatherComplexitySignals(text, projectPath);
    expect(s.requirementMarkers).toBeGreaterThanOrEqual(4);
  });

  test("flags a mentioned file that does not exist on disk", () => {
    const s = gatherComplexitySignals("update src/nonexistent-module.ts to fix the bug", projectPath);
    expect(s.missingFiles).toContain("src/nonexistent-module.ts");
  });

  test("does not flag a file that actually exists", () => {
    const s = gatherComplexitySignals("update existing.ts", projectPath);
    expect(s.missingFiles).not.toContain("existing.ts");
    expect(existsSync(join(projectPath, "existing.ts"))).toBe(true);
  });

  test("ignores URLs and bare decimals as path candidates", () => {
    const s = gatherComplexitySignals("see https://example.com/docs and bump to v2.0", projectPath);
    expect(s.missingFiles).toEqual([]);
  });
});

describe("classifyByHeuristic", () => {
  test("a typo fix is trivial — the PS6 exit criterion's negative case", () => {
    const signals = gatherComplexitySignals("fix the typo in the readme", projectPath);
    expect(classifyByHeuristic(signals)).toBe("trivial");
  });

  test("many distinct requirements plus missing files is complex without a model call", () => {
    const signals = {
      length: 900,
      requirementMarkers: 5,
      missingFiles: ["a.ts", "b.ts"],
    };
    expect(classifyByHeuristic(signals)).toBe("complex");
  });

  test("a middling signal set is borderline, not decided outright", () => {
    const signals = { length: 300, requirementMarkers: 1, missingFiles: [] };
    expect(classifyByHeuristic(signals)).toBe("borderline");
  });
});
