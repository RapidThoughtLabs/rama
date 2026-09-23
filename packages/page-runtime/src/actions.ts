// AGENT_BROWSER_PLAN.md AB4 — the four action ops (click/type/press/scroll). Pure-ish functions
// over a real `Element`/`Document`, unit-testable with `happy-dom` the same way walk.ts is: no
// `window.__rama*` globals here. `dom.ts` is the thin wrapper that resolves a `ref` against
// `window.__ramaRefs` (or produces the stale-ref error) and calls into these.
//
// Decision 6 — a full synthetic pointer sequence, not `el.click()`: bare `.click()` never fires
// `pointerover`/`pointerdown`/`mousedown`/`pointerup`/`mouseup`, so it misses every `:hover`-
// revealed menu and any widget listening for pointer events specifically (which is most of
// anything built with a modern component library). Decision 10 — a stale ref is always an error,
// never a best-effort re-resolve; that check lives in dom.ts, not here, since it needs the refs
// map this module deliberately doesn't touch.

export interface ActionResult {
  ok: boolean;
  /** Set only when `ok` is false because the action wasn't attempted at all — an element covering
   *  the target, for instance. Distinct from `error` only for this module's own tests; the wire
   *  protocol (AgentWebBridge.tsx) collapses both into one `error` string for the tool layer. */
  warning?: string;
  error?: string;
}

function truncate(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/** Short, non-selector description of an element for a "blocked by ..." message — not meant to be reused as a handle. */
function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const firstClass = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/)[0] : "";
  const text = (el.textContent || "").trim();
  return text ? `${tag}${firstClass} "${truncate(text, 60)}"` : `${tag}${firstClass}`;
}

function isSameOrAncestor(candidate: Element, target: Element): boolean {
  let cur: Element | null = target;
  while (cur) {
    if (cur === candidate) return true;
    cur = cur.parentElement;
  }
  return false;
}

export function dispatchClick(el: Element): ActionResult {
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  if (!view) return { ok: false, error: "element has no owner window" };

  el.scrollIntoView({ block: "center", inline: "nearest" });

  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return { ok: false, error: "element has no layout box (zero size) — it may be hidden" };
  }
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  // Decision from §4 (AB4 implementation notes): an element covering the target's center is a
  // real bug worth surfacing (an invisible modal swallowing clicks), not something to click
  // through. `elementFromPoint` returning null (jsdom-ish environments, or a point outside the
  // viewport) is not treated as "covered" — there's nothing there to be blocked by.
  const topEl = doc.elementFromPoint ? doc.elementFromPoint(x, y) : null;
  if (topEl && !isSameOrAncestor(topEl, el) && !isSameOrAncestor(el, topEl)) {
    return { ok: false, warning: `blocked by ${describeElement(topEl)} covering this element — did not click through it` };
  }

  const EventCtor = (view as typeof view & { PointerEvent?: typeof PointerEvent }).PointerEvent ?? view.MouseEvent;
  const init = { bubbles: true, cancelable: true, view, clientX: x, clientY: y, button: 0 };
  el.dispatchEvent(new EventCtor("pointerover", init));
  el.dispatchEvent(new EventCtor("pointerdown", init));
  el.dispatchEvent(new view.MouseEvent("mousedown", init));
  if (typeof (el as HTMLElement).focus === "function") (el as HTMLElement).focus();
  el.dispatchEvent(new EventCtor("pointerup", init));
  el.dispatchEvent(new view.MouseEvent("mouseup", init));
  el.dispatchEvent(new view.MouseEvent("click", init));

  return { ok: true };
}

function isContentEditableEl(el: Element): boolean {
  const attr = el.getAttribute("contenteditable");
  return attr === "" || attr === "true";
}

export function dispatchType(el: Element, text: string, submit?: boolean): ActionResult {
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  if (!view) return { ok: false, error: "element has no owner window" };

  const tag = el.tagName;
  const isInputLike = tag === "INPUT" || tag === "TEXTAREA";
  if (!isInputLike && !isContentEditableEl(el)) {
    return { ok: false, error: `ref does not point at an editable element (got <${tag.toLowerCase()}>)` };
  }

  if (typeof (el as HTMLElement).focus === "function") (el as HTMLElement).focus();

  if (isInputLike) {
    // React (and most controlled-input frameworks) install their own setter on the instance via
    // Object.defineProperty, and track changes through the *native* prototype setter — a plain
    // `el.value = text` gets silently swallowed because it hits the instance property, not the
    // one React's change-detection is watching. Going through the prototype's setter directly
    // is the one thing that makes `type` actually work on a controlled input.
    const proto = tag === "INPUT" ? view.HTMLInputElement.prototype : view.HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) {
      setter.call(el, text);
    } else {
      (el as HTMLInputElement).value = text;
    }
  } else {
    el.textContent = text;
  }

  el.dispatchEvent(new view.Event("input", { bubbles: true }));
  el.dispatchEvent(new view.Event("change", { bubbles: true }));

  if (submit) {
    const keyInit = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13, view };
    el.dispatchEvent(new view.KeyboardEvent("keydown", keyInit));
    el.dispatchEvent(new view.KeyboardEvent("keyup", keyInit));
    const form = (el as HTMLInputElement).form;
    if (form && typeof form.requestSubmit === "function") form.requestSubmit();
  }

  return { ok: true };
}

export function dispatchPress(doc: Document, key: string): ActionResult {
  const view = doc.defaultView;
  if (!view) return { ok: false, error: "document has no owner window" };
  const target: Element = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : doc.body || doc.documentElement;
  if (!target) return { ok: false, error: "no element to dispatch to" };
  const init = { bubbles: true, cancelable: true, key, view };
  target.dispatchEvent(new view.KeyboardEvent("keydown", init));
  target.dispatchEvent(new view.KeyboardEvent("keyup", init));
  return { ok: true };
}

export function dispatchScroll(doc: Document, to: "top" | "bottom" | number): ActionResult {
  const el = doc.scrollingElement || doc.documentElement;
  if (!el) return { ok: false, error: "no scrolling element" };
  const top = to === "top" ? 0 : to === "bottom" ? el.scrollHeight : to;
  el.scrollTo(0, top);
  return { ok: true };
}
