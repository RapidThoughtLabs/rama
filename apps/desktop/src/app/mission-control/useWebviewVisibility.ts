import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { webviewSetBounds, webviewSetVisible } from "../../engine/client";
import { useSettingsLink } from "../data/SettingsLinkContext";

// docs/MISSION_CONTROL_PLAN.md §8 Phase M5 — "the rule that keeps it survivable." A native child
// webview always paints above the DOM, so it has to be hidden whenever something else needs to be
// on top of it. WebStage only mounts while the Web pane is the active pane and Mission Control is
// expanded (MissionControl.tsx unmounts the whole panel on `panelCollapsed`, and only the active
// pane's Stage is ever mounted), so those two cases are covered by this hook simply not running.
// What's left: SettingsModal and the command palette, neither of which this component can see
// through props — SettingsLinkContext already exists for the former; the palette has no shared
// context for its open state, so CommandPalette.tsx broadcasts one (`rama:palette-visibility`).
export function useWebviewVisibility(pageId: string | null, containerRef: RefObject<HTMLElement | null>): void {
  const { isOpen: settingsOpen } = useSettingsLink();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    function onPaletteVisibility(e: Event) {
      setPaletteOpen(!!(e as CustomEvent<boolean>).detail);
    }
    window.addEventListener("rama:palette-visibility", onPaletteVisibility);
    return () => window.removeEventListener("rama:palette-visibility", onPaletteVisibility);
  }, []);

  const visible = !!pageId && !settingsOpen && !paletteOpen;

  useEffect(() => {
    if (!pageId) return;
    void webviewSetVisible(pageId, visible).catch(() => {});
  }, [pageId, visible]);

  // Hides (never destroys — that's WebPaneContext.closePage's job) on unmount, so switching away
  // from the Web pane doesn't leave a stale webview painted over whatever's shown next.
  useEffect(() => {
    if (!pageId) return;
    return () => {
      void webviewSetVisible(pageId, false).catch(() => {});
    };
  }, [pageId]);

  const rafRef = useRef<number | null>(null);

  // Bounds sync: one ResizeObserver on the stage node, rAF-throttled (§4.7's own pattern for the
  // splitter drag), issuing `webview_set_bounds` in the same logical-pixel coordinate space
  // `getBoundingClientRect()` already reports in (this window has exactly one DOM webview, so its
  // client-area origin is the window's own).
  useEffect(() => {
    const node = containerRef.current;
    if (!pageId || !node) return;

    function flush() {
      rafRef.current = null;
      const rect = node!.getBoundingClientRect();
      void webviewSetBounds(pageId!, rect.left, rect.top, rect.width, rect.height).catch(() => {});
    }

    function schedule() {
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(flush);
    }

    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(node);
    window.addEventListener("resize", schedule);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [pageId, containerRef]);
}
