import { describe, expect, test } from "bun:test";
import { THINKING_VERBS, pickThinkingVerb, workingTitle, workingVerb } from "./working";

describe("workingVerb", () => {
  test("generic thinking rotates every two seconds, starting with the whale verbs", () => {
    expect(workingVerb({ state: "thinking", verb: "thinking", elapsedSeconds: 0 })).toBe("Diving in");
    expect(workingVerb({ state: "thinking", verb: "thinking", elapsedSeconds: 2 })).toBe("Surfacing");
    expect(pickThinkingVerb(2 * THINKING_VERBS.length)).toBe(THINKING_VERBS[0]!);
  });
  test("specific verbs are plain sentences and never rotate", () => {
    expect(workingVerb({ state: "waiting_permission", elapsedSeconds: 9 })).toBe("Waiting for your OK");
    expect(workingVerb({ state: "thinking", verb: "compacting", elapsedSeconds: 9 })).toBe("Compacting the conversation");
    expect(workingVerb({ state: "streaming", verb: "responding", elapsedSeconds: 9 })).toBe("Writing");
    expect(workingVerb({ state: "tool", verb: "running bash", runningLabel: "Running bun test", elapsedSeconds: 9 })).toBe("Running bun test");
    expect(workingVerb({ state: "tool", verb: "running bash", elapsedSeconds: 9 })).toBe("Working on it");
  });
});

describe("workingTitle", () => {
  test("elapsed, tokens, and thinking only once it is a second or more", () => {
    expect(workingTitle(12, 340, 0)).toBe("12s · ↓ 340 tokens");
    expect(workingTitle(12, 340, 4)).toBe("12s · ↓ 340 tokens · thought for 4s");
  });
});
