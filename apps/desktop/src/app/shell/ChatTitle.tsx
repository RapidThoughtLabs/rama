import { useRef, useState } from "react";
import { Icon, Popover, type IconName } from "@rama/ui";

/* The top bar's chat-title button — HOME_REDESIGN_PLAN.md Phase HD1 (mock:L174-181). Clicking it
   opens a small menu (not in the mockup, §6.3) with Rename and Delete chat; Rename swaps the
   button for an inline field. Shared by both sections: callers own what rename/delete mean, and
   `items` lets the Code side add its own rows (Pop out) without forking this. */
export interface ChatTitleItem {
  label: string;
  icon: IconName;
  onSelect: () => void;
  danger?: boolean;
}

export function ChatTitle({
  title,
  onRename,
  onDelete,
  items = [],
}: {
  title: string;
  onRename: (title: string) => void | Promise<void>;
  onDelete: () => void;
  items?: ChatTitleItem[];
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  function commit() {
    const next = editing?.trim();
    setEditing(null);
    if (next && next !== title) void onRename(next);
  }

  if (editing !== null) {
    return (
      <input
        className="r-rename-input"
        autoFocus
        aria-label="Chat title"
        value={editing}
        onChange={(e) => setEditing(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(null);
        }}
      />
    );
  }

  const all: ChatTitleItem[] = [
    { label: "Rename", icon: "pencil", onSelect: () => setEditing(title) },
    ...items,
    { label: "Delete chat", icon: "x", onSelect: onDelete, danger: true },
  ];

  return (
    <>
      <button
        ref={btnRef}
        className="r-chat-title"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
      >
        <span>{title}</span>
        <Icon name="down" />
      </button>
      <Popover open={menuOpen} onClose={() => setMenuOpen(false)} anchor={btnRef} className="r-menu" role="menu">
        {all.map((item) => (
          <button
            key={item.label}
            role="menuitem"
            className={item.danger ? "r-mp-item danger" : "r-mp-item"}
            onClick={() => {
              setMenuOpen(false);
              item.onSelect();
            }}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </button>
        ))}
      </Popover>
    </>
  );
}
