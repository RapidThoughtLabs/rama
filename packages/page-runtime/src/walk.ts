// AGENT_BROWSER_PLAN.md AB2 — the ref-tree walker. A pure function over a `Document`: no
// `window.__rama*` globals, no Tauri, nothing that only exists inside a real webview. That's
// what makes it unit-testable with `happy-dom` in plain `bun test` (see test/walk.test.ts) —
// `dom.ts` is the thin browser-side wrapper that assigns the returned nodes' refs into
// `window.__ramaRefs` and bumps `window.__ramaGen`.
//
// §6.1's rules, in order of how much of a real page's noise they remove:
//  - only actionable nodes (links, buttons, form controls, explicit interactive roles,
//    `[onclick]`, `[tabindex>=0]`, contenteditable) get a ref: `click 12` must never be
//    hallucinated onto a different element, so only elements the page itself calls out as
//    interactive are numbered.
//  - invisible subtrees are pruned entirely, not walked past — `aria-hidden`, `hidden`,
//    `display:none`, `visibility:hidden`/`collapse`.
//  - "wrapper chains collapse": an element with no direct text of its own (all its text lives in
//    descendants) contributes no output line — the walker just recurses through it. Only an
//    element whose *own* child text nodes are non-empty becomes a "text" line, and having one
//    doesn't stop the walker recursing into that element's child *elements* too (a `<div>Say
//    hello <button>Hi</button></div>` yields a text line and a button, not a single blob).
//  - actionable elements and headings are leaves for this walker's purposes — it does not
//    recurse into a button's or heading's children, both to avoid nested/invalid-HTML edge cases
//    and because an accessible-name computation over the subtree already captured what's there.
//  - repeated sibling structure (identical tag + class + explicit role, no `id`) collapses after
//    the third occurrence into one omission line with a count — this is where most of a real
//    site's size actually comes from (feeds, nav lists, table rows).

import { computeAccessibleName } from "dom-accessibility-api";

export type WalkKind = "actionable" | "heading" | "text" | "omitted" | "iframe-cross-origin";

export interface WalkNode {
  kind: WalkKind;
  /** Assigned in document order to `kind === "actionable"` nodes only, starting at 1. */
  ref: number | null;
  role: string;
  name: string;
  state?: string;
  href?: string;
  /** Only set on `kind === "omitted"` — how many siblings were collapsed. */
  omittedCount?: number;
  element: Element | null;
}

export interface WalkOptions {
  /** "outline" (default) drops plain-text lines; "full" keeps everything. */
  depth?: "outline" | "full";
  maxTextLength?: number;
}

const DEFAULT_MAX_TEXT = 120;

const ACTIONABLE_ROLES = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "slider",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "option",
]);

const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);

