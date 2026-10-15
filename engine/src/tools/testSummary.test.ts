import { describe, expect, test } from "bun:test";
import { parseCommitLine, parseTestSummary, testSummarySuffix } from "./testSummary";

describe("parseTestSummary", () => {
  test("bun", () => {
    const out = "bun test v1.3.2\n\npackages/ui/src/theme.test.ts:\n(pass) a\n(pass) b\n\n 31 pass\n 0 fail\n 54 expect() calls\nRan 31 tests across 4 files. [412.00ms]";
    expect(parseTestSummary(out)).toEqual({ passed: 31, failed: 0 });
  });
  test("bun with failures", () => {
    expect(parseTestSummary(" 29 pass\n 2 fail\nRan 31 tests")).toEqual({ passed: 29, failed: 2 });
  });
  test("jest", () => {
    expect(parseTestSummary("Test Suites: 1 passed, 1 total\nTests:       1 failed, 30 passed, 31 total\nTime: 2s")).toEqual({ passed: 30, failed: 1 });
  });
  test("vitest", () => {
    expect(parseTestSummary(" Test Files  2 passed (2)\n      Tests  31 passed (31)\n   Duration  1.2s")).toEqual({ passed: 31, failed: 0 });
    expect(parseTestSummary("      Tests  1 failed | 30 passed (31)")).toEqual({ passed: 30, failed: 1 });
  });
  test("pytest", () => {
    expect(parseTestSummary("===================== 31 passed in 0.52s =====================")).toEqual({ passed: 31, failed: 0 });
    expect(parseTestSummary("=========== 1 failed, 30 passed, 2 warnings in 1.10s ===========")).toEqual({ passed: 30, failed: 1 });
  });
  test("cargo sums every test binary", () => {
    const out = "test result: ok. 12 passed; 0 failed; 0 ignored\n\ntest result: FAILED. 3 passed; 1 failed; 0 ignored";
    expect(parseTestSummary(out)).toEqual({ passed: 15, failed: 1 });
  });
  test("ignores output that is not a runner's summary", () => {
    expect(parseTestSummary("deploy: 3 passed the health check")).toBeNull();
    expect(parseTestSummary("")).toBeNull();
  });
  test("only reads the tail", () => {
    expect(parseTestSummary(` 5 pass\n 0 fail\n${"x".repeat(5000)}`)).toBeNull();
  });
});

describe("testSummarySuffix", () => {
  test("passed, failed (failures win) and nothing", () => {
    expect(testSummarySuffix(" 31 pass\n 0 fail")).toBe(" · 31 passed");
    expect(testSummarySuffix(" 29 pass\n 2 fail")).toBe(" · 2 failed");
    expect(testSummarySuffix("hello")).toBe("");
  });
});

describe("parseCommitLine", () => {
  test("branch and short sha", () => {
    expect(parseCommitLine("[main 4c1e9a2f3b] Apply the saved theme\n 4 files changed, 31 insertions(+)")).toBe("main 4c1e9a2");
    expect(parseCommitLine("[feature/x (root-commit) abc1234] first")).toBe("feature/x abc1234");
  });
  test("no match", () => {
    expect(parseCommitLine("nothing to commit")).toBeNull();
  });
});
