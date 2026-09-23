// AGENT_BROWSER_PLAN.md AB3 acceptance criteria: a fixture article extracts to markdown at <40%
// the token count of its innerText, and a fixture app-shell page falls back to innerText and says
// which path ran (not silently). Uses the same chars/4 token approximation walk.test.ts already
// established — no tokenizer dependency exists anywhere else in this repo either.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { extractArticle } from "../src/read";

const TOKEN_CHARS_PER_TOKEN = 4;

function loadFixture(name: string): Document {
  const html = readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
  const win = new Window({ url: "https://example.com/" }) as unknown as { document: Document };
  win.document.write(html);
  return win.document;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_CHARS_PER_TOKEN);
}

describe("AB3 read.ts — extractArticle", () => {
  test("a real article extracts to markdown under 40% of its innerText token count", () => {
    const doc = loadFixture("article.html");
    const innerTextTokens = estimateTokens(doc.body!.innerText);
    const result = extractArticle(doc);

    expect(result.mode).toBe("readability");
    expect(result.fallbackReason).toBeUndefined();
    const markdownTokens = estimateTokens(result.markdown);
    expect(markdownTokens).toBeLessThan(innerTextTokens * 0.4);
  });

  test("the extracted markdown keeps the article's own prose, not the surrounding chrome", () => {
    const doc = loadFixture("article.html");
    const result = extractArticle(doc);
    expect(result.markdown).toContain("A selector is a guess dressed up as an address");
    expect(result.markdown).not.toContain("Accept all");
    expect(result.markdown).not.toContain("Advertisement");
    expect(result.markdown).not.toContain("Share on X");
  });

  test("an app shell page falls back to innerText and says why", () => {
    const doc = loadFixture("app-shell.html");
    const result = extractArticle(doc);
    expect(result.mode).toBe("innerText");
    expect(result.fallbackReason).toBeTruthy();
    expect(result.markdown.length).toBeGreaterThan(0);
  });

  test("a docs page (headings + short paragraphs, no <article> shape Readability likes) also falls back honestly", () => {
    const doc = loadFixture("docs-site.html");
    const result = extractArticle(doc);
    // Whichever path it takes, the fallback flag must be consistent with the mode — this is the
    // "says which one it used" acceptance line, not a claim about which mode a short docs page
    // should get.
    if (result.mode === "innerText") {
      expect(result.fallbackReason).toBeTruthy();
    } else {
      expect(result.fallbackReason).toBeUndefined();
    }
  });

  test("an empty document falls back rather than throwing", () => {
    const win = new Window({ url: "https://example.com/" }) as unknown as { document: Document };
    win.document.write("<html><body></body></html>");
    const result = extractArticle(win.document);
    expect(result.mode).toBe("innerText");
    expect(result.fallbackReason).toBeTruthy();
  });
});
