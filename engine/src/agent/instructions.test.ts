// docs/PROMPT_STACK_PLAN.md §7.2, Phase PS7 — applyProposalToContent is the one function that
// actually turns an accepted curator proposal into a RAMA.md edit (decision 6: everything else in
// the curator only ever produces a proposal, never a write). Pure string transform, no filesystem.
import { describe, expect, test } from "bun:test";
import { applyProposalToContent } from "./instructions";

describe("applyProposalToContent", () => {
  test("add: creates a new section when the header doesn't exist yet", () => {
    const result = applyProposalToContent("", { kind: "add", section: "Commands", content: "Tests: `bun test`" });
    expect(result).toBe("## Commands\n- Tests: `bun test`\n");
  });

  test("add: appends under an existing header, before the next one", () => {
    const before = "## Commands\n\n- Build: `npm run build`\n\n## Gotchas\n\n- watch out for X\n";
    const result = applyProposalToContent(before, { kind: "add", section: "Commands", content: "Tests: `bun test`" });
    expect(result).toContain("- Build: `npm run build`\n- Tests: `bun test`\n\n## Gotchas");
  });

  test("add: is idempotent — an identical bullet already present is not duplicated", () => {
    const before = "## Commands\n\n- Tests: `bun test`\n";
    const result = applyProposalToContent(before, { kind: "add", section: "Commands", content: "Tests: `bun test`" });
    expect(result).toBe(before);
  });

  test("remove: deletes the exact matching bullet line and leaves the rest intact", () => {
    const before = "## Gotchas\n\n- stale entry: `deleted/script.sh`\n- keep this one\n";
    const result = applyProposalToContent(before, { kind: "remove", section: "Gotchas", content: "stale entry: `deleted/script.sh`" });
    expect(result).not.toContain("deleted/script.sh");
    expect(result).toContain("- keep this one");
  });

  test("remove: a no-longer-present line is a no-op, not an error", () => {
    const before = "## Gotchas\n\n- keep this one\n";
    const result = applyProposalToContent(before, { kind: "remove", section: "Gotchas", content: "never was here" });
    expect(result).toBe(before);
  });
});
