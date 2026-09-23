import type { MouseEvent } from "react";
import { FileIcon } from "@rama/ui";
import { requestOpenFile } from "../mission-control/panes/openFileBridge";

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

export function PathLink({ code }: { code: string }) {
  const isPath = isPathShape(code);

  if (!isPath) {
    return <code className="rama-inline-code">{code}</code>;
  }

  const handleClick = (e: MouseEvent) => {
    e.stopPropagation();
    requestOpenFile(code.trim());
  };

  return (
    <span
      className="rama-inline-code rama-path-link"
      title={`Open ${code.trim()} in Files pane`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          handleClick(e as unknown as MouseEvent);
        }
      }}
    >
      <FileIcon path={code.trim()} width={13} height={13} />
      <span>{code}</span>
    </span>
  );
}
