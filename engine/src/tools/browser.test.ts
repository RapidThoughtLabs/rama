// AGENT_BROWSER_PLAN.md AB5 — unit tests for `formatActionOutcome`, the pure formatter that
// assembles §6.2's "clicked / settled / diff / console" block. This is the one piece of AB5's
// acceptance criteria that can run in a plain `bun test` process: the fixture-app "click → 400ms
// delayed fetch → diff contains the rendered content" regression lives in
// packages/page-runtime/test/dom.test.ts instead, since it needs a real (happy-dom) document to
// walk and diff — this file only checks what the model actually reads once that data comes back
// over the wire.

import { describe, expect, test } from "bun:test";
import { formatActionOutcome, type ActionOutcomeFields } from "./browser";

// Same chars/4 approximation packages/page-runtime/test/walk.test.ts already uses for its own
// token-budget assertion — no real tokenizer is a dependency anywhere in this repo.
const TOKEN_CHARS_PER_TOKEN = 4;
const STEP_TOKEN_BUDGET = 300;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_CHARS_PER_TOKEN);
}

describe("AB5 formatActionOutcome", () => {
  test("a settled action with no changes reports that plainly", () => {
    const out = formatActionOutcome("clicked [4]", {
      settleReason: "network idle, dom stable",
      settleMs: 812,
      genFrom: 3,
      gen: 4,
      diff: [],
    });
    expect(out).toContain("clicked [4]");
    expect(out).toContain("settled in 0.8s (network idle, dom stable)");
    expect(out).toContain("gen 3 → 4");
    expect(out).toContain("(no changes)");
  });

  test("a diff is shown verbatim, one change per line", () => {
    const out = formatActionOutcome("clicked [4]", {
      settleReason: "network idle, dom stable",
      settleMs: 200,
      diff: ['+ [5]  button    "Pause"', '- [6]  button    "Sign in"'],
    });
    expect(out).toContain('+ [5]  button    "Pause"');
    expect(out).toContain('- [6]  button    "Sign in"');
  });

  test("a timeout is reported without duplicating the duration", () => {
    const out = formatActionOutcome("clicked [4]", {
      settleReason: "timed out after 5s (2 requests still in flight)",
      settleMs: 5000,
      genFrom: 3,
      gen: 4,
      diff: [],
    });
    expect(out).toContain("settled: timed out after 5s (2 requests still in flight)");
    expect(out).not.toContain("settled in");
  });

  test("full:true shows the snapshot text, not a diff", () => {
    const out = formatActionOutcome("clicked [4]", {
      settleReason: "network idle, dom stable",
      settleMs: 500,
      genFrom: 1,
      gen: 2,
      full: true,
      snapshot: 'page test — "Player" — https://example.com/  (gen 2)\n\n[1] button    "Pause"\n\n1 interactive elements',
    });
    expect(out).toContain('[1] button    "Pause"');
    expect(out).not.toContain("(no changes)");
  });

  test("console/network delta is appended with a count", () => {
    const out = formatActionOutcome("clicked [4]", {
      settleReason: "network idle, dom stable",
      settleMs: 500,
      diff: [],
      consoleLogs: ["error: TypeError: Cannot read properties of undefined (reading 'id')"],
    });
    expect(out).toContain("1 console/network entry since:");
    expect(out).toContain("error: TypeError");
  });

  test("no settleReason at all (a failed/blocked dispatch) omits the settle line entirely", () => {
    const out = formatActionOutcome("clicked [4]", {});
    expect(out).not.toContain("settled");
  });
});

describe("AB5 acceptance — a 10-step scripted run stays under budget", () => {
  // A realistic sequence: navigate a form, submit it, scroll and paginate a feed, hit a flaky
  // endpoint that times out, search, and open a result — the kind of run a test scenario (AB7)
  // would actually replay. §6.2's own budget line: "under 300 tokens for a typical step."
  test("10 realistic action results average under the 300-token step budget", () => {
    const steps: { verb: string; res: ActionOutcomeFields }[] = [
      {
        verb: "clicked [3]",
        res: {
          settleReason: "network idle, dom stable",
          settleMs: 620,
          genFrom: 1,
          gen: 2,
          diff: ['+ [4]  button    "Confirm"', '+ [5]  textbox   "Email"  (empty)'],
        },
      },
      {
        verb: "typed into [5]",
        res: {
          settleReason: "network idle, dom stable",
          settleMs: 210,
          genFrom: 2,
          gen: 3,
          diff: ['~ [5]  textbox   (empty) → (value: "a@b.com")'],
        },
      },
      {
        verb: "clicked [4]",
        res: {
          settleReason: "network idle, dom stable",
          settleMs: 940,
          genFrom: 3,
          gen: 4,
          diff: ['- [4]  button    "Confirm"', '+ [6]  heading   "Welcome back"'],
        },
      },
      {
        verb: "pressed Escape",
        res: { settleReason: "network idle, dom stable", settleMs: 310, genFrom: 4, gen: 5, diff: [] },
      },
      {
        verb: "scrolled to bottom",
        res: {
          settleReason: "network idle, dom stable",
          settleMs: 400,
          genFrom: 5,
          gen: 6,
          diff: ['+ [7]  button    "Load more"'],
        },
      },
      {
        verb: "clicked [7]",
        res: {
          settleReason: "network idle, dom stable",
          settleMs: 1_100,
          genFrom: 6,
          gen: 7,
          diff: ['+ [8]  link      "Item 21"', '+ [9]  link      "Item 22"', '+ [10] link      "Item 23"'],
        },
      },
      {
        verb: "clicked [2]",
        res: {
          settleReason: "timed out after 5s (1 request still in flight)",
          settleMs: 5_000,
          genFrom: 7,
          gen: 8,
          diff: [],
        },
      },
      {
        verb: "typed into [9]",
        res: {
          settleReason: "network idle, dom stable",
          settleMs: 180,
          genFrom: 8,
          gen: 9,
          diff: ['~ [9]  textbox   (empty) → (value: "search term")'],
        },
      },
      {
        verb: "pressed Enter",
        res: {
          settleReason: "network idle, dom stable",
          settleMs: 730,
          genFrom: 9,
          gen: 10,
          diff: ['+ [11] heading   "12 results"', '- [9]  textbox   "search term"'],
          consoleLogs: ["error: network: GET /api/search → 500 (142ms)"],
        },
      },
      {
        verb: "clicked [11]",
        res: { settleReason: "network idle, dom stable", settleMs: 500, genFrom: 10, gen: 11, diff: [] },
      },
    ];

    const total = steps.reduce((sum, { verb, res }) => sum + estimateTokens(formatActionOutcome(verb, res)), 0);
    const average = total / steps.length;
    expect(average).toBeLessThan(STEP_TOKEN_BUDGET);
  });
});
