import { useState } from "react";
import { Fluke, Icon } from "@rama/ui";
import { CodeChatList } from "../code/CodeChatList";
import { HomeChatList } from "../home/HomeChatList";
import { useNavigation } from "../data/NavigationProvider";
import { useProjectsData } from "../data/ProjectsProvider";

/* Sidebar frame — HOME_REDESIGN_PLAN.md Phase HD1 (mock:L99-163, 740-760, 1508-1516). Owns the
   chrome both sections share: the traffic-light row, the Home/Code segment, the nav rows, the
   search field and the footer. The list itself belongs to each section's plan (§3 rule 2):
   home/HomeChatList.tsx (HD4) and code/CodeChatList.tsx (the Code plan). Neither list file is
   edited from here. */
export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const nav = useNavigation();
  const { activeProjectId, openDraft } = useProjectsData();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const home = nav.section === "home";

  function closeSearch() {
    setQuery("");
    setSearchOpen(false);
  }

  function newChat() {
    if (home) {
      nav.goHomeLanding();
      return;
    }
    if (activeProjectId) openDraft(activeProjectId);
    nav.goSection("code");
  }

  return (
    <aside className="r-sidebar" aria-label="Chats">
      {/* "deep" so any non-interactive point in the row drags the window; Tauri's drag script still
          lets the buttons take their own clicks. */}
      <div className="r-sb-top" data-tauri-drag-region="deep">
        <div className="r-sb-lights" aria-hidden="true" />
        <button className="r-icon-btn" title="Hide sidebar" aria-label="Hide sidebar" onClick={() => nav.setSidebarOpen(false)}>
          <Icon name="panel" />
        </button>
        <button
          className="r-icon-btn"
          title="Search chats"
          aria-label="Search chats"
          aria-pressed={searchOpen}
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
        >
          <Icon name="search" />
        </button>
      </div>

      {searchOpen && (
        <div className="r-sb-search">
          <input
            autoFocus
            placeholder="Search chats"
            aria-label="Search chats"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeSearch();
            }}
            onBlur={() => {
              if (!query) setSearchOpen(false);
            }}
          />
        </div>
      )}

      <div className="r-seg" role="group" aria-label="Section">
        <button aria-pressed={home} onClick={() => nav.goSection("home")}>
          <Icon name="home" />
          Home
        </button>
        <button aria-pressed={!home} onClick={() => nav.goSection("code")}>
          <Icon name="code" />
          Code
        </button>
      </div>

      <nav className="r-sb-nav">
        <button className="r-nav-row" onClick={newChat}>
          <Icon name="plus" />
          New chat<kbd>⌘N</kbd>
        </button>
        {!home && (
          <button className="r-nav-row" onClick={() => nav.goPage("docs")}>
            <Icon name="docs" />
            Docs
          </button>
        )}
        <button className="r-nav-row" onClick={() => nav.goPage("toolbox")}>
          <Icon name="tool" />
          Toolbox
        </button>
      </nav>

      <div className="r-sb-list">{home ? <HomeChatList query={query} /> : <CodeChatList query={query} />}</div>

      <div className="r-sb-foot">
        <div className="r-avatar">
          <Fluke aria-hidden="true" role={undefined} aria-label={undefined} />
        </div>
        <div className="r-who">
          <b>rama</b>
          <span>Local account</span>
        </div>
        <button className="r-icon-btn" title="Settings" aria-label="Settings" onClick={onOpenSettings}>
          <Icon name="sliders" />
        </button>
      </div>
    </aside>
  );
}
