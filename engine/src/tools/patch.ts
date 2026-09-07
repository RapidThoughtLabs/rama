// docs/TOOL_LAYER_PLAN.md §5.3 — the matching ladder behind `edit`. Pure, synchronous, no
// filesystem or DB: every edit is applied to an in-memory string, in order, and a failure at
// any edit means nothing is written — the caller never sees a partially-transformed file.

import { similarity } from "./textSimilarity";

export interface EditSpec {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export interface PatchFailure {
  index: number;
  reason: "not_found" | "not_unique" | "empty_old_string";
  occurrences?: number;
  nearest?: { line: number; excerpt: string };
}

export interface PatchOutcome {
  ok: boolean;
  /** Full new file content — only present when every edit applied. */
  content?: string;
  applied: number;
  failure?: PatchFailure;
}

const BOM = "﻿";

interface ByteShape {
  hadBOM: boolean;
  eol: "\r\n" | "\n";
}

// Matching and splicing happen on an LF-normalised body so CRLF documents behave identically to
// LF ones; the original line ending (and a leading BOM) is reapplied once at the very end.
function normalize(text: string): { body: string; shape: ByteShape } {
  const hadBOM = text.startsWith(BOM);
  const stripped = hadBOM ? text.slice(BOM.length) : text;
  const crlf = (stripped.match(/\r\n/g) ?? []).length;
  const lfOnly = (stripped.match(/(?<!\r)\n/g) ?? []).length;
  const eol: "\r\n" | "\n" = crlf > 0 && crlf >= lfOnly ? "\r\n" : "\n";
  const body = stripped.replace(/\r\n/g, "\n");
  return { body, shape: { hadBOM, eol } };
}

function denormalize(body: string, shape: ByteShape): string {
  const withEol = shape.eol === "\r\n" ? body.replace(/\n/g, "\r\n") : body;
  return shape.hadBOM ? BOM + withEol : withEol;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count++;
    from = idx + needle.length;
  }
}

function replaceOnce(haystack: string, needle: string, replacement: string): string {
  const idx = haystack.indexOf(needle);
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
}

function replaceAllOccurrences(haystack: string, needle: string, replacement: string): string {
  return haystack.split(needle).join(replacement);
}

function stripIndent(line: string): string {
  return line.replace(/^[ \t]+/, "");
}

// Step 4 of the ladder: re-match with each line's leading whitespace stripped. Only meaningful
// when oldString is line-aligned (spans whole lines) — a partial-line oldString simply won't
// match here and falls through to the nearest-match failure, which is the safe outcome.
function findIndentToleranceMatches(lines: string[], oldLines: string[]): number[] {
  const strippedOld = oldLines.map(stripIndent);
  const matches: number[] = [];
  for (let i = 0; i + oldLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (stripIndent(lines[i + j]!) !== strippedOld[j]) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(i);
  }
  return matches;
}

// "Nearest candidate region" for a not_found failure — slides a window the size of oldString
// across the file and scores each position by per-line similarity, so the error can show the
// model what's actually there instead of just "not found".
function findNearestRegion(lines: string[], oldLines: string[]): { line: number; excerpt: string } | undefined {
  if (lines.length === 0 || oldLines.length === 0) return undefined;
  const windowSize = Math.min(oldLines.length, lines.length);

  let bestScore = -Infinity;
  let bestStart = 0;
  for (let i = 0; i + windowSize <= lines.length; i++) {
    let score = 0;
    for (let j = 0; j < windowSize; j++) {
      score += similarity(stripIndent(lines[i + j]!).trim(), stripIndent(oldLines[j]!).trim());
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }

  const avg = bestScore / windowSize;
  if (avg < 0.3) return undefined; // too dissimilar to be a useful suggestion
  return { line: bestStart + 1, excerpt: lines[bestStart]!.slice(0, 200) };
}

function applyOneEdit(working: string, edit: EditSpec, index: number): { ok: true; result: string } | { ok: false; failure: PatchFailure } {
  if (edit.oldString === "") {
    return { ok: false, failure: { index, reason: "empty_old_string" } };
  }

  const count = countOccurrences(working, edit.oldString);
  if (count === 1) {
    return { ok: true, result: replaceOnce(working, edit.oldString, edit.newString) };
  }
  if (count > 1) {
    if (edit.replaceAll) {
      return { ok: true, result: replaceAllOccurrences(working, edit.oldString, edit.newString) };
    }
    return { ok: false, failure: { index, reason: "not_unique", occurrences: count } };
  }

  // count === 0 — try indentation-tolerant matching before giving up.
  const lines = working.split("\n");
  const oldLines = edit.oldString.split("\n");
  const matches = findIndentToleranceMatches(lines, oldLines);
  if (matches.length === 1) {
    const start = matches[0]!;
    const before = lines.slice(0, start);
    const after = lines.slice(start + oldLines.length);
    const newLines = edit.newString.split("\n");
    return { ok: true, result: [...before, ...newLines, ...after].join("\n") };
  }

  return { ok: false, failure: { index, reason: "not_found", nearest: findNearestRegion(lines, oldLines) } };
}

export function applyEdits(original: string, edits: EditSpec[]): PatchOutcome {
  const { body, shape } = normalize(original);
  let working = body;

  for (let i = 0; i < edits.length; i++) {
    const outcome = applyOneEdit(working, edits[i]!, i);
    if (!outcome.ok) {
      return { ok: false, applied: 0, failure: outcome.failure };
    }
    working = outcome.result;
  }

  return { ok: true, applied: edits.length, content: denormalize(working, shape) };
}
