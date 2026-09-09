// docs/SYMBOL_LAYER_PLAN.md Phase SL2 — outline tool rewired to tree-sitter.
// The regex heuristic (engine/src/tools/outline.ts:36-71 in the previous version) has been
// removed and replaced by extractSymbols from the SL1 extractor. The output format is
// unchanged (SL2 decision 5) so the swap is verifiable as a diff of content, not format.
// Nesting render (SL3) and parse cache (SL4) follow separately.

import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { defineTool } from "./define";
import { z } from "zod";
import { gate } from "../agent/permissions";
import { resolveInProject } from "./paths";
import { listProjectFiles } from "./projectFiles";
import type { ToolCtx, ToolResult } from "./types";
import { extractSymbols, type Symbol } from "./symbols/extract";
import { getCached, setCached, MAX_FILE_BYTES } from "./symbols/cache";
import type { Family } from "./symbols/grammars";


const MAX_FILES_FOR_DIR = 40;

type FamilyOrNull = Family | null;

const EXT_FAMILY: Record<string, Family> = {
  ".ts": "js",
  ".tsx": "js",
  ".js": "js",
  ".jsx": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".py": "py",
  ".go": "go",
  ".rs": "rs",
};

/** Render a flat list of symbols as the indented outline block (SL3 depth-aware). */
function renderSymbols(symbols: Symbol[]): string {
  return symbols
    .map((s) => {
      // SL3: indent two spaces per depth level, capped at depth 2 to avoid staircases.
      const depthCapped = Math.min(s.depth, 2);
      const extraIndent = "  ".repeat(depthCapped);
      return `  ${extraIndent}${String(s.line).padStart(4)}  ${s.text}`;
    })
    .join("\n");
}

async function outlineOneFile(abs: string, rel: string): Promise<string | null> {
  const family: FamilyOrNull = EXT_FAMILY[extname(rel).toLowerCase()] ?? null;
  if (!family) return null;

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(abs);
  } catch {
    return null;
  }

  // SL4: skip files over 1 MB — almost certainly generated bundles.
  if (stat.size > MAX_FILE_BYTES) {
    return `${rel} (${stat.size} bytes — too large for symbol extraction; use read or grep)`;
  }

  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return null;
  }

  const lineCount = text.split("\n").length;
  const header = `${rel} (${lineCount} lines)`;

  // SL4: check cache before parsing (parse is the expensive operation).
  let syms: Symbol[];
  let hasError: boolean;

  const cached = getCached(abs, stat.mtimeMs, stat.size);
  if (cached) {
    syms = cached.symbols;
    hasError = cached.hasError;
  } else {
    let extracted: { symbols: Symbol[]; hasError: boolean };
    try {
      extracted = await extractSymbols(family, text);
    } catch (e) {
      // Grammar loading error: explicit, never silent (SYMBOL_LAYER_PLAN.md decision 7).
      return `${header}\n  (symbol extraction failed for ${family}: ${e})`;
    }
    syms = extracted.symbols;
    hasError = extracted.hasError;
    setCached(abs, stat.mtimeMs, stat.size, syms, hasError);
  }

  // Open question 2 (SYMBOL_LAYER_PLAN.md §8): annotate partial parse so the model
  // knows absence of symbols after the error point is not evidence of emptiness.
  const errorNote = hasError
    ? `\n  (parse incomplete — symbols after the first syntax error may be missing)`
    : "";

  if (syms.length === 0) {
    return `${header}${errorNote}\n  (no top-level symbols recognized)`;
  }

  return `${header}${errorNote}\n${renderSymbols(syms)}`;
}

export function createOutlineTool(ctx: ToolCtx) {
  return defineTool({
    description:
      "List a file's (or every file in a directory's) symbols — functions, classes, methods, " +
      "interfaces, types — with line numbers and no bodies. Supports TS/JS/TSX, Python, Go, and " +
      "Rust; uses real tree-sitter parsing, so nested symbols (methods inside a class, functions " +
      "inside an impl) are indented under their container. Prefer this over `read` for a file " +
      "over ~500 lines when you just need to find where something is defined before reading " +
      "the relevant part.",
    inputSchema: z.object({
      path: z.string().describe("A file, or a directory to outline every file within"),
    }),
    execute: async (input): Promise<ToolResult> =>
      gate(ctx, { name: "outline", input, risk: "low" }, async () => {
        const abs = resolveInProject(ctx.projectPath, input.path);
        let stat;
        try {
          stat = statSync(abs);
        } catch {
          const msg = `not found: ${input.path}`;
          return { ok: false, summary: msg, content: msg };
        }

        if (!stat.isDirectory()) {
          const result = await outlineOneFile(abs, input.path);
          if (result === null) {
            const msg = `outline doesn't support ${input.path}'s file type (TS/JS/TSX, Python, Go, Rust only)`;
            return { ok: false, summary: msg, content: msg };
          }
          return { ok: true, content: result, summary: "outlined" };
        }

        const all = await listProjectFiles(abs);
        const supported = all.filter((f) => EXT_FAMILY[extname(f).toLowerCase()]);
        const shown = supported.slice(0, MAX_FILES_FOR_DIR);

        // Sequential await per file: parsing is CPU-bound and a 40-way Promise.all
        // would pin the event loop (SYMBOL_LAYER_PLAN.md SL2 note).
        const blocks: string[] = [];
        for (const rel of shown) {
          const block = await outlineOneFile(join(abs, rel), rel);
          if (block !== null) blocks.push(block);
        }

        if (blocks.length === 0) {
          const msg = `no TS/JS/TSX, Python, Go, or Rust files found under ${input.path}`;
          return { ok: true, content: msg, summary: msg };
        }

        const truncated = supported.length > MAX_FILES_FOR_DIR;
        const truncatedNote = truncated
          ? `\n\n… ${supported.length - MAX_FILES_FOR_DIR} more files not shown; outline a subdirectory or specific file to see them`
          : "";

        return {
          ok: true,
          content: blocks.join("\n\n") + truncatedNote,
          summary: `${blocks.length} file${blocks.length === 1 ? "" : "s"} outlined`,
          meta: truncated
            ? {
                truncated: {
                  shown: shown.length,
                  total: supported.length,
                  unit: "entries",
                  how: "outline a subdirectory or a specific file",
                },
              }
            : undefined,
        };
      }),
  });
}
