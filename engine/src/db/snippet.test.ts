// HOME_REDESIGN_PLAN.md Phase HD3 — the Home sidebar snippet.
import { describe, expect, test } from "bun:test";
import { SNIPPET_MAX, snippetFromText, waitingSnippet } from "./snippet";

describe("snippetFromText", () => {
  test("empty, null and whitespace-only text give null", () => {
    expect(snippetFromText(null)).toBeNull();
    expect(snippetFromText("")).toBeNull();
    expect(snippetFromText("   \n\n ")).toBeNull();
  });

  test("takes the first sentence", () => {
    expect(snippetFromText("The lease looks fine. Two clauses need a second look.")).toBe("The lease looks fine.");
    expect(snippetFromText("Really? Yes.")).toBe("Really?");
  });

  test("a decimal or a dotted name doesn't end the sentence", () => {
    expect(snippetFromText("Rent goes up 3.5% next year. That's normal.")).toBe("Rent goes up 3.5% next year.");
  });

  test("strips markdown: headings, emphasis, links, inline code, list markers, quotes", () => {
    expect(snippetFromText("## Summary\n\n**Short version:** the [deposit](https://x.y) is `refundable`.")).toBe(
      "Summary Short version: the deposit is refundable.",
    );
    expect(snippetFromText("- first *point* here\n- second")).toBe("first point here second");
    expect(snippetFromText("> quoted _words_ only")).toBe("quoted words only");
  });

  test("code and draft fences are dropped whole, even unterminated", () => {
    expect(snippetFromText("Here it is:\n```draft Email draft\nHi Sam. Thanks.\n```\nSend when ready.")).toBe("Here it is: Send when ready.");
    expect(snippetFromText("```ts\nconst a = 1;\n```")).toBeNull();
    expect(snippetFromText("Working on it\n```py\nprint(1)")).toBe("Working on it");
  });

  test("tables are dropped", () => {
    expect(snippetFromText("| a | b |\n|---|---|\n| 1 | 2 |\n\nOption A wins.")).toBe("Option A wins.");
  });

  test("long text is cut at a word boundary with an ellipsis, within the limit", () => {
    const long = "word ".repeat(80).trim();
    const out = snippetFromText(long)!;
    expect(out.length).toBeLessThanOrEqual(SNIPPET_MAX);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain(" …");
  });
});

// CODE_REDESIGN_PLAN.md CR8 — the Code landing's resume row for a chat that is waiting on an ask.
describe("waitingSnippet", () => {
  test("names what a yes would do", () => {
    expect(waitingSnippet("git_write", { op: "commit", message: "x" })).toBe("Waiting for your OK to commit.");
    expect(waitingSnippet("bash", { command: "rm -rf dist" })).toBe("Waiting for your OK to run a command.");
    expect(waitingSnippet("edit", { path: "a.ts" })).toBe("Waiting for your OK to edit a file.");
    expect(waitingSnippet("browser", { action: "click" })).toBe("Waiting for your OK to use the browser.");
  });

  test("an unknown tool or a missing input still reads as a sentence", () => {
    expect(waitingSnippet("mystery", null)).toBe("Waiting for your OK to continue.");
    expect(waitingSnippet("git_write", undefined)).toBe("Waiting for your OK to change git.");
  });
});
