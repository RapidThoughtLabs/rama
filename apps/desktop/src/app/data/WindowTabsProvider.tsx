import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ChatDTO } from "@rama/protocol";
import { WINDOW_LABEL } from "../../engine/window";
import { useProjectsData } from "./ProjectsProvider";

// Per-window tab ownership (docs/IMPLEMENTATION_PLAN.md Phase 5), layered on top of
// ProjectsProvider's global `allChats`/`activeChatId`. Rust's WindowRegistry
// (src-tauri/src/window_registry.rs) is the single source of truth for "which chat ids does
// *this* window own as tabs" — this provider only ever mirrors it, via `get_window_tabs` on
// mount and the `tabs-changed` event afterward. It never keeps local reordering/adoption state
// past an incoming event, so it can't diverge from Rust into a second source of truth.
//
// IMPORTANT: listeners below use `getCurrentWindow().listen(...)`, NOT the bare `listen()` from
// `@tauri-apps/api/event`. The bare form registers with target `{ kind: "Any" }` by default —
// which, per Tauri's own event-matching code, accepts an event regardless of what label
// `emit_to` targeted it at. Every window in the app would receive every *other* window's
// tabs-changed/drag-hover events and stomp its own tab list with them. `getCurrentWindow().listen`
// scopes the registration to `{ kind: "Window", label: <this window's own label> }`, so a window
// only ever reacts to events actually addressed to it.

interface TabsChangedPayload {
  chatIds: string[];
}

interface DragHoverPayload {
  hovering: boolean;
}

export interface WindowTabsDataValue {
  windowLabel: string;
  tabs: ChatDTO[];
  activeTabId: string | null;
  isDropTarget: boolean;
  selectTab: (chatId: string) => void;
  openNewTab: (projectId: string) => Promise<ChatDTO>;
  adoptChat: (chatId: string) => Promise<string | null>;
  reorderTabs: (chatIds: string[]) => void;
  beginTabDrag: (chatId: string, grabOffsetX: number, grabOffsetY: number) => void;
}

const WindowTabsContext = createContext<WindowTabsDataValue | null>(null);

