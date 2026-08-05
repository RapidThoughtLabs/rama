import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTheme } from "@rama/ui";
import type { ChatDTO } from "@rama/protocol";
import { useProjectsData } from "./data/ProjectsProvider";
import { useWindowTabsData } from "./data/WindowTabsProvider";
import { ProviderSettingsModal } from "./ProviderSettingsModal";

// Phase 5 tab drag (docs/IMPLEMENTATION_PLAN.md): a pointer-capture-driven gesture, not native
// HTML5 draggable (which can't spawn a new native window mid-drag or hit-test other OS windows).
// Small movement within the strip previews an in-window reorder (committed via `reorderTabs` on
// release); movement that leaves the strip's vertical bounds hands off to the Rust-driven
// cross-window drag (`beginTabDrag` -> src-tauri/src/drag.rs) — from that point on this
// component does nothing further, the poll loop and `tabs-changed`/`drag-hover` events take over.
const DRAG_THRESHOLD_PX = 6;
const TEAR_OFF_MARGIN_PX = 28;

interface DragSession {
  chatId: string;
  pointerId: number;
  startX: number;
  startY: number;
  grabOffsetX: number;
  grabOffsetY: number;
  mode: "pending" | "reorder" | "detached" | "windowMove";
  centers: { id: string; centerX: number }[];
  el: HTMLDivElement;
}

// Applied/removed imperatively (not via React state) directly on the grabbed tab's element —
// this runs at pointer-move frequency, and re-rendering the whole tab list every frame just to
// toggle one element's class/transform would be wasteful and janky.
const DRAGGING_CLASS = "rama-tab-item-dragging";

function clearDragVisual(el: HTMLDivElement) {
  el.classList.remove(DRAGGING_CLASS);
  el.style.transform = "";
}

