import type { SVGProps } from "react";

// docs/REDESIGN_PLAN.md Phase R5/R6 — a small stroke-icon set replacing the ascii/unicode glyphs
// (+, >, ▤, ✦, ⚙, ◫, ⇱, ⌕) used across the sidebar/titlebar since R2/R3. One shared visual
// language: 16x16, 1.6px stroke, currentColor — so every icon inherits color/size from its
// button the same way the old unicode glyphs did, no per-icon color prop needed.
const BASE: SVGProps<SVGSVGElement> = {
  viewBox: "0 0 16 16",
  width: 15,
  height: 15,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

export function IconHome(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M2.3 8.2 8 3.3l5.7 4.9" />
      <path d="M4 7.2v6.3h8V7.2" />
    </svg>
  );
}

export function IconCode(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M5.6 4.5 2 8l3.6 3.5" />
      <path d="M10.4 4.5 14 8l-3.6 3.5" />
    </svg>
  );
}

export function IconPlus(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function IconTerminal(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.6" />
      <path d="M4.2 6.2 6.6 8l-2.4 1.8" />
      <path d="M8.2 10.4h3.4" />
    </svg>
  );
}

export function IconDocs(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M4.6 1.6h4.6l3.2 3.2v9a1 1 0 0 1-1 1H4.6a1 1 0 0 1-1-1V2.6a1 1 0 0 1 1-1Z" />
      <path d="M9.2 1.6v3.2h3.2" />
      <path d="M5.7 8.4h4.6M5.7 10.7h4.6" />
    </svg>
  );
}

export function IconToolbox(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M11.3 2.7a3 3 0 0 0-3.9 3.9l-4.7 4.7a1.4 1.4 0 0 0 2 2l4.7-4.7a3 3 0 0 0 3.9-3.9l-2 2-1.6-.4-.4-1.6Z" />
    </svg>
  );
}

export function IconChevronDown(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M4 6.2 8 10l4-3.8" />
    </svg>
  );
}

export function IconGear(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.6v1.9M8 12.5v1.9M14.4 8h-1.9M3.5 8H1.6M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3M12.5 12.5l-1.3-1.3M4.8 4.8 3.5 3.5" />
    </svg>
  );
}

export function IconPanel(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.6" />
      <path d="M10.4 2.6v10.8" />
    </svg>
  );
}

export function IconPopOut(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M6.6 2.6H3a1 1 0 0 0-1 1V12a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3.6" />
      <path d="M9.6 2.6h3.8v3.8" />
      <path d="M13.2 2.9 7.4 8.7" />
    </svg>
  );
}

export function IconSearch(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <circle cx="7" cy="7" r="4.4" />
      <path d="M10.3 10.3 14 14" />
    </svg>
  );
}

export function IconBrush(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M12.8 2.2c.7.7.7 1.8 0 2.5L7.6 9.9l-2.5-2.5 5.2-5.2c.7-.7 1.8-.7 2.5 0Z" />
      <path d="M6.4 8.6 4.7 10c-.5.4-.7 1-.7 1.7 0 1.4-.6 2.4-1.6 3.1 1.4.4 3.9.5 5.2-.7.6-.6.9-1.3.9-2.1 0-.6.2-1.1.6-1.5l1.3-1.3" />
    </svg>
  );
}

export function IconSun(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.6v1.8M8 12.6v1.8M14.4 8h-1.8M3.4 8H1.6M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3M12.5 12.5l-1.3-1.3M4.8 4.8 3.5 3.5" />
    </svg>
  );
}

// docs/MISSION_CONTROL_PLAN.md M1 — Mission Control's three pane tabs.
export function IconArtifacts(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M8 2.2 13.6 5.4 8 8.6 2.4 5.4 8 2.2Z" />
      <path d="M2.4 8.2 8 11.4l5.6-3.2" />
      <path d="M2.4 11 8 14.2 13.6 11" />
    </svg>
  );
}

export function IconWeb(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c1.8 1.8 2.8 4 2.8 6s-1 4.2-2.8 6c-1.8-1.8-2.8-4-2.8-6S6.2 3.8 8 2Z" />
    </svg>
  );
}

// docs/WORKSPACE_PANES_PLAN.md §3 — Mission Control's Changes and Files pane icons.
export function IconChanges(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M8 2.5v6M5 5.5h6" />
      <path d="M4.5 12.5h7" />
    </svg>
  );
}

export function IconFiles(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.6 1.6h4.8A1.5 1.5 0 0 1 14 6.1v5.4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z" />
    </svg>
  );
}

export function IconChevronRight(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M6.2 4 10 8l-3.8 4" />
    </svg>
  );
}

export function IconFolder(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.6 1.6h4.8A1.5 1.5 0 0 1 14 6.1v5.4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z" />
    </svg>
  );
}

export function IconFolderOpen(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h2.6l1.6 1.5h4.8A1.5 1.5 0 0 1 14 7v.5M2 7.5h12l-1.5 5.5a1.5 1.5 0 0 1-1.4 1H3.9a1.5 1.5 0 0 1-1.4-1L2 7.5Z" />
    </svg>
  );
}

export function IconFile(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M3.5 2h5.5l3.5 3.5v8a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-10.5a1 1 0 0 1 1-1Z" />
      <path d="M9 2v3.5h3.5" />
    </svg>
  );
}

export function IconClose(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="m4 4 8 8M12 4 4 12" />
    </svg>
  );
}

export function IconRefresh(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9L14 6.2M14 2v4.2H9.8" />
      <path d="M13.5 8a5.5 5.5 0 0 1-9.4 3.9L2 9.8M2 14V9.8h4.2" />
    </svg>
  );
}

export function IconMore(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <circle cx="3.5" cy="8" r="1" fill="currentColor" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1" fill="currentColor" />
    </svg>
  );
}

export function IconCopy(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} {...props}>
      <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1" />
      <path d="M3.5 10.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v.5" />
    </svg>
  );
}