export function WindowTabsProvider({ children }: { children: ReactNode }) {
  const { allChats, activeChatId, selectChat, addChat } = useProjectsData();
  const [chatIds, setChatIds] = useState<string[] | null>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const seededRef = useRef(false);

  useEffect(() => {
    const unlisten = getCurrentWindow().listen<TabsChangedPayload>("tabs-changed", (event) => {
      seededRef.current = true;
      setChatIds(event.payload.chatIds);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlisten = getCurrentWindow().listen<DragHoverPayload>("drag-hover", (event) => {
      setIsDropTarget(event.payload.hovering);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    invoke<string[]>("get_window_tabs", { windowLabel: WINDOW_LABEL }).then((ids) => {
      if (ids.length > 0) {
        seededRef.current = true;
        setChatIds(ids);
      }
    });
  }, []);

  // Self-heal on focus: re-pull the registry's ground truth whenever this window regains OS
  // focus. `tabs-changed` emits are best-effort (a window's listener may not be attached yet
  // when Rust fires one — e.g. immediately after a drag or right after a new window is spawned),
  // so a window can otherwise be left showing a stale tab list until something else happens to
  // provoke another emit. Focus is a reliable, low-cost moment to reconcile: it's exactly when
  // the user starts looking at a window, so any drift is invisible for at most a moment.
  useEffect(() => {
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      invoke<string[]>("get_window_tabs", { windowLabel: WINDOW_LABEL }).then((ids) => {
        seededRef.current = true;
        setChatIds(ids);
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Cold-boot seeding: once this window's global chat list is known and Rust has never told us
  // otherwise, hand it every currently-known chat id. No-op on the Rust side if this window's
  // label already has a registry entry (e.g. a freshly spawned drag-target window, pre-seeded
  // with a single chat id before its HTML even loads) — so this only actually fires for a
  // cold-booted `main` window.
  useEffect(() => {
    if (seededRef.current || allChats.length === 0) return;
    const ids = allChats.map((c) => c.id);
    invoke("initialize_window_tabs", { windowLabel: WINDOW_LABEL, chatIds: ids }).then(() => {
      seededRef.current = true;
    });
  }, [allChats]);

  const tabs = useMemo(() => {
    if (!chatIds) return [];
    const byId = new Map(allChats.map((c) => [c.id, c]));
    const resolved: ChatDTO[] = [];
    for (const id of chatIds) {
      const chat = byId.get(id);
      if (chat) resolved.push(chat);
    }
    return resolved;
  }, [chatIds, allChats]);

  const activeTabId = useMemo(() => {
    if (activeChatId && tabs.some((t) => t.id === activeChatId)) return activeChatId;
    return tabs[0]?.id ?? null;
  }, [activeChatId, tabs]);

  useEffect(() => {
    if (activeTabId && activeTabId !== activeChatId) selectChat(activeTabId);
  }, [activeTabId, activeChatId, selectChat]);

  const selectTab = useCallback(
    (chatId: string) => {
      if (tabs.some((t) => t.id === chatId)) selectChat(chatId);
    },
    [tabs, selectChat],
  );

  const openNewTab = useCallback(
    async (projectId: string) => {
      const chat = await addChat(projectId);
      await invoke("add_chat_to_window", { windowLabel: WINDOW_LABEL, chatId: chat.id });
      return chat;
    },
    [addChat],
  );

  // Adopts an existing chat into this window's tabs, or — if it's already owned by another
  // window — returns that window's label so the caller can focus it instead (a chat is a tab in
  // at most one window; see Sidebar.tsx's click handler).
  const adoptChat = useCallback(async (chatId: string): Promise<string | null> => {
    const otherOwner = await invoke<string | null>("add_chat_to_window", { windowLabel: WINDOW_LABEL, chatId });
    return otherOwner;
  }, []);

  // Commits an in-window tab reorder (final order only — the live drag preview while reordering
  // is purely local UI state owned by Titlebar, not this provider; see its pointer handlers).
  const reorderTabs = useCallback((nextChatIds: string[]) => {
    invoke("reorder_window_tabs", { windowLabel: WINDOW_LABEL, chatIds: nextChatIds }).catch((err) => {
      console.error("[rama] failed to persist tab order", err);
    });
  }, []);

  // Starts a real cross-window tab tear-off drag (Rust-driven poll loop; see
  // src-tauri/src/drag.rs). `grabOffsetX/Y` are physical-pixel offsets from the tab element's
  // top-left to where the pointer grabbed it, used so the spawned window's top-left tracks the
  // cursor naturally rather than snapping the whole window under the pointer.
  const beginTabDrag = useCallback((chatId: string, grabOffsetX: number, grabOffsetY: number) => {
    invoke("begin_tab_drag", { chatId, fromLabel: WINDOW_LABEL, grabOffsetX, grabOffsetY }).catch((err) => {
      console.error("[rama] failed to begin tab drag", err);
    });
  }, []);

  const value = useMemo<WindowTabsDataValue>(
    () => ({
      windowLabel: WINDOW_LABEL,
      tabs,
      activeTabId,
      isDropTarget,
      selectTab,
      openNewTab,
      adoptChat,
      reorderTabs,
      beginTabDrag,
    }),
    [tabs, activeTabId, isDropTarget, selectTab, openNewTab, adoptChat, reorderTabs, beginTabDrag],
  );

  return <WindowTabsContext.Provider value={value}>{children}</WindowTabsContext.Provider>;
}

export function useWindowTabsData(): WindowTabsDataValue {
  const ctx = useContext(WindowTabsContext);
  if (!ctx) throw new Error("useWindowTabsData must be used within a WindowTabsProvider");
  return ctx;
}
