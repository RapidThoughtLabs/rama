import { useState } from "react";
import type { MouseEvent } from "react";
import type { HomeChatSummaryDTO } from "@rama/protocol";
import { Icon, Popover } from "@rama/ui";
import { useHomeChats } from "../data/HomeChatsProvider";
import { useNavigation } from "../data/NavigationProvider";
import { groupByDate } from "./dates";

/* Home's sidebar list — HOME_REDESIGN_PLAN.md Phase HD4 (mock:L146-156, 1517-1522). Home chats by
   date, never by project: Today, Yesterday, Previous 7 days, then month names. The frame around it
   (search field, segment, nav rows) is shell/Sidebar.tsx, which passes the search text in.

   The `.r-chat-row` rule is shared with Code's list and lives in code/code.css. A row is current
   only while that chat is on screen, not merely remembered. Right-click opens Rename and Delete
   (not in the mockup, §6.3). Rename edits the row in place; Delete asks first through the one
   confirm dialog HomeChatsProvider owns. A running Home chat shows no dot: Home's working
   indicator lives in the transcript. */

type Menu = { chat: HomeChatSummaryDTO; x: number; y: number };

export function HomeChatList({ query }: { query: string }) {
  const { homeChats, loading, rename, requestRemove } = useHomeChats();
  const nav = useNavigation();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);

  const term = query.trim().toLowerCase();
  const visible = term ? homeChats.filter((c) => c.title.toLowerCase().includes(term)) : homeChats;
  const groups = groupByDate(visible, Date.now());
  const onScreenId = nav.view === "home" && nav.homeView === "chat" ? nav.homeChatId : null;

  function openMenu(e: MouseEvent, chat: HomeChatSummaryDTO) {
    e.preventDefault();
    // Keep the menu on screen.
    setMenu({ chat, x: Math.min(e.clientX, window.innerWidth - 216), y: Math.min(e.clientY, window.innerHeight - 110) });
  }

  function commitRename() {
    if (!editing) return;
    const { id, value } = editing;
    setEditing(null);
    const title = value.trim();
    const chat = homeChats.find((c) => c.id === id);
    if (title && chat && title !== chat.title) rename(id, title).catch((err) => console.error("[rama] failed to rename Home chat", err));
  }

  if (!loading && homeChats.length === 0) return null;
  if (term && groups.length === 0) return <div className="r-sb-empty">No chats match “{query.trim()}”.</div>;

  return (
    <>
      {groups.map((g) => (
        <div key={g.label}>
          <div className="r-group-label">{g.label}</div>
          {g.items.map((chat) =>
            editing?.id === chat.id ? (
              <div key={chat.id} className="r-chat-row" aria-current={chat.id === onScreenId}>
                <input
                  className="r-row-edit"
                  autoFocus
                  aria-label="Chat title"
                  value={editing.value}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setEditing({ id: chat.id, value: e.target.value })}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setEditing(null);
                  }}
                />
              </div>
            ) : (
              <button
                key={chat.id}
                className="r-chat-row"
                aria-current={chat.id === onScreenId}
                onClick={() => nav.openHomeChat(chat.id)}
                onContextMenu={(e) => openMenu(e, chat)}
              >
                <span className="t">{chat.title}</span>
              </button>
            ),
          )}
        </div>
      ))}

      <Popover open={menu !== null} onClose={() => setMenu(null)} className="r-menu" role="menu" style={menu ? { left: menu.x, top: menu.y } : undefined}>
        {menu && (
          <>
            <button
              role="menuitem"
              className="r-mp-item"
              onClick={() => {
                setMenu(null);
                setEditing({ id: menu.chat.id, value: menu.chat.title });
              }}
            >
              <Icon name="pencil" />
              <span>Rename</span>
            </button>
            <button
              role="menuitem"
              className="r-mp-item danger"
              onClick={() => {
                setMenu(null);
                requestRemove(menu.chat.id);
              }}
            >
              <Icon name="x" />
              <span>Delete chat</span>
            </button>
          </>
        )}
      </Popover>
    </>
  );
}
