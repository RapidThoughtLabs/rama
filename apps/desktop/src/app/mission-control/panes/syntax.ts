import hljs from "highlight.js";
import "./syntax.css";

const EXT_TO_LANG: Record<string, string> = {
  py: "python",
  pyw: "python",
  ipynb: "python",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  json5: "json",
  rs: "rust",
  go: "go",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  sql: "sql",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  cs: "csharp",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  rb: "ruby",
  php: "php",
  diff: "diff",
  patch: "diff",
  lua: "lua",
  zig: "zig",
  r: "r",
  dart: "dart",
  dockerfile: "dockerfile",
  makefile: "makefile",
};

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Splits highlighted HTML by newlines while preserving opening/closing spans across line boundaries.
 * Every line returned is a completely balanced, standalone HTML string.
 */
export function splitHighlightedHtml(html: string): string[] {
  const lines: string[] = [];
  const openTags: string[] = [];
  let currentLine = "";

  const regex = /(<span\b[^>]*>)|(<\/span>)|(\n)|([^<\n]+)|(.)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    const [, openTag, closeTag, newline, text, fallback] = match;
    if (newline) {
      let lineOutput = currentLine;
      for (let i = openTags.length - 1; i >= 0; i--) {
        lineOutput += "</span>";
      }
      lines.push(lineOutput);
      currentLine = openTags.join("");
    } else if (openTag) {
      openTags.push(openTag);
      currentLine += openTag;
    } else if (closeTag) {
      openTags.pop();
      currentLine += closeTag;
    } else {
      currentLine += text ?? fallback;
    }
  }

  let lineOutput = currentLine;
  for (let i = openTags.length - 1; i >= 0; i--) {
    lineOutput += "</span>";
  }
  lines.push(lineOutput);

  return lines;
}

export function highlightCode(code: string, filePath: string): string[] {
  if (!code) return [""];

  const fileName = filePath.split("/").pop()?.toLowerCase() ?? "";
  const parts = fileName.split(".");
  const ext = parts.length > 1 ? parts.pop()?.toLowerCase() ?? "" : "";

  let lang: string | undefined;
  if (fileName === "dockerfile" || fileName.startsWith("dockerfile.")) {
    lang = "dockerfile";
  } else if (fileName === "makefile" || fileName === "gnumakefile") {
    lang = "makefile";
  } else if (ext) {
    lang = EXT_TO_LANG[ext];
  }

  try {
    if (lang && hljs.getLanguage(lang)) {
      const highlighted = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      return splitHighlightedHtml(highlighted);
    }

    // Fallback auto-detection for non-huge files (< 30KB)
    if (code.length < 30000) {
      const autoRes = hljs.highlightAuto(code);
      if (autoRes.language && autoRes.value) {
        return splitHighlightedHtml(autoRes.value);
      }
    }
  } catch (err) {
    console.warn(`[rama] syntax highlighting error for ${filePath}:`, err);
  }

  // Safe plaintext fallback
  return code.split("\n").map(escapeHtml);
}
