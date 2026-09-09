// docs/PROMPT_STACK_PLAN.md §8.3, Phase PS6 — the display half (formatUnverifiedWrites) and the
// enforcement-message half (buildCompletionGateNudge) of the completion gate, tested independent
// of loop.ts's actual retry wiring.
import { describe, expect, test } from "bun:test";
import { buildCompletionGateNudge, formatUnverifiedWrites, MAX_COMPLETION_NUDGES } from "./completionGate";

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

describe("buildCompletionGateNudge", () => {
  test("system-role when the model supports mid-conversation system messages", () => {
    const msg = buildCompletionGateNudge(new Set(["a.ts"]), true);
    expect(msg.role).toBe("system");
    expect(msg.content).toContain("a.ts");
    expect(msg.content).toContain("Run check now");
  });

  test("falls back to a user-role message otherwise", () => {
    const msg = buildCompletionGateNudge(new Set(["a.ts"]), false);
    expect(msg.role).toBe("user");
  });
});

test("exactly one enforced nudge, not unbounded retries (§8.3 scope decision)", () => {
  expect(MAX_COMPLETION_NUDGES).toBe(1);
});
