// docs/PROMPT_STACK_PLAN.md §8.1/§8.3, Phase PS6 — buildEphemeralText's pure formatting half, plus
// PS6's two new slots (taskComplexityHint, unverifiedWrites). getVolatileEnv/buildEphemeralMessage
// aren't covered here — they need real fs/git and aren't pure — same scope as before PS6.
import { describe, expect, test } from "bun:test";
import { buildEphemeralText, formatVolatileEnv, type VolatileEnv } from "./ephemeral";

const ENV: VolatileEnv = { date: "2026-09-08", git: { branch: "main", dirty: false } };

describe("buildEphemeralText", () => {
  test("volatile env alone, no PS6 slots populated", () => {
    const text = buildEphemeralText({ volatileEnv: ENV });
    expect(text).toContain(formatVolatileEnv(ENV));
    expect(text).not.toContain("check not run");
  });

  test("taskComplexityHint appears only when set", () => {
    const withHint = buildEphemeralText({ volatileEnv: ENV, taskComplexityHint: "ambiguous, consider clarify" });
    expect(withHint).toContain("ambiguous, consider clarify");
    const without = buildEphemeralText({ volatileEnv: ENV });
    expect(without).not.toContain("consider clarify");
  });

  test("unverifiedWrites appears only when set, independent of taskComplexityHint", () => {
    const text = buildEphemeralText({ volatileEnv: ENV, unverifiedWrites: "1 file written · check not run since last edit (a.ts)." });
    expect(text).toContain("check not run since last edit");
  });

  test("both PS6 slots and volatile env can coexist in one block", () => {
    const text = buildEphemeralText({
      volatileEnv: ENV,
      taskComplexityHint: "hint text",
      unverifiedWrites: "1 file written · check not run since last edit (a.ts).",
    });
    expect(text).toContain(formatVolatileEnv(ENV));
    expect(text).toContain("hint text");
    expect(text).toContain("check not run since last edit");
  });
});
