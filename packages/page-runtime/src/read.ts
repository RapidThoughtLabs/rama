// AGENT_BROWSER_PLAN.md AB3 — `read` v2: §6.3's Readability → Turndown → markdown pipeline, with
// an `innerText` fallback for pages Readability declines (it's tuned for articles and will
// correctly refuse an app shell, a dashboard, a form). Which path ran is part of the result, not
// hidden — a model acting on `read`'s output needs to know whether it's looking at a curated
// extract or a raw text dump before it draws conclusions from what's *missing*.

import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

export interface ReadResult {
  markdown: string;
  mode: "readability" | "innerText";
  /** Only set when `mode` is "innerText" — why Readability's output was rejected. */
  fallbackReason?: string;
}

// Readability can "succeed" on an app shell with a three-word result (whatever text happens to
// sit in the biggest single container) — that's not an article, it's noise that looks confident.
// Rejecting anything this short falls back to innerText, which is at least honestly complete.
const MIN_ARTICLE_CHARS = 200;
const INNER_TEXT_CAP = 20_000;

export function extractArticle(doc: Document): ReadResult {
  const fallback = (reason: string): ReadResult => ({
    markdown: (doc.body?.innerText || "").slice(0, INNER_TEXT_CAP),
    mode: "innerText",
    fallbackReason: reason,
  });

  let article: { content: string; textContent: string } | null = null;
  try {
    // Per @mozilla/readability's own documented usage: Readability mutates the document it's
    // given, so it always runs against a clone, never the live page the user (or a later `snapshot`
    // in the same session) is still looking at.
    const clone = doc.cloneNode(true) as Document;
    article = new Readability(clone).parse();
  } catch (e) {
    return fallback(`Readability threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!article || !article.content) {
    return fallback("Readability declined this page — it doesn't look like an article");
  }
  if (article.textContent.trim().length < MIN_ARTICLE_CHARS) {
    return fallback("extracted content too short to be a real article");
  }

  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  const markdown = turndown.turndown(article.content).trim();
  return { markdown, mode: "readability" };
}