function truncate(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

function inputRole(el: Element): string {
  const type = (el.getAttribute("type") || "text").toLowerCase();
  switch (type) {
    case "button":
    case "submit":
    case "reset":
    case "image":
      return "button";
    case "checkbox":
      return "checkbox";
    case "radio":
      return "radio";
    case "range":
      return "slider";
    case "search":
      return "searchbox";
    case "hidden":
      return "none";
    default:
      return "textbox";
  }
}

function implicitRole(el: Element): string | null {
  switch (el.tagName) {
    case "A":
      return el.hasAttribute("href") ? "link" : null;
    case "BUTTON":
      return "button";
    case "SELECT":
      return el.hasAttribute("multiple") ? "listbox" : "combobox";
    case "TEXTAREA":
      return "textbox";
    case "INPUT":
      return inputRole(el);
    default:
      return HEADING_TAGS.has(el.tagName) ? "heading" : null;
  }
}

function isContentEditable(el: Element): boolean {
  const attr = el.getAttribute("contenteditable");
  return attr === "" || attr === "true";
}

/** Returns the ARIA role that makes `el` actionable, or null if it isn't. */
function actionableRole(el: Element): string | null {
  const explicit = el.getAttribute("role");
  if (explicit && ACTIONABLE_ROLES.has(explicit)) return explicit;

  const implicit = implicitRole(el);
  if (implicit && ACTIONABLE_ROLES.has(implicit)) return implicit;

  if (isContentEditable(el)) return "textbox";

  const tabindex = el.getAttribute("tabindex");
  if (tabindex !== null && Number(tabindex) >= 0) return implicit ?? "generic";

  if (el.hasAttribute("onclick")) return implicit ?? "button";

  return null;
}

function getStyle(el: Element): CSSStyleDeclaration | null {
  const view = el.ownerDocument?.defaultView;
  if (!view) return null;
  try {
    return view.getComputedStyle(el);
  } catch {
    return null;
  }
}

function isHiddenSelf(el: Element): boolean {
  if (el.hasAttribute("hidden")) return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  const style = getStyle(el);
  if (!style) return false;
  if (style.display === "none") return true;
  if (style.visibility === "hidden" || style.visibility === "collapse") return true;
  return false;
}

function formatState(el: Element, role: string): string | undefined {
  const asControl = el as HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement;
  if (asControl.disabled) return "(disabled)";

  if (role === "checkbox" || role === "radio") {
    return asControl.checked ? "(checked)" : "(unchecked)";
  }

  if (role === "textbox" || role === "searchbox" || role === "combobox" || role === "slider") {
    const value = isContentEditable(el) ? el.textContent ?? "" : (asControl.value ?? "");
    return value === "" ? "(empty)" : `(value: "${truncate(value, 60)}")`;
  }

  return undefined;
}

function accessibleName(el: Element): string {
  try {
    return truncate(computeAccessibleName(el) || el.textContent || "", DEFAULT_MAX_TEXT);
  } catch {
    return truncate(el.textContent || "", DEFAULT_MAX_TEXT);
  }
}

/** Direct (non-descendant) text of `el`, or "" if it has none worth reporting. */
function directText(el: Element): string {
  let text = "";
  for (const node of el.childNodes) {
    if (node.nodeType === 3 /* TEXT_NODE */) text += (node.textContent || "") + " ";
  }
  return text.trim();
}

/** Same-origin frame document, or null (cross-origin, not yet loaded, or not an iframe). */
function frameDocument(el: Element): Document | null {
  if (el.tagName !== "IFRAME") return null;
  try {
    return (el as HTMLIFrameElement).contentDocument ?? null;
  } catch {
    return null; // cross-origin — SecurityError
  }
}

/** Signature used to dedupe runs of visually-identical siblings; null means "never dedupe this". */
function siblingSignature(el: Element): string | null {
  if (el.id) return null;
  if (HEADING_TAGS.has(el.tagName)) return null;
  return `${el.tagName}.${el.className || ""}#${el.getAttribute("role") || ""}`;
}

interface WalkCtx {
  refCounter: { n: number };
  opts: Required<WalkOptions>;
  out: WalkNode[];
}

const DEDUPE_KEEP = 3;
// A run has to be meaningfully long before collapsing pays for itself. A plain unclassed <a> nav
// with 4-6 items shares the same tag+class+role signature as a feed's repeated cards — the only
// real difference is length. Collapsing at >3 (this constant's original value, found wrong by
// AB2's own docs-site fixture test: it silently ate a fourth, genuinely distinct nav link) throws
// away real navigation targets for a one-line savings that isn't worth it. >6 still collapses
// feeds, tables, and long sidebars hard while leaving ordinary short navs fully visible.
const MIN_RUN_TO_DEDUPE = 6;

function visitChildren(parent: Element | Document, ctx: WalkCtx): void {
  const children =
    parent.nodeType === 9 /* DOCUMENT_NODE */ ? Array.from((parent as Document).children) : Array.from((parent as Element).children);

  let i = 0;
  while (i < children.length) {
    const sig = siblingSignature(children[i]);
    let j = i + 1;
    if (sig !== null) {
      while (j < children.length && siblingSignature(children[j]) === sig) j++;
    }
    const runLength = j - i;

    if (sig !== null && runLength > MIN_RUN_TO_DEDUPE) {
      for (let k = i; k < i + DEDUPE_KEEP; k++) visit(children[k], ctx);
      ctx.out.push({
        kind: "omitted",
        ref: null,
        role: "",
        name: `… ${runLength - DEDUPE_KEEP} similar items omitted (snapshot depth:full to expand)`,
        omittedCount: runLength - DEDUPE_KEEP,
        element: null,
      });
    } else {
      for (let k = i; k < j; k++) visit(children[k], ctx);
    }
    i = j;
  }
}

function visit(el: Element, ctx: WalkCtx): void {
  if (isHiddenSelf(el)) return; // prune the whole subtree

  const role = actionableRole(el);
  if (role) {
    ctx.out.push({
      kind: "actionable",
      ref: ++ctx.refCounter.n,
      role,
      name: accessibleName(el),
      state: formatState(el, role),
      href: role === "link" ? (el.getAttribute("href") ?? undefined) : undefined,
      element: el,
    });
    return; // actionable elements are leaves for this walker
  }

  if (HEADING_TAGS.has(el.tagName)) {
    ctx.out.push({ kind: "heading", ref: null, role: "heading", name: accessibleName(el), element: el });
    return;
  }

  const iframeDoc = frameDocument(el);
  if (el.tagName === "IFRAME") {
    if (iframeDoc) {
      visitChildren(iframeDoc, ctx);
    } else {
      ctx.out.push({
        kind: "iframe-cross-origin",
        ref: null,
        role: "iframe",
        name: (el as HTMLIFrameElement).src || "(no src)",
        element: el,
      });
    }
    return;
  }

  const text = directText(el);
  if (text && ctx.opts.depth === "full") {
    ctx.out.push({ kind: "text", ref: null, role: "text", name: truncate(text, ctx.opts.maxTextLength), element: el });
  }

  // Open shadow roots are walked in place of (not in addition to) light-DOM children — an
  // element either has a shadow root or doesn't.
  const shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
  if (shadow) {
    let child = shadow.firstElementChild;
    while (child) {
      visit(child, ctx);
      child = child.nextElementSibling;
    }
    return;
  }

  visitChildren(el, ctx);
}

export function walkDocument(doc: Document, opts: WalkOptions = {}): WalkNode[] {
  const ctx: WalkCtx = {
    refCounter: { n: 0 },
    opts: { depth: opts.depth ?? "outline", maxTextLength: opts.maxTextLength ?? DEFAULT_MAX_TEXT },
    out: [],
  };
  if (doc.body) visitChildren(doc.body, ctx);
  return ctx.out;
}

export interface SnapshotMeta {
  pageId: string;
  title: string;
  url: string;
  gen: number;
}

function formatLine(node: WalkNode): string {
  if (node.kind === "omitted") return `     ${node.name}`;
  if (node.kind === "iframe-cross-origin") return `     [iframe] cross-origin: ${node.name} (not inspectable)`;
  if (node.kind === "heading") return `     heading  "${node.name}"`;
  if (node.kind === "text") return `     text     "${node.name}"`;

  const ref = `[${node.ref}]`.padEnd(5);
  const role = node.role.padEnd(9);
  let line = `${ref}${role} "${node.name}"`;
  if (node.href) line += `  → ${node.href}`;
  if (node.state) line += `  ${node.state}`;
  return line;
}

export function serializeSnapshot(nodes: WalkNode[], meta: SnapshotMeta): string {
  const header = `page ${meta.pageId} — "${meta.title}" — ${meta.url}  (gen ${meta.gen})`;
  const refCount = nodes.filter((n) => n.ref !== null).length;
  if (nodes.length === 0) return `${header}\n\n(no content)`;
  return `${header}\n\n${nodes.map(formatLine).join("\n")}\n\n${refCount} interactive elements`;
}