export function Titlebar(props: { panelOpen: boolean; onTogglePanel: () => void }) {
  const { theme, toggleTheme, cycleAccent, cycleWallpaper } = useTheme();
  const { activeProjectId } = useProjectsData();
  const { tabs, activeTabId, isDropTarget, selectTab, openNewTab, reorderTabs, beginTabDrag } = useWindowTabsData();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragSession | null>(null);

  const displayTabs = previewOrder
    ? previewOrder.map((id) => tabs.find((t) => t.id === id)).filter((t): t is ChatDTO => !!t)
    : tabs;

  // The strip now scrolls instead of clipping once tabs hit their min-width floor (app-shell.css)
  // — without this, switching to a tab that's scrolled out of view would leave it selected but
  // still invisible. Skipped mid-drag (`previewOrder` set) so it doesn't fight the drag gesture.
  useEffect(() => {
    if (!activeTabId || previewOrder) return;
    const el = stripRef.current?.querySelector<HTMLElement>(`[data-tab-id="${activeTabId}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, previewOrder]);

  const handlePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>, chatId: string) => {
    if (e.button !== 0) return;
    // Suppress the native text-selection/drag that would otherwise fire on the tab label and
    // fight our pointer-capture gesture.
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = {
      chatId,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      grabOffsetX: e.clientX - rect.left,
      grabOffsetY: e.clientY - rect.top,
      mode: "pending",
      centers: [],
      el: e.currentTarget,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const session = dragRef.current;
      if (!session || e.pointerId !== session.pointerId) return;

      if (session.mode === "pending") {
        if (Math.hypot(e.clientX - session.startX, e.clientY - session.startY) < DRAG_THRESHOLD_PX) return;

        // A single-tab window IS the window: there's nothing to reorder against and tearing it
        // off would just spawn a new window and leave this one an empty husk behind (the "tab
        // mitosis" bug — repeat that a few times and you get a trail of derelict windows all
        // showing the same chat). Instead, grabbing the lone tab just moves the window, matching
        // Chrome. Hand off to Tauri's native interactive-move loop and stop tracking this session
        // ourselves; nothing left for our pointer handlers to do once the OS takes over.
        if (tabs.length === 1) {
          session.mode = "windowMove";
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
          void getCurrentWindow().startDragging();
          return;
        }

        session.mode = "reorder";
        session.centers = Array.from(stripRef.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? []).map(
          (el) => {
            const r = el.getBoundingClientRect();
            return { id: el.dataset.tabId as string, centerX: r.left + r.width / 2 };
          },
        );
        setPreviewOrder(tabs.map((t) => t.id));
        // Visual "picked up" state — Chrome-style hint that this tab is now stuck to the
        // cursor, ahead of it actually leaving the strip and becoming a real window drag.
        session.el.classList.add(DRAGGING_CLASS);
      }

      if (session.mode !== "reorder") return;

      // Keep the lifted tab tracking the cursor horizontally while other tabs shuffle around it.
      session.el.style.transform = `translateX(${e.clientX - session.startX}px)`;

      const stripRect = stripRef.current?.getBoundingClientRect();
      const leftStrip =
        stripRect && (e.clientY < stripRect.top - TEAR_OFF_MARGIN_PX || e.clientY > stripRect.bottom + TEAR_OFF_MARGIN_PX);
      if (leftStrip) {
        session.mode = "detached";
        clearDragVisual(session.el);
        setPreviewOrder(null);
        const scale = window.devicePixelRatio || 1;
        beginTabDrag(session.chatId, session.grabOffsetX * scale, session.grabOffsetY * scale);
        return;
      }

      let targetIndex = session.centers.length;
      for (let i = 0; i < session.centers.length; i++) {
        if (e.clientX < session.centers[i].centerX) {
          targetIndex = i;
          break;
        }
      }

      setPreviewOrder((prev) => {
        if (!prev) return prev;
        const from = prev.indexOf(session.chatId);
        if (from === -1) return prev;
        const next = [...prev];
        next.splice(from, 1);
        next.splice(Math.min(targetIndex, next.length), 0, session.chatId);
        return next;
      });
    },
    [tabs, beginTabDrag],
  );

  // Core end-of-drag cleanup, factored out so it's callable both from the tab's own
  // pointerup/pointercancel handlers below AND from the window-level fallback listeners further
  // down. Idempotent (bails immediately once `dragRef.current` is null) so it's safe to reach
  // from multiple listeners for the same physical release.
  const finishDrag = useCallback(
    (commit: boolean, pointerId?: number) => {
      const session = dragRef.current;
      if (!session) return;
      if (pointerId !== undefined && pointerId !== session.pointerId) return;
      dragRef.current = null;
      if (session.el.hasPointerCapture(session.pointerId)) session.el.releasePointerCapture(session.pointerId);
      clearDragVisual(session.el);

      if (session.mode === "pending") {
        if (commit) selectTab(session.chatId);
        return;
      }
      if (session.mode === "reorder") {
        if (commit && previewOrder) reorderTabs(previewOrder);
        setPreviewOrder(null);
      }
      // "detached": handed off to the Rust cross-window drag loop; "windowMove": handed off to
      // Tauri's native OS move loop. Either way, nothing left to do here.
    },
    [previewOrder, selectTab, reorderTabs],
  );

  const endDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, commit: boolean) => finishDrag(commit, e.pointerId),
    [finishDrag],
  );

  // Defensive fallback for the "tab stays stuck to the cursor" bug: `setPointerCapture` is
  // *supposed* to guarantee the capturing element keeps getting pointerup/pointercancel no
  // matter what's under the cursor at release time, but that contract has known gaps in embedded
  // webviews (WKWebView on macOS included) once the cursor crosses outside the webview's own
  // bounds mid-drag — exactly what tearing a tab towards the strip's edges does. When that gap
  // hits, the tab's own handlers never fire, `dragRef` never clears, and the "picked up" visual
  // (shadow + translateX) is left stuck indefinitely. These window-level listeners are a second,
  // redundant path to the same cleanup; `finishDrag`'s null-check makes them harmless no-ops in
  // the normal case, where the element's own handler already got there first. `blur` covers the
  // cursor leaving the OS window entirely with the button released outside it.
  useEffect(() => {
    const onPointerUp = (e: PointerEvent) => finishDrag(true, e.pointerId);
    const onPointerCancel = (e: PointerEvent) => finishDrag(false, e.pointerId);
    const onMouseUp = () => finishDrag(true);
    const onBlur = () => finishDrag(false);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [finishDrag]);

  return (
    // "deep" (not bare) so any non-interactive point in the titlebar drags the window — a bare
    // attr here only armed the root element itself, which children fully cover, so in practice
    // only the tiny traffic-gap/spacer slivers below were ever draggable. Tauri's drag script
    // still blocks on clickable elements/roles first (buttons, role="tab"), so tab items and
    // the control buttons are unaffected and keep their own gesture handling.
    <div className="rama-titlebar" data-tauri-drag-region="deep">
      <div className="rama-titlebar-traffic-gap" />
      <div className="rama-titlebar-divider" />
      <div ref={stripRef} className={`rama-tabstrip ${isDropTarget ? "rama-tabstrip-drop-target" : ""}`}>
        {displayTabs.map((chat) => (
          <div
            key={chat.id}
            data-tab-id={chat.id}
            role="tab"
            aria-selected={chat.id === activeTabId}
            className="rama-tab-item"
            onPointerDown={(e) => handlePointerDown(e, chat.id)}
            onPointerMove={handlePointerMove}
            onPointerUp={(e) => endDrag(e, true)}
            onPointerCancel={(e) => endDrag(e, false)}
          >
            <span className={`rama-tab-dot ${chat.status === "running" ? "rama-tab-dot-running" : ""}`} />
            <span className="rama-tab-title">{chat.title}</span>
            <span className="rama-tab-edge" />
          </div>
        ))}
        <button
          className="rama-tab-new"
          title="New tab (⌘T)"
          disabled={!activeProjectId}
          onClick={() => activeProjectId && openNewTab(activeProjectId)}
        >
          +
        </button>
      </div>
      <div style={{ flex: 1, minWidth: 24 }} />
      <div className="rama-titlebar-controls">
        <span className="rama-cmdk-pill">
          ⌘K<span style={{ opacity: 0.65 }}>commands</span>
        </span>
        <button className="rama-btn rama-btn-icon" onClick={cycleWallpaper} title="Cycle wallpaper">
          ▨
        </button>
        <button className="rama-btn rama-btn-icon" onClick={cycleAccent} title="Cycle accent">
          <span className="rama-accent-dot" />
        </button>
        <button className="rama-btn rama-btn-icon" onClick={toggleTheme} title="Switch to light / dark">
          {theme === "dark" ? "☾" : "☀"}
        </button>
        <button className="rama-btn rama-btn-icon" onClick={props.onTogglePanel} title="Toggle artifacts panel">
          ◫
        </button>
        <button className="rama-btn rama-btn-icon" onClick={() => setSettingsOpen(true)} title="Provider settings">
          ⚙
        </button>
      </div>
      <ProviderSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
