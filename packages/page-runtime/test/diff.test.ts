// AGENT_BROWSER_PLAN.md AB5 — diffSnapshot is pure over two WalkNode[] arrays (no window/document
// globals beyond Element.parentElement/.children), so it's tested directly against walk.ts's own
// walkDocument, the same "exercise the real pipeline, not a hand-built node list" approach
// walk.test.ts takes with its fixtures.

import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { walkDocument } from "../src/walk";
import { diffSnapshot } from "../src/diff";

function doc(html: string): Document {
  const win = new Window({ url: "https://example.com/" }) as unknown as { document: Document };
  win.document.write(`<html><body>${html}</body></html>`);
  return win.document;
}

describe("AB5 diff.ts — diffSnapshot", () => {
  test("no changes between two walks of the same unchanged document is an empty diff", () => {
    const d = doc('<button id="a">A</button><h1>Title</h1>');
    const prev = walkDocument(d, { depth: "outline" });
    const next = walkDocument(d, { depth: "outline" });
    expect(diffSnapshot(prev, next)).toEqual([]);
  });

  test("a newly-appeared element is a + line, in document order", () => {
    const d = doc('<div id="out"></div>');
    const prev = walkDocument(d, { depth: "outline" });
    d.getElementById("out")!.innerHTML = '<button id="a">Pause</button><input id="b" placeholder="Seek"/>';
    const next = walkDocument(d, { depth: "outline" });

    const lines = diffSnapshot(prev, next);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith("+");
    expect(lines[0]).toContain("Pause");
    expect(lines[1]).toStartWith("+");
  });

  test("a removed element is a - line", () => {
    const d = doc('<div id="out"><button id="a">Sign in</button></div>');
    const prev = walkDocument(d, { depth: "outline" });
    d.getElementById("a")!.remove();
    const next = walkDocument(d, { depth: "outline" });

    const lines = diffSnapshot(prev, next);
    expect(lines).toEqual([expect.stringContaining("Sign in")]);
    expect(lines[0]).toStartWith("-");
  });

  test("a heading whose text changed in place is a ~ line, not a remove+add pair", () => {
    const d = doc("<h1>YouTube</h1>");
    const prev = walkDocument(d, { depth: "outline" });
    d.querySelector("h1")!.textContent = "Rick Astley - Never Gonna Give You Up - YouTube";
    const next = walkDocument(d, { depth: "outline" });

    const lines = diffSnapshot(prev, next);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("~");
    expect(lines[0]).toContain('"YouTube" → "Rick Astley - Never Gonna Give You Up - YouTube"');
  });

  test("a checkbox's checked state changing in place is a ~ line", () => {
    const d = doc('<input id="c" type="checkbox"/>');
    const prev = walkDocument(d, { depth: "outline" });
    (d.getElementById("c") as HTMLInputElement).checked = true;
    const next = walkDocument(d, { depth: "outline" });

    const lines = diffSnapshot(prev, next);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("~");
    expect(lines[0]).toContain("(unchecked) → (checked)");
  });

  test("diffing against no prior snapshot reports everything currently on the page as added", () => {
    const d = doc('<button id="a">A</button><button id="b">B</button>');
    const next = walkDocument(d, { depth: "outline" });
    const lines = diffSnapshot([], next);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.startsWith("+"))).toBe(true);
  });

  test("a very large diff is capped with an omission line rather than blowing the token budget", () => {
    const d = doc('<div id="out"></div>');
    const prev = walkDocument(d, { depth: "outline" });
    const out = d.getElementById("out")!;
    for (let i = 0; i < 60; i++) out.innerHTML += `<button id="btn${i}">Item ${i}</button>`;
    const next = walkDocument(d, { depth: "outline" });

    const lines = diffSnapshot(prev, next);
    expect(lines.length).toBeLessThanOrEqual(41); // 40 shown + 1 omission line
    expect(lines[lines.length - 1]).toContain("more changes omitted");
  });

  test("text/omitted nodes never appear in the diff even when they change", () => {
    const d = doc('<p id="p">before</p>');
    const prev = walkDocument(d, { depth: "full" });
    d.getElementById("p")!.textContent = "after";
    const next = walkDocument(d, { depth: "full" });
    expect(diffSnapshot(prev, next)).toEqual([]);
  });
});
