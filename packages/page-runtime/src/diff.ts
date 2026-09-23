// AGENT_BROWSER_PLAN.md AB5 — the diff half of "settle and diff". Pure over two `WalkNode[]`
// arrays from walk.ts (no window/document globals beyond reading `Element.parentElement`/
// `.children`, both real on any `Element` including happy-dom's), so it's unit-testable the same
// way walk.ts itself is — see test/diff.test.ts.
//
// Nodes are matched across snapshots by (role, DOM path), not by `ref` — refs are reassigned
// fresh on every snapshot (Decision 10) and can't be compared across generations. A name/state
// change on an otherwise-matched node becomes a `~` line instead of a spurious remove+add pair —
// see §6.2's own example ("YouTube" → "Rick Astley..."). Only "actionable" and "heading" kinds
// participate: text/omitted/iframe lines have no stable name a model would reason about turn to
// turn, and outline-depth snapshots (the default `browser click` etc. take) don't carry them
// anyway.

import type { WalkNode } from "./walk";

const MAX_DIFF_LINES = 40;

/** `TAG:childIndex` from `el` up to (not including) `<body>` — a position-based identity that
 *  survives a ref renumbering but not a structural reorder; good enough for "did this element
 *  change", not a guarantee against a false match on a heavily-reshuffled page. */
function elementPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.tagName !== "BODY") {
    const parent: Element | null = node.parentElement;
    if (!parent) break;
    const idx = Array.prototype.indexOf.call(parent.children, node);
    parts.unshift(`${node.tagName}:${idx}`);
    node = parent;
  }
  return parts.join(">");
}

function keyedNodes(nodes: WalkNode[]): Map<string, WalkNode> {
  const out = new Map<string, WalkNode>();
  for (const node of nodes) {
    if (node.kind !== "actionable" && node.kind !== "heading") continue;
    if (!node.element) continue;
    out.set(`${node.role}@${elementPath(node.element)}`, node);
  }
  return out;
}

function refCol(node: WalkNode): string {
  return node.ref !== null ? `[${node.ref}]`.padEnd(5) : "     ";
}

function formatAdd(node: WalkNode): string {
  let line = `+ ${refCol(node)}${node.role.padEnd(9)} "${node.name}"`;
  if (node.state) line += `  ${node.state}`;
  return line;
}

function formatRemove(node: WalkNode): string {
  return `- ${refCol(node)}${node.role.padEnd(9)} "${node.name}"`;
}

function formatChange(prev: WalkNode, next: WalkNode): string {
  const parts: string[] = [];
  if (prev.name !== next.name) parts.push(`"${prev.name}" → "${next.name}"`);
  if (prev.state !== next.state) parts.push(`${prev.state ?? "(none)"} → ${next.state ?? "(none)"}`);
  return `~ ${refCol(next)}${next.role.padEnd(9)} ${parts.join("  ")}`;
}

/** Returns §6.2's `+`/`-`/`~` lines — additions first (document order), then changes, then
 *  removals — matching the plan's own example ordering. Capped at MAX_DIFF_LINES with a trailing
 *  omission note, the same "don't let a huge page blow the token budget" rule walk.ts's own
 *  sibling-dedupe applies. */
export function diffSnapshot(prev: WalkNode[], next: WalkNode[]): string[] {
  const prevByKey = keyedNodes(prev);
  const nextByKey = keyedNodes(next);

  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];

  for (const [key, node] of nextByKey) {
    const prevNode = prevByKey.get(key);
    if (!prevNode) {
      added.push(formatAdd(node));
    } else if (prevNode.name !== node.name || prevNode.state !== node.state) {
      changed.push(formatChange(prevNode, node));
    }
  }
  for (const [key, node] of prevByKey) {
    if (!nextByKey.has(key)) removed.push(formatRemove(node));
  }

  const lines = [...added, ...changed, ...removed];
  if (lines.length > MAX_DIFF_LINES) {
    const shown = lines.slice(0, MAX_DIFF_LINES);
    shown.push(`… ${lines.length - MAX_DIFF_LINES} more changes omitted`);
    return shown;
  }
  return lines;
}
