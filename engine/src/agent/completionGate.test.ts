// docs/PROMPT_STACK_PLAN.md §8.3, Phase PS6 — the display half (formatUnverifiedWrites) and the
// enforcement-text half (buildCompletionGateNudgeText) of the completion gate, tested independent
// of hooks.ts's actual retry wiring.
import { describe, expect, test } from "bun:test";
import { buildCompletionGateNudgeText, formatUnverifiedWrites } from "./completionGate";

describe("formatUnverifiedWrites", () => {
  test("empty set renders nothing", () => {
    expect(formatUnverifiedWrites(new Set())).toBeUndefined();
  });

  test("singular vs plural, and lists the file(s)", () => {
    expect(formatUnverifiedWrites(new Set(["a.ts"]))).toBe("1 file written · check not run since last edit (a.ts).");
    const two = formatUnverifiedWrites(new Set(["a.ts", "b.ts"]));
    expect(two).toContain("2 files written");
    expect(two).toContain("a.ts, b.ts");
  });

  test("caps the listed files and notes the remainder", () => {
    const files = new Set(Array.from({ length: 10 }, (_, i) => `f${i}.ts`));
    const text = formatUnverifiedWrites(files)!;
    expect(text).toContain("10 files written");
    expect(text).toContain("+2 more");
  });
});

describe("buildCompletionGateNudgeText", () => {
  test("renders the nudge with the file list and the check instruction", () => {
    const text = buildCompletionGateNudgeText(new Set(["a.ts"]));
    expect(text).toContain("a.ts");
    expect(text).toContain("Run check now");
  });
});

