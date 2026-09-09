import type { SVGProps } from "react";

const BASE: SVGProps<SVGSVGElement> = {
  viewBox: "0 0 16 16",
  width: 14,
  height: 14,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

// Python icon (interlocking snakes silhouette)
function IconPython(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M7.5 1.5H5.8A2.3 2.3 0 0 0 3.5 3.8v1.7h4v.5H2.5A2.3 2.3 0 0 0 .2 8.3v1.9a2.3 2.3 0 0 0 2.3 2.3h1V11A2.5 2.5 0 0 1 6 8.5h4A1.5 1.5 0 0 0 11.5 7V4A2.5 2.5 0 0 0 9 1.5H7.5Z" transform="scale(0.85) translate(1.4, 1.4)" />
      <circle cx="5" cy="3.5" r="0.8" fill="currentColor" />
      <path d="M8.5 14.5h1.7a2.3 2.3 0 0 0 2.3-2.3v-1.7h-4v-.5h5A2.3 2.3 0 0 0 15.8 7.7V5.8a2.3 2.3 0 0 0-2.3-2.3h-1V5A2.5 2.5 0 0 1 10 7.5H6A1.5 1.5 0 0 0 4.5 9v3A2.5 2.5 0 0 0 7 14.5h1.5Z" transform="scale(0.85) translate(1.4, 1.4)" />
      <circle cx="11" cy="12.5" r="0.8" fill="currentColor" />
    </svg>
  );
}

// TypeScript / TSX icon
function IconTypeScript(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
      <path d="M3.5 6h4M5.5 6v6M9.5 10.2c.4.6 1 1 1.8 1 1 0 1.7-.6 1.7-1.4 0-1.8-3.4-1.2-3.4-3 0-.8.7-1.5 1.7-1.5.8 0 1.4.3 1.8.8" />
    </svg>
  );
}

// JavaScript / JSX icon
function IconJavaScript(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
      <path d="M5.5 6v4.5c0 .8-.5 1.5-1.5 1.5M9.5 10.2c.4.6 1 1 1.8 1 1 0 1.7-.6 1.7-1.4 0-1.8-3.4-1.2-3.4-3 0-.8.7-1.5 1.7-1.5.8 0 1.4.3 1.8.8" />
    </svg>
  );
}

// React atom icon
function IconReact(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <ellipse cx="8" cy="8" rx="6.5" ry="2.6" transform="rotate(30 8 8)" />
      <ellipse cx="8" cy="8" rx="6.5" ry="2.6" transform="rotate(90 8 8)" />
      <ellipse cx="8" cy="8" rx="6.5" ry="2.6" transform="rotate(150 8 8)" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
    </svg>
  );
}

// JSON icon ({ })
function IconJson(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M6 3c-1.5 0-2 .8-2 2.2v1.6c0 .8-.5 1.2-1.2 1.2.7 0 1.2.4 1.2 1.2v1.6C4 12.2 4.5 13 6 13M10 3c1.5 0 2 .8 2 2.2v1.6c0 .8.5 1.2 1.2 1.2-.7 0-1.2.4-1.2 1.2v1.6c0 1.4-.5 2.2-2 2.2" />
    </svg>
  );
}

// Rust icon (gear / R)
function IconRust(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5 13 13M3 13l1.5-1.5M11.5 4.5 13 3" />
    </svg>
  );
}

// Go icon
function IconGo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M7 6.5A2.8 2.8 0 1 0 7 11h1V8.5H5.8M10 8.5a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0Z" />
      <path d="M1 5.5h2M.5 8h3M1.5 10.5h2" />
    </svg>
  );
}

// Markdown icon (M with down arrow)
function IconMarkdown(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M3.5 10.5V5.5l2.2 2.5 2.2-2.5v5M11.5 5.5v5M9.8 8.8l1.7 1.7 1.7-1.7" />
    </svg>
  );
}

// HTML icon (< >)
function IconHtml(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="m5 4.5-3.5 3.5L5 11.5M11 4.5l3.5 3.5-3.5 3.5M9.5 3.5 6.5 12.5" />
    </svg>
  );
}

// CSS / SCSS icon (#)
function IconCss(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M5.5 2.5 4 13.5M11.5 2.5 10 13.5M2.5 6h11M2 10h11" />
    </svg>
  );
}

// Shell / Bash icon ($_ >)
function IconShell(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="m3 4.5 4 3.5-4 3.5M8.5 12h4.5" />
    </svg>
  );
}

// YAML / TOML / Config icon
function IconYaml(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h11" />
      <circle cx="5.5" cy="3.5" r="1.5" fill="currentColor" />
      <circle cx="10.5" cy="8" r="1.5" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r="1.5" fill="currentColor" />
    </svg>
  );
}

