import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCallback } from "react";
import { useNavigation } from "../data/NavigationProvider";
import { useProjectsData } from "../data/ProjectsProvider";
import { useWindowTabsData } from "../data/WindowTabsProvider";

/** Opens a Code chat the way the sidebar does. A chat is a tab in at most one window at a time
 *  (docs/IMPLEMENTATION_PLAN.md Phase 5): if it's already a tab here, select it; otherwise adopt it
 *  into this window — unless another window owns it, in which case that window is focused instead
 *  of duplicating the tab. Shared by the sidebar rows and the landing's resume rows. */
export function useOpenChat(): (chatId: string) => Promise<void> {
  const { selectChat } = useProjectsData();
  const { tabs, adoptChat } = useWindowTabsData();
  const nav = useNavigation();
  return useCallback(
    async (chatId: string) => {
      if (!tabs.some((t) => t.id === chatId)) {
        const otherOwner = await adoptChat(chatId);
        if (otherOwner) {
          const win = await WebviewWindow.getByLabel(otherOwner);
          await win?.setFocus();
          return;
        }
      }
      selectChat(chatId);
      nav.goSection("code");
    },
    [tabs, adoptChat, selectChat, nav],
  );
}
