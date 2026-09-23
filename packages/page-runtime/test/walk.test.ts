// AGENT_BROWSER_PLAN.md AB2 acceptance criteria: golden-file tests over three checked-in fixture
// pages, asserting both exact output (via bun:test's built-in `toMatchSnapshot`, which is the
// project's own golden-file mechanism — no need to hand-roll one) and a token budget. The budget
// uses a chars/4 approximation (documented, not a real tokenizer — see TOKEN_CHARS_PER_TOKEN)
// since no tokenizer is a dependency anywhere else in this repo either; it only needs to be
// conservative enough that "did this regress" stays a meaningful question.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { serializeSnapshot, walkDocument } from "../src/walk";

const TOKEN_CHARS_PER_TOKEN = 4;
const OUTLINE_TOKEN_BUDGET = 1_500;

function loadFixture(name: string): Document {
  const html = readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
  const win = new Window({ url: "https://example.com/" }) as unknown as { document: Document; close: () => void };
  win.document.write(html);
  return win.document;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_CHARS_PER_TOKEN);
}

const FIXTURES = ["app-shell.html", "docs-site.html", "heavy-feed.html"];

describe("AB2 walk.ts — snapshot golden files", () => {
  for (const fixture of FIXTURES) {
    test(`${fixture} outline serializes to the expected snapshot`, () => {
      const doc = loadFixture(fixture);
      const nodes = walkDocument(doc, { depth: "outline" });
      const text = serializeSnapshot(nodes, { pageId: "test", title: doc.title, url: "https://example.com/", gen: 1 });
      expect(text).toMatchSnapshot();
    });

    test(`${fixture} outline stays under the ${OUTLINE_TOKEN_BUDGET}-token budget`, () => {
      const doc = loadFixture(fixture);
      const nodes = walkDocument(doc, { depth: "outline" });
      const text = serializeSnapshot(nodes, { pageId: "test", title: doc.title, url: "https://example.com/", gen: 1 });
      expect(estimateTokens(text)).toBeLessThan(OUTLINE_TOKEN_BUDGET);
    });
  }
});

describe("AB2 walk.ts — specific rules", () => {
  test("app-shell: hidden modal and its contents never appear", () => {
    const doc = loadFixture("app-shell.html");
    const nodes = walkDocument(doc, { depth: "full" });
    expect(nodes.some((n) => n.name.includes("hidden and must not appear"))).toBe(false);
    expect(nodes.some((n) => n.name === "Close")).toBe(false);
  });

  test("app-shell: an empty search input reports (empty), a disabled button reports (disabled)", () => {
    const doc = loadFixture("app-shell.html");
    const nodes = walkDocument(doc, { depth: "full" });
    const search = nodes.find((n) => n.role === "searchbox");
    expect(search?.state).toBe("(empty)");
    const archive = nodes.find((n) => n.name === "Archive all");
    expect(archive?.state).toBe("(disabled)");
  });

  test("app-shell: refs are assigned in document order starting at 1", () => {
    const doc = loadFixture("app-shell.html");
    const nodes = walkDocument(doc, { depth: "full" });
    const refs = nodes.map((n) => n.ref).filter((r): r is number => r !== null);
    expect(refs).toEqual(refs.map((_, i) => i + 1));
  });

  test("docs-site: headings are unref'd and links are actionable", () => {
    const doc = loadFixture("docs-site.html");
    const nodes = walkDocument(doc, { depth: "full" });
    const h1 = nodes.find((n) => n.kind === "heading" && n.name === "Getting Started");
    expect(h1?.ref).toBeNull();
    const editLink = nodes.find((n) => n.name === "Edit this page");
    expect(editLink?.kind).toBe("actionable");
    expect(editLink?.href).toContain("edit/main/docs");
  });

  test("docs-site: outline depth omits prose text, full depth includes it", () => {
    const doc = loadFixture("docs-site.html");
    const outline = walkDocument(doc, { depth: "outline" });
    const full = walkDocument(doc, { depth: "full" });
    expect(outline.some((n) => n.kind === "text")).toBe(false);
    expect(full.some((n) => n.kind === "text")).toBe(true);
  });

  test("heavy-feed: 50 identical posts collapse to 3 shown plus one omission line", () => {
    const doc = loadFixture("heavy-feed.html");
    const nodes = walkDocument(doc, { depth: "outline" });
    const omitted = nodes.filter((n) => n.kind === "omitted");
    expect(omitted).toHaveLength(1);
    expect(omitted[0].omittedCount).toBe(47); // 50 posts, 3 kept
    // Each shown post contributes a link + a button; the feed's own heading is separate.
    const postLinks = nodes.filter((n) => n.role === "link" && n.name.startsWith("Post number"));
    expect(postLinks).toHaveLength(3);
  });

  test("heavy-feed: without dedup this fixture alone would blow the token budget", () => {
    // Not a walker test — a sanity check that the fixture is doing its job. If this ever fails,
    // the fixture stopped being "heavy" and the dedup test above stopped proving anything.
    const doc = loadFixture("heavy-feed.html");
    const raw = doc.querySelectorAll(".post").length;
    expect(raw).toBe(50);
    const roughUndedupedChars = raw * 160; // ~160 chars per post's 3 output lines, back-of-envelope
    expect(estimateTokens("x".repeat(roughUndedupedChars))).toBeGreaterThan(OUTLINE_TOKEN_BUDGET);
  });
});
