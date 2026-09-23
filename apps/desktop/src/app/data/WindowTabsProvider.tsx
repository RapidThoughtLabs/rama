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
// tabs-changed events and stomp its own tab list with them. `getCurrentWindow().listen` scopes
// the registration to `{ kind: "Window", label: <this window's own label> }`, so a window only
// ever reacts to events actually addressed to it.

interface TabsChangedPayload {
  chatIds: string[];
}

export interface WindowTabsDataValue {
  windowLabel: string;
  tabs: ChatDTO[];
  activeTabId: string | null;
  selectTab: (chatId: string) => void;
  /** Turns the current draft (ProjectsProvider.draft) into a real chat, registers it as this
   *  window's tab, and selects it. Returns null if there's no draft to promote. */
  promoteDraft: () => Promise<ChatDTO | null>;
  adoptChat: (chatId: string) => Promise<string | null>;
  popOutTab: (chatId: string) => Promise<void>;
}

const WindowTabsContext = createContext<WindowTabsDataValue | null>(null);

export function WindowTabsProvider({ children }: { children: ReactNode }) {
  const { allChats, activeChatId, selectChat, addChat, draft, clearDraft } = useProjectsData();
  const [chatIds, setChatIds] = useState<string[] | null>(null);
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

  // Registers the new chat as this window's tab — and folds its id into `chatIds` locally —
  // *before* selecting it. Selecting first (the old order) raced the `add_chat_to_window`
  // round-trip: `activeChatId` would flip to the new chat while `tabs` still reflected the old
  // registry snapshot, so the activeTabId/selectChat effect above saw an activeChatId that
  // wasn't (yet) one of "my" tabs, fell back to `tabs[0]`, and immediately reselected whatever
  // chat was previously active — the new chat would flash in and the old one would snap right
  // back ("ghost of an old chat" not clearing). Updating `chatIds` in the same tick as
  // `selectChat` keeps `tabs` and `activeChatId` consistent on the very next render, so that
  // effect has nothing to correct.
  //
  // Only ever called with a real, freshly-created chat — the "New chat" button itself no longer
  // creates one (see ProjectsProvider.openDraft); this only runs once the user actually sends
  // the draft's first message (ChatColumn.submit), which is also the only thing allowed to
  // create the chat that gets registered here.
  const promoteDraft = useCallback(async () => {
    if (!draft) return null;
    const chat = await addChat(draft.projectId, undefined, {
      select: false,
      mode: draft.mode,
      providerId: draft.providerId ?? undefined,
      model: draft.model ?? undefined,
      agentId: draft.agentId,
    });
    await invoke("add_chat_to_window", { windowLabel: WINDOW_LABEL, chatId: chat.id });
    seededRef.current = true;
    setChatIds((prev) => (prev ? [...prev, chat.id] : [chat.id]));
    selectChat(chat.id);
    clearDraft();
    return chat;
  }, [draft, addChat, selectChat, clearDraft]);

  // Adopts an existing chat into this window's tabs, or — if it's already owned by another
  // window — returns that window's label so the caller can focus it instead (a chat is a tab in
  // at most one window; see Sidebar.tsx's click handler).
  const adoptChat = useCallback(async (chatId: string): Promise<string | null> => {
    const otherOwner = await invoke<string | null>("add_chat_to_window", { windowLabel: WINDOW_LABEL, chatId });
    return otherOwner;
  }, []);

  // docs/REDESIGN_PLAN.md Phase R3 — moves a chat out of this window into a brand new standalone
  // one (src-tauri/src/drag.rs's pop_out_chat), replacing the old tear-off drag gesture with an
  // explicit action. Rust removes the chat from this window's registry entry and emits
  // `tabs-changed` itself, so there's nothing further to reconcile here beyond the invoke.
  const popOutTab = useCallback(async (chatId: string) => {
    await invoke("pop_out_chat", { chatId, fromLabel: WINDOW_LABEL }).catch((err) => {
      console.error("[rama] failed to pop out chat", err);
    });
  }, []);

  const value = useMemo<WindowTabsDataValue>(
    () => ({
      windowLabel: WINDOW_LABEL,
      tabs,
      activeTabId,
      selectTab,
      promoteDraft,
      adoptChat,
      popOutTab,
    }),
    [tabs, activeTabId, selectTab, promoteDraft, adoptChat, popOutTab],
  );

  return <WindowTabsContext.Provider value={value}>{children}</WindowTabsContext.Provider>;
}

export function useWindowTabsData(): WindowTabsDataValue {
  const ctx = useContext(WindowTabsContext);
  if (!ctx) throw new Error("useWindowTabsData must be used within a WindowTabsProvider");
  return ctx;
}
