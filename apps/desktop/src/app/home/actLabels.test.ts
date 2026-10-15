import { describe, expect, test } from "bun:test";
import { errorSentence, liveThinkingAct, thinkingAct, toolAct, workingVerb } from "./actLabels";

const call = (name: string, input: unknown, ok: boolean | null = true, resultSummary: string | null = null) => ({ name, input, ok, resultSummary });

describe("thinkingAct", () => {
  test("seconds, a moment, and a lost duration", () => {
    expect(thinkingAct("x", 6200).label).toBe("Thought for 6 seconds");
    expect(thinkingAct("x", 1000).label).toBe("Thought for 1 second");
    expect(thinkingAct("x", 400).label).toBe("Thought for a moment");
    expect(thinkingAct("x", undefined).label).toBe("Thought it through");
  });
  test("the body is the thinking text, or nothing", () => {
    expect(thinkingAct("  weighed it  ", 3000).body).toEqual({ kind: "text", text: "weighed it" });
    expect(thinkingAct("", 3000).body).toBeNull();
  });
  test("live: Thinking with whole seconds", () => {
    const a = liveThinkingAct("hm", 2900);
    expect(a.label).toBe("Thinking");
    expect(a.meta).toBe("2 seconds");
  });
});

describe("toolAct", () => {
  test("read: file name and line count, never the tool name", () => {
    const a = toolAct(call("read", { path: "attachments/abc/lease.txt" }, true, "1-340 of 340 lines"));
    expect(a).toMatchObject({ icon: "doc", label: "Read lease.txt", meta: "340 lines" });
    expect(a.body).toEqual({ kind: "text", text: "Read the whole of lease.txt, on this Mac." });
    expect(JSON.stringify(a)).not.toContain("read ");
  });
  test("read: a partial read says which lines", () => {
    const a = toolAct(call("read", { path: "notes.md", offset: 200 }, true, "201-400 of 900 lines"));
    expect(a.body).toEqual({ kind: "text", text: "Read lines 201–400 of notes.md, on this Mac." });
  });
  test("read: images are looked at", () => {
    expect(toolAct(call("read", { path: "recipe-card.jpg" }, true, "image (2 MB)"))).toMatchObject({ icon: "image", label: "Looked at recipe-card.jpg" });
  });
  test("clarify lists the questions", () => {
    const a = toolAct(call("clarify", { questions: [{ question: "Which city?" }, { question: "When?" }] }));
    expect(a.label).toBe("Asked you a question");
    expect(a.body).toEqual({ kind: "list", items: [{ title: "Which city?" }, { title: "When?" }] });
  });
  test("web: search with a source count, fetch by host", () => {
    expect(toolAct(call("web", { query: "lisbon march" }, true, "6 results"))).toMatchObject({ label: "Searched the web", meta: "6 sources" });
    expect(toolAct(call("web", { url: "https://www.visitlisboa.com/en/events" }))).toMatchObject({ label: "Read visitlisboa.com" });
  });
  test("a failed call keeps its label and says it didn't work", () => {
    const a = toolAct(call("read", { path: "gone.pdf" }, false, "file not found: gone.pdf"));
    expect(a).toMatchObject({ label: "Read gone.pdf", meta: "didn't work", metaBad: true });
    expect(a.body).toEqual({ kind: "text", text: "file not found: gone.pdf" });
  });
  test("an unknown tool still doesn't show its name", () => {
    expect(toolAct(call("bash", { cmd: "ls" })).label).toBe("Used a tool");
  });
});

describe("workingVerb", () => {
  test("present tense", () => {
    expect(workingVerb(call("read", { path: "a/lease.pdf" }))).toBe("Reading lease.pdf");
    expect(workingVerb(call("read", { path: "card.png" }))).toBe("Looking at card.png");
    expect(workingVerb(call("web", { query: "q" }))).toBe("Searching the web");
    expect(workingVerb(call("clarify", {}))).toBe("Asking you a question");
  });
});

describe("web sources and PDFs", () => {
  test("sources from the result meta become the list", () => {
    const a = toolAct({ ...call("web", { query: "q" }), resultMeta: { sources: [{ title: "Lisbon climate averages", source: "IPMA" }, { title: "Tram 28", source: "Carris" }] } });
    expect(a.meta).toBe("2 sources");
    expect(a.body).toEqual({ kind: "list", items: [{ title: "Lisbon climate averages", source: "IPMA" }, { title: "Tram 28", source: "Carris" }] });
  });
  test("a PDF read reports pages", () => {
    expect(toolAct(call("read", { path: "lease-2026-draft.pdf" }, true, "14 pages"))).toMatchObject({ label: "Read lease-2026-draft.pdf", meta: "14 pages" });
  });
});

describe("errorSentence", () => {
  test("plain sentences, first line only", () => {
    expect(errorSentence("no Together AI key configured — add one in settings")).toContain("API key");
    expect(errorSentence("fetch failed\n  at x (y.ts:1)")).toContain("Couldn't reach");
    expect(errorSentence("boom\n  at stack")).toBe("Something went wrong with that reply: boom");
    expect(errorSentence(null)).toBe("Something went wrong with that reply.");
  });
});