// SQL / Database icon
function IconDatabase(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <ellipse cx="8" cy="4" rx="5.5" ry="2" />
      <path d="M2.5 4v4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4M2.5 8v4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V8" />
    </svg>
  );
}

// Docker icon
function IconDocker(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M1.5 9.5c.8 3.5 4.5 5 8.5 4 3.5-.8 4.8-3.5 4.8-4.5-1-.2-2.5.3-3.3-.5 0-1.5-1-2.5-2.5-2.5H1.5" />
      <path d="M3.5 6.5h1.8v1.8H3.5zM6 6.5h1.8v1.8H6zM8.5 6.5h1.8v1.8H8.5zM6 4h1.8v1.8H6z" />
    </svg>
  );
}

// Git icon
function IconGit(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <circle cx="4.5" cy="4.5" r="1.8" />
      <circle cx="4.5" cy="11.5" r="1.8" />
      <circle cx="11.5" cy="7" r="1.8" />
      <path d="M4.5 6.3v3.4M6 5.5c1.8.3 3.5 1 4 1.5" />
    </svg>
  );
}

// Image file icon
function IconImage(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <circle cx="5.5" cy="6" r="1.2" />
      <path d="m2.5 11.5 3.5-3.5 3 3 2-2 2.5 2.5" />
    </svg>
  );
}

// C / C++ icon
function IconCpp(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M7 5.5a3.5 3.5 0 1 0 0 5M10.5 7v2M9.5 8h2M14 7v2M13 8h2" />
    </svg>
  );
}

// Generic file / text icon
function IconDocument(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M3.5 2h5.5l3.5 3.5v8a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-10.5a1 1 0 0 1 1-1Z" />
      <path d="M9 2v3.5h3.5M6 8.5h4M6 11h3" />
    </svg>
  );
}

// Lock / Key / Env icon
function IconLock(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <rect x="3.5" y="6.5" width="9" height="7.5" rx="1.2" />
      <path d="M5.5 6.5V4.5a2.5 2.5 0 0 1 5 0v2" />
      <circle cx="8" cy="10" r=".8" fill="currentColor" />
    </svg>
  );
}

export interface FileIconProps extends SVGProps<SVGSVGElement> {
  path: string;
}

/**
 * Returns a theme-adaptive VS Code-style SVG icon matching the file extension or filename.
 * Inherits currentColor to adapt dynamically to Rama's theme engine palettes.
 */
export function FileIcon({ path, ...props }: FileIconProps) {
  const fileName = path.split("/").pop()?.toLowerCase() ?? "";
  const parts = fileName.split(".");
  const ext = parts.length > 1 ? parts.pop()?.toLowerCase() : "";

  // Exact filename matches
  if (fileName === "dockerfile" || fileName.startsWith("dockerfile.") || fileName === "docker-compose.yml") {
    return <IconDocker {...props} />;
  }
  if (fileName.startsWith(".env")) {
    return <IconLock {...props} />;
  }
  if (fileName === ".gitignore" || fileName === ".gitmodules" || fileName === ".gitattributes") {
    return <IconGit {...props} />;
  }
  if (fileName.endsWith(".lock") || fileName === "package-lock.json" || fileName === "bun.lock") {
    return <IconLock {...props} />;
  }

  // Extension matches
  switch (ext) {
    case "py":
    case "pyw":
    case "ipynb":
      return <IconPython {...props} />;

    case "tsx":
      return <IconReact {...props} />;
    case "ts":
    case "mts":
    case "cts":
      return <IconTypeScript {...props} />;

    case "jsx":
      return <IconReact {...props} />;
    case "js":
    case "mjs":
    case "cjs":
      return <IconJavaScript {...props} />;

    case "json":
    case "jsonc":
    case "json5":
      return <IconJson {...props} />;

    case "rs":
      return <IconRust {...props} />;

    case "go":
      return <IconGo {...props} />;

    case "md":
    case "mdx":
    case "markdown":
      return <IconMarkdown {...props} />;

    case "html":
    case "htm":
      return <IconHtml {...props} />;

    case "css":
    case "scss":
    case "sass":
    case "less":
      return <IconCss {...props} />;

    case "sh":
    case "bash":
    case "zsh":
      return <IconShell {...props} />;

    case "yaml":
    case "yml":
    case "toml":
    case "ini":
      return <IconYaml {...props} />;

    case "sql":
    case "db":
    case "sqlite":
      return <IconDatabase {...props} />;

    case "c":
    case "h":
    case "cpp":
    case "hpp":
    case "cc":
    case "cxx":
    case "cs":
      return <IconCpp {...props} />;

    case "svg":
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "ico":
      return <IconImage {...props} />;

    default:
      return <IconDocument {...props} />;
  }
}
