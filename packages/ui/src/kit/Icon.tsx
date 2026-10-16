import type { SVGProps } from "react";
import type { JSX } from "react";

/* Kit icon set — HOME_REDESIGN_PLAN.md Phase HD0. All 40 `i-*` symbols from the mockup
   (docs/Rama/home-redesign.html, mock:L695-737), paths verbatim, generated from the file so they
   can't drift by hand. Each renders as `svg.r-i` (kit/kit.css, mock:L92): a 16px box, stroke
   currentColor at 1.5, round caps and joins. Size variants come from CSS (13px in act dots, 15px
   in rails…), never from props, matching how the mockup sizes its <use> icons. */

const PATHS = {
  "plus": <><path d="M8 3v10M3 8h10"/></>,
  "search": <><circle cx="7" cy="7" r="4.25"/><path d="m10.2 10.2 3.3 3.3"/></>,
  "panel": <><rect x="2" y="2.5" width="12" height="11" rx="2.5"/><path d="M6 2.5v11"/></>,
  "home": <><path d="M2.5 7.2 8 2.8l5.5 4.4V13a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8z"/><path d="M6.3 13.8V10h3.4v3.8"/></>,
  "code": <><path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/></>,
  "tool": <><path d="M10.6 2.6a3.2 3.2 0 0 0-3.9 4.1L2.6 10.8a1.4 1.4 0 0 0 2 2l4.1-4.1a3.2 3.2 0 0 0 4.1-3.9l-1.9 1.9-1.8-.3-.3-1.8z"/></>,
  "docs": <><path d="M4 1.8h5l3.2 3.2V14a.6.6 0 0 1-.6.6H4a.6.6 0 0 1-.6-.6V2.4A.6.6 0 0 1 4 1.8z"/><path d="M9 1.8V5h3.2M5.6 8.5h4.8M5.6 11h3.2"/></>,
  "sliders": <><path d="M2.5 5h6M11.5 5h2M2.5 11h2M7.5 11h6"/><circle cx="10" cy="5" r="1.5"/><circle cx="6" cy="11" r="1.5"/></>,
  "clip": <><path d="M13 7.5 8.3 12.2a3 3 0 0 1-4.3-4.3l5-5a2 2 0 0 1 2.9 2.9l-5 5a1 1 0 0 1-1.5-1.5l4.4-4.4"/></>,
  "globe": <><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14c-1.8-1.7-2.6-3.7-2.6-6S6.2 3.7 8 2z"/></>,
  "up": <><path d="M8 13V3.5M4 7.2l4-4 4 4"/></>,
  "down": <><path d="M4.5 6.2 8 9.7l3.5-3.5"/></>,
  "right": <><path d="M6.2 4.5 9.7 8l-3.5 3.5"/></>,
  "copy": <><rect x="5.5" y="5.5" width="8" height="8" rx="1.8"/><path d="M10.5 5.5V3.8a1.3 1.3 0 0 0-1.3-1.3H3.8a1.3 1.3 0 0 0-1.3 1.3v5.4a1.3 1.3 0 0 0 1.3 1.3h1.7"/></>,
  "retry": <><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.8v2.6h-2.6"/></>,
  "doc": <><path d="M4 1.8h5l3.2 3.2V14a.6.6 0 0 1-.6.6H4a.6.6 0 0 1-.6-.6V2.4A.6.6 0 0 1 4 1.8z"/><path d="M9 1.8V5h3.2"/></>,
  "image": <><rect x="2" y="3" width="12" height="10" rx="2"/><circle cx="6" cy="6.6" r="1.2"/><path d="m2.5 11.5 3.5-3 3 2.5 2-1.5 2.5 2"/></>,
  "check": <><path d="m3.5 8.3 3 2.9 6-6.4"/></>,
  "lock": <><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/></>,
  "cloud": <><path d="M4.6 12.5h7a2.6 2.6 0 0 0 .3-5.2A3.9 3.9 0 0 0 4.4 6.6a3 3 0 0 0 .2 5.9z"/></>,
  "clock": <><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/></>,
  "menu": <><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/></>,
  "folder": <><path d="M2 4.5c0-.6.4-1 1-1h3l1.5 1.5H13c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z"/></>,
  "pencil": <><path d="M10.8 2.7a1.4 1.4 0 0 1 2 2l-7.2 7.2-2.8.8.8-2.8z"/></>,
  "term": <><rect x="2" y="3" width="12" height="10" rx="2"/><path d="m5 6.5 2 1.5-2 1.5M8.5 10H11"/></>,
  "eye": <><path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8s-2.3 4.2-6.2 4.2S1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.8"/></>,
  "branch": <><circle cx="5" cy="3.8" r="1.5"/><circle cx="5" cy="12.2" r="1.5"/><circle cx="11" cy="5.2" r="1.5"/><path d="M5 5.3v5.4M11 6.7c0 2.2-1.6 3-5.2 3.8"/></>,
  "panel-r": <><rect x="2" y="2.5" width="12" height="11" rx="2.5"/><path d="M10 2.5v11"/></>,
  "pop": <><path d="M9 2.5h4.5V7M13.5 2.5 8 8M11.5 10v2.3a1.2 1.2 0 0 1-1.2 1.2H3.7a1.2 1.2 0 0 1-1.2-1.2V5.7a1.2 1.2 0 0 1 1.2-1.2H6"/></>,
  "x": <><path d="m4 4 8 8M12 4l-8 8"/></>,
  "left": <><path d="M9.8 4.5 6.3 8l3.5 3.5"/></>,
  "list": <><path d="M6 4.5h7.5M6 8h7.5M6 11.5h7.5"/><circle cx="3" cy="4.5" r=".7"/><circle cx="3" cy="8" r=".7"/><circle cx="3" cy="11.5" r=".7"/></>,
  "ask": <><path d="M3 3h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5l-3 2.5V11H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/></>,
  "agent": <><path d="m8 2.2 1.3 3.6 3.6 1.3-3.6 1.3L8 12l-1.3-3.6-3.6-1.3 3.6-1.3z"/><path d="M12.5 11.2v2.6M11.2 12.5h2.6"/></>,
  "undo": <><path d="M5.5 4 2.5 7l3 3M2.8 7h6.7a3.3 3.3 0 0 1 0 6.6H7"/></>,
  "changes": <><rect x="2" y="2" width="12" height="12" rx="2.5"/><path d="M8 4.8v4.4M5.8 7h4.4M5.8 11.2h4.4"/></>,
  "commit": <><circle cx="8" cy="8" r="2.4"/><path d="M2 8h3.6M10.4 8H14"/></>,
  "push": <><path d="M8 11V3M4.5 6.5 8 3l3.5 3.5M3 13.5h10"/></>,
  "shield": <><path d="M8 1.8 13 3.6v4c0 3-2.1 5.2-5 6.6-2.9-1.4-5-3.6-5-6.6v-4z"/><path d="M8 5.5v3M8 10.6v.2"/></>,
  "file-plus": <><path d="M4 1.8h5l3.2 3.2V14a.6.6 0 0 1-.6.6H4a.6.6 0 0 1-.6-.6V2.4A.6.6 0 0 1 4 1.8z"/><path d="M9 1.8V5h3.2M8 7.5v4M6 9.5h4"/></>,
  // Not in the mockup: the Files stage's word-wrap toggle (docs/CODE_REDESIGN_PLAN.md §9).
  "wrap": <><path d="M2.5 4h11M2.5 8h8.2a2.3 2.3 0 0 1 0 4.6H8.5M10 11l-1.6 1.6L10 14.2M2.5 12.6H5"/></>,
  // Not in the mockup: the Settings nav (app/settings/SettingsModal.tsx), drawn to the same grid.
  "palette": <><path d="M8 2a6 6 0 0 0 0 12c.9 0 1.4-.6 1.4-1.3 0-.4-.2-.7-.4-1s-.4-.6-.4-1c0-.7.6-1.2 1.3-1.2h1.5A2.6 2.6 0 0 0 14 6.9 5.6 5.6 0 0 0 8 2z"/><path d="M4.9 7.4h.01M7.4 4.9h.01M10.5 5.6h.01"/></>,
  "plug": <><path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3"/></>,
  "chip": <><rect x="4" y="4" width="8" height="8" rx="1.5"/><path d="M6.5 1.8V4M9.5 1.8V4M6.5 12v2.2M9.5 12v2.2M1.8 6.5H4M1.8 9.5H4M12 6.5h2.2M12 9.5h2.2"/></>,
  "keyboard": <><rect x="1.8" y="4" width="12.4" height="8" rx="1.8"/><path d="M4.6 6.7h.01M7 6.7h.01M9.4 6.7h.01M11.6 6.7h-.2M5.2 9.4h5.6"/></>,
  "user": <><circle cx="8" cy="5.5" r="2.6"/><path d="M2.8 13.6c.6-2.5 2.7-3.9 5.2-3.9s4.6 1.4 5.2 3.9"/></>,
  "info": <><circle cx="8" cy="8" r="6"/><path d="M8 7.3v3.5M8 5.1v.01"/></>,
} satisfies Record<string, JSX.Element>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className ? `r-i ${className}` : "r-i"} {...props}>
      {PATHS[name]}
    </svg>
  );
}
