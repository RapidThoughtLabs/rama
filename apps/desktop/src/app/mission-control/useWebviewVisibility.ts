import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { webviewSetBounds, webviewSetVisible } from "../../engine/client";
import { useSettingsLink } from "../data/SettingsLinkContext";

// docs/MISSION_CONTROL_PLAN.md §8 Phase M5 — "the rule that keeps it survivable." A native child
// webview always paints above the DOM, so it has to be hidden whenever something else needs to be
// on top of it. WebStage only mounts while the Web pane is the active pane and the workspace is
// open, and only the active pane's Stage is ever mounted. (Closing the workspace leaves the stage
// mounted but `display: none`, so the hook hides the webview when its card loses its box.)
// Those cases are otherwise covered by this hook simply not running. What's left: SettingsModal (through
// SettingsLinkContext), the command palette (`rama:palette-visibility`, a boolean) and every kit
// popover — the seal's theme popover always lands over the page (CR4). Popovers announce
// themselves on `rama:overlay-visibility` as `{ id, open }`; the hook keeps the set of open ids, so
// two popovers opening and closing out of order never un-hide the page early.
export function useWebviewVisibility(pageId: string | null, containerRef: RefObject<HTMLElement | null>): void {
  const { isOpen: settingsOpen } = useSettingsLink();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [overlays, setOverlays] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    function onPaletteVisibility(e: Event) {
      setPaletteOpen(!!(e as CustomEvent<boolean>).detail);
    }
    function onOverlay(e: Event) {
      const { id, open } = (e as CustomEvent<{ id: string; open: boolean }>).detail;
      setOverlays((prev) => {
        if (prev.has(id) === open) return prev;
        const next = new Set(prev);
        if (open) next.add(id);
        else next.delete(id);
        return next;
      });
    }
    window.addEventListener("rama:palette-visibility", onPaletteVisibility);
    window.addEventListener("rama:overlay-visibility", onOverlay);
    return () => {
      window.removeEventListener("rama:palette-visibility", onPaletteVisibility);
      window.removeEventListener("rama:overlay-visibility", onOverlay);
    };
  }, []);

  const visible = !!pageId && !settingsOpen && !paletteOpen && overlays.size === 0;

  // The workspace can be closed (`display: none`) with this stage still mounted; a hidden card has no
  // offsetParent, and the webview must not stay painted over the chat.
  const shown = useRef(false);
  const applyVisible = (node: HTMLElement | null) => {
    shown.current = visible && !!node && node.offsetParent !== null;
    void webviewSetVisible(pageId!, shown.current).catch(() => {});
  };

  useEffect(() => {
    if (!pageId) return;
    applyVisible(containerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      const nowShown = visible && node!.offsetParent !== null;
      if (nowShown !== shown.current) applyVisible(node!);
      if (rect.width > 0 && rect.height > 0) void webviewSetBounds(pageId!, rect.left, rect.top, rect.width, rect.height).catch(() => {});
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, containerRef, visible]);
}
