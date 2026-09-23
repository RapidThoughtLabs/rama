// AGENT_BROWSER_PLAN.md AB4 — unit tests for the DB-free half of the loopback-vs-ask decision
// (isLoopbackOrigin, decideBrowserActionRule). The DB-backed wrapper (resolveBrowserActionRule)
// isn't tested here — this repo has no precedent for standing up a fixture project/settings store
// in a test, and the pure logic is the part actually worth pinning down.

import { describe, expect, test } from "bun:test";
import { decideBrowserActionRule, isLoopbackOrigin } from "./permissions";

describe("AB4 isLoopbackOrigin", () => {
  test.each([
    ["http://localhost:5173", true],
    ["http://127.0.0.1:8080", true],
    ["http://foo.localhost:3000", true],
    ["https://github.com", false],
    ["https://www.youtube.com", false],
    [undefined, false],
    ["not a url", false],
  ])("%s -> %s", (origin, expected) => {
    expect(isLoopbackOrigin(origin as string | undefined)).toBe(expected);
  });
});

describe("AB4 decideBrowserActionRule", () => {
  test("no explicit override: loopback auto-allows", () => {
    expect(decideBrowserActionRule(undefined, "http://localhost:5173")).toBe("allow");
  });

  test("no explicit override: a real origin asks", () => {
    expect(decideBrowserActionRule(undefined, "https://github.com")).toBe("ask");
  });

  test("no explicit override and no known origin: asks (safe default, not allow)", () => {
    expect(decideBrowserActionRule(undefined, undefined)).toBe("ask");
  });

  test("an explicit project/global rule overrides the loopback default in both directions", () => {
    expect(decideBrowserActionRule("deny", "http://localhost:5173")).toBe("deny");
    expect(decideBrowserActionRule("allow", "https://github.com")).toBe("allow");
  });
});
