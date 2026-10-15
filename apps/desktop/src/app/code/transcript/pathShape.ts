/* Which inline code reads as a path — kept from the old chat/PathLink.tsx. */

const KNOWN_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "rs", "go", "py", "rb", "java", "c", "cpp", "h", "hpp",
  "json", "yaml", "yml", "toml", "xml", "html", "css", "scss",
  "md", "mdx", "sql", "sh", "bash", "zsh", "env", "lock",
]);

export function isPathShape(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes(" ") || trimmed.includes("\n")) return false;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return false;

  // Contains / (e.g. src/foo.ts, ./bar, docs/plan.md)
  if (trimmed.includes("/")) {
    if (trimmed.startsWith("/") && trimmed.endsWith("/") && trimmed.length > 2 && !trimmed.slice(1, -1).includes("/")) {
      return false;
    }
    return true;
  }

  // Filename with known extension (e.g. package.json, README.md)
  const parts = trimmed.split(".");
  if (parts.length >= 2) {
    const ext = parts[parts.length - 1].toLowerCase();
    if (KNOWN_EXTENSIONS.has(ext)) {
      return true;
    }
  }

  return false;
}
