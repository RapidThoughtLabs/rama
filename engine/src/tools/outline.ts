import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { gate } from "../agent/permissions";
import { resolveInProject } from "./paths";
import { listProjectFiles } from "./projectFiles";
import type { ToolCtx, ToolResult } from "./types";

// docs/TOOL_LAYER_PLAN.md §6.5 (TL5) / Open Question 5 — the plan's own end-state design is
// tree-sitter (bundled grammars) with an LSP documentSymbol upgrade path, explicitly left
// unresolved. Bundling and wiring tree-sitter grammars for five languages is real scope on its
// own; this ships a regex-heuristic outline instead so the tool exists and is useful now, and
// documents the gap rather than silently approximating it. Deliberate simplification, matching
// how bash background/process was deferred in TL3: top-level declarations only (functions,
// classes, interfaces, types, exported consts) for TS/JS/TSX; Python and Rust additionally
// recognise one level of indentation (class methods / impl fns) since their grammars tie that
// directly to indentation, unlike JS's brace nesting. No method-level detection for JS/TS/Go.
const MAX_FILES_FOR_DIR = 40;
const MAX_LINE_TEXT = 120;

type Family = "js" | "py" | "go" | "rs";

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

const JS_TOP_LEVEL: RegExp[] = [
  /^(export\s+)?(default\s+)?(async\s+)?function\b/,
  /^(export\s+)?(default\s+)?(abstract\s+)?class\b/,
  /^(export\s+)?interface\b/,
  /^(export\s+)?type\s+\w+\s*=/,
  /^(export\s+)?(const|let)\s+\w+\s*(:[^=]+)?=\s*(async\s*)?\(?.*=>/,
];
const PY_TOP_LEVEL: RegExp[] = [/^(async\s+)?def\s+\w+/, /^class\s+\w+/];
const PY_METHOD = /^(\s{4}|\t)(async\s+)?def\s+\w+/;
const GO_TOP_LEVEL: RegExp[] = [/^func\b/, /^type\s+\w+\s+(struct|interface)\b/];
const RS_TOP_LEVEL: RegExp[] = [
  /^(pub(\([^)]*\))?\s+)?(async\s+)?fn\s+\w+/,
  /^(pub(\([^)]*\))?\s+)?struct\s+\w+/,
  /^(pub(\([^)]*\))?\s+)?enum\s+\w+/,
  /^(pub(\([^)]*\))?\s+)?trait\s+\w+/,
  /^impl\b/,
];
const RS_METHOD = /^\s{4}(pub(\([^)]*\))?\s+)?(async\s+)?fn\s+\w+/;

function matchesFamily(family: Family, line: string): boolean {
  if (family === "js") return JS_TOP_LEVEL.some((re) => re.test(line));
  if (family === "py") return PY_TOP_LEVEL.some((re) => re.test(line)) || PY_METHOD.test(line);
  if (family === "go") return GO_TOP_LEVEL.some((re) => re.test(line));
  return RS_TOP_LEVEL.some((re) => re.test(line)) || RS_METHOD.test(line);
}

function symbolsFor(family: Family, text: string): { line: number; text: string }[] {
  const lines = text.split("\n");
  const out: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!matchesFamily(family, lines[i]!)) continue;
    const trimmed = lines[i]!.replace(/\s*\{?\s*$/, "").trim();
    out.push({ line: i + 1, text: trimmed.length > MAX_LINE_TEXT ? `${trimmed.slice(0, MAX_LINE_TEXT)}…` : trimmed });
  }
  return out;
}

function outlineOneFile(abs: string, rel: string): string | null {
  const family = EXT_FAMILY[extname(rel).toLowerCase()];
  if (!family) return null;
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const lineCount = text.split("\n").length;
  const symbols = symbolsFor(family, text);
  const header = `${rel} (${lineCount} lines)`;
  if (symbols.length === 0) return `${header}\n  (no top-level symbols recognized)`;
  return `${header}\n${symbols.map((s) => `  ${String(s.line).padStart(4)}  ${s.text}`).join("\n")}`;
}

export function createOutlineTool(ctx: ToolCtx) {
  return tool({
    description:
      "List a file's (or every file in a directory's) top-level symbols — functions, classes, " +
      "interfaces, types — with line numbers and no bodies. Supports TS/JS/TSX, Python, Go, and " +
      "Rust; heuristic, not a full parse, so it can miss or misidentify unusual code. Prefer this " +
      "over `read` for a file over ~500 lines when you just need to find where something is " +
      "defined before reading the relevant part.",
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
          const result = outlineOneFile(abs, input.path);
          if (result === null) {
            const msg = `outline doesn't support ${input.path}'s file type (TS/JS/TSX, Python, Go, Rust only)`;
            return { ok: false, summary: msg, content: msg };
          }
          return { ok: true, content: result, summary: "outlined" };
        }

        const all = await listProjectFiles(abs);
        const supported = all.filter((f) => EXT_FAMILY[extname(f).toLowerCase()]);
        const shown = supported.slice(0, MAX_FILES_FOR_DIR);
        const blocks = shown.map((rel) => outlineOneFile(join(abs, rel), rel)).filter((b): b is string => b !== null);

        if (blocks.length === 0) {
          const msg = `no TS/JS/TSX, Python, Go, or Rust files found under ${input.path}`;
          return { ok: true, content: msg, summary: msg };
        }

        const truncated = supported.length > MAX_FILES_FOR_DIR;
        const truncatedNote = truncated ? `\n\n… ${supported.length - MAX_FILES_FOR_DIR} more files not shown; outline a subdirectory or specific file to see them` : "";

        return {
          ok: true,
          content: blocks.join("\n\n") + truncatedNote,
          summary: `${blocks.length} file${blocks.length === 1 ? "" : "s"} outlined`,
          meta: truncated ? { truncated: { shown: shown.length, total: supported.length, unit: "entries", how: "outline a subdirectory or a specific file" } } : undefined,
        };
      }),
  });
}
