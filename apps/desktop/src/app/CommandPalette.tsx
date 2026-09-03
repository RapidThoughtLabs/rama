import { useEffect, useMemo, useRef, useState } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useTheme } from "@rama/ui";
import type { SearchResultDTO } from "@rama/protocol";
import { ramaSearch } from "../engine/client";
import { useProjectsData } from "./data/ProjectsProvider";
import { useWindowTabsData } from "./data/WindowTabsProvider";

interface PaletteAction {
  id: string;
  title: string;
  subtitle?: string;
  run: () => void;
}

type PaletteEntry = { kind: "action"; action: PaletteAction } | { kind: "result"; result: SearchResultDTO };

// Global ⌘K app-action palette, distinct from the composer's `/` menu (ChatColumn.tsx) but
// sharing the same rama search backend (docs/IMPLEMENTATION_PLAN.md Phase 7, Part 5). Selecting a
// tools/skills/mcp/docs result or a commands entry can't touch ChatColumn's local composer state
// directly since this component lives in AppShell, outside ChatColumn — bridged via a couple of
// window CustomEvents that ChatColumn listens for, the lightest option that doesn't require
// lifting composer state into a context (this codebase has no global store).
//
// docs/REDESIGN_PLAN.md Phase R3 — this is also where every other global keyboard chord lives
// (⌘K was already here; ⌘, / ⌘N / ⌃⇥ / ⌘1-9 / ⌘⇧O joined once the tab strip's own click targets
// went away), so shortcut handling stays in one place instead of scattered per-component.
export function CommandPalette({
  onTogglePanel,
  onOpenSettings,
}: {
  onTogglePanel: () => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResultDTO[]>([]);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const { cycleTheme } = useTheme();
  const { allChats, activeProjectId } = useProjectsData();
  const { tabs, activeTabId, selectTab, openNewTab, adoptChat, popOutTab } = useWindowTabsData();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (meta && key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (meta && key === ",") {
        e.preventDefault();
        onOpenSettings();
        return;
      }
      if (meta && key === "n") {
        e.preventDefault();
        if (activeProjectId) void openNewTab(activeProjectId);
        return;
      }
      if (meta && e.shiftKey && key === "o") {
        e.preventDefault();
        if (activeTabId) void popOutTab(activeTabId);
        return;
      }
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        if (tabs.length < 2) return;
        const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
        const step = e.shiftKey ? -1 : 1;
        const next = tabs[(currentIndex + step + tabs.length) % tabs.length];
        selectTab(next.id);
        return;
      }
      if (e.metaKey && /^[1-9]$/.test(e.key)) {
        const target = tabs[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          selectTab(target.id);
        }
      }
    }
    // Titlebar.tsx's ⌘K pill dispatches this on click, toggling the same palette instead of
    // duplicating open/close state across two sibling components.
    function onToggle() {
      setOpen((v) => !v);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("rama:toggle-palette", onToggle);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("rama:toggle-palette", onToggle);
    };
  }, [activeProjectId, activeTabId, tabs, openNewTab, popOutTab, selectTab, onOpenSettings]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setResults([]);
    setIndex(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open || !query.trim()) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      ramaSearch(query, activeProjectId ?? undefined)
        .then((r) => {
          setResults(r);
          setIndex(0);
        })
        .catch(() => setResults([]));
    }, 150);
    return () => clearTimeout(timer);
  }, [open, query, activeProjectId]);

  // Mirrors Sidebar.tsx's handleChatClick: a chat is a tab in at most one window at a time
  // (docs/IMPLEMENTATION_PLAN.md Phase 5) — select it directly if it's already a tab here,
  // adopt it into this window otherwise, or focus the window that already owns it.
  async function jumpToChat(chatId: string) {
    if (tabs.some((t) => t.id === chatId)) {
      selectTab(chatId);
      setOpen(false);
      return;
    }
    const otherOwner = await adoptChat(chatId);
    if (otherOwner) {
      const win = await WebviewWindow.getByLabel(otherOwner);
      await win?.setFocus();
    }
    setOpen(false);
  }

  const actions: PaletteAction[] = useMemo(() => {
    const list: PaletteAction[] = [
      {
        id: "act:new-chat",
        title: "new chat",
        subtitle: "start a new chat in the active project",
        run: () => {
          if (activeProjectId) void openNewTab(activeProjectId);
        },
      },
      { id: "act:theme", title: "cycle theme", run: cycleTheme },
      { id: "act:panel", title: "toggle artifacts panel", run: onTogglePanel },
      { id: "act:settings", title: "settings", subtitle: "⌘,", run: onOpenSettings },
    ];
    if (tabs.length > 1 && activeTabId) {
      list.push({
        id: "act:pop-out",
        title: "pop out this chat",
        subtitle: "⌘⇧O · opens it in a new window",
        run: () => void popOutTab(activeTabId),
      });
    }
    for (const chat of allChats) {
      list.push({ id: `act:chat:${chat.id}`, title: chat.title, subtitle: "jump to chat", run: () => void jumpToChat(chat.id) });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    allChats,
    activeProjectId,
    openNewTab,
    cycleTheme,
    onTogglePanel,
    onOpenSettings,
    tabs,
    activeTabId,
    popOutTab,
  ]);

  const filteredActions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions.slice(0, 6);
    return actions.filter((a) => a.title.toLowerCase().includes(q));
  }, [actions, query]);

  const entries: PaletteEntry[] = useMemo(
    () => [...filteredActions.map((action) => ({ kind: "action" as const, action })), ...results.map((result) => ({ kind: "result" as const, result }))],
    [filteredActions, results],
  );

  function selectEntry(entry: PaletteEntry) {
    if (entry.kind === "action") {
      entry.action.run();
      setOpen(false);
      return;
    }
    const { result } = entry;
    if (result.domain === "commands") {
      window.dispatchEvent(new CustomEvent("rama:run-command", { detail: result.id }));
    } else {
      window.dispatchEvent(new CustomEvent("rama:composer-insert", { detail: `/${result.title} ` }));
    }
    setOpen(false);
  }

  if (!open) return null;

  return (
    <div className="rama-palette-overlay" onClick={() => setOpen(false)}>
      <div className="rama-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="rama-palette-input"
          placeholder="search actions, tools, skills, mcp, docs…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, Math.max(entries.length - 1, 0)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (entries[index]) selectEntry(entries[index]);
            }
          }}
        />
        <div className="rama-search-menu rama-palette-menu">
          {entries.length === 0 && <div className="rama-search-menu-empty">no matches</div>}
          {filteredActions.length > 0 && <div className="rama-search-menu-group-label">actions</div>}
          {filteredActions.map((action, i) => (
            <button
              key={action.id}
              className={`rama-search-menu-item${i === index ? " rama-search-menu-item-active" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => selectEntry({ kind: "action", action })}
            >
              <span className="rama-search-menu-item-title">{action.title}</span>
              {action.subtitle && <span className="rama-search-menu-item-subtitle">{action.subtitle}</span>}
            </button>
          ))}
          {results.length > 0 && <div className="rama-search-menu-group-label">search results</div>}
          {results.map((result, i) => {
            const entryIndex = filteredActions.length + i;
            return (
              <button
                key={result.id}
                className={`rama-search-menu-item${entryIndex === index ? " rama-search-menu-item-active" : ""}`}
                onMouseEnter={() => setIndex(entryIndex)}
                onClick={() => selectEntry({ kind: "result", result })}
              >
                <span className="rama-search-menu-item-title">{result.title}</span>
                <span className="rama-search-menu-item-subtitle">{result.subtitle}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
