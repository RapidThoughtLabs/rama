// AGENT_BROWSER_PLAN.md AB4 acceptance criteria (the parts that don't need a live fixture app):
// a full pointer sequence fires on click, a controlled-input-style `type` actually changes state
// via the native setter, a covered element is reported rather than clicked through, and press/
// scroll dispatch what they say they do. Ref resolution and the stale-ref/gen-mismatch errors are
// dom.test.ts's job — this file only covers actions.ts's dispatch functions directly.
//
// happy-dom has no real layout engine: `getBoundingClientRect()` always returns an all-zero rect
// and `elementFromPoint()` always returns null. Both are monkey-patched per test on the specific
// element/document instances under test — same trick a browser automation test suite uses against
// any DOM double that doesn't paint pixels.

import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { dispatchClick, dispatchPress, dispatchScroll, dispatchType } from "../src/actions";

function makeDoc(html: string) {
  const win = new Window({ url: "https://example.com/" }) as unknown as {
    document: Document;
    HTMLInputElement: { prototype: unknown };
  };
  win.document.write(`<html><body>${html}</body></html>`);
  return win.document;
}

function stubRect(el: Element, rect: Partial<DOMRect>) {
  (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, ...rect }) as DOMRect;
}

describe("AB4 actions.ts — dispatchClick", () => {
  test("fires the full pointer sequence and returns ok", () => {
    const doc = makeDoc('<button id="b">Go</button>');
    const btn = doc.getElementById("b")!;
    stubRect(btn, {});
    (doc as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => btn;

    const seen: string[] = [];
    for (const type of ["pointerover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      btn.addEventListener(type, () => seen.push(type));
    }
    const result = dispatchClick(btn);
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual(["pointerover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
  });

  test("a zero-size element is reported instead of silently clicked", () => {
    const doc = makeDoc('<button id="b">Go</button>');
    const btn = doc.getElementById("b")!;
    // No stubRect() — happy-dom's real getBoundingClientRect() is already all-zero, exactly the
    // "hidden/unlaid-out element" case this guard exists for.
    const result = dispatchClick(btn);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no layout box");
  });

  test("an unrelated element covering the target is reported, not clicked through", () => {
    const doc = makeDoc('<button id="b">Go</button><div id="overlay" class="modal-backdrop">Please wait</div>');
    const btn = doc.getElementById("b")!;
    const overlay = doc.getElementById("overlay")!;
    stubRect(btn, {});
    (doc as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => overlay;

    let clicked = false;
    btn.addEventListener("click", () => (clicked = true));
    const result = dispatchClick(btn);
    expect(result.ok).toBe(false);
    expect(result.warning).toContain("blocked by");
    expect(result.warning).toContain("modal-backdrop");
    expect(clicked).toBe(false);
  });

  test("elementFromPoint returning the target's own descendant is not treated as covered", () => {
    const doc = makeDoc('<button id="b"><span id="label">Go</span></button>');
    const btn = doc.getElementById("b")!;
    const label = doc.getElementById("label")!;
    stubRect(btn, {});
    (doc as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => label;

    const result = dispatchClick(btn);
    expect(result).toEqual({ ok: true });
  });
});

describe("AB4 actions.ts — dispatchType", () => {
  test("sets value through the native setter and fires input+change (the controlled-input path)", () => {
    const doc = makeDoc('<input id="i" value=""/>');
    const input = doc.getElementById("i") as HTMLInputElement;
    let seenOnInput = "";
    let changeFired = false;
    input.addEventListener("input", (e) => (seenOnInput = (e.target as HTMLInputElement).value));
    input.addEventListener("change", () => (changeFired = true));

    const result = dispatchType(input, "hello world");
    expect(result).toEqual({ ok: true });
    expect(input.value).toBe("hello world");
    expect(seenOnInput).toBe("hello world");
    expect(changeFired).toBe(true);
  });

  test("submit:true fires an Enter keypress and calls the form's requestSubmit", () => {
    const doc = makeDoc('<form id="f"><input id="i"/></form>');
    const form = doc.getElementById("f") as HTMLFormElement;
    const input = doc.getElementById("i") as HTMLInputElement;
    let submitCalled = false;
    (form as unknown as { requestSubmit: () => void }).requestSubmit = () => (submitCalled = true);
    const keys: string[] = [];
    input.addEventListener("keydown", (e) => keys.push("down:" + (e as KeyboardEvent).key));
    input.addEventListener("keyup", (e) => keys.push("up:" + (e as KeyboardEvent).key));

    const result = dispatchType(input, "go", true);
    expect(result).toEqual({ ok: true });
    expect(keys).toEqual(["down:Enter", "up:Enter"]);
    expect(submitCalled).toBe(true);
  });

  test("a contenteditable element gets its textContent set instead of .value", () => {
    const doc = makeDoc('<div id="e" contenteditable="true"></div>');
    const el = doc.getElementById("e")!;
    const result = dispatchType(el, "note to self");
    expect(result).toEqual({ ok: true });
    expect(el.textContent).toBe("note to self");
  });

  test("a non-editable element is rejected rather than silently doing nothing", () => {
    const doc = makeDoc('<div id="d">not an input</div>');
    const el = doc.getElementById("d")!;
    const result = dispatchType(el, "text");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("editable");
  });
});

describe("AB4 actions.ts — dispatchPress / dispatchScroll", () => {
  test("dispatchPress fires keydown+keyup on the focused element", () => {
    const doc = makeDoc('<input id="i"/>');
    const input = doc.getElementById("i") as HTMLInputElement;
    input.focus();
    const keys: string[] = [];
    input.addEventListener("keydown", (e) => keys.push("down:" + (e as KeyboardEvent).key));
    input.addEventListener("keyup", (e) => keys.push("up:" + (e as KeyboardEvent).key));

    const result = dispatchPress(doc, "Escape");
    expect(result).toEqual({ ok: true });
    expect(keys).toEqual(["down:Escape", "up:Escape"]);
  });

  test("dispatchScroll resolves top/bottom/number to the right scrollTo call", () => {
    const doc = makeDoc('<div style="height:5000px"></div>');
    const scrollEl = (doc.scrollingElement || doc.documentElement) as HTMLElement & { scrollHeight: number };
    Object.defineProperty(scrollEl, "scrollHeight", { value: 5000, configurable: true });
    const calls: [number, number][] = [];
    (scrollEl as unknown as { scrollTo: (x: number, y: number) => void }).scrollTo = (x: number, y: number) => calls.push([x, y]);

    expect(dispatchScroll(doc, "top")).toEqual({ ok: true });
    expect(dispatchScroll(doc, "bottom")).toEqual({ ok: true });
    expect(dispatchScroll(doc, 250)).toEqual({ ok: true });
    expect(calls).toEqual([
      [0, 0],
      [0, 5000],
      [0, 250],
    ]);
  });
});
