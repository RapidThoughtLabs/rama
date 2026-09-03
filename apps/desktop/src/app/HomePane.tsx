import { Fluke } from "@rama/ui";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useProjectsData } from "./data/ProjectsProvider";
import { useWindowTabsData } from "./data/WindowTabsProvider";

// docs/REDESIGN_PLAN.md Phase R5 — Home route: a placeholder pane showing recent chats across
// every project, reached via Titlebar.tsx's home/code view switcher (main window only). Opening a
// chat here reuses the exact adopt-or-focus-other-window logic Sidebar.tsx's handleChatClick
// already has — a chat is a tab in at most one window at a time (docs/IMPLEMENTATION_PLAN.md
// Phase 5) — then hands back to AppShell to flip the view to "code".
function relativeTime(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function HomePane({ onOpenChat }: { onOpenChat: () => void }) {
  const { allChats, projects } = useProjectsData();
  const { tabs, selectTab, adoptChat } = useWindowTabsData();

  async function open(chatId: string) {
    if (tabs.some((t) => t.id === chatId)) {
      selectTab(chatId);
      onOpenChat();
      return;
    }
    const otherOwner = await adoptChat(chatId);
    if (otherOwner) {
      const win = await WebviewWindow.getByLabel(otherOwner);
      await win?.setFocus();
      return;
    }
    onOpenChat();
  }

  return (
    <div className="rama-home">
      <div className="rama-home-header">
        <Fluke className="rama-home-fluke" />
        <div className="rama-home-title">recent activity</div>
      </div>
      <div className="rama-home-list">
        {allChats.length === 0 && (
          <div className="rama-home-empty">no chats yet — start one from a project in the sidebar.</div>
        )}
        {allChats.slice(0, 60).map((chat) => {
          const project = projects.find((p) => p.id === chat.projectId);
          return (
            <button key={chat.id} className="rama-home-row" onClick={() => open(chat.id)}>
              <span className={`rama-tab-dot ${chat.status === "running" ? "rama-tab-dot-running" : ""}`} />
              <div className="rama-home-row-main">
                <span className="rama-home-row-title">{chat.title}</span>
                <span className="rama-home-row-project">{project?.name ?? "—"}</span>
              </div>
              <span className="rama-home-row-time">{relativeTime(chat.updatedAt)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
